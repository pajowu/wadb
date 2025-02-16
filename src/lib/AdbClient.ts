/*
 * Copyright 2020 Google Inc. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

import { Transport } from './transport/Transport';
import { Options } from './Options';
import { Message, MessageChannel, MessageListener } from './message';
import { KeyStore } from './KeyStore';
import { privateKeyDump } from './Helpers';
import { AdbConnectionInformation } from './AdbConnectionInformation';
import { Stream } from './Stream';
import { Shell } from './Shell';
import { AsyncBlockingQueue } from './Queues';
import { Framebuffer } from './Framebuffer';

const VERSION = 0x01000000;
const VERSION_NO_CHECKSUM = 0x01000001;
const MAX_PAYLOAD = 256 * 1024;

const MACHINE_BANNER = 'host::\0';

export class AdbClient implements MessageListener {
	private messageChannel: MessageChannel;
	private messageQueue = new AsyncBlockingQueue<Message>();
	private openStreams: Set<Stream> = new Set();

	/**
	 * Creates a new AdbClient
	 *
	 * @param {Transport} transport the transport layer.
	 */
	constructor(
		readonly transport: Transport<unknown>,
		readonly options: Options,
		readonly keyStore: KeyStore,
	) {
		this.messageChannel = new MessageChannel(transport, options, this);
	}

	registerStream(stream: Stream): void {
		this.openStreams.add(stream);
	}

	unregisterStream(stream: Stream): void {
		this.openStreams.delete(stream);
	}

	newMessage(msg: Message): void {
		// Check if this message matches one of the open streams.
		const streams = Array.from(this.openStreams);
		for (const stream of streams) {
			if (stream.consumeMessage(msg)) {
				return;
			}
		}
		this.messageQueue.enqueue(msg);
	}

	public async awaitMessage(): Promise<Message> {
		return this.messageQueue.dequeue();
	}

	async connect(): Promise<AdbConnectionInformation> {
		const version = this.options.useChecksum ? VERSION : VERSION_NO_CHECKSUM;
		const cnxn = Message.cnxn(version, MAX_PAYLOAD, MACHINE_BANNER, this.options.useChecksum);
		await this.sendMessage(cnxn); // Send the Message

		// Response to connect must be CNXN or AUTH. Ignore different responses until the right one
		// arrives.
		let response;
		do {
			response = await this.awaitMessage();
		} while (response.header.cmd !== 'CNXN' && response.header.cmd !== 'AUTH');

		// Server connected
		if (response.header.cmd === 'CNXN') {
			if (!response.data) {
				throw new Error("Connection doesn't have data");
			}
			return AdbConnectionInformation.fromDataView(response.data);
		}

		// Server asked to authenticate
		response = await this.doAuth(response);
		if (!response.data) {
			throw new Error("Connection doesn't have data");
		}
		return AdbConnectionInformation.fromDataView(response.data);
	}

	async disconnect(): Promise<void> {
		this.messageChannel.close();
	}

	async shellV2(command: string): Promise<{ stdout: string; stderr: string; exit: number }> {
		const stream = await Stream.open(this, `shell,v2,raw:${command}`, this.options);
		let stdout = '';
		let stderr = '';
		let exit = -1;
		type ShellV2Packet = { cmd: number; length: number; data: ArrayBuffer };
		function parsePackages(data: ArrayBuffer): ShellV2Packet[] {
			const pkts: ShellV2Packet[] = [];
			while (data.byteLength >= 5) {
				const view = new DataView(data);
				const packetType = view.getUint8(0);
				const packetLength = view.getUint32(1, true);
				console.log('type, length', packetType, packetLength);
				const packetData = data.slice(5, packetLength + 5);
				data = data.slice(packetLength + 5);
				pkts.push({ cmd: packetType, length: packetLength, data: packetData });
			}
			return pkts;
		}
		while (true) {
			const cmd = await stream.read();
			if (cmd.header.cmd == 'CLSE') {
				break;
			} else {
				const textDecoder = new TextDecoder();
				const packets = cmd.data ? parsePackages(cmd.data.buffer) : [];
				console.log(packets);
				for (const pkt of packets) {
					switch (pkt.cmd) {
						case 0:
							break;
						case 1:
							stdout += textDecoder.decode(pkt.data);
							break;
						case 2:
							stderr += textDecoder.decode(pkt.data);
							break;
						case 3:
							exit = new Uint8Array(pkt.data)[0];
							break;
						default:
							console.warn('unknown cmd', pkt);
					}
					await stream.write('OKAY');
				}
			}
		}
		await stream.close();
		return { stdout, stderr, exit };
	}

	async backup(command: string): Promise<Blob> {
		const stream = await Stream.open(this, `backup:${command}`, this.options);
		const data = [];
		while (true) {
			const cmd = await stream.read();
			if (cmd.header.cmd == 'CLSE') {
				break;
			} else {
				if (cmd?.data?.buffer) {
					data.push(cmd.data.buffer);
				}
				await stream.write('OKAY');
			}
		}
		await stream.close();
		return new Blob(data);
	}

	async shell(command: string): Promise<string> {
		const stream = await Stream.open(this, `shell:${command}`, this.options);
		let response = '';
		while (true) {
			const cmd = await stream.read();
			if (cmd.header.cmd == 'CLSE') {
				break;
			} else {
				response += cmd.dataAsString();
				await stream.write("OKAY");
			}
		}
		await stream.close();
		return response;
	}

	async framebuffer(): Promise<Framebuffer> {
		return Framebuffer.create(this, this.options);
	}

	async interactiveShell(callback?: (result: string) => void): Promise<Shell> {
		const stream = await Stream.open(this, 'shell:', this.options);
		return new Shell(stream, callback);
	}

	async sync(): Promise<Stream> {
		return await Stream.open(this, 'sync:', this.options);
	}

	async pull(filename: string): Promise<Blob> {
		const syncStream = await this.sync();
		const result = await syncStream.pull(filename);
		await syncStream.close();
		return result;
	}

	async *pullGenerator(filename: string): AsyncGenerator<ArrayBuffer> {
		const syncStream = await this.sync();
		yield* syncStream.pullGenerator(filename);
		await syncStream.close();
	}

	private async doAuth(authResponse: Message): Promise<Message> {
		if (authResponse.header.cmd !== 'AUTH') {
			throw new Error('Not an AUTH response');
		}

		if (authResponse.header.arg0 !== 1) {
			throw new Error(`
          Invalid AUTH parameter. Expected 1 and received ${authResponse.header.arg0}`);
		}

		if (!authResponse.data) {
			throw new Error("AUTH message doens't contain data");
		}

		const token = authResponse.data.buffer;

		// Try signing with one of the stored keys
		const keys = await this.keyStore.loadKeys();
		for (const key of keys) {
			const signed = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, token);
			const signatureMessage = Message.authSignature(
				new DataView(signed),
				this.options.useChecksum,
			);
			await this.sendMessage(signatureMessage);
			const signatureResponse = await this.awaitMessage();
			if (signatureResponse.header.cmd === 'CNXN') {
				console.log('keyMatched', key);
				return signatureResponse;
			}
			// console.log("Received message ", signatureResponse, "from phone");
		}
		let key;
		if (keys.length === 0) {
			// None of they saved Keys is usable. Create new key
			key = await AdbClient.generateKey(this.options.dump, this.options.keySize);
			await this.keyStore.saveKey(key);
		} else {
			key = keys[0];
		}
		const exportedKey = new DataView(await crypto.subtle.exportKey('spki', key.publicKey));
		const keyMessage = Message.authPublicKey(exportedKey, this.options.useChecksum);
		await this.sendMessage(keyMessage);

		if (this.options.debug) {
			console.log('Waiting for key to be accepted on the device.');
		}
		const keyResponse = await this.awaitMessage();
		if (keyResponse.header.cmd !== 'CNXN') {
			console.error("AUTH failed. Phone didn't accept key", keyResponse);
			throw new Error("AUTH failed. Phone didn't accept key");
		}
		return keyResponse;
	}

	public async sendMessage(m: Message): Promise<void> {
		await this.messageChannel.write(m);
	}

	static async generateKey(dump: boolean, keySize: number): Promise<CryptoKeyPair> {
		const extractable = dump;
		const key = await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: keySize,
				publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
				hash: { name: 'SHA-1' },
			},
			extractable,
			['sign', 'verify'],
		);

		if (dump) {
			await privateKeyDump(key);
		}

		return key;
	}
}
