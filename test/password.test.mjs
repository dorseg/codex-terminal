import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { hashPassword, parsePasswordHash, verifyPassword } from '../app/password.mjs';
import { credentials } from '../app/auth.mjs';

test('scrypt uses fresh salts and verifies exact passwords including Unicode', async () => {
  const password = ' pass: 🔐 + שלום ';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  const parsed = parsePasswordHash(first);
  assert.throws(() => parsePasswordHash(first + '\n'), /Invalid AUTH_PASSWORD_HASH/);
  assert.equal(parsed.salt.length, 16);
  assert.equal(parsed.hash.length, 32);
  assert.equal(await verifyPassword(password, parsed), true);
  assert.equal(await verifyPassword(password.trim(), parsed), false);
  assert.equal(await verifyPassword('wrong', parsed), false);
  assert.equal(await verifyPassword(first, parsed), false);
  await assert.rejects(hashPassword(''), /must not be empty/);
});

test('invalid algorithms, excessive parameters and malformed encodings fail startup safely', () => {
  for (const value of ['', 'plaintext', 'sha256$123', 'scrypt$1048576$8$3$' + 'a'.repeat(32) + '$' + 'b'.repeat(64),
    'scrypt$32768$8$3$short$short', 'scrypt$32768$8$3$' + 'g'.repeat(32) + '$' + 'b'.repeat(64)]) {
    assert.throws(() => parsePasswordHash(value), /Invalid AUTH_PASSWORD_HASH/);
    if (value) assert.throws(() => credentials({ AUTH_USERNAME: 'alice', AUTH_PASSWORD_HASH: value }), /Invalid AUTH_PASSWORD_HASH/);
  }
  assert.throws(() => credentials({ AUTH_PASSWORD: 'old-secret' }), /no longer supported/);
});

test('hash generator refuses noninteractive input and password arguments without echoing them', async () => {
  const child = spawn(process.execPath, ['app/hash-password.mjs', 'test-secret'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end('test-secret\n');
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(output, /interactively/);
  assert.ok(!output.includes('test-secret'));
});
