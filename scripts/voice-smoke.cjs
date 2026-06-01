#!/usr/bin/env node
/**
 * Ses API duman testi: health, voice-groups (admin token gerekir).
 * Kullanım:
 *   export BASE_URL=http://127.0.0.1:8080
 *   export ADMIN_TOKEN=...
 *   node scripts/voice-smoke.cjs
 *
 * RN fiziksel cihaz veya emülatör; API tabanı aynı BASE_URL olmalı.
 */
const base = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const token = process.env.ADMIN_TOKEN || '';

async function j(path, opts = {}) {
  const url = `${base}${path}`;
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, { ...opts, headers });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: r.ok, status: r.status, data };
}

async function main() {
  console.log('BASE_URL', base);

  const h = await j('/health');
  console.log('GET /health', h.status, h.data?.ok === true ? 'ok' : h.data);

  if (!token) {
    console.warn('ADMIN_TOKEN yok; voice API adımları atlanır.');
    process.exit(h.ok ? 0 : 1);
  }

  const name = `smoke-${Date.now()}`;
  const create = await j('/api/voice-groups', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  console.log('POST /api/voice-groups', create.status, create.data);
  const gid = create.data?.id;
  if (!create.ok || typeof gid !== 'number') {
    process.exit(1);
  }

  const join = await j(`/api/voice-groups/${gid}/join`, { method: 'POST' });
  console.log('POST .../join', join.status, join.data);

  const state = await j(`/api/voice-groups/${gid}/state`);
  console.log('GET .../state', state.status, state.data);
  const udpPort = state.data?.rtp?.udpPort;

  const reg = await j(`/api/voice-groups/${gid}/rtp/register`, {
    method: 'POST',
    body: JSON.stringify({ listenPort: 45000, clientHost: '127.0.0.1' }),
  });
  console.log('POST .../rtp/register', reg.status, reg.data);

  process.exit(join.ok && state.ok && reg.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
