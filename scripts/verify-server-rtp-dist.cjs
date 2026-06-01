/**
 * Production sunucusu `npm start` → node dist/index.js kullandığı için
 * `rtp/register` route'u yalnızca `npm run build` sonrası dist'e girer.
 * Bu betik server/dist/index.js içinde string arar; önce `npm run server:build` çalıştırın.
 */

const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist', 'index.js');

if (!fs.existsSync(dist)) {
  console.error('[server:verify-rtp-dist] server/dist/index.js bulunamadı.');
  console.error('  Çalıştırın: npm run server:build   (veya cd server && npm run build)');
  process.exit(1);
}

const s = fs.readFileSync(dist, 'utf8');
if (!s.includes('rtp/register')) {
  console.error('[server:verify-rtp-dist] dist/index.js içinde "rtp/register" yok; build eksik veya hatalı.');
  process.exit(1);
}

console.log('[server:verify-rtp-dist] OK — dist/index.js rtp/register route içeriyor.');
