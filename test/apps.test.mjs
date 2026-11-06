import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { appPorts, appRoute } from '../app/apps.mjs';
import { createAuthServer } from '../app/auth.mjs';
import { hashPassword } from '../app/password.mjs';

const passwordHash = await hashPassword('secret');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function setup(t, auth = false) {
  const seen = [];
  const sockets = new Set();
  const apps = await Promise.all([1, 2].map(async id => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({ url: req.url, headers: req.headers, method: req.method, body: Buffer.concat(chunks).toString() });
      if (req.url.includes('/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ready\n\n');
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60', 'Set-Cookie': ['codex_terminal_session=forged; Path=/', `app=value; Path=/apps/${server.address().port}/`], Location: req.url });
      res.end(JSON.stringify({ id, url: req.url }));
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket, head) => {
      seen.push({ url: req.url, headers: req.headers });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: example\r\nSet-Cookie: codex_terminal_session=forged\r\n\r\n');
      if (head.length) socket.write(head);
      socket.on('data', chunk => socket.write(chunk));
    });
    const port = await listen(server);
    return { server, port };
  }));
  let time = 1000;
  const gateway = createAuthServer({ ...(auth ? { username: 'alice', passwordHash } : {}), appPorts: new Set(apps.map(app => app.port)), upstreamPort: apps[1].port, now: () => time, sessionMs: 100 });
  const port = await listen(gateway);
  t.after(() => { gateway.shutdown(); for (const socket of sockets) socket.destroy(); for (const app of apps) { app.server.closeAllConnections(); app.server.close(); } });
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
  const login = (next = '/', password = 'secret') => request(`/login?next=${encodeURIComponent(next)}`, { method: 'POST', body: new URLSearchParams({ username: 'alice', password, next }) });
  return { apps, seen, gateway, port, request, login, expire: () => { time += 101; } };
}
function upgrade(port, path, cookie = '', origin = `http://127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello`));
    let output = '';
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Upgrade timed out')); });
    socket.on('error', reject);
    socket.on('data', chunk => {
      output += chunk;
      if (output.includes('hello') || /^HTTP\/1.1 (401|404|502)/.test(output)) { socket.destroy(); resolve(output); }
    });
  });
}

test('APP_PORTS defaults, validation and normalization', () => {
  assert.deepEqual(appPorts(), new Set());
  assert.deepEqual(appPorts(' 3000,5173,3000 '), new Set([3000, 5173]));
  for (const value of ['80', '0', '65536', '7681', '7682', '3000,', '3000,,5173', 'x', '3e3', '-3000', '03000']) assert.throws(() => appPorts(value), /APP_PORTS/);
  assert.deepEqual(appPorts('1024,65535'), new Set([1024, 65535]));
  for (const path of ['/apps', '/apps/x/', '/apps/3001/', '/apps/3000/../', '/apps/3000/%2e%2e/', '/apps/3000/%2f../', '/apps/3000/a\\b', '/apps/3000/%zz']) assert.equal(appRoute(path, appPorts('3000')).invalid, true);
  assert.equal(appRoute('/token', appPorts('3000')), null);
});

test('HTTP routes multiple apps and preserves bodies, paths, queries, headers and app responses', async t => {
  const { request, apps, seen, port } = await setup(t);
  for (const [index, app] of apps.entries()) {
    const path = `/apps/${app.port}/nested/file?x=a%2Fb&x=2`;
    const res = await request(path, { method: 'POST', body: 'payload', headers: { cookie: 'codex_terminal_session=private; other=value' } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: index + 1, url: path });
    assert.equal(res.headers.get('cache-control'), 'max-age=60');
    assert.equal(res.headers.get('location'), path);
    assert.doesNotMatch(res.headers.get('set-cookie'), /codex_terminal_session/);
    assert.match(res.headers.get('set-cookie'), /app=value/);
    assert.equal(seen.at(-1).headers.cookie.trim(), 'other=value');
    assert.equal(seen.at(-1).headers.host, `127.0.0.1:${port}`);
    assert.equal(seen.at(-1).body, 'payload');
    assert.equal(seen.at(-1).method, 'POST');
    const redirect = await request(`/apps/${app.port}?x=1`);
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), `/apps/${app.port}/?x=1`);
  }
  for (const path of ['/apps', '/apps/7682/', '/apps/nope/']) assert.equal((await request(path)).status, 404);
  assert.equal(seen.length, 2);
  const head = await request(`/apps/${apps[0].port}/`, { method: 'HEAD' });
  assert.equal(head.status, 201);
  assert.equal(await head.text(), '');
});

test('app streams are forwarded immediately and disconnect releases the upstream', async t => {
  const { request, apps } = await setup(t);
  const closed = new Promise(resolve => apps[0].server.once('request', (req, res) => res.on('close', resolve)));
  const res = await request(`/apps/${apps[0].port}/stream`);
  const reader = res.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: ready\n\n');
  await reader.cancel();
  await closed;
});

test('app login returns to original path, rejects unsafe destinations and expires', async t => {
  const { request, apps, login, expire, port } = await setup(t, true);
  const path = `/apps/${apps[0].port}/nested?x=1&y=2`;
  const redirect = await request(path);
  assert.equal(redirect.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
  assert.match(await (await request(redirect.headers.get('location'))).text(), /name="next"/);
  const failure = await login(path, 'wrong');
  assert.equal(failure.status, 401);
  assert.match(await failure.text(), /x=1&amp;y=2/);
  const res = await login(path);
  assert.equal(res.headers.get('location'), path);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(path, { headers: { cookie } })).status, 201);
  for (const next of ['https://evil.example', '//evil.example', '/apps/7682/', `/apps/${apps[0].port}/%2e%2e/%2e%2e/`, '/']) assert.equal((await request(`/login?next=${encodeURIComponent(next)}`, { headers: { cookie } })).headers.get('location'), '/');
  expire();
  assert.equal((await request(path, { headers: { cookie } })).status, 303);
  assert.match(await upgrade(port, path, cookie), /401/);
});

test('app WebSockets enforce auth, port and origin checks and filter cookies', async t => {
  const { apps, login, port, seen } = await setup(t, true);
  const path = `/apps/${apps[0].port}/live?token=x`;
  assert.match(await upgrade(port, path), /401/);
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  assert.match(await upgrade(port, path, cookie, 'https://evil.example'), /401/);
  assert.match(await upgrade(port, '/apps/7682/ws', cookie), /404/);
  const result = await upgrade(port, path, `${cookie}; app=value`);
  assert.match(result, /101 Switching Protocols/);
  assert.match(result, /hello/);
  assert.match(result, /sec-websocket-protocol: example/i);
  assert.doesNotMatch(result, /codex_terminal_session/);
  assert.equal(seen.at(-1).url, path);
  assert.equal(seen.at(-1).headers.cookie.trim(), 'app=value');
});

test('app outage returns 502 while terminal remains available; shutdown closes upgrades', async t => {
  const { apps, request, port, gateway } = await setup(t);
  await new Promise(resolve => apps[0].server.close(resolve));
  const path = `/apps/${apps[0].port}/`;
  const res = await request(path);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /unavailable/);
  assert.match(await upgrade(port, path), /502/);
  assert.equal((await request('/token')).status, 201);
  const socket = net.connect(port, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`GET /apps/${apps[1].port}/live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  await new Promise(resolve => socket.once('data', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  gateway.shutdown();
  await closed;
});
