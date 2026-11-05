import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { parsePasswordHash, verifyPassword } from './password.mjs';

const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = 'codex_terminal_session';
const logo = readFileSync(new URL('./assets/logo.png', import.meta.url));
const digest = value => createHash('sha256').update(value).digest();

export function credentials(env = process.env) {
  const username = env.AUTH_USERNAME || '';
  if (env.AUTH_PASSWORD) throw new Error('AUTH_PASSWORD is no longer supported. Use AUTH_PASSWORD_HASH instead.');
  const passwordHash = env.AUTH_PASSWORD_HASH || '';
  if (Boolean(username) !== Boolean(passwordHash)) {
    throw new Error('Set both AUTH_USERNAME and AUTH_PASSWORD_HASH, or leave both unset.');
  }
  if (passwordHash) parsePasswordHash(passwordHash);
  return username ? { username, passwordHash } : null;
}

function loginPage(error = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/assets/logo.png">
<title>Codex Terminal</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14171c;color:#edf0f5;font:16px system-ui;padding:24px}
main{width:100%;max-width:380px;padding:32px;background:#20252d;border:1px solid #38404d;border-radius:16px}h1{font-size:24px;margin:0 0 24px}
.logo{display:block;width:88px;height:88px;object-fit:contain;margin:0 0 16px}
label{display:block;margin:16px 0 8px}input,button{width:100%;font:inherit;padding:12px;border-radius:8px;border:1px solid #566172}input{background:#14171c;color:inherit}
button{margin-top:24px;background:#b8e7ce;color:#10251b;font-weight:600;cursor:pointer}.error{color:#ffb5b5}input:focus-visible,button:focus-visible{outline:3px solid #b8e7ce;outline-offset:3px}
</style><main><img class="logo" src="/assets/logo.png" alt="" width="88" height="88"><h1>Codex Terminal</h1>${error ? `<p class="error" role="alert">${error}</p>` : ''}
<form action="/login" method="post"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required autofocus>
<label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form></main></html>`;
}

export function createAuthServer({ username, passwordHash, upstreamPort = 7682, now = Date.now, sessionMs = SESSION_MS }) {
  const sessions = new Map();
  const failures = new Map();
  const expectedUser = digest(username);
  const expectedPassword = parsePasswordHash(passwordHash);
  let activeVerifications = 0;
  const sockets = new Set();
  function authenticated(req) {
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const expires = sessions.get(token);
    if (!expires) return false;
    if (expires <= now()) { sessions.delete(token); return false; }
    return true;
  }
  // Compare hosts rather than schemes: TLS can terminate at the existing reverse proxy.
  function sameOrigin(req, required = false) {
    if (!req.headers.origin) return !required;
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  }
  function reply(res, status, body = '', headers = {}) {
    res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(body);
  }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/assets/logo.png') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, '', { Allow: 'GET, HEAD' });
      return reply(res, 200, req.method === 'HEAD' ? '' : logo, { 'Content-Type': 'image/png', 'Content-Length': logo.length });
    }
    if (req.url === '/login') {
      if (req.method === 'GET') {
        return authenticated(req) ? reply(res, 303, '', { Location: '/' }) : reply(res, 200, loginPage());
      }
      if (req.method !== 'POST') return reply(res, 405, '', { Allow: 'GET, POST' });
      if (!sameOrigin(req)) return reply(res, 403, 'Forbidden');
      if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return reply(res, 415, 'Unsupported form encoding');
      const address = req.socket.remoteAddress;
      let previous = failures.get(address);
      if (previous && previous.until > now() && previous.count >= 5) return reply(res, 429, loginPage('Too many attempts. Try again in a minute.'), { 'Retry-After': '60' });
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) { reply(res, 413, 'Form too large'); return; }
          chunks.push(chunk);
        }
      } catch { return; }
      // Recheck after reading the body so parallel requests cannot bypass the limit.
      previous = failures.get(address);
      if (previous && previous.until > now() && previous.count >= 5) return reply(res, 429, loginPage('Too many attempts. Try again in a minute.'), { 'Retry-After': '60' });
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const userMatches = timingSafeEqual(digest(form.get('username') || ''), expectedUser);
      // Limit memory use across all addresses, including clients behind a proxy.
      if (activeVerifications >= 2) return reply(res, 429, loginPage('Login is busy. Please try again.'), { 'Retry-After': '1' });
      activeVerifications++;
      // Reserve an attempt before awaiting scrypt so parallel requests count too.
      failures.set(address, { count: previous && previous.until > now() ? previous.count + 1 : 1, until: now() + 60_000 });
      let passwordMatches;
      try {
        passwordMatches = await verifyPassword(form.get('password') || '', expectedPassword);
      } catch {
        return reply(res, 503, loginPage('Unable to sign in. Please try again.'));
      } finally { activeVerifications--; }
      if (!userMatches || !passwordMatches) {
        return reply(res, 401, loginPage('Invalid username or password.'));
      }
      failures.delete(address);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, now() + sessionMs);
      return reply(res, 303, '', { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (!authenticated(req)) return reply(res, 303, '', { Location: '/login' });
    const terminalPage = req.method === 'GET' && req.url.split('?')[0] === '/';
    const headers = { ...req.headers };
    if (terminalPage) {
      // The embedded ttyd page must be plain HTML to replace its bundled icon.
      headers['accept-encoding'] = 'identity';
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers }, response => {
      if (terminalPage && response.statusCode === 200 && response.headers['content-type']?.startsWith('text/html')) {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', () => res.destroy());
        response.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8').replace(
            /<link\b(?=[^>]*\brel=["'](?:shortcut )?icon["'])[^>]*>/gi,
            '<link rel="icon" type="image/png" href="/assets/logo.png">')
            .replace(/<title>[^<]*<\/title>/i, '<title>Codex Terminal</title>');
          const body = Buffer.from(html);
          const headers = { ...response.headers, 'cache-control': 'no-store', 'content-length': body.length };
          delete headers['transfer-encoding'];
          delete headers.etag;
          delete headers['last-modified'];
          res.writeHead(response.statusCode, headers);
          res.end(body);
        });
        return;
      }
      res.writeHead(response.statusCode, { ...response.headers, 'cache-control': 'no-store' });
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) reply(res, 502, 'Terminal is starting. Please refresh.'); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!authenticated(req) || !sameOrigin(req, true)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, headers: req.headers });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      sockets.add(remote);
      remote.on('close', () => sockets.delete(remote));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((all, value, i, headers) => i % 2 ? all : all + value + ': ' + headers[i + 1] + '\r\n', '')}\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      socket.on('close', () => remote.destroy());
      remote.on('close', () => socket.destroy());
      remote.on('error', () => socket.destroy());
    });
    upstream.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const cleanup = setInterval(() => {
    for (const [token, expires] of sessions) if (expires <= now()) sessions.delete(token);
    for (const [address, failure] of failures) if (failure.until <= now()) failures.delete(address);
  }, 60_000).unref();
  server.on('close', () => clearInterval(cleanup));
  server.shutdown = () => { server.close(); for (const socket of sockets) socket.destroy(); };
  return server;
}
