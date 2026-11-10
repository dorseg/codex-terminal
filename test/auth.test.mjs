import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { credentials, createAuthServer } from '../app/auth.mjs';
import { hashPassword } from '../app/password.mjs';

const passwordHash = await hashPassword('a: secret & + pass');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function setup(t, options = {}) {
  const upstream = http.createServer(options.upstreamHandler || ((req, res) => { res.end(`terminal:${req.url}`); }));
  upstream.on('upgrade', (req, socket, head) => {
    options.onUpgrade?.(req);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: tty\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
  });
  const upstreamPort = await listen(upstream);
  const server = createAuthServer({ username: 'alice', passwordHash, upstreamPort, ...options });
  const port = await listen(server);
  t.after(() => { server.shutdown(); upstream.closeAllConnections(); upstream.close(); });
  const request = (path = '/', init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  const login = (password = 'a: secret & + pass', extra = {}) => request('/login', {
    method: 'POST', body: new URLSearchParams({ username: 'alice', password }), ...extra,
  });
  return { server, request, login, port };
}

function upgrade(port, cookie = '', origin = `http://127.0.0.1:${port}`, path = '/ws', host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\n\r\nhello`));
    let received = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('WebSocket proxy timed out')); });
    socket.on('error', reject);
    socket.on('data', chunk => {
      received += chunk.toString();
      if (received.includes('401') || received.includes('404') || received.includes('hello')) { socket.destroy(); resolve(received); }
    });
  });
}

test('credentials are optional but require a complete pair', () => {
  assert.equal(credentials({}), null);
  assert.equal(credentials({ AUTH_USERNAME: '', AUTH_PASSWORD_HASH: '' }), null);
  for (const env of [{ AUTH_USERNAME: 'alice' }, { AUTH_PASSWORD_HASH: passwordHash }, { AUTH_USERNAME: 'alice', AUTH_PASSWORD_HASH: '' }]) {
    assert.throws(() => credentials(env), /both AUTH_USERNAME and AUTH_PASSWORD_HASH/);
  }
  assert.deepEqual(credentials({ AUTH_USERNAME: ' alice ', AUTH_PASSWORD_HASH: passwordHash }), { username: ' alice ', passwordHash });
});

test('all terminal paths require authentication; login page contains accessible fields', async t => {
  const { request, port } = await setup(t);
  for (const path of ['/', '/token', '/ws', '/anything']) {
    const res = await request(path);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
  }
  const page = await request('/login');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /autocomplete="current-password"/);
  assert.match(await upgrade(port), /401 Unauthorized/);
});

test('login grants HTTP and bidirectional WebSocket access; refresh reuses session', async t => {
  const { request, login, port } = await setup(t);
  assert.equal((await login('wrong')).status, 401);
  const res = await login();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\//);
  const headers = { cookie: cookie.split(';')[0] };
  for (let i = 0; i < 2; i++) assert.equal(await (await request('/', { headers })).text(), 'terminal:/');
  assert.equal(await (await request('/token', { headers })).text(), 'terminal:/token');
  assert.equal((await request('/login', { headers })).status, 303);
  const upgraded = await upgrade(port, headers.cookie);
  assert.match(upgraded, /101 Switching Protocols/);
  assert.match(upgraded, /Sec-WebSocket-Protocol: tty/i);
  assert.match(upgraded, /hello/);
  assert.match(await upgrade(port, headers.cookie, 'https://evil.example'), /401 Unauthorized/);
});

test('login logo is available before authentication with image content and a compatible CSP', async t => {
  const { request } = await setup(t);
  const page = await request('/login');
  assert.match(await page.text(), /<img[^>]+src="\/assets\/logo\.png"/);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self'/);
  const image = await request('/assets/logo.png');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await image.arrayBuffer());
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(Number(image.headers.get('content-length')), bytes.length);
  const head = await request('/assets/logo.png', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await request('/assets/logo.png', { method: 'POST' })).status, 405);
  assert.equal((await request('/assets/other.png')).status, 303);
});

for (const authenticated of [false, true]) test('Remobi content is forwarded unchanged, auth=' + authenticated, async t => {
  const html = '<html><head><title>Remobi</title></head><body>Terminal ✓</body></html>';
  const binary = Buffer.from([0, 255, 127, 1]);
  const { request, login, port } = await setup(t, {
    ...(authenticated ? {} : { username: undefined, passwordHash: undefined }),
    upstreamHandler(req, res) {
      assert.equal(req.headers['accept-encoding'], 'identity');
      assert.equal(req.headers['if-none-match'], 'original');
      if (req.url === '/api/echo') {
        assert.equal(req.headers.host, 'terminal.example');
        assert.equal(req.headers.origin, 'https://terminal.example');
        assert.equal(req.headers['x-forwarded-proto'], 'https');
        req.pipe(res); return;
      }
      res.writeHead(200, { 'Content-Type': req.url === '/' ? 'text/html' : 'application/octet-stream', ETag: 'original' });
      res.end(req.url === '/' ? html : binary);
    }
  });
  const cookie = authenticated ? (await login()).headers.get('set-cookie').split(';')[0] : '';
  const headers = { cookie, 'accept-encoding': 'identity', 'if-none-match': 'original' };
  const page = await request('/', { headers });
  assert.equal(await page.text(), html);
  assert.equal(page.headers.get('etag'), 'original');
  assert.deepEqual(Buffer.from(await (await request('/asset.bin', { headers })).arrayBuffer()), binary);
  // Use node:http because fetch controls the Host header.
  const echoed = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/echo', method: 'POST', headers: { ...headers, host: 'terminal.example', origin: 'https://terminal.example', 'x-forwarded-proto': 'https' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject); req.end(binary);
  });
  assert.deepEqual(echoed, binary);
  assert.match(await upgrade(port, cookie), /101 Switching Protocols/);
  assert.match(await upgrade(port, cookie, 'https://evil.example'), /401 Unauthorized/);
});

test('forged, expired and previous-process sessions are rejected', async t => {
  let time = 1000;
  const { request, login, port } = await setup(t, { now: () => time, sessionMs: 100 });
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/', { headers: { cookie: 'codex_terminal_session=forged' } })).status, 303);
  time += 101;
  assert.equal((await request('/', { headers: { cookie } })).status, 303);
  assert.match(await upgrade(port, cookie), /401 Unauthorized/);
  const other = await setup(t);
  assert.equal((await other.request('/', { headers: { cookie } })).status, 303);
});

test('malformed, oversized, cross-origin and unsupported login requests are rejected', async t => {
  const { request, login } = await setup(t);
  assert.equal((await login(undefined, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await login(undefined, { headers: { origin: 'null' } })).status, 403);
  assert.equal((await request('/login', { method: 'PUT' })).status, 405);
  assert.equal((await request('/login', { method: 'POST', body: 'x' })).status, 415);
  assert.equal((await request('/login', { method: 'POST', body: new URLSearchParams({ username: 'x'.repeat(5000) }) })).status, 413);
  assert.equal((await request('/login', { method: 'POST', body: new URLSearchParams({}) })).status, 401);
});

test('failed attempts are throttled and recover after cooldown', async t => {
  let time = 1000;
  const { login } = await setup(t, { now: () => time });
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
  assert.equal((await login()).status, 429);
  time += 60_001;
  assert.equal((await login()).status, 303);
});

test('unavailable Remobi returns a gateway error', async t => {
  const { request, login } = await setup(t, { upstreamPort: 1 });
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/', { headers: { cookie } })).status, 502);
});

test('parallel failed attempts cannot bypass throttling', async t => {
  const { login } = await setup(t);
  const responses = await Promise.all(Array.from({ length: 12 }, () => login('wrong')));
  const verified = responses.filter(res => res.status === 401).length;
  assert.ok(verified >= 1 && verified <= 5);
  assert.equal(responses.filter(res => res.status === 429).length, 12 - verified);
  // Busy requests must not consume all five password attempts.
  assert.equal((await login()).status, 303);
});

test('launcher fails early for incomplete credentials', async () => {
  const child = spawn(process.execPath, [resolve('app/start.mjs')], { env: { ...process.env, AUTH_USERNAME: 'alice', AUTH_PASSWORD_HASH: '' } });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /Set both AUTH_USERNAME and AUTH_PASSWORD_HASH/);
});


test('launcher rejects invalid APP_PORTS before starting Remobi', async () => {
  const child = spawn(process.execPath, [resolve('app/start.mjs')], { env: { ...process.env, AUTH_USERNAME: '', AUTH_PASSWORD_HASH: '', APP_PORTS: '7682' } });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /APP_PORTS must contain/);
  assert.doesNotMatch(stderr, /Unable to start Remobi/);
});

test('external HTTPS origin survives HTTP and WebSocket proxying', async t => {
  const { request, port } = await setup(t, { username: undefined, passwordHash: undefined, onUpgrade(req) {
    assert.equal(req.headers.host, 'terminal.example');
    assert.equal(req.headers.origin, 'https://terminal.example');
  }, upstreamHandler(req, res) {
    assert.equal(req.headers.origin, `https://127.0.0.1:${port}`);
    assert.equal(req.headers['x-forwarded-proto'], 'https');
    res.end('forwarded');
  } });
  assert.equal(await (await request('/', { headers: { origin: `https://127.0.0.1:${port}`, 'x-forwarded-proto': 'https' } })).text(), 'forwarded');
  assert.match(await upgrade(port, '', 'https://terminal.example', '/ws', 'terminal.example'), /101 Switching Protocols/);
  assert.match(await upgrade(port, '', 'https://foreign.example', '/ws', 'terminal.example'), /401 Unauthorized/);
});
