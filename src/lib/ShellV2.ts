/*
 * Copyright 2025 pajowu. All Rights Reserved.
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

import { Stream } from './Stream';

type ShellV2Packet = { cmd: number; length: number; data: ArrayBuffer };

export class ShellV2 {
    private textDecoder = new TextDecoder();

    public stdout: ReadableStream;
    private stdoutController!: ReadableStreamDefaultController;
    public stderr: ReadableStream;
    private stderrController!: ReadableStreamDefaultController;
    public exitCode: Promise<number>;
    private exitCodeResolve!: (value: number) => void;


    constructor(
        readonly stream: Stream,
    ) {
        this.stdout = new ReadableStream({
            start: (controller) => this.stdoutController = controller
        });
        this.stderr = new ReadableStream({
            start: (controller) => this.stderrController = controller
        });
        this.exitCode = new Promise((resolve) => this.exitCodeResolve = resolve);

        this.processStream();
    }


    private parsePackages(data: DataView): ShellV2Packet[] {
        const pkts: ShellV2Packet[] = [];
        while (data.byteLength >= 5) {
            const packetType = data.getUint8(0);
            const packetLength = data.getUint32(1, true);
            const packetData = data.buffer.slice(5, packetLength + 5);
            data = new DataView(data.buffer.slice(packetLength + 5));
            pkts.push({ cmd: packetType, length: packetLength, data: packetData });
        }
        return pkts;
    }

    private async processStream(): Promise<void> {
        while (true) {
            const cmd = await this.stream.read();
            if (cmd.header.cmd == 'CLSE') {
                break;
            } else {
                const packets = cmd.data ? this.parsePackages(cmd.data) : [];
                for (const pkt of packets) {
                    switch (pkt.cmd) {
                        case 0:
                            break;
                        case 1:
                            this.stdoutController.enqueue(new Uint8Array(pkt.data));
                            break;
                        case 2:
                            this.stderrController.enqueue(new Uint8Array(pkt.data));
                            break;
                        case 3:
                            this.exitCodeResolve(new Uint8Array(pkt.data)[0]);
                            break;
                        default:
                            console.warn('unknown cmd', pkt);
                    }
                    await this.stream.write('OKAY');
                }
            }
        }
        await this.stream.close();
        await this.stdoutController.close();
        await this.stderrController.close();
    }
}
