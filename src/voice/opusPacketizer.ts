import { VOICE_WIRE_HEADER_BYTES } from './wireFormat.js';

/** Sunucu tarafı ayrıştırıcı; wire formatı için bkz. `./wireFormat`. */
export type OpusPacket = {
  voiceGroupId: number;
  senderAdminId: number;
  seq: number;
  timestamp: number;
  payload: Buffer;
};

export function decodeOpusPacket(buf: Buffer): OpusPacket | null {
  if (buf.length < VOICE_WIRE_HEADER_BYTES) {
    return null;
  }
  const voiceGroupId = buf.readUInt32BE(0);
  const senderAdminId = buf.readUInt32BE(4);
  const seq = buf.readUInt32BE(8);
  const timestamp = Number(buf.readBigUInt64BE(12));
  const payload = buf.subarray(VOICE_WIRE_HEADER_BYTES);
  return { voiceGroupId, senderAdminId, seq, timestamp, payload };
}

export function encodeOpusPacket(p: OpusPacket): Buffer {
  const out = Buffer.alloc(VOICE_WIRE_HEADER_BYTES + p.payload.length);
  out.writeUInt32BE(p.voiceGroupId, 0);
  out.writeUInt32BE(p.senderAdminId, 4);
  out.writeUInt32BE(p.seq, 8);
  out.writeBigUInt64BE(BigInt(p.timestamp), 12);
  p.payload.copy(out, VOICE_WIRE_HEADER_BYTES);
  return out;
}

