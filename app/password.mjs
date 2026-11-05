import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
// OWASP's 32 MiB scrypt configuration. Keep parameters fixed to bound login cost.
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const PREFIX = 'scrypt$32768$8$3$';

export function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string' || encoded.length !== PREFIX.length + 97 ||
      !/^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(encoded)) {
    throw new Error('Invalid AUTH_PASSWORD_HASH. Generate it with the hash-password command.');
  }
  const parts = encoded.split('$');
  return { salt: Buffer.from(parts[4], 'hex'), hash: Buffer.from(parts[5], 'hex') };
}

export async function hashPassword(password) {
  if (!password) throw new Error('Password must not be empty.');
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 32, OPTIONS);
  return `${PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, parsed) {
  const actual = await derive(password, parsed.salt, parsed.hash.length, OPTIONS);
  return timingSafeEqual(actual, parsed.hash);
}
