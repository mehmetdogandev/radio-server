import { execFileSync } from 'node:child_process';
import os from 'node:os';

function isWindows(): boolean {
  return os.platform() === 'win32';
}

/** Windows `netstat -ano` satırlarında `:port` geçen TCP/UDP kayıtları (ss yokken). */
function windowsNetstatLinesForPort(port: number): string[] {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    const portRe = new RegExp(`:${port}(\\s|$)`);
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => portRe.test(l) && (l.startsWith('TCP') || l.startsWith('UDP')));
  } catch {
    return [];
  }
}

function logSsTcp(port: number): void {
  try {
    const out = execFileSync('ss', ['-tlnp'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const portRe = new RegExp(`:${port}(\\s|$)`);
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => portRe.test(l));
    if (lines.length > 0) {
      console.error(`[http] TCP listeners mentioning port ${port}:\n${lines.join('\n')}`);
    } else {
      console.error(`[http] ss -tlnp shows no row for :${port} (IPv6-only or race; try: ss -tlnp | grep ${port})`);
    }
  } catch (e) {
    console.error('[http] Could not run ss -tlnp:', (e as Error).message);
  }
}

function logSsUdp(port: number): void {
  try {
    const out = execFileSync('ss', ['-ulnp'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const portRe = new RegExp(`:${port}(\\s|$)`);
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => portRe.test(l));
    if (lines.length > 0) {
      console.error(`[voice] Current UDP listeners mentioning port ${port}:\n${lines.join('\n')}`);
    } else {
      console.error(
        `[voice] ss shows no matching UDP socket for ${port} (race or IPv6-only bind elsewhere; try: ss -ulnp | grep ${port})`,
      );
    }
  } catch (e) {
    console.error('[voice] Could not run ss -ulnp:', (e as Error).message);
  }
}

export function logTcpListenersForPort(port: number): void {
  if (isWindows()) {
    const lines = windowsNetstatLinesForPort(port);
    if (lines.length > 0) {
      console.error(`[http] Port ${port} — netstat -ano eşleşmeleri:\n${lines.join('\n')}`);
    } else {
      console.error(`[http] Port ${port}: netstat eşleşmesi yok (deneyin: netstat -ano | findstr ":${port}")`);
    }
    console.error(
      `[http] Windows: eski süreci kapatın — taskkill /PID <son_sütundaki_pid> /F   veya   Get-NetTCPConnection -LocalPort ${port}`,
    );
    return;
  }
  logSsTcp(port);
}

export function logUdpListenersForPort(port: number): void {
  if (isWindows()) {
    const lines = windowsNetstatLinesForPort(port);
    if (lines.length > 0) {
      console.error(`[voice] Port ${port} — netstat-ano eşleşmeleri:\n${lines.join('\n')}`);
    } else {
      console.error(`[voice] Port ${port}: netstat eşleşmesi yok`);
    }
    console.error(
      `[voice] Windows: taskkill /PID <son_sütundaki_pid> /F   veya   Get-NetUDPEndpoint -LocalPort ${port}`,
    );
    return;
  }
  logSsUdp(port);
}
