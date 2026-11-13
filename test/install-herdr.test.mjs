import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installHerdr } from '../scripts/install-herdr.mjs';

const api = 'https://api.github.com/repos/herdrdev/herdr/releases/latest';
const download = 'https://github.com/herdrdev/herdr/releases/download/v1.0.0/herdr';
const binary = Buffer.from('fixture Herdr binary');
const digest = `sha256:${createHash('sha256').update(binary).digest('hex')}`;
const release = (architecture, checksum = digest) => ({
  tag_name: 'v1.0.0', draft: false, prerelease: false,
  assets: [{ name: `herdr-linux-${architecture}`, digest: checksum, browser_download_url: download }],
});
async function destination(t) {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'herdr');
}

for (const [target, architecture] of [['amd64', 'x86_64'], ['arm64', 'aarch64']]) {
  test(`Herdr ${target} authenticates only the API and verifies the downloaded binary`, async t => {
    const path = await destination(t);
    const calls = [];
    await installHerdr(target, { token: 'fixture-token', destination: path, fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers });
      return url === api ? Response.json(release(architecture)) : new Response(binary);
    } });
    assert.deepEqual(calls, [
      { url: api, headers: { authorization: 'Bearer fixture-token' } },
      { url: download, headers: {} },
    ]);
    assert.deepEqual(await readFile(path), binary);
    assert.equal((await stat(path)).mode & 0o777, 0o755);
  });
}

test('Herdr local builds still work without a token', async t => {
  const path = await destination(t);
  await installHerdr('amd64', { token: '', destination: path, fetchImpl: async (url, options) => {
    assert.deepEqual(options.headers, {});
    return url === api ? Response.json(release('x86_64')) : new Response(binary);
  } });
  assert.deepEqual(await readFile(path), binary);
});

for (const checksum of [undefined, `sha256:${'0'.repeat(64)}`]) {
  test(`Herdr refuses a ${checksum ? 'mismatched' : 'missing'} checksum without installing a binary`, async t => {
    const path = await destination(t);
    const metadata = release('x86_64');
    metadata.assets[0].digest = checksum;
    await assert.rejects(installHerdr('amd64', { token: '', destination: path, fetchImpl: async url =>
      url === api ? Response.json(metadata) : new Response(binary),
    }), /checksum/i);
    await assert.rejects(stat(path), { code: 'ENOENT' });
  });
}

test('Herdr reports exhausted API rate limits without exposing the token', async t => {
  const path = await destination(t);
  await assert.rejects(installHerdr('amd64', { token: 'private-fixture-token', destination: path,
    fetchImpl: async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
  }), error => {
    assert.match(error.message, /403.*rate limit exhausted/);
    assert.doesNotMatch(error.message, /private-fixture-token/);
    return true;
  });
  await assert.rejects(stat(path), { code: 'ENOENT' });
});
