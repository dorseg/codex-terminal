// Run inside the built image: node /tmp/smoke.mjs
// For a checkout with Remobi installed: TERMINAL_ROOT="$PWD/app" node scripts/smoke.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
const root = process.env.TERMINAL_ROOT || '/opt/codex-terminal';
const { hashPassword } = await import(pathToFileURL(join(root, 'password.mjs')));
const { WebSocket, WebSocketServer } = createRequire(join(root, 'start.mjs'))('ws');
const base = 'http://127.0.0.1:' + (process.env.SMOKE_PORT || '7681');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await pause(250); }
  throw Error(`Timed out: ${label}`);
}
const app = http.createServer((req, res) => res.end(req.url));
const appWs = new WebSocketServer({ server: app });
appWs.on('connection', ws => ws.on('message', data => ws.send(data)));
await new Promise(resolve => app.listen(3000, '127.0.0.1', resolve));
try {
  for (const authenticated of [false, true]) {
    const config = await mkdtemp('/tmp/remobi-smoke-');
    const env = { ...process.env, TMUX_TMPDIR: config, CODEX_HOME: config, APP_PORTS: '3000', AUTH_PASSWORD: '', AUTH_USERNAME: authenticated ? 'smoke' : '', AUTH_PASSWORD_HASH: authenticated ? await hashPassword('smoke-password') : '' };
    delete env.TMUX;
    const tmux = (...args) => execFileSync('tmux', args, { env, encoding: 'utf8' }).trim();
    const child = spawn(process.execPath, [join(root, 'start.mjs')], { env, stdio: 'inherit' });
    const exit = once(child, 'exit');
    const clients = new Set();
    let cookie = '';
    const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options, headers: { cookie, origin: base, ...options.headers } });
    async function connect({ path = '/ws', origin = base, external = false } = {}) {
      let output = '', snapshot = false;
      const ws = new WebSocket(base.replace('http:', 'ws:') + path, { headers: { cookie, origin, ...(external ? { host: 'terminal.example', 'x-forwarded-proto': 'https' } : {}) } });
      clients.add(ws);
      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'snapshot') snapshot = true;
        if (['snapshot', 'output'].includes(msg.type)) output += msg.data;
      });
      await once(ws, 'open');
      await until(() => snapshot, 'terminal snapshot');
      return { ws, output: () => output, send: message => ws.send(JSON.stringify(message)) };
    }
    try {
      await until(async () => {
        assert.equal(child.exitCode, null, 'launcher exited during startup');
        try {
          if (authenticated && !cookie) {
            assert.equal((await request('/')).status, 303);
            const login = await request('/login', { method: 'POST', body: new URLSearchParams({ username: 'smoke', password: 'smoke-password' }) });
            assert.equal(login.status, 303);
            cookie = login.headers.get('set-cookie').split(';')[0];
          }
          return (await request('/')).ok;
        } catch { return false; }
      }, 'Remobi startup');
      assert.match(await (await request('/')).text(), /<html/i);
      const terminal = await connect();
      terminal.send({ type: 'resize', cols: 100, rows: 30 });
      terminal.send({ type: 'input', data: "printf 'PTY_%s:%s\\n' OK \"$PWD\"\r" });
      await until(() => terminal.output().includes('PTY_OK:/workspace'), 'PTY input/output');
      await until(() => tmux('display-message', '-p', '-t', 'main', '#{pane_width} #{pane_height}') === '100 29', 'tmux resize');
      terminal.send({ type: 'input', data: "printf 'SIZE_%s\\n' \"$(stty size)\"\r" });
      await until(() => terminal.output().includes('SIZE_29 100'), 'PTY resize (one tmux status row)');
      assert.equal(tmux('display-message', '-p', '-t', 'main', '#{pane_current_path}'), '/workspace');
      assert.equal(tmux('show-options', '-gv', 'mouse'), 'on');
      assert.equal(tmux('show-options', '-gv', 'status-position'), 'bottom');
      assert.equal(tmux('show-options', '-gv', 'prefix'), 'C-b');
      // Exercise tmux bindings over the browser protocol, including confirmation.
      terminal.send({ type: 'input', data: '\x02c' });
      await until(() => tmux('list-windows', '-t', 'main').split('\n').length === 2, 'create window');
      terminal.send({ type: 'input', data: '\x02,' });
      await pause(250);
      terminal.send({ type: 'input', data: '\x15renamed\r' });
      await until(() => tmux('display-message', '-p', '-t', 'main', '#{window_name}') === 'renamed', 'rename window');
      terminal.send({ type: 'input', data: '\x02p' });
      await until(() => tmux('display-message', '-p', '-t', 'main', '#{window_index}') === '0', 'previous window');
      terminal.send({ type: 'input', data: '\x02n' });
      await until(() => tmux('display-message', '-p', '-t', 'main', '#{window_name}') === 'renamed', 'next window');
      terminal.send({ type: 'input', data: '\x02&' });
      await pause(250);
      terminal.send({ type: 'input', data: 'y' });
      await until(() => tmux('list-windows', '-t', 'main').split('\n').length === 1, 'close window');
      terminal.ws.close(); await once(terminal.ws, 'close');
      const reconnected = await connect({ external: true, origin: 'https://terminal.example' });
      await until(() => reconnected.output().includes('PTY_OK:/workspace'), 'snapshot preserves output after reconnect');
      const shared = await connect();
      reconnected.send({ type: 'input', data: "printf 'SHARED_%s\\n' OK\r" });
      await until(() => shared.output().includes('SHARED_OK'), 'shared terminal views');
      for (const origin of ['https://foreign.example', 'null']) {
        const foreign = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { cookie, origin } });
        const error = await new Promise(resolve => { foreign.on('error', resolve); foreign.on('open', () => { foreign.close(); resolve(null); }); });
        assert.match(error?.message || '', /401/);
      }
      assert.equal(await (await request('/apps/3000/ready?yes=1')).text(), '/apps/3000/ready?yes=1');
      assert.equal((await request('/apps/3001/')).status, 404);
      const proxy = new WebSocket(base.replace('http:', 'ws:') + '/apps/3000/ws', { headers: { cookie, origin: base } });
      clients.add(proxy);
      await once(proxy, 'open');
      const echoed = once(proxy, 'message'); proxy.send('app websocket');
      assert.equal((await echoed)[0].toString(), 'app websocket');
      // Keep live sockets open to verify gateway shutdown releases them.
      child.kill('SIGTERM');
      const result = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(Error('Shutdown timed out')), 8000).unref())]);
      assert.deepEqual(result, [0, null]);
      await until(() => [...clients].every(ws => ws.readyState === WebSocket.CLOSED), 'gateway socket shutdown');
      console.log(`Native Remobi smoke passed (auth=${authenticated})`);
    } finally {
      for (const ws of clients) ws.terminate();
      if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
      try { tmux('kill-server'); } catch { /* already gone */ }
      await rm(config, { recursive: true, force: true });
    }
  }
} finally { appWs.close(); app.closeAllConnections(); app.close(); }
