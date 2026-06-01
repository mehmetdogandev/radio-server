import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { voiceSpeakerLocks } from '../db/schema.js';

const DEFAULT_LOCK_TTL_MS = Number(process.env.VOICE_LOCK_TTL_MS ?? 60_000);
const DEFAULT_RTP_RENEW_THROTTLE_MS = Number(process.env.VOICE_LOCK_RTP_RENEW_MS ?? 4_000);

export class VoiceLockService {
  private lastRtpRenewByGroup = new Map<number, number>();

  constructor(
    private db: Db,
    private ttlMs = DEFAULT_LOCK_TTL_MS,
    private rtpRenewThrottleMs = DEFAULT_RTP_RENEW_THROTTLE_MS,
  ) {}

  current(voiceGroupId: number) {
    const now = Date.now();
    const row = this.db
      .select()
      .from(voiceSpeakerLocks)
      .where(eq(voiceSpeakerLocks.voiceGroupId, voiceGroupId))
      .get();
    if (!row) {
      return null;
    }
    if (row.expiresAt <= now) {
      this.db.delete(voiceSpeakerLocks).where(eq(voiceSpeakerLocks.id, row.id)).run();
      return null;
    }
    return row;
  }

  acquire(voiceGroupId: number, adminId: number): { ok: true } | { ok: false; lockedByAdminId: number } {
    const now = Date.now();
    const cur = this.current(voiceGroupId);
    if (cur && cur.lockedByAdminId !== adminId) {
      return { ok: false, lockedByAdminId: cur.lockedByAdminId };
    }
    if (cur && cur.lockedByAdminId === adminId) {
      this.db
        .update(voiceSpeakerLocks)
        .set({ expiresAt: now + this.ttlMs, lockedAt: now })
        .where(eq(voiceSpeakerLocks.id, cur.id))
        .run();
      return { ok: true };
    }
    this.db
      .insert(voiceSpeakerLocks)
      .values({
        voiceGroupId,
        lockedByAdminId: adminId,
        lockedAt: now,
        expiresAt: now + this.ttlMs,
      })
      .run();
    this.lastRtpRenewByGroup.delete(voiceGroupId);
    return { ok: true };
  }

  /**
   * PTT ile alınan kilit yalnızca HTTP `acquire` ile uzuyordu; RTP akışı 12sn sonra düşüyordu.
   * Geçerli kilit sahibinden gelen her RTP (throttle ile) `expiresAt` yenilenir.
   */
  rtpKeepAliveIfHolder(voiceGroupId: number, adminId: number): boolean {
    const lock = this.current(voiceGroupId);
    if (!lock || lock.lockedByAdminId !== adminId) {
      return false;
    }
    const now = Date.now();
    const last = this.lastRtpRenewByGroup.get(voiceGroupId) ?? 0;
    if (now - last >= this.rtpRenewThrottleMs) {
      this.lastRtpRenewByGroup.set(voiceGroupId, now);
      this.db
        .update(voiceSpeakerLocks)
        .set({ expiresAt: now + this.ttlMs, lockedAt: now })
        .where(eq(voiceSpeakerLocks.id, lock.id))
        .run();
    }
    return true;
  }

  release(voiceGroupId: number, adminId: number): boolean {
    const cur = this.current(voiceGroupId);
    if (!cur || cur.lockedByAdminId !== adminId) {
      return false;
    }
    this.db.delete(voiceSpeakerLocks).where(eq(voiceSpeakerLocks.id, cur.id)).run();
    this.lastRtpRenewByGroup.delete(voiceGroupId);
    return true;
  }
}

