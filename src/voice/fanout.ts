import type dgram from 'node:dgram';
import { encodeOpusPacket, type OpusPacket } from './opusPacketizer.js';

export type UdpTarget = { address: string; port: number };

export function fanoutPacket(
  socket: dgram.Socket,
  packet: OpusPacket,
  targets: UdpTarget[],
): number {
  const out = encodeOpusPacket(packet);
  let sent = 0;
  for (const t of targets) {
    socket.send(out, t.port, t.address);
    sent += 1;
  }
  return sent;
}

