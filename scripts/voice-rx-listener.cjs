#!/usr/bin/env node

const dgram = require('node:dgram');

function usage() {
  console.log(`
Dead-simple voice RX listener (logs volume level from incoming UDP packets).

Usage:
  npm run voice:listen -- --base-url http://<server-ip>:3000 --group-id <id> --token <jwt>

Or with credentials (email normal RFC biçiminde olmalı, örn. test@example.com — test@local çoğu sunucuda reddedilir):
  npm run voice:listen -- --base-url http://<server-ip>:3000 --group-id <id> --email <email> --password <password> [--name <name>] [--role user|admin]

Options:
  --base-url <url>           Required. API base URL (e.g. http://192.168.1.50:3000)
  --group-id <number>        Required. Voice group id to join/listen
  --token <jwt>              Existing bearer token (preferred)
  --email <email>            Login/register email via /api/users/sync
  --password <password>      Login/register password via /api/users/sync
  --name <name>              Display name for /api/users/sync (default: email)
  --role <user|admin>        Role for /api/users/sync (default: user)
  --client-host <ip>         Optional explicit RTP callback host for register endpoint
  --bind-host <ip>           UDP bind host (default: 0.0.0.0)
  --bind-port <number>       UDP bind port (default: 0 = random)
  --threshold <0..1>         ACTIVE threshold (default: 0.04)
  --log-interval-ms <num>    Min interval per sender log (default: 450)
  --stats-interval-ms <num>  Stats print interval (default: 5000)
  --help                     Show this help
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq > 2) {
      out[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toFloat(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function errorMessage(status, data, fallback) {
  if (data && typeof data === 'object' && typeof data.error === 'string') {
    let msg = `[${status}] ${data.error}`;
    if (Array.isArray(data.details) && data.details.length > 0) {
      msg += ` — ${JSON.stringify(data.details)}`;
    }
    return msg;
  }
  return `[${status}] ${fallback}`;
}

async function fetchJson(url, init = {}, fallbackError = 'Request failed') {
  const res = await fetch(url, init);
  const raw = await res.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }
  if (!res.ok) {
    throw new Error(errorMessage(res.status, data, fallbackError));
  }
  return data;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function rmsLevelPcm16Le(buf) {
  if (!buf || buf.length < 2) return 0;
  let sumSq = 0;
  let samples = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i) / 32768;
    sumSq += sample * sample;
    samples += 1;
  }
  if (samples === 0) return 0;
  return Math.max(0, Math.min(1, Math.sqrt(sumSq / samples)));
}

function levelBars(level) {
  const blocks = Math.max(0, Math.min(10, Math.round(level * 10)));
  return `${'#'.repeat(blocks).padEnd(10, '.')}`;
}

async function bindUdp(socket, port, host) {
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      socket.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      socket.off('error', onError);
      resolve();
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port, host);
  });
}

async function loginWithCredentials(baseUrl, email, password, name, role) {
  const payload = {
    name: name || email,
    email,
    password,
    role: role || 'user',
  };
  const data = await fetchJson(
    joinUrl(baseUrl, '/api/users/sync'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'Login failed',
  );
  if (!data || typeof data.token !== 'string') {
    throw new Error('Login succeeded but token missing in response');
  }
  return data.token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true') {
    usage();
    return;
  }

  const baseUrl = args['base-url'];
  const groupId = toInt(args['group-id'], NaN);
  const bindHost = args['bind-host'] || '0.0.0.0';
  const bindPort = toInt(args['bind-port'], 0);
  const threshold = Math.max(0, Math.min(1, toFloat(args.threshold, 0.04)));
  const logIntervalMs = Math.max(80, toInt(args['log-interval-ms'], 450));
  const statsIntervalMs = Math.max(1000, toInt(args['stats-interval-ms'], 5000));

  if (!baseUrl || !Number.isFinite(groupId) || groupId <= 0) {
    usage();
    throw new Error('Missing required args: --base-url and --group-id');
  }

  let token = args.token;
  if (!token) {
    const email = args.email;
    const password = args.password;
    if (!email || !password) {
      usage();
      throw new Error('Provide --token, or provide --email + --password');
    }
    token = await loginWithCredentials(baseUrl, email, password, args.name, args.role || 'user');
  }

  await fetchJson(
    joinUrl(baseUrl, `/api/voice-groups/${groupId}/join`),
    {
      method: 'POST',
      headers: authHeaders(token),
    },
    'Join voice group failed',
  );

  const state = await fetchJson(
    joinUrl(baseUrl, `/api/voice-groups/${groupId}/state`),
    {
      method: 'GET',
      headers: authHeaders(token),
    },
    'Fetch voice state failed',
  );

  const udpPort = Number(state?.rtp?.udpPort);
  if (!Number.isFinite(udpPort) || udpPort <= 0) {
    throw new Error('Voice state does not include a valid rtp.udpPort');
  }

  const socket = dgram.createSocket('udp4');
  let listenPort;
  try {
    await bindUdp(socket, bindPort, bindHost);
    const addr = socket.address();
    listenPort = typeof addr === 'object' ? addr.port : bindPort;

    const registerBody = { listenPort };
    if (typeof args['client-host'] === 'string' && args['client-host'].trim()) {
      registerBody.clientHost = args['client-host'].trim();
    }

    await fetchJson(
      joinUrl(baseUrl, `/api/voice-groups/${groupId}/rtp/register`),
      {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(registerBody),
      },
      'Register RTP target failed',
    );
  } catch (e) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    throw e;
  }

  console.log(`[voice-listener] ready: group=${groupId} local=${bindHost}:${listenPort} serverRtpPort=${udpPort}`);

  /** Son [rx] log zamanı (seviye göstergesi); istatistikte activeSenders için kullanılmaz. */
  const perSender = new Map();
  /** Her pakette güncellenir — sessiz karelerde stats.activeSenders yanlışlıkla 0 olmasın. */
  const lastRxAtBySender = new Map();
  const seqBySender = new Map();
  let packets = 0;
  let bytes = 0;
  let dropped = 0;
  let outOfOrder = 0;
  let lastPackets = 0;
  let lastBytes = 0;
  let lastStatsAt = Date.now();

  socket.on('message', msg => {
    if (!Buffer.isBuffer(msg) || msg.length < 20) {
      return;
    }
    const voiceGroupId = msg.readUInt32BE(0);
    const senderAdminId = msg.readUInt32BE(4);
    const seq = msg.readUInt32BE(8);
    const payload = msg.subarray(20);
    if (voiceGroupId !== groupId) {
      return;
    }

    const key = `${voiceGroupId}:${senderAdminId}`;
    const prevSeq = seqBySender.get(key);
    if (typeof prevSeq === 'number') {
      if (seq < prevSeq) {
        outOfOrder += 1;
      } else if (seq > prevSeq + 1) {
        dropped += seq - prevSeq - 1;
      }
    }
    seqBySender.set(key, seq);

    packets += 1;
    bytes += payload.length;
    const now = Date.now();
    lastRxAtBySender.set(key, now);
    const level = rmsLevelPcm16Le(payload);
    const bucket = Math.max(0, Math.min(10, Math.round(level * 10)));
    const last = perSender.get(key);
    const shouldLog = !last || now - last.ts >= logIntervalMs || Math.abs(last.bucket - bucket) >= 2;
    if (shouldLog) {
      perSender.set(key, { ts: now, bucket });
      const indicator = level >= threshold ? 'ACTIVE' : 'silent';
      console.log(
        `[rx] sender=${senderAdminId} seq=${seq} level=${Math.round(level * 100)}% ${indicator} [${levelBars(level)}]`,
      );
    }
  });

  socket.on('error', err => {
    console.error(`[voice-listener] UDP error: ${err.message}`);
  });

  const statsTimer = setInterval(() => {
    const now = Date.now();
    const dtSec = Math.max(0.001, (now - lastStatsAt) / 1000);
    const deltaPackets = packets - lastPackets;
    const deltaBytes = bytes - lastBytes;
    const pps = (deltaPackets / dtSec).toFixed(1);
    const kbps = ((deltaBytes * 8) / dtSec / 1000).toFixed(1);
    const activeSenders = Array.from(lastRxAtBySender.entries()).filter(([, t]) => now - t < 2500).length;
    console.log(
      `[stats] pps=${pps} kbps=${kbps} packets=${packets} dropped=${dropped} outOfOrder=${outOfOrder} activeSenders=${activeSenders}`,
    );
    lastPackets = packets;
    lastBytes = bytes;
    lastStatsAt = now;
  }, statsIntervalMs);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(statsTimer);
    console.log(`\n[voice-listener] ${signal}: leaving group and closing UDP socket...`);
    try {
      await fetchJson(
        joinUrl(baseUrl, `/api/voice-groups/${groupId}/leave`),
        { method: 'POST', headers: authHeaders(token) },
        'Leave voice group failed',
      );
    } catch (err) {
      console.error(`[voice-listener] leave failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      socket.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch(err => {
  console.error(`[voice-listener] ${err instanceof Error ? err.message : String(err)}`);
  setImmediate(() => {
    process.exitCode = 1;
    process.exit(1);
  });
});

