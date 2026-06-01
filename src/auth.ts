import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;

export function signUserToken(userId: number, secret: string): string {
  return jwt.sign({ sub: String(userId) }, secret, { expiresIn: '30d' });
}

export function verifyUserToken(
  token: string,
  secret: string,
): { ok: true; userId: number } | { ok: false; error: string } {
  try {
    const p = jwt.verify(token, secret) as { sub?: string };
    const id = Number(p.sub);
    if (!Number.isFinite(id) || id < 1) {
      return { ok: false, error: 'invalid' };
    }
    return { ok: true, userId: id };
  } catch {
    return { ok: false, error: 'invalid' };
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
