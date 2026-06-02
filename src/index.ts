import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { eq, and, desc, gt, isNull, inArray, like } from 'drizzle-orm';
import { createDb } from './db/client.js';
import {
  users,
  chats,
  chatMembers,
  chatJoinRequests,
  messages,
  groupInvitations,
  voiceGroups,
  voiceSessions,
  voicePresence,
  voiceSpeakerLocks,
} from './db/schema.js';
import { signUserToken, verifyUserToken, hashPassword, verifyPassword } from './auth.js';
import { WsHub, type WsClient } from './wsHub.js';
import { VoiceLockService } from './voice/lockService.js';
import { VoiceRtpServer } from './voice/rtpServer.js';
import { VoiceEndpointRegistry } from './voice/voiceEndpointRegistry.js';
import { VoiceMediaMetrics } from './voice/voiceMediaMetrics.js';
import { logTcpListenersForPort } from './portDiag.js';
import {
  validateUserSync,
  validateCreateChat,
  validateSendMessage,
  validateChatId,
  validateJoinRequest,
  validatePagination,
  validateRequestId,
  sanitizeMessage,
} from './validation.js';

const PORT = Number(process.env.PORT ?? 8080);
/** 0.0.0.0: tüm arayüzler (LAN’dan 192.168.1.x erişimi). Yalnızca loopback için 127.0.0.1. */
const HTTP_LISTEN_HOST = process.env.HTTP_LISTEN_HOST ?? '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-insecure-change-me';
const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'radio.db');
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000);
const _rateLimitMaxRaw = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 100);
const RATE_LIMIT_MAX_REQUESTS =
  Number.isFinite(_rateLimitMaxRaw) && _rateLimitMaxRaw > 0 ? _rateLimitMaxRaw : 100;
const APP_VERSION = process.env.APP_VERSION ?? process.env.npm_package_version ?? 'dev';
const APP_GIT_SHA = process.env.APP_GIT_SHA ?? 'unknown';
/** Çalışan sürecin gerçekten hangi dosyayı yüklediği (8080’de eski kopya mı kanıtı). */
const MAIN_MODULE_PATH = fileURLToPath(import.meta.url);

// Validate JWT_SECRET on startup
const INSECURE_SECRETS = [
  'dev-insecure-change-me',
  'change-me-long-random-string',
  'change-me-long-random-string-REPLACE-WITH-SECURE-VALUE',
];
if (!JWT_SECRET || INSECURE_SECRETS.includes(JWT_SECRET) || JWT_SECRET.length < 32) {
  console.error('❌ SECURITY ERROR: JWT_SECRET is not set or uses an insecure default value!');
  console.error('   Please set a strong JWT_SECRET in your .env file.');
  console.error('   Generate one with: openssl rand -base64 32');
  process.exit(1);
}

const app = express();

// Rate limiting middleware
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  message: { error: 'Çok fazla istek. Lütfen daha sonra tekrar deneyin.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Çok fazla giriş denemesi. 1 saat sonra tekrar deneyin.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// CORS configuration
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '*').trim();
if (process.env.NODE_ENV === 'production') {
  const insecure = !CORS_ORIGINS || CORS_ORIGINS === '*';
  if (insecure) {
    console.error(
      '❌ CORS_ORIGINS must be set to an explicit comma-separated origin list in production (not * or empty).',
    );
    console.error('   Example: CORS_ORIGINS=http://192.168.1.167:8080,http://204.168.162.200:8080');
    process.exit(1);
  }
}
const corsOptions =
  CORS_ORIGINS === '*' ? {} : { origin: CORS_ORIGINS.split(',').map(o => o.trim()) };

app.use(cors(corsOptions));
app.use(express.json({ limit: '512kb' }));
app.use('/api/', generalLimiter);

const db = createDb(DB_PATH);
const hub = new WsHub();
const voiceLockService = new VoiceLockService(db);
const voiceRtpServer = new VoiceRtpServer();
const RTP_PROBE_TTL_MS = 60_000;
const voiceMediaMetrics = process.env.VOICE_RTP_METRICS === '1' ? new VoiceMediaMetrics() : null;
voiceRtpServer.setMediaMetrics(voiceMediaMetrics);
const voiceEndpointRegistry = new VoiceEndpointRegistry(voiceRtpServer, voiceLockService, RTP_PROBE_TTL_MS);
voiceRtpServer.setLockCheck((voiceGroupId: number, senderAdminId: number) =>
  voiceLockService.rtpKeepAliveIfHolder(voiceGroupId, senderAdminId),
);
voiceRtpServer.setPacketLevelHandler((payload) => {
  emitVoiceEvent('voice.audio.level', payload);
});
voiceRtpServer.setStatsHandler((payload) => {
  emitVoiceEvent('voice.rtp.stats', payload);
});
voiceRtpServer.setRxProbeHandler(({ voiceGroupId, userId, address, port }) => {
  const normalized = normalizeRemoteAddress(address);
  if (!normalized || !Number.isFinite(port) || port <= 0 || port > 65535) {
    return;
  }
  const inGroup = db
    .select({ userId: voicePresence.userId })
    .from(voicePresence)
    .where(and(eq(voicePresence.voiceGroupId, voiceGroupId), eq(voicePresence.userId, userId)))
    .get();
  if (!inGroup) {
    return;
  }
  voiceEndpointRegistry.recordUdpProbe(voiceGroupId, userId, normalized, port);
});
voiceRtpServer.start();

/**
 * PTT açıkken uzun sessizlikte UDP karesi gelmeyebilir (emülatör / güç tasarrufu).
 * Eski 7s değeri kilidi düşürüp paketleri lockDenied sayıyordu; Durdur/Devam olmadan ses dönmezdi.
 * 0 = bu otomatik temizlik kapalı (yalnızca açık PTT kapatma / leave ile kilit kalkar).
 */
const NO_PACKET_SPEAKER_TIMEOUT_MS = Number(process.env.VOICE_NO_PACKET_SPEAKER_TIMEOUT_MS ?? 300_000);
setInterval(() => {
  if (NO_PACKET_SPEAKER_TIMEOUT_MS <= 0) {
    return;
  }
  const now = Date.now();
  const activeSessions = db
    .select({
      voiceGroupId: voiceSessions.voiceGroupId,
      activeSpeakerAdminId: voiceSessions.activeSpeakerAdminId,
    })
    .from(voiceSessions)
    .all();
  for (const s of activeSessions) {
    if (s.activeSpeakerAdminId == null) continue;
    const stats = voiceRtpServer.getStatsSnapshot(s.voiceGroupId);
    if (
      !stats ||
      stats.lastPacketAt <= 0 ||
      now - stats.lastPacketAt <= NO_PACKET_SPEAKER_TIMEOUT_MS
    ) {
      continue;
    }
    const speakerId = s.activeSpeakerAdminId;
    voiceLockService.release(s.voiceGroupId, speakerId);
    db.update(voiceSessions)
      .set({ activeSpeakerAdminId: null, updatedAt: now })
      .where(eq(voiceSessions.voiceGroupId, s.voiceGroupId))
      .run();
    db.update(voicePresence)
      .set({ role: 'admin', lastSeenAt: now })
      .where(and(eq(voicePresence.voiceGroupId, s.voiceGroupId), eq(voicePresence.userId, speakerId)))
      .run();
    voiceEndpointRegistry.refreshFanout(s.voiceGroupId);
    emitVoiceEvent('voice.speaker.stopped', { voiceGroupId: s.voiceGroupId, adminId: speakerId, reason: 'no_packet_timeout' });
  }
}, 2000);

type VoiceSseEventType =
  | 'voice.group.created'
  | 'voice.group.deleted'
  | 'voice.presence.changed'
  | 'voice.speaker.started'
  | 'voice.speaker.stopped'
  | 'voice.lock.denied'
  | 'voice.group.metrics'
  | 'voice.audio.level'
  | 'voice.rtp.stats';

type VoiceSseClient = { userId: number; res: express.Response };
const voiceSseClients = new Set<VoiceSseClient>();

function emitVoiceEvent(type: VoiceSseEventType, payload: unknown, targetUserId?: number): void {
  const event = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of voiceSseClients) {
    if (targetUserId != null && c.userId !== targetUserId) {
      continue;
    }
    try {
      c.res.write(event);
    } catch {
      voiceSseClients.delete(c);
    }
  }
}

function voiceGroupMetrics(voiceGroupId: number) {
  const listeners = db
    .select({ userId: voicePresence.userId, name: users.name, role: users.role })
    .from(voicePresence)
    .innerJoin(users, eq(users.id, voicePresence.userId))
    .where(and(eq(voicePresence.voiceGroupId, voiceGroupId), isNull(users.deletedAt)))
    .all();
  return {
    voiceGroupId,
    listenerCount: listeners.length,
    listeners: listeners.map((l) => ({ id: l.userId, name: l.name, role: l.role })),
  };
}

function normalizeRemoteAddress(addr: string | undefined): string | null {
  if (!addr) return null;
  if (addr.startsWith('::ffff:')) {
    return addr.slice(7);
  }
  if (addr === '::1') {
    return '127.0.0.1';
  }
  return addr;
}

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

function parseSyncRole(body: { role?: string }): 'admin' | 'user' {
  const r = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
  if (r === 'admin') {
    return 'admin';
  }
  return 'user';
}

const MDNS_HOSTNAME = (process.env.MDNS_HOSTNAME ?? '').trim();
const MDNS_HTTP_BASE =
  MDNS_HOSTNAME.length > 0
    ? `http://${MDNS_HOSTNAME}.local:${PORT}`
    : undefined;

function readCpuTemperatureC(): number | null {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
    const milli = Number(raw);
    if (!Number.isFinite(milli)) {
      return null;
    }
    return Math.round((milli / 1000) * 10) / 10;
  } catch {
    return null;
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'radio-server',
    version: APP_VERSION,
    gitSha: APP_GIT_SHA,
    pid: process.pid,
    mainModulePath: MAIN_MODULE_PATH,
    cwd: process.cwd(),
    port: PORT,
    voiceRtpPort: Number(process.env.VOICE_RTP_PORT ?? 5004),
    ...(MDNS_HOSTNAME ? { mdnsHostname: MDNS_HOSTNAME, httpBaseUrl: MDNS_HTTP_BASE } : {}),
    features: {
      voiceRtpRegister: true,
      voiceRtpUdp: voiceRtpServer.isUdpListening(),
      /** UDP kapalı veya isteğe bağlı yumuşak başarısızlık — ses RTP kullanılamaz. */
      voiceMediaDegraded: !voiceRtpServer.isUdpListening(),
      ...(voiceMediaMetrics ? { voiceRtpMetrics: voiceMediaMetrics.snapshot() } : {}),
    },
  });
});

app.get('/status', (_req, res) => {
  const mem = process.memoryUsage();
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  const cpuTempC = readCpuTemperatureC();
  res.json({
    ok: true,
    service: 'radio-server',
    version: APP_VERSION,
    gitSha: APP_GIT_SHA,
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid,
    cwd: process.cwd(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      loadavg: os.loadavg(),
      cpuTempC,
    },
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      freeMem,
      totalMem,
    },
    network: {
      port: PORT,
      voiceRtpPort: Number(process.env.VOICE_RTP_PORT ?? 5004),
      voiceRtpUdpListening: voiceRtpServer.isUdpListening(),
      ...(MDNS_HOSTNAME ? { mdnsHostname: MDNS_HOSTNAME, httpBaseUrl: MDNS_HTTP_BASE } : {}),
    },
  });
});

app.post('/api/users/sync', strictLimiter, validateUserSync, async (req: express.Request, res: express.Response) => {
  const body = req.body as {
    name?: string;
    email?: string;
    password?: string;
    passwordHash?: string;
    role?: string;
  };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? normEmail(body.email) : '';
  
  // Support both plain password (new) and passwordHash (legacy)
  const password = typeof body.password === 'string' ? body.password : '';
  const legacyHash = typeof body.passwordHash === 'string' ? body.passwordHash : '';
  
  if (!name || !email || (!password && !legacyHash)) {
    res.status(400).json({ error: 'name, email ve password gerekli' });
    return;
  }

  const role = parseSyncRole(body);
  const now = Date.now();

  const existing = db.select().from(users).where(eq(users.email, email)).get();
  if (existing) {
    // Verify password
    let passwordValid = false;
    if (password) {
      // New bcrypt verification
      passwordValid = await verifyPassword(password, existing.passwordHash);
    } else if (legacyHash) {
      // Legacy SHA-256 comparison (backwards compatibility during migration)
      passwordValid = existing.passwordHash === legacyHash;
      
      // If legacy hash matches, upgrade to bcrypt
      if (passwordValid && password) {
        const newHash = await hashPassword(password);
        db.update(users)
          .set({ passwordHash: newHash, updatedAt: now })
          .where(eq(users.id, existing.id))
          .run();
      }
    }
    
    if (!passwordValid) {
      res.status(401).json({ error: 'Şifre eşleşmiyor' });
      return;
    }
    
    if (existing.role !== role) {
      db.update(users)
        .set({ role, updatedAt: now })
        .where(eq(users.id, existing.id))
        .run();
    }
    const u = db.select().from(users).where(eq(users.id, existing.id)).get()!;
    const token = signUserToken(u.id, JWT_SECRET);
    res.json({
      token,
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role as 'admin' | 'user',
      },
    });
    return;
  }

  // New user registration - hash password with bcrypt
  const passwordHash = password ? await hashPassword(password) : legacyHash;
  
  db.insert(users)
    .values({
      name,
      email,
      passwordHash,
      role,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const created = db.select().from(users).where(eq(users.email, email)).get()!;
  const token = signUserToken(created.id, JWT_SECRET);
  res.json({
    token,
    user: {
      id: created.id,
      name: created.name,
      email: created.email,
      role: created.role as 'admin' | 'user',
    },
  });
});

function bearerUserId(req: express.Request): number | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    return null;
  }
  const r = verifyUserToken(h.slice(7), JWT_SECRET);
  if (!r.ok) {
    return null;
  }
  return r.userId;
}

function requireUser(req: express.Request, res: express.Response): number | null {
  const id = bearerUserId(req);
  if (id == null) {
    res.status(401).json({ error: 'Yetkisiz' });
    return null;
  }
  return id;
}

function requireAdmin(req: express.Request, res: express.Response): number | null {
  const id = requireUser(req, res);
  if (id == null) {
    return null;
  }
  const u = db.select().from(users).where(eq(users.id, id)).get();
  if (!u || u.role !== 'admin') {
    res.status(403).json({ error: 'Yönetici gerekli' });
    return null;
  }
  return id;
}

// User discovery endpoints
app.get('/api/users', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Number(req.query.offset) || 0;
  
  const allUsers = db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(isNull(users.deletedAt))
    .orderBy(users.name)
    .limit(limit)
    .offset(offset)
    .all();
  
  res.json({ users: allUsers, limit, offset });
});

app.get('/api/users/search', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  
  const query = String(req.query.q || '').trim().toLowerCase();
  if (!query) {
    res.json({ users: [] });
    return;
  }
  
  const allUsers = db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    })
    .from(users)
    .where(isNull(users.deletedAt))
    .all();
  
  const filtered = allUsers.filter(u =>
    u.name.toLowerCase().includes(query) ||
    u.email.toLowerCase().includes(query)
  ).slice(0, 20);
  
  res.json({ users: filtered });
});

// Group settings endpoints
app.patch('/api/chats/:chatId', validateChatId, (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  
  const chatId = Number(req.params.chatId);
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  
  if (!chat || chat.deletedAt) {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }
  
  if (chat.createdBy !== userId) {
    res.status(403).json({ error: 'Sadece grup sahibi değiştirebilir' });
    return;
  }
  
  const body = req.body as { name?: string };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  
  if (!name) {
    res.status(400).json({ error: 'Grup adı gerekli' });
    return;
  }
  
  db.update(chats)
    .set({ name, updatedAt: Date.now() })
    .where(eq(chats.id, chatId))
    .run();
  
  const updated = db.select().from(chats).where(eq(chats.id, chatId)).get();
  res.json({ chat: updated });
});

app.delete('/api/chats/:chatId', validateChatId, (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  
  const chatId = Number(req.params.chatId);
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  
  if (!chat || chat.deletedAt) {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }
  
  if (chat.createdBy !== userId) {
    res.status(403).json({ error: 'Sadece grup sahibi silebilir' });
    return;
  }
  
  db.update(chats)
    .set({ deletedAt: Date.now() })
    .where(eq(chats.id, chatId))
    .run();
  
  res.json({ success: true });
});

// Member management endpoints
app.delete('/api/chats/:chatId/members/:memberId', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  
  const chatId = Number(req.params.chatId);
  const memberId = Number(req.params.memberId);
  
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat || chat.deletedAt) {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }
  
  // Check if user is admin of the group
  const userMember = db.select().from(chatMembers)
    .where(and(
      eq(chatMembers.chatId, chatId),
      eq(chatMembers.userId, userId),
      eq(chatMembers.status, 'active'),
      isNull(chatMembers.removedAt)
    ))
    .get();
  
  if (!userMember || !userMember.isAdmin) {
    res.status(403).json({ error: 'Sadece grup yöneticileri üye çıkarabilir' });
    return;
  }
  
  // Cannot remove self via this endpoint
  if (memberId === userId) {
    res.status(400).json({ error: 'Kendinizi çıkarmak için /leave kullanın' });
    return;
  }
  
  db.update(chatMembers)
    .set({ status: 'removed', removedAt: Date.now() })
    .where(and(
      eq(chatMembers.chatId, chatId),
      eq(chatMembers.userId, memberId)
    ))
    .run();
  
  res.json({ success: true });
});

app.post('/api/chats/:chatId/leave', validateChatId, (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  
  const chatId = Number(req.params.chatId);
  
  db.update(chatMembers)
    .set({ status: 'removed', removedAt: Date.now() })
    .where(and(
      eq(chatMembers.chatId, chatId),
      eq(chatMembers.userId, userId)
    ))
    .run();
  
  res.json({ success: true });
});

app.post('/api/chats/:chatId/members/:memberId/promote', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  
  const chatId = Number(req.params.chatId);
  const memberId = Number(req.params.memberId);
  
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat || chat.deletedAt) {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }
  
  // Check if user is admin
  const userMember = db.select().from(chatMembers)
    .where(and(
      eq(chatMembers.chatId, chatId),
      eq(chatMembers.userId, userId),
      eq(chatMembers.status, 'active')
    ))
    .get();
  
  if (!userMember || !userMember.isAdmin) {
    res.status(403).json({ error: 'Sadece yöneticiler başka yöneticiler atayabilir' });
    return;
  }
  
  db.update(chatMembers)
    .set({ isAdmin: true })
    .where(and(
      eq(chatMembers.chatId, chatId),
      eq(chatMembers.userId, memberId),
      eq(chatMembers.status, 'active')
    ))
    .run();
  
  res.json({ success: true });
});

app.post('/api/chats/:chatId/members/:memberId/demote', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  
  const chatId = Number(req.params.chatId);
  const memberId = Number(req.params.memberId);
  
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat || chat.deletedAt) {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }
  
  // Only group creator can demote
  if (chat.createdBy !== userId) {
    res.status(403).json({ error: 'Sadece grup sahibi yönetici yetkisini alabilir' });
    return;
  }
  
  // Cannot demote self
  if (memberId === userId) {
    res.status(400).json({ error: 'Kendi yönetici yetkinizi alamazsınız' });
    return;
  }
  
  db.update(chatMembers)
    .set({ isAdmin: false })
    .where(and(
      eq(chatMembers.chatId, chatId),
      eq(chatMembers.userId, memberId)
    ))
    .run();
  
  res.json({ success: true });
});

app.post('/api/chats', validateCreateChat, (req: express.Request, res: express.Response) => {
  const adminId = requireAdmin(req, res);
  if (adminId == null) {
    return;
  }
  const body = req.body as { name?: string; isGroup?: boolean; chatType?: string };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const isGroup = body.isGroup !== false;
  const chatType =
    body.chatType === 'voice' ? 'voice' : 'chat';
  if (!name) {
    res.status(400).json({ error: 'name gerekli' });
    return;
  }
  const now = Date.now();
  db.insert(chats)
    .values({
      name,
      isGroup,
      chatType,
      createdAt: now,
      createdBy: adminId,
    })
    .run();
  const row = db
    .select()
    .from(chats)
    .orderBy(desc(chats.id))
    .limit(1)
    .get()!;
  db.insert(chatMembers)
    .values({
      chatId: row.id,
      userId: adminId,
      status: 'active',
      createdAt: now,
    })
    .run();
  res.json({ chat: { id: row.id, name: row.name, chatType: row.chatType } });
  hub.broadcastEvent('chats:changed', { chatId: row.id });
});

app.get('/api/chats', (req, res) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const rows = db
    .select()
    .from(chats)
    .where(
      and(
        eq(chats.isGroup, true),
        eq(chats.chatType, 'chat'),
        isNull(chats.deletedAt),
      ),
    )
    .orderBy(desc(chats.id))
    .all();

  const chatIds = rows.map((r) => r.id);
  const activeSet = new Set<number>();
  const pendingSet = new Set<number>();
  if (chatIds.length > 0) {
    const members = db
      .select()
      .from(chatMembers)
      .where(
        and(
          inArray(chatMembers.chatId, chatIds),
          eq(chatMembers.userId, userId),
          eq(chatMembers.status, 'active'),
        ),
      )
      .all();
    for (const m of members) {
      if (m.removedAt == null) {
        activeSet.add(m.chatId);
      }
    }
    const pendingRows = db
      .select()
      .from(chatJoinRequests)
      .where(
        and(
          inArray(chatJoinRequests.chatId, chatIds),
          eq(chatJoinRequests.userId, userId),
          eq(chatJoinRequests.status, 'pending'),
        ),
      )
      .all();
    for (const p of pendingRows) {
      pendingSet.add(p.chatId);
    }
  }

  const out = rows.map((c) => {
    let myMembership: 'active' | 'pending' | 'none';
    if (activeSet.has(c.id)) {
      myMembership = 'active';
    } else if (pendingSet.has(c.id)) {
      myMembership = 'pending';
    } else {
      myMembership = 'none';
    }
    return {
      id: c.id,
      name: c.name,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
      myMembership,
    };
  });
  res.json({ chats: out });
});

app.post('/api/chats/:chatId/join-request', validateJoinRequest, (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const chatId = Number(req.params.chatId);
  if (!Number.isFinite(chatId)) {
    res.status(400).json({ error: 'Geçersiz chat' });
    return;
  }
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat) {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }
  const now = Date.now();
  const dup = db
    .select()
    .from(chatJoinRequests)
    .where(
      and(
        eq(chatJoinRequests.chatId, chatId),
        eq(chatJoinRequests.userId, userId),
        eq(chatJoinRequests.status, 'pending'),
      ),
    )
    .get();
  if (dup) {
    res.json({ ok: true, requestId: dup.id, status: 'pending' });
    return;
  }
  db.insert(chatJoinRequests)
    .values({ chatId, userId, status: 'pending', createdAt: now })
    .run();
  const inserted = db
    .select()
    .from(chatJoinRequests)
    .orderBy(desc(chatJoinRequests.id))
    .limit(1)
    .get()!;
  res.json({ ok: true, requestId: inserted.id, status: 'pending' });
  if (chat.createdBy != null) {
    hub.broadcastToUser(chat.createdBy, 'join-request:created', {
      requestId: inserted.id,
      chatId,
      chatName: chat.name ?? null,
      userId,
      createdAt: inserted.createdAt,
    });
  }
});

app.get('/api/join-requests', (req, res) => {
  const adminId = requireAdmin(req, res);
  if (adminId == null) {
    return;
  }
  const rows = db
    .select({
      id: chatJoinRequests.id,
      chatId: chatJoinRequests.chatId,
      userId: chatJoinRequests.userId,
      status: chatJoinRequests.status,
      createdAt: chatJoinRequests.createdAt,
      chatName: chats.name,
      userName: users.name,
      userEmail: users.email,
    })
    .from(chatJoinRequests)
    .innerJoin(chats, eq(chats.id, chatJoinRequests.chatId))
    .innerJoin(users, eq(users.id, chatJoinRequests.userId))
    .where(and(eq(chatJoinRequests.status, 'pending'), eq(chats.createdBy, adminId)))
    .orderBy(desc(chatJoinRequests.createdAt))
    .all();
  res.json({ requests: rows });
});

app.post('/api/join-requests/:id/approve', validateRequestId, (req: express.Request, res: express.Response) => {
  const adminId = requireAdmin(req, res);
  if (adminId == null) {
    return;
  }
  const id = Number(req.params.id);
  const row = db.select().from(chatJoinRequests).where(eq(chatJoinRequests.id, id)).get();
  if (!row || row.status !== 'pending') {
    res.status(404).json({ error: 'İstek yok' });
    return;
  }
  const chat = db.select().from(chats).where(eq(chats.id, row.chatId)).get();
  if (!chat || chat.createdBy !== adminId) {
    res.status(403).json({ error: 'Yetkisiz' });
    return;
  }
  const now = Date.now();
  db.update(chatJoinRequests)
    .set({ status: 'approved' })
    .where(eq(chatJoinRequests.id, id))
    .run();
  const existing = db
    .select()
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, row.chatId), eq(chatMembers.userId, row.userId)))
    .get();
  if (existing) {
    db.update(chatMembers)
      .set({ status: 'active', removedAt: null })
      .where(eq(chatMembers.id, existing.id))
      .run();
  } else {
    db.insert(chatMembers)
      .values({
        chatId: row.chatId,
        userId: row.userId,
        status: 'active',
        createdAt: now,
      })
      .run();
  }
  res.json({ ok: true });
  hub.broadcastEvent('chats:changed', { chatId: row.chatId });
  hub.broadcastToUser(row.userId, 'join-request:approved', {
    chatId: row.chatId,
    requestId: id,
  });
});

app.post('/api/join-requests/:id/reject', validateRequestId, (req: express.Request, res: express.Response) => {
  const adminId = requireAdmin(req, res);
  if (adminId == null) {
    return;
  }
  const id = Number(req.params.id);
  const row = db.select().from(chatJoinRequests).where(eq(chatJoinRequests.id, id)).get();
  if (!row || row.status !== 'pending') {
    res.status(404).json({ error: 'İstek yok' });
    return;
  }
  const chat = db.select().from(chats).where(eq(chats.id, row.chatId)).get();
  if (!chat || chat.createdBy !== adminId) {
    res.status(403).json({ error: 'Yetkisiz' });
    return;
  }
  db.update(chatJoinRequests)
    .set({ status: 'rejected' })
    .where(eq(chatJoinRequests.id, id))
    .run();
  res.json({ ok: true });
  hub.broadcastToUser(row.userId, 'join-request:rejected', {
    chatId: row.chatId,
    requestId: id,
  });
});

function assertActiveMember(chatId: number, userId: number): boolean {
  const m = db
    .select()
    .from(chatMembers)
    .where(
      and(
        eq(chatMembers.chatId, chatId),
        eq(chatMembers.userId, userId),
        eq(chatMembers.status, 'active'),
      ),
    )
    .get();
  return !!m && m.removedAt == null;
}

app.get('/api/chats/:chatId/roster', validateChatId, (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const chatId = Number(req.params.chatId);
  if (!Number.isFinite(chatId)) {
    res.status(400).json({ error: 'Geçersiz chat' });
    return;
  }
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat || chat.deletedAt != null) {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }
  if (!chat.isGroup || chat.chatType !== 'chat') {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }
  const isCreator = chat.createdBy === userId;
  const isMember = assertActiveMember(chatId, userId);
  if (!isCreator && !isMember) {
    res.status(403).json({ error: 'Bu grubu görüntüleyemezsiniz' });
    return;
  }

  const pendingRows = db
    .select({ userId: chatJoinRequests.userId })
    .from(chatJoinRequests)
    .where(and(eq(chatJoinRequests.chatId, chatId), eq(chatJoinRequests.status, 'pending')))
    .all();
  const pendingSet = new Set(pendingRows.map((r) => r.userId));

  const memberRows = db
    .select()
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.status, 'active')))
    .all();
  const activeMemberIds = memberRows.filter(m => m.removedAt == null).map(m => m.userId);
  const adminIds = memberRows.filter(m => m.removedAt == null && m.isAdmin).map(m => m.userId);
  const memberSet = new Set(activeMemberIds);
  const adminSet = new Set(adminIds);

  if (isCreator) {
    const rows = db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(isNull(users.deletedAt))
      .all();
    rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'tr'));
    res.json({
      users: rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        pendingJoin: pendingSet.has(u.id),
        isMember: memberSet.has(u.id),
        isAdmin: adminSet.has(u.id),
      })),
    });
    return;
  }

  const idSet = new Set<number>([...activeMemberIds, ...pendingSet]);
  if (idSet.size === 0) {
    res.json({ users: [] });
    return;
  }
  const rosterIds = Array.from(idSet);
  const rows = db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(inArray(users.id, rosterIds), isNull(users.deletedAt)))
    .all();
  rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'tr'));
  res.json({
    users: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      pendingJoin: pendingSet.has(u.id),
      isMember: memberSet.has(u.id),
      isAdmin: adminSet.has(u.id),
    })),
  });
});

app.get('/api/chats/:chatId/messages', validateChatId, validatePagination, (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const chatId = Number(req.params.chatId);
  const after = Number(req.query.after ?? 0);
  if (!assertActiveMember(chatId, userId)) {
    res.status(403).json({ error: 'Üye değilsiniz' });
    return;
  }
  const afterSeq = Number.isFinite(after) && after > 0 ? after : 0;
  const list = db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), gt(messages.seq, afterSeq)))
    .orderBy(messages.seq)
    .limit(200)
    .all();
  res.json({ messages: list });
});

app.post('/api/chats/:chatId/messages', validateSendMessage, (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const chatId = Number(req.params.chatId);
  const body = req.body as { content?: string; clientMsgId?: string };
  const rawContent = typeof body.content === 'string' ? body.content : '';
  const content = sanitizeMessage(rawContent); // Sanitize message content
  const clientMsgId =
    typeof body.clientMsgId === 'string' && body.clientMsgId.length > 0
      ? body.clientMsgId
      : null;
  if (!assertActiveMember(chatId, userId)) {
    res.status(403).json({ error: 'Üye değilsiniz' });
    return;
  }
  if (clientMsgId) {
    const dup = db.select().from(messages).where(eq(messages.clientMsgId, clientMsgId)).get();
    if (dup) {
      res.json({ message: dup, deduped: true });
      hub.broadcastAck(chatId, { deduped: true, clientMsgId });
      return;
    }
  }
  const now = Date.now();
  const result = db.transaction((tx) => {
    const last = tx
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.seq))
      .limit(1)
      .get();
    const nextSeq = last ? last.seq + 1 : 1;
    tx.insert(messages)
      .values({
        chatId,
        senderId: userId,
        content: content || null,
        clientMsgId,
        seq: nextSeq,
        createdAt: now,
      })
      .run();
    const ins = tx
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.seq))
      .limit(1)
      .get()!;
    return ins;
  });
  hub.broadcastChatMessage(chatId, result);
  res.json({ message: result });
});

// Message search API
app.get('/api/messages/search', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.json({ messages: [] });
    return;
  }
  const chatIdParam = req.query.chatId ? Number(req.query.chatId) : null;
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const memberRows = db
    .select({ chatId: chatMembers.chatId })
    .from(chatMembers)
    .where(
      and(
        eq(chatMembers.userId, userId),
        eq(chatMembers.status, 'active'),
        isNull(chatMembers.removedAt),
      ),
    )
    .all();
  const allowedChatIds = memberRows.map((r) => r.chatId);
  if (allowedChatIds.length === 0) {
    res.json({ messages: [] });
    return;
  }

  const pattern = `%${q}%`;
  let where = and(inArray(messages.chatId, allowedChatIds), like(messages.content, pattern));

  if (chatIdParam && Number.isFinite(chatIdParam)) {
    if (!allowedChatIds.includes(chatIdParam)) {
      res.json({ messages: [] });
      return;
    }
    where = and(eq(messages.chatId, chatIdParam), like(messages.content, pattern));
  }

  const rows = db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();

  res.json({ messages: rows });
});

// Group invitation APIs
app.post('/api/chats/:chatId/invite', validateChatId, (req: express.Request, res: express.Response) => {
  const inviterId = requireUser(req, res);
  if (inviterId == null) {
    return;
  }
  const chatId = Number(req.params.chatId);
  const body = req.body as { inviteeId?: number };
  const inviteeId = Number(body.inviteeId);
  if (!Number.isFinite(inviteeId) || inviteeId <= 0 || inviteeId === inviterId) {
    res.status(400).json({ error: 'Geçersiz davet edilen kullanıcı' });
    return;
  }

  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat || chat.deletedAt) {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }

  const member = db
    .select()
    .from(chatMembers)
    .where(
      and(
        eq(chatMembers.chatId, chatId),
        eq(chatMembers.userId, inviterId),
        eq(chatMembers.status, 'active'),
      ),
    )
    .get();
  const isAdmin = chat.createdBy === inviterId || !!member?.isAdmin;
  if (!isAdmin) {
    res.status(403).json({ error: 'Sadece yöneticiler davet gönderebilir' });
    return;
  }

  const existingMember = db
    .select()
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, inviteeId)))
    .get();
  if (existingMember && existingMember.status === 'active' && existingMember.removedAt == null) {
    res.status(400).json({ error: 'Kullanıcı zaten üye' });
    return;
  }

  const now = Date.now();
  const existingInvite = db
    .select()
    .from(groupInvitations)
    .where(
      and(
        eq(groupInvitations.chatId, chatId),
        eq(groupInvitations.inviteeId, inviteeId),
        eq(groupInvitations.status, 'pending'),
      ),
    )
    .get();
  if (existingInvite) {
    res.json({ invitation: existingInvite, duplicated: true });
    return;
  }

  db.insert(groupInvitations)
    .values({ chatId, inviterId, inviteeId, status: 'pending', createdAt: now })
    .run();
  const created = db
    .select()
    .from(groupInvitations)
    .orderBy(desc(groupInvitations.id))
    .limit(1)
    .get()!;
  res.json({ invitation: created });
});

app.get('/api/invitations', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }

  const rows = db
    .select({
      id: groupInvitations.id,
      chatId: groupInvitations.chatId,
      status: groupInvitations.status,
      createdAt: groupInvitations.createdAt,
      inviterId: groupInvitations.inviterId,
      chatName: chats.name,
      inviterName: users.name,
    })
    .from(groupInvitations)
    .innerJoin(chats, eq(chats.id, groupInvitations.chatId))
    .innerJoin(users, eq(users.id, groupInvitations.inviterId))
    .where(
      and(
        eq(groupInvitations.inviteeId, userId),
        eq(groupInvitations.status, 'pending'),
        isNull(chats.deletedAt),
      ),
    )
    .orderBy(desc(groupInvitations.createdAt))
    .all();

  res.json({ invitations: rows });
});

app.post('/api/invitations/:id/accept', validateRequestId, (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const id = Number(req.params.id);
  const inv = db.select().from(groupInvitations).where(eq(groupInvitations.id, id)).get();
  if (!inv || inv.status !== 'pending' || inv.inviteeId !== userId) {
    res.status(404).json({ error: 'Davet bulunamadı' });
    return;
  }
  const chat = db.select().from(chats).where(eq(chats.id, inv.chatId)).get();
  if (!chat || chat.deletedAt) {
    res.status(404).json({ error: 'Grup bulunamadı' });
    return;
  }

  const now = Date.now();
  db.transaction((tx) => {
    tx
      .update(groupInvitations)
      .set({ status: 'accepted', respondedAt: now })
      .where(eq(groupInvitations.id, id))
      .run();

    const existing = tx
      .select()
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, inv.chatId), eq(chatMembers.userId, userId)))
      .get();
    if (existing) {
      tx
        .update(chatMembers)
        .set({ status: 'active', removedAt: null })
        .where(eq(chatMembers.id, existing.id))
        .run();
    } else {
      tx
        .insert(chatMembers)
        .values({ chatId: inv.chatId, userId, status: 'active', createdAt: now })
        .run();
    }
  });

  res.json({ ok: true });
});

app.post('/api/invitations/:id/decline', validateRequestId, (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const id = Number(req.params.id);
  const inv = db.select().from(groupInvitations).where(eq(groupInvitations.id, id)).get();
  if (!inv || inv.status !== 'pending' || inv.inviteeId !== userId) {
    res.status(404).json({ error: 'Davet bulunamadı' });
    return;
  }

  const now = Date.now();
  db
    .update(groupInvitations)
    .set({ status: 'declined', respondedAt: now })
    .where(eq(groupInvitations.id, id))
    .run();

  res.json({ ok: true });
});

// Voice groups (SSE control plane + RTP media plane)
app.post('/api/voice-groups', (req: express.Request, res: express.Response) => {
  const adminId = requireAdmin(req, res);
  if (adminId == null) {
    return;
  }
  const body = req.body as { name?: string };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name gerekli' });
    return;
  }
  const now = Date.now();
  db.insert(voiceGroups).values({ name, createdBy: adminId, createdAt: now }).run();
  const row = db.select().from(voiceGroups).orderBy(desc(voiceGroups.id)).limit(1).get()!;
  db.insert(voiceSessions).values({
    voiceGroupId: row.id,
    activeSpeakerAdminId: null,
    pttMode: 'toggle',
    updatedAt: now,
  }).run();
  emitVoiceEvent('voice.group.created', { id: row.id, name: row.name, createdBy: row.createdBy });
  res.json({ group: row });
});

app.get('/api/voice-groups', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const rows = db
    .select({
      id: voiceGroups.id,
      name: voiceGroups.name,
      createdBy: voiceGroups.createdBy,
      createdAt: voiceGroups.createdAt,
      activeSpeakerAdminId: voiceSessions.activeSpeakerAdminId,
    })
    .from(voiceGroups)
    .leftJoin(voiceSessions, eq(voiceSessions.voiceGroupId, voiceGroups.id))
    .where(isNull(voiceGroups.deletedAt))
    .orderBy(desc(voiceGroups.id))
    .all();
  const groups = rows.map((r) => ({ ...r, ...voiceGroupMetrics(r.id) }));
  res.json({ groups });
});

app.delete('/api/voice-groups/:id', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const voiceGroupId = Number(req.params.id);
  if (!Number.isFinite(voiceGroupId)) {
    res.status(400).json({ error: 'Geçersiz voice group' });
    return;
  }
  const group = db.select().from(voiceGroups).where(eq(voiceGroups.id, voiceGroupId)).get();
  if (!group || group.deletedAt != null) {
    res.status(404).json({ error: 'Voice grup bulunamadı' });
    return;
  }
  if (group.createdBy !== userId) {
    res.status(403).json({ error: 'Bu grubu sadece oluşturan kişi silebilir' });
    return;
  }
  const now = Date.now();
  db.update(voiceGroups).set({ deletedAt: now }).where(eq(voiceGroups.id, voiceGroupId)).run();
  db.delete(voicePresence).where(eq(voicePresence.voiceGroupId, voiceGroupId)).run();
  db.delete(voiceSpeakerLocks).where(eq(voiceSpeakerLocks.voiceGroupId, voiceGroupId)).run();
  voiceEndpointRegistry.clearGroup(voiceGroupId);
  db.update(voiceSessions)
    .set({ activeSpeakerAdminId: null, updatedAt: now })
    .where(eq(voiceSessions.voiceGroupId, voiceGroupId))
    .run();
  emitVoiceEvent('voice.group.deleted', { voiceGroupId });
  res.json({ ok: true });
});

app.post('/api/voice-groups/:id/join', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const voiceGroupId = Number(req.params.id);
  if (!Number.isFinite(voiceGroupId)) {
    res.status(400).json({ error: 'Geçersiz voice group' });
    return;
  }
  const group = db.select().from(voiceGroups).where(eq(voiceGroups.id, voiceGroupId)).get();
  if (!group || group.deletedAt != null) {
    res.status(404).json({ error: 'Voice grup bulunamadı' });
    return;
  }
  const now = Date.now();
  const existing = db
    .select()
    .from(voicePresence)
    .where(and(eq(voicePresence.voiceGroupId, voiceGroupId), eq(voicePresence.userId, userId)))
    .get();
  const me = db.select().from(users).where(eq(users.id, userId)).get();
  const role = me?.role === 'admin' ? 'admin' : 'listener';
  if (existing) {
    db.update(voicePresence).set({ role, lastSeenAt: now }).where(eq(voicePresence.id, existing.id)).run();
  } else {
    db.insert(voicePresence)
      .values({ voiceGroupId, userId, role, joinedAt: now, lastSeenAt: now })
      .run();
  }
  const metrics = voiceGroupMetrics(voiceGroupId);
  emitVoiceEvent('voice.presence.changed', metrics);
  emitVoiceEvent('voice.group.metrics', metrics);
  res.json({ ok: true, ...metrics });
});

app.post('/api/voice-groups/:id/leave', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const voiceGroupId = Number(req.params.id);
  if (!Number.isFinite(voiceGroupId)) {
    res.status(400).json({ error: 'Geçersiz voice group' });
    return;
  }
  db.delete(voicePresence)
    .where(and(eq(voicePresence.voiceGroupId, voiceGroupId), eq(voicePresence.userId, userId)))
    .run();
  voiceEndpointRegistry.removeUser(voiceGroupId, userId);
  const lock = voiceLockService.current(voiceGroupId);
  if (lock && lock.lockedByAdminId === userId) {
    voiceLockService.release(voiceGroupId, userId);
    db.update(voiceSessions)
      .set({ activeSpeakerAdminId: null, updatedAt: Date.now() })
      .where(eq(voiceSessions.voiceGroupId, voiceGroupId))
      .run();
    emitVoiceEvent('voice.speaker.stopped', { voiceGroupId, userId });
  }
  const metrics = voiceGroupMetrics(voiceGroupId);
  emitVoiceEvent('voice.presence.changed', metrics);
  emitVoiceEvent('voice.group.metrics', metrics);
  res.json({ ok: true, ...metrics });
});

app.post('/api/voice-groups/:id/rtp/register', (req: express.Request, res: express.Response) => {
  const logRegister = (payload: Record<string, unknown>) => {
    if (process.env.VOICE_RTP_LOG_REGISTER === '1') {
      console.info('[voice:rtp:register]', payload);
    }
  };
  const userId = requireUser(req, res);
  if (userId == null) {
    logRegister({ ok: false, reason: 'unauthorized' });
    return;
  }
  const voiceGroupId = Number(req.params.id);
  if (!Number.isFinite(voiceGroupId)) {
    logRegister({ ok: false, reason: 'invalid_group', voiceGroupId: req.params.id, userId });
    res.status(400).json({ error: 'Geçersiz voice group' });
    return;
  }
  const body = req.body as { listenPort?: unknown; clientHost?: unknown } | undefined;
  const listenPort = Number(body?.listenPort);
  if (!Number.isFinite(listenPort) || listenPort <= 0 || listenPort > 65535) {
    logRegister({ ok: false, reason: 'invalid_listen_port', voiceGroupId, userId, listenPort: body?.listenPort });
    res.status(400).json({ error: 'Geçersiz dinleme portu' });
    return;
  }
  const inGroup = db
    .select({ userId: voicePresence.userId })
    .from(voicePresence)
    .where(and(eq(voicePresence.voiceGroupId, voiceGroupId), eq(voicePresence.userId, userId)))
    .get();
  if (!inGroup) {
    logRegister({ ok: false, reason: 'not_in_group', voiceGroupId, userId, listenPort });
    res.status(403).json({ error: 'Önce voice gruba katılmalısınız' });
    return;
  }
  const candidateHost = typeof body?.clientHost === 'string' && body.clientHost.trim() ? body.clientHost.trim() : '';
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);
  const applied = voiceEndpointRegistry.applyRegister(
    voiceGroupId,
    userId,
    listenPort,
    candidateHost,
    remoteAddress,
  );
  if (!applied) {
    logRegister({
      ok: false,
      reason: 'address_unresolved',
      voiceGroupId,
      userId,
      listenPort,
      candidateHost,
      remoteAddress,
    });
    res.status(400).json({ error: 'İstemci adresi çözümlenemedi' });
    return;
  }
  logRegister({
    ok: true,
    voiceGroupId,
    userId,
    address: applied.address,
    listenPort: applied.port,
    candidateHost,
    remoteAddress,
    resolvedBy: applied.resolvedBy,
  });
  res.json({
    ok: true,
    voiceGroupId,
    userId,
    address: applied.address,
    listenPort: applied.port,
    resolvedBy: applied.resolvedBy,
  });
});

app.post('/api/voice-groups/:id/ptt/toggle', (req: express.Request, res: express.Response) => {
  const adminId = requireAdmin(req, res);
  if (adminId == null) {
    return;
  }
  const voiceGroupId = Number(req.params.id);
  if (!Number.isFinite(voiceGroupId)) {
    res.status(400).json({ error: 'Geçersiz voice group' });
    return;
  }
  const group = db.select().from(voiceGroups).where(eq(voiceGroups.id, voiceGroupId)).get();
  if (!group || group.deletedAt != null) {
    res.status(404).json({ error: 'Voice grup bulunamadı' });
    return;
  }
  const lock = voiceLockService.current(voiceGroupId);
  if (!lock) {
    const acquired = voiceLockService.acquire(voiceGroupId, adminId);
    if (!acquired.ok) {
      emitVoiceEvent('voice.lock.denied', { voiceGroupId, adminId }, adminId);
      res.status(409).json({ error: 'lock_denied' });
      return;
    }
    db.update(voiceSessions)
      .set({ activeSpeakerAdminId: adminId, updatedAt: Date.now() })
      .where(eq(voiceSessions.voiceGroupId, voiceGroupId))
      .run();
    db.update(voicePresence)
      .set({ role: 'speaker', lastSeenAt: Date.now() })
      .where(and(eq(voicePresence.voiceGroupId, voiceGroupId), eq(voicePresence.userId, adminId)))
      .run();
    voiceEndpointRegistry.refreshFanout(voiceGroupId);
    emitVoiceEvent('voice.speaker.started', { voiceGroupId, adminId });
    res.json({ ok: true, speaking: true, rtp: voiceRtpServer.getPublicConfig(voiceGroupId) });
    return;
  }
  if (lock.lockedByAdminId === adminId) {
    voiceLockService.release(voiceGroupId, adminId);
    db.update(voiceSessions)
      .set({ activeSpeakerAdminId: null, updatedAt: Date.now() })
      .where(eq(voiceSessions.voiceGroupId, voiceGroupId))
      .run();
    db.update(voicePresence)
      .set({ role: 'admin', lastSeenAt: Date.now() })
      .where(and(eq(voicePresence.voiceGroupId, voiceGroupId), eq(voicePresence.userId, adminId)))
      .run();
    voiceEndpointRegistry.refreshFanout(voiceGroupId);
    emitVoiceEvent('voice.speaker.stopped', { voiceGroupId, adminId });
    res.json({ ok: true, speaking: false });
    return;
  }
  emitVoiceEvent('voice.lock.denied', { voiceGroupId, adminId, lockedByAdminId: lock.lockedByAdminId }, adminId);
  res.status(409).json({ error: 'lock_denied', lockedByAdminId: lock.lockedByAdminId });
});

app.get('/api/voice-groups/:id/state', (req: express.Request, res: express.Response) => {
  const userId = requireUser(req, res);
  if (userId == null) {
    return;
  }
  const voiceGroupId = Number(req.params.id);
  if (!Number.isFinite(voiceGroupId)) {
    res.status(400).json({ error: 'Geçersiz voice group' });
    return;
  }
  const session = db.select().from(voiceSessions).where(eq(voiceSessions.voiceGroupId, voiceGroupId)).get();
  const metrics = voiceGroupMetrics(voiceGroupId);
  res.json({
    activeSpeakerAdminId: session?.activeSpeakerAdminId ?? null,
    pttMode: session?.pttMode ?? 'toggle',
    ...metrics,
    rtp: voiceRtpServer.getPublicConfig(voiceGroupId),
  });
});

app.get('/api/voice/events', (req: express.Request, res: express.Response) => {
  let userId = bearerUserId(req);
  if (userId == null) {
    const qToken = typeof req.query.token === 'string' ? req.query.token : '';
    if (qToken) {
      const auth = verifyUserToken(qToken, JWT_SECRET);
      if (auth.ok) {
        userId = auth.userId;
      }
    }
  }
  if (userId == null) {
    res.status(401).json({ error: 'Yetkisiz' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, userId })}\n\n`);
  const client: VoiceSseClient = { userId, res };
  voiceSseClients.add(client);

  const keepAlive = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    } catch {
      // noop
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    voiceSseClients.delete(client);
  });
});

app.use('/api', (req: express.Request, res: express.Response) => {
  if (process.env.API_ROUTE_LOG_404 === '1') {
    console.warn('[api:404]', {
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
    });
  }
  res.status(404).json({ error: 'Route bulunamadı', method: req.method, path: req.originalUrl || req.url });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function parseJson(raw: RawData): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

wss.on('connection', (socket: WebSocket, req) => {
  const connectedAt = Date.now();
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const token = url.searchParams.get('token') ?? '';
  const auth = verifyUserToken(token, JWT_SECRET);
  if (!auth.ok) {
    socket.close(4001, 'auth');
    return;
  }
  const client: WsClient = { socket, userId: auth.userId, subs: new Set(), lastPing: Date.now() };
  hub.add(client);
  socket.send(JSON.stringify({ type: 'hello', userId: auth.userId }));

  socket.on('message', raw => {
    const msg = parseJson(raw) as { type?: string; chatId?: number; afterSeq?: number } | null;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (msg.type === 'chat:subscribe' && typeof msg.chatId === 'number') {
      if (assertActiveMember(msg.chatId, auth.userId)) {
        client.subs.add(msg.chatId);
        socket.send(JSON.stringify({ type: 'subscribed', chatId: msg.chatId }));
      }
    }
  });

  socket.on('close', (code, reasonBuffer) => {
    const elapsed = Date.now() - connectedAt;
    const reason = reasonBuffer?.toString() ?? '';
    console.log('[ws] closed', {
      userId: client.userId,
      subsCount: client.subs.size,
      closeCode: code,
      reason,
      durationMs: elapsed,
    });
    hub.remove(client);
  });

  socket.on('error', err => {
    console.warn('[ws] socket_error', {
      userId: client.userId,
      subsCount: client.subs.size,
      error: err.message,
    });
  });
});

let listenErrorHandled = false;
function onHttpListenError(err: NodeJS.ErrnoException) {
  if (listenErrorHandled) {
    return;
  }
  listenErrorHandled = true;
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[http] PORT ${PORT} (env PORT) already in use — another radio server or app is listening. ` +
        `Stop the other process or set PORT to a free port.`,
    );
    logTcpListenersForPort(PORT);
  } else {
    console.error('[http] HTTP listen error:', err);
  }
  process.exit(1);
}

httpServer.once('error', onHttpListenError);
wss.once('error', onHttpListenError);

httpServer.listen(PORT, HTTP_LISTEN_HOST, () => {
  console.log(
    `Radio server http://${HTTP_LISTEN_HOST}:${PORT}  ws /ws  pid=${process.pid}`,
  );
  if (MDNS_HTTP_BASE) {
    console.log(`[boot] mDNS: ${MDNS_HTTP_BASE}  health ${MDNS_HTTP_BASE}/health`);
  }
  console.log(`[boot] main=${MAIN_MODULE_PATH} cwd=${process.cwd()}`);
});
