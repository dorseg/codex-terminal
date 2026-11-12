import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuthServer } from '../app/auth.mjs';
import { hashPassword } from '../app/password.mjs';
import { IMAGE_LIMIT, saveImage, listImages, deleteImages } from '../app/images.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWWQAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const webp = Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-images-'));
  const directory = join(root, 'uploads');
  const server = createAuthServer({ imageDirectory: directory, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.shutdown(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = (body = png, headers = {}, extra = {}) => fetch(base + '/api/terminal/images', {
    method: 'POST', body, ...extra, headers: { origin: base, 'content-type': 'image/png', ...headers }, redirect: 'manual',
  });
  return { root, directory, server, base, upload };
}
for (const auth of [false, true]) test(`image uploads enforce origin, formats, names and optional auth (${auth})`, async t => {
  let time = 0;
  const f = await fixture(t, auth ? { username: 'test', passwordHash: await hashPassword('secret'), now: () => time, sessionMs: 10 } : {});
  let headers = {};
  if (auth) {
    let response = await f.upload();
    assert.equal(response.status, 401); assert.match((await response.json()).error, /expired/);
    const login = await fetch(f.base + '/login', { method: 'POST', body: new URLSearchParams({ username: 'test', password: 'secret' }), redirect: 'manual' });
    headers.cookie = login.headers.get('set-cookie').split(';')[0];
  }
  for (const origin of ['', 'null', 'https://other.example', 'ftp://' + new URL(f.base).host, f.base + '/path']) {
    const response = await f.upload(png, { ...headers, origin });
    assert.equal(response.status, 403); assert.match((await response.json()).error, /Origin/);
  }
  const noOrigin = await fetch(f.base + '/api/terminal/images', { method: 'POST', headers, body: png });
  assert.equal(noOrigin.status, 403);
  assert.equal((await f.upload(null, headers, { method: 'PUT' })).status, 405);
  const saved = [];
  for (const [body, mimeType, extension] of [[png, 'image/png', 'png'], [jpeg, 'image/jpeg', 'jpg'], [webp, 'image/webp', 'webp']]) {
    const response = await f.upload(body, { ...headers, 'content-type': mimeType, 'content-disposition': 'attachment; filename="../../escape.png"' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.mimeType, mimeType); assert.equal(result.size, body.length);
    assert.match(result.path, new RegExp('^' + f.directory + '/[a-f0-9-]+\\.' + extension + '$'));
    assert.deepEqual(await readFile(result.path), body); assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    saved.push(result.path);
  }
  assert.equal(new Set(saved).size, 3);
  for (const [body, type] of [[png, 'image/jpeg'], [jpeg, 'image/png'], [webp, 'image/png'], [Buffer.alloc(0), 'image/png'], [Buffer.from('not image'), 'image/png'], [Buffer.from(webp.map(byte => byte | 128)), 'image/webp'], [png, 'image/heic'], [png, 'application/octet-stream']]) {
    const response = await f.upload(body, { ...headers, 'content-type': type });
    assert.equal(response.status, 415); assert.ok((await response.json()).error);
  }
  assert.equal((await readdir(f.directory)).length, 3, 'rejected uploads leave no files');
  if (auth) {
    time = 11;
    const response = await f.upload(png, headers);
    assert.equal(response.status, 401); assert.match((await response.json()).error, /expired/);
  }
});

test('image upload enforces 10 MiB with and without Content-Length', async t => {
  const f = await fixture(t);
  const maximum = Buffer.alloc(IMAGE_LIMIT); png.copy(maximum);
  assert.equal((await f.upload(maximum)).status, 201);
  const response = await f.upload(Buffer.concat([maximum, Buffer.from([0])]));
  assert.equal(response.status, 413); assert.match((await response.json()).error, /10 MiB/);
  const chunked = await new Promise((resolve, reject) => {
    const request = http.request(f.base + '/api/terminal/images', { method: 'POST', headers: { origin: f.base, 'content-type': 'image/png' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject);
    request.write(maximum); request.end(Buffer.from([0]));
  });
  assert.equal(chunked.status, 413); assert.match(chunked.body.error, /10 MiB/);
  assert.equal((await readdir(f.directory)).length, 1);
});

test('interrupted upload retains no partial file and gateway stays healthy', async t => {
  const f = await fixture(t);
  await new Promise(resolve => {
    const request = http.request(f.base + '/api/terminal/images', { method: 'POST', headers: { origin: f.base, 'content-type': 'image/png', 'content-length': png.length + 100 } });
    request.on('error', () => resolve());
    request.write(png, () => setTimeout(() => request.destroy(Error('cancelled')), 20));
  });
  assert.equal((await f.upload()).status, 201);
  assert.equal((await readdir(f.directory)).length, 1);
});

test('storage errors and symlinks in any directory component fail safely', async t => {
  const f = await fixture(t);
  await writeFile(f.directory, 'not a directory');
  let response = await f.upload();
  assert.equal(response.status, 503); assert.match((await response.json()).error, /storage/);
  await rm(f.directory);
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, f.directory);
  assert.equal((await f.upload()).status, 503);
  assert.deepEqual(await readdir(outside), []);
  const req = Readable.from([png]); req.headers = { 'content-type': 'image/png' };
  await assert.rejects(saveImage(req, { directory: join(f.directory, 'nested') }), /storage/);
  assert.deepEqual(await readdir(outside), []);
});

test('disconnect during storage removes the exclusively created file', async t => {
  const f = await fixture(t);
  const req = Readable.from([png]); req.headers = { 'content-type': 'image/png' };
  let checks = 0;
  await assert.rejects(saveImage(req, { directory: f.directory, disconnected: () => ++checks === 2 }), /storage/);
  assert.deepEqual(await readdir(f.directory), []);
});

test('completed uploads survive gateway recreation with the same workspace directory', async t => {
  const f = await fixture(t);
  const response = await f.upload();
  const saved = await response.json();
  f.server.shutdown();
  const replacement = createAuthServer({ imageDirectory: f.directory });
  await new Promise(resolve => replacement.listen(0, '127.0.0.1', resolve));
  t.after(() => replacement.shutdown());
  const base = `http://127.0.0.1:${replacement.address().port}`;
  assert.deepEqual(await readFile(saved.path), png);
  // Stored files have no public image-serving route.
  assert.ok([404, 502].includes((await fetch(base + saved.path)).status));
  const next = await fetch(base + '/api/terminal/images', { method: 'POST', headers: { origin: base, 'content-type': 'image/png' }, body: png });
  assert.equal(next.status, 201);
  assert.notEqual((await next.json()).path, saved.path);
  assert.deepEqual(await readFile(saved.path), png);
});


for (const auth of [false, true]) test(`saved images can be listed and deleted individually or together (auth=${auth})`, async t => {
  let time = 0;
  const f = await fixture(t, auth ? { username: 'test', passwordHash: await hashPassword('secret'), now: () => time, sessionMs: 10 } : {});
  let cookie = '';
  if (auth) {
    const login = await fetch(f.base + '/login', { method: 'POST', body: new URLSearchParams({ username: 'test', password: 'secret' }), redirect: 'manual' });
    cookie = login.headers.get('set-cookie').split(';')[0];
  }
  const request = (suffix = '', method = 'GET', headers = {}) => fetch(f.base + '/api/terminal/images' + suffix, { method, headers: { cookie, ...(method === 'DELETE' ? { origin: f.base } : {}), ...headers } });
  assert.deepEqual(await (await request()).json(), { images: [] });
  assert.deepEqual(await (await request('', 'DELETE')).json(), { deleted: 0 });
  const first = await (await f.upload(png, { cookie })).json();
  const second = await (await f.upload(png, { cookie })).json();
  const suffix = '/' + first.path.split('/').pop();
  const images = (await (await request()).json()).images;
  assert.deepEqual(new Set(images.map(image => image.path)), new Set([first.path, second.path]));
  assert.equal(images[0].mimeType, 'image/png'); assert.equal(images[0].size, png.length);
  for (const origin of ['', 'https://foreign.example']) {
    assert.equal((await request(suffix, 'DELETE', { origin })).status, 403);
    assert.equal((await request('', 'DELETE', { origin })).status, 403);
  }
  if (auth) {
    assert.equal((await request('', 'GET', { cookie: '' })).status, 401);
    assert.equal((await request(suffix, 'DELETE', { cookie: '' })).status, 401);
  }
  assert.equal((await request('/%2e%2e%2foutside.png', 'DELETE')).status, 400);
  assert.deepEqual(await (await request(suffix, 'DELETE')).json(), { deleted: 1 });
  await assert.rejects(readFile(first.path), { code: 'ENOENT' });
  assert.deepEqual(await readFile(second.path), png);
  assert.equal((await request(suffix, 'DELETE')).status, 404);
  assert.deepEqual(await (await request('', 'DELETE')).json(), { deleted: 1 });
  assert.deepEqual(await (await request()).json(), { images: [] });
  if (auth) {
    time = 11;
    assert.equal((await request('', 'GET')).status, 401);
    assert.equal((await request('', 'DELETE')).status, 401);
  }
});

test('cleanup only removes generated regular files and cannot follow symlinks', async t => {
  const f = await fixture(t);
  await f.upload();
  const outside = join(f.root, 'outside.png'); await writeFile(outside, 'preserve');
  const linkName = '00000000-0000-4000-8000-000000000001.png';
  const directoryName = '00000000-0000-4000-8000-000000000002.png';
  await symlink(outside, join(f.directory, linkName));
  await mkdir(join(f.directory, directoryName));
  await writeFile(join(f.directory, 'notes.txt'), 'preserve');
  assert.equal((await listImages({ directory: f.directory })).images.length, 1);
  await assert.rejects(deleteImages({ directory: f.directory, name: linkName }), { status: 404 });
  assert.deepEqual(await deleteImages({ directory: f.directory }), { deleted: 1 });
  assert.deepEqual(new Set(await readdir(f.directory)), new Set([linkName, directoryName, 'notes.txt']));
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
  const linkDirectory = join(f.root, 'redirect'); await symlink(f.directory, linkDirectory);
  await assert.rejects(listImages({ directory: linkDirectory }), { status: 503 });
  await assert.rejects(deleteImages({ directory: linkDirectory }), { status: 503 });
});

test('uploads, listing and cleanup serialize access to partially written files', async t => {
  const f = await fixture(t);
  const req = Readable.from([png]); req.headers = { 'content-type': 'image/png' };
  let pendingList, pendingDelete;
  const saved = await saveImage(req, { directory: f.directory, disconnected: () => {
    if (!pendingList) {
      pendingList = listImages({ directory: f.directory });
      pendingDelete = deleteImages({ directory: f.directory });
    }
    return false;
  } });
  assert.equal((await pendingList).images[0].path, saved.path);
  assert.deepEqual(await pendingDelete, { deleted: 1 });
  assert.deepEqual(await readdir(f.directory), []);
});
