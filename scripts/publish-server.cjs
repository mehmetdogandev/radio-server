#!/usr/bin/env node
/**
 * Sunucuyu derler ve SSH ile Raspberry Pi'ye gönderir.
 * Değişkenler: server/.env veya kök .env içinde
 *   DEPLOY_SSH_TARGET=mdkare@host
 *   DEPLOY_REMOTE_PATH=/home/mdkare/radio-server
 *   DEPLOY_REMOTE_COMMAND=cd /path && npm ci --omit=dev && sudo systemctl restart radio-server
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile(p) {
  if (!fs.existsSync(p)) {
    return;
  }
  const txt = fs.readFileSync(p, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) {
      continue;
    }
    let v = m[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = v;
    }
  }
}

const serverDir = path.join(__dirname, '..');
loadEnvFile(path.join(serverDir, '.env'));

const target = process.env.DEPLOY_SSH_TARGET;
const remotePath = process.env.DEPLOY_REMOTE_PATH;
const remoteCmd = process.env.DEPLOY_REMOTE_COMMAND;

if (!target || !remotePath) {
  console.error('DEPLOY_SSH_TARGET ve DEPLOY_REMOTE_PATH tanımlayın (server/.env).');
  process.exit(1);
}

console.log('Building server...');
execSync('npm run build', { cwd: serverDir, stdio: 'inherit' });

const sshBase = ['ssh', target];
const rsyncSrc = serverDir + '/';
const rsyncDest = `${target}:${remotePath}/`;

console.log('rsync →', rsyncDest);
execSync(
  [
    'rsync',
    '-az',
    '--delete',
    '--exclude',
    'node_modules',
    '--exclude',
    '.env',
    '--exclude',
    'data',
    rsyncSrc,
    rsyncDest,
  ].join(' '),
  { stdio: 'inherit' },
);

if (remoteCmd) {
  console.log('Remote:', remoteCmd);
  execSync([...sshBase, remoteCmd].join(' '), { stdio: 'inherit' });
} else {
  console.log('DEPLOY_REMOTE_COMMAND tanımlı değil; yalnızca dosyalar kopyalandı.');
}

console.log('Done.');
