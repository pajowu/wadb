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

import { AdbClient } from './AdbClient';
import { Message } from './message';
import { Options } from './Options';
import { toHex32 } from './Helpers';
import { SyncFrame } from './SyncFrame';
import { AsyncBlockingQueue } from './Queues';

export class Stream {
	private static nextId = 1;
	private messageQueue = new AsyncBlockingQueue<Message>();

	constructor(
		readonly client: AdbClient,
		readonly service: string,
		readonly localId: number,
		readonly remoteId: number,
		private options: Options,
	) {}

	async close(): Promise<void> {
		await this.write('CLSE');

		if (this.options.debug) {
			console.log(`Closed stream ${this.service}`);
			console.log(` local_id: 0x${toHex32(this.localId)}`);
			console.log(` remote_id: 0x${toHex32(this.remoteId)}`);
		}
		this.client.unregisterStream(this);
	}

	consumeMessage(msg: Message): boolean {
		if (
			msg.header.arg0 === 0 ||
			msg.header.arg0 !== this.remoteId ||
			msg.header.arg1 === 0 ||
			msg.header.arg1 !== this.localId
		) {
			return false;
		}
		this.messageQueue.enqueue(msg);
		return true;
	}

	async write(cmd: string, data?: DataView): Promise<void> {
		const message = this.newMessage(cmd, data);
		await this.client.sendMessage(message);
	}

	async read(): Promise<Message> {
		return this.messageQueue.dequeue();
	}

	/**
	 *
	 * Retrieves a file from device to a local file. The remote path is the path to
	 * the file that will be returned. Just as for the SEND sync request the file
	 * received is split up into chunks. The sync response id is "DATA" and length is
	 * the chunk size. After follows chunk size number of bytes. This is repeated
	 * until the file is transferred. Each chunk will not be larger than 64k.
	 * When the file is transferred a sync response "DONE" is retrieved where the
	 * length can be ignored.
	 *
	 * @param {string} remotePath path to the file to be pulled from the device
	 * @returns {Promise<Blob>} a Blog with the file contents.
	 */
	async pull(remotePath: string): Promise<Blob> {
		const encoder = new TextEncoder();
		const encodedFilename = encoder.encode(remotePath);

		// Sends RECV with filename length.
		const recvFrame = new SyncFrame('RECV', encodedFilename.byteLength);
		const wrteRecvMessage = this.newMessage('WRTE', recvFrame.toDataView());
		await this.client.sendMessage(wrteRecvMessage);
		const wrteRecvResponse = await this.read();
		if (wrteRecvResponse.header.cmd !== 'OKAY') {
			throw new Error('WRTE/RECV failed: ' + wrteRecvResponse);
		}

		// 17. We send the path of the file we want again sdcard/someFile.txt
		const wrteFilenameMessage = this.newMessage('WRTE', new DataView(encodedFilename.buffer));
		await this.client.sendMessage(wrteFilenameMessage);

		// 18. Device sends us OKAY
		const wrteFilenameResponse = await this.read();
		if (wrteFilenameResponse.header.cmd !== 'OKAY') {
			throw new Error('WRTE/filename failed: ' + wrteFilenameResponse);
		}

		const okayMessage = this.newMessage('OKAY');
		let fileDataMessage = await this.read();
		await this.client.sendMessage(okayMessage);

		let syncFrame = SyncFrame.fromDataView(new DataView(fileDataMessage.data!.buffer.slice(0, 8)));
		let buffer = new Uint8Array(fileDataMessage.data!.buffer.slice(8));
		const chunks: ArrayBuffer[] = [];
		while (syncFrame.cmd !== 'DONE') {
			while (syncFrame.byteLength >= buffer.byteLength) {
				fileDataMessage = await this.read();
				await this.client.sendMessage(okayMessage);

				// Join both arrays
				const newLength = buffer.byteLength + fileDataMessage.data!.byteLength;
				const newBuffer = new Uint8Array(newLength);
				newBuffer.set(buffer, 0);
				newBuffer.set(new Uint8Array(fileDataMessage.data!.buffer), buffer.byteLength);
				buffer = newBuffer;
			}
			chunks.push(buffer.slice(0, syncFrame.byteLength).buffer);
			buffer = buffer.slice(syncFrame.byteLength);
			syncFrame = SyncFrame.fromDataView(new DataView(buffer.slice(0, 8).buffer));
			buffer = buffer.slice(8);
		}
		return new Blob(chunks);
	}

	private newMessage(cmd: string, data?: DataView): Message {
		return Message.newMessage(cmd, this.localId, this.remoteId, this.options.useChecksum, data);
	}

	static async open(adbClient: AdbClient, service: string, options: Options): Promise<Stream> {
		const localId = Stream.nextId++;
		let remoteId = 0;
		const m = Message.open(localId, remoteId, service, options.useChecksum);
		await adbClient.sendMessage(m);

		let response;
		do {
			response = await adbClient.awaitMessage();
		} while (response.header.arg1 !== localId);

		if (response.header.cmd !== 'OKAY') {
			throw new Error('OPEN Failed');
		}

		remoteId = response.header.arg0;
		if (options.debug) {
			console.log(`Opened stream ${service}`);
			console.log(` local_id: 0x${toHex32(localId)}`);
			console.log(` remote_id: 0x${toHex32(remoteId)}`);
		}

		const stream = new Stream(adbClient, service, localId, remoteId, options);
		adbClient.registerStream(stream);
		return stream;
	}
}
