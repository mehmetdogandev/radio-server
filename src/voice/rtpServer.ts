import dgram from 'node:dgram';
import { decodeOpusPacket } from './opusPacketizer.js';
import { fanoutPacket, type UdpTarget } from './fanout.js';
import type { VoiceMediaMetrics } from './voiceMediaMetrics.js';
import {
  VOICE_WIRE_CHANNELS,
  VOICE_WIRE_FRAME_MS,
  VOICE_WIRE_HEADER_BYTES,
  VOICE_WIRE_PAYLOAD_ENCODING,
  VOICE_WIRE_SAMPLE_RATE_HZ,
  VOICE_WIRE_VERSION,
} from './wireFormat.js';
import { logUdpListenersForPort } from '../portDiag.js';

type GroupTargets = Map<number, UdpTarget[]>;
type LockCheck = (voiceGroupId: number, senderAdminId: number) => boolean;
type PacketLevelHandler = (payload: {
  voiceGroupId: number;
  senderAdminId: number;
  level: number;
  ts: number;
}) => void;
type StatsHandler = (payload: {
  voiceGroupId: number;
  packets: number;
  droppedPackets: number;
  outOfOrderPackets: number;
  jitterMsAvg: number;
  lastPacketAt: number;
  activeListeners: number;
  decodeSuccess: number;
  decodeFail: number;
}) => void;
type RxProbeHandler = (payload: {
  voiceGroupId: number;
  userId: number;
  address: string;
  port: number;
  ts: number;
}) => void;

type GroupRtpStats = {
  lastSeq: number | null;
  packets: number;
  droppedPackets: number;
  outOfOrderPackets: number;
  jitterMsAvg: number;
  lastPacketAt: number;
  lastTransitMs: number | null;
  lastLevelEmitAt: number;
  decodeSuccess: number;
  decodeFail: number;
};
export type RtpStatsSnapshot = {
  voiceGroupId: number;
  packets: number;
  droppedPackets: number;
  outOfOrderPackets: number;
  jitterMsAvg: number;
  lastPacketAt: number;
  activeListeners: number;
  decodeSuccess: number;
  decodeFail: number;
};

const STATS_TTL_MS = 90_000;

export class VoiceRtpServer {
  private socket = dgram.createSocket('udp4');
  /** start() çağrıldı (bind denendi). */
  private startInvoked = false;
  /** UDP dinlemede; false ise port çakışması vb. nedeniyle sadece HTTP/API çalışıyor olabilir. */
  private udpListening = false;
  private groupTargets: GroupTargets = new Map();
  private lockCheck: LockCheck = () => true;
  private onPacketLevel: PacketLevelHandler | null = null;
  private onStats: StatsHandler | null = null;
  private onRxProbe: RxProbeHandler | null = null;
  private statsByGroup = new Map<number, GroupRtpStats>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly port: number;
  private mediaMetrics: VoiceMediaMetrics | null = null;

  constructor(port = Number(process.env.VOICE_RTP_PORT ?? 5004)) {
    this.port = port;
  }

  setMediaMetrics(metrics: VoiceMediaMetrics | null) {
    this.mediaMetrics = metrics;
  }

  setLockCheck(checker: LockCheck) {
    this.lockCheck = checker;
  }

  setPacketLevelHandler(handler: PacketLevelHandler | null) {
    this.onPacketLevel = handler;
  }

  setStatsHandler(handler: StatsHandler | null) {
    this.onStats = handler;
  }

  setRxProbeHandler(handler: RxProbeHandler | null) {
    this.onRxProbe = handler;
  }

  private getGroupStats(voiceGroupId: number): GroupRtpStats {
    let stats = this.statsByGroup.get(voiceGroupId);
    if (!stats) {
      stats = {
        lastSeq: null,
        packets: 0,
        droppedPackets: 0,
        outOfOrderPackets: 0,
        jitterMsAvg: 0,
        lastPacketAt: 0,
        lastTransitMs: null,
        lastLevelEmitAt: 0,
        decodeSuccess: 0,
        decodeFail: 0,
      };
      this.statsByGroup.set(voiceGroupId, stats);
    }
    return stats;
  }

  private estimateLevel(payload: Buffer): number {
    if (payload.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < payload.length; i += 1) {
      sum += Math.abs(payload[i] - 127.5);
    }
    const normalized = Math.min(1, sum / (payload.length * 127.5));
    return Number(normalized.toFixed(3));
  }

  start() {
    if (this.startInvoked) return;
    this.startInvoked = true;
    const strict = process.env.VOICE_RTP_STRICT === '1';

    this.socket.on('message', (msg, rinfo) => {
      const packet = decodeOpusPacket(msg);
      if (!packet) return;
      if (packet.seq === 0 && packet.payload.length === 0) {
        this.mediaMetrics?.recordRxProbe();
        if (this.onRxProbe) {
          this.onRxProbe({
            voiceGroupId: packet.voiceGroupId,
            userId: packet.senderAdminId,
            address: rinfo.address,
            port: rinfo.port,
            ts: Date.now(),
          });
        }
        return;
      }
      if (!this.lockCheck(packet.voiceGroupId, packet.senderAdminId)) {
        this.mediaMetrics?.recordLockDenied();
        return;
      }
      this.mediaMetrics?.recordIncomingMedia();
      const now = Date.now();
      const stats = this.getGroupStats(packet.voiceGroupId);
      stats.packets += 1;
      stats.decodeSuccess += 1;
      if (stats.lastSeq != null) {
        if (packet.seq < stats.lastSeq) {
          stats.outOfOrderPackets += 1;
        } else if (packet.seq > stats.lastSeq + 1) {
          stats.droppedPackets += packet.seq - stats.lastSeq - 1;
        }
      }
      const transitMs = Math.max(0, now - packet.timestamp);
      if (stats.lastTransitMs != null) {
        const delta = Math.abs(transitMs - stats.lastTransitMs);
        stats.jitterMsAvg = stats.jitterMsAvg === 0 ? delta : stats.jitterMsAvg * 0.85 + delta * 0.15;
      }
      stats.lastTransitMs = transitMs;
      stats.lastSeq = packet.seq;
      stats.lastPacketAt = now;
      const targets = this.groupTargets.get(packet.voiceGroupId) ?? [];
      const sent = fanoutPacket(this.socket, packet, targets);
      this.mediaMetrics?.recordFanout(sent);
      if (this.onPacketLevel && now - stats.lastLevelEmitAt >= 80) {
        stats.lastLevelEmitAt = now;
        this.onPacketLevel({
          voiceGroupId: packet.voiceGroupId,
          senderAdminId: packet.senderAdminId,
          level: this.estimateLevel(packet.payload),
          ts: now,
        });
      }
    });

    this.socket.once('listening', () => {
      this.udpListening = true;
      this.statsTimer = setInterval(() => {
        if (!this.onStats) return;
        const now = Date.now();
        for (const [voiceGroupId, stats] of this.statsByGroup.entries()) {
          if (stats.lastPacketAt > 0 && now - stats.lastPacketAt > STATS_TTL_MS) {
            this.statsByGroup.delete(voiceGroupId);
            continue;
          }
          this.onStats({
            voiceGroupId,
            packets: stats.packets,
            droppedPackets: stats.droppedPackets,
            outOfOrderPackets: stats.outOfOrderPackets,
            jitterMsAvg: Number(stats.jitterMsAvg.toFixed(2)),
            lastPacketAt: stats.lastPacketAt,
            activeListeners: (this.groupTargets.get(voiceGroupId) ?? []).length,
            decodeSuccess: stats.decodeSuccess,
            decodeFail: stats.decodeFail,
          });
        }
      }, 1500);
      console.log(`[voice] RTP UDP listening on 0.0.0.0:${this.port} (pid=${process.pid})`);
    });

    this.socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[voice] UDP ${this.port} (VOICE_RTP_PORT) already in use (EADDRINUSE). This instance pid=${process.pid} could not bind; another process holds the port.`,
        );
        logUdpListenersForPort(this.port);
        if (strict) {
          process.exit(1);
        }
        console.warn(
          '[voice] UDP kapalı; HTTP/API açık kalıyor (ses RTP yok). Çakışmayı giderin veya VOICE_RTP_STRICT=1 ile bu durumda süreci durdurun.',
        );
        try {
          this.socket.close();
        } catch {
          /* ignore */
        }
        return;
      }
      console.error('[voice] RTP UDP socket error:', err);
      process.exit(1);
    });
    console.log(`[voice] binding RTP UDP 0.0.0.0:${this.port} (pid=${process.pid})`);
    this.socket.bind(this.port, '0.0.0.0');
  }

  isUdpListening(): boolean {
    return this.udpListening;
  }

  stop() {
    if (!this.startInvoked) return;
    this.startInvoked = false;
    this.udpListening = false;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }

  setGroupTargets(voiceGroupId: number, targets: UdpTarget[]) {
    this.groupTargets.set(voiceGroupId, targets);
  }

  getPublicConfig(voiceGroupId: number) {
    return {
      mode: 'rtp-opus' as const,
      udpPort: this.port,
      voiceGroupId,
      udpActive: this.udpListening,
      wire: {
        version: VOICE_WIRE_VERSION,
        payloadEncoding: VOICE_WIRE_PAYLOAD_ENCODING,
        headerBytes: VOICE_WIRE_HEADER_BYTES,
      },
      codec: {
        name: 'pcm_s16le' as const,
        sampleRate: VOICE_WIRE_SAMPLE_RATE_HZ,
        channels: VOICE_WIRE_CHANNELS,
        frameMs: VOICE_WIRE_FRAME_MS,
      },
    };
  }

  getStatsSnapshot(voiceGroupId: number): RtpStatsSnapshot | null {
    const stats = this.statsByGroup.get(voiceGroupId);
    if (!stats) return null;
    return {
      voiceGroupId,
      packets: stats.packets,
      droppedPackets: stats.droppedPackets,
      outOfOrderPackets: stats.outOfOrderPackets,
      jitterMsAvg: Number(stats.jitterMsAvg.toFixed(2)),
      lastPacketAt: stats.lastPacketAt,
      activeListeners: (this.groupTargets.get(voiceGroupId) ?? []).length,
      decodeSuccess: stats.decodeSuccess,
      decodeFail: stats.decodeFail,
    };
  }
}
