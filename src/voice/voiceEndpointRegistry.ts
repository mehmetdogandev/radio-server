import type { VoiceRtpServer } from './rtpServer.js';
import type { VoiceLockService } from './lockService.js';
import type { UdpTarget } from './fanout.js';

type TargetRow = { address: string; port: number };
type ProbeRow = TargetRow & { seenAt: number };

/**
 * UDP probe + HTTP register tek otorite: hedef adres/port burada tutulur,
 * VoiceRtpServer.setGroupTargets ile fan-out listesi güncellenir.
 */
export class VoiceEndpointRegistry {
  private readonly targetsByGroup = new Map<number, Map<number, TargetRow>>();
  private readonly probeByGroup = new Map<number, Map<number, ProbeRow>>();

  constructor(
    private readonly voiceRtp: VoiceRtpServer,
    private readonly voiceLock: VoiceLockService,
    private readonly probeTtlMs: number,
  ) {}

  /** Gelen UDP probe (seq=0): hem probe kaydı hem canlı hedef güncellenir. */
  recordUdpProbe(voiceGroupId: number, userId: number, address: string, port: number): void {
    const g =
      this.probeByGroup.get(voiceGroupId) ?? new Map<number, ProbeRow>();
    const seenAt = Date.now();
    g.set(userId, { address, port, seenAt });
    this.probeByGroup.set(voiceGroupId, g);
    this.upsertTarget(voiceGroupId, userId, address, port);
  }

  /** HTTP rtp/register çözümlemesi; probe varsa UDP otoritelidir. */
  resolveRegisterEndpoints(
    voiceGroupId: number,
    userId: number,
    listenPort: number,
    candidateHost: string,
    remoteAddress: string | null,
  ): { address: string; port: number; resolvedBy: 'udp_probe' | 'client_host' | 'http_remote' } | null {
    const probe = this.getFreshProbe(voiceGroupId, userId);
    if (probe) {
      return { address: probe.address, port: probe.port, resolvedBy: 'udp_probe' };
    }
    const addr = (candidateHost.trim() ? candidateHost.trim() : null) ?? remoteAddress;
    if (!addr) {
      return null;
    }
    const resolvedBy = candidateHost.trim() ? 'client_host' : 'http_remote';
    return { address: addr, port: Math.floor(listenPort), resolvedBy };
  }

  applyRegister(
    voiceGroupId: number,
    userId: number,
    listenPort: number,
    candidateHost: string,
    remoteAddress: string | null,
  ): { address: string; port: number; resolvedBy: 'udp_probe' | 'client_host' | 'http_remote' } | null {
    const r = this.resolveRegisterEndpoints(voiceGroupId, userId, listenPort, candidateHost, remoteAddress);
    if (!r) {
      return null;
    }
    this.upsertTarget(voiceGroupId, userId, r.address, r.port);
    return r;
  }

  removeUser(voiceGroupId: number, userId: number): void {
    const existing = this.targetsByGroup.get(voiceGroupId);
    if (existing) {
      existing.delete(userId);
      if (existing.size === 0) {
        this.targetsByGroup.delete(voiceGroupId);
      } else {
        this.targetsByGroup.set(voiceGroupId, existing);
      }
    }
    const probes = this.probeByGroup.get(voiceGroupId);
    if (probes) {
      probes.delete(userId);
      if (probes.size === 0) {
        this.probeByGroup.delete(voiceGroupId);
      } else {
        this.probeByGroup.set(voiceGroupId, probes);
      }
    }
    this.refreshFanout(voiceGroupId);
  }

  clearGroup(voiceGroupId: number): void {
    this.targetsByGroup.delete(voiceGroupId);
    this.probeByGroup.delete(voiceGroupId);
    this.voiceRtp.setGroupTargets(voiceGroupId, []);
  }

  /** Kilit veya hedef listesi değişince (ör. PTT). */
  refreshFanout(voiceGroupId: number): void {
    const groupTargets = this.targetsByGroup.get(voiceGroupId);
    if (!groupTargets || groupTargets.size === 0) {
      this.voiceRtp.setGroupTargets(voiceGroupId, []);
      return;
    }
    const lock = this.voiceLock.current(voiceGroupId);
    const targets: UdpTarget[] = Array.from(groupTargets.entries())
      .filter(([uid]) => (lock ? uid !== lock.lockedByAdminId : true))
      .map(([, t]) => ({ address: t.address, port: t.port }));
    this.voiceRtp.setGroupTargets(voiceGroupId, targets);
  }

  private upsertTarget(voiceGroupId: number, userId: number, address: string, port: number): void {
    const existing = this.targetsByGroup.get(voiceGroupId) ?? new Map<number, TargetRow>();
    existing.set(userId, { address, port });
    this.targetsByGroup.set(voiceGroupId, existing);
    this.refreshFanout(voiceGroupId);
  }

  private getFreshProbe(voiceGroupId: number, userId: number): TargetRow | null {
    const group = this.probeByGroup.get(voiceGroupId);
    if (!group) return null;
    const found = group.get(userId);
    if (!found) return null;
    if (Date.now() - found.seenAt > this.probeTtlMs) {
      group.delete(userId);
      if (group.size === 0) {
        this.probeByGroup.delete(voiceGroupId);
      } else {
        this.probeByGroup.set(voiceGroupId, group);
      }
      return null;
    }
    return { address: found.address, port: found.port };
  }
}
