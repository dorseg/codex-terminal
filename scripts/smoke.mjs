// Run inside the built image: node /tmp/smoke.mjs
// For a checkout with Remobi installed: TERMINAL_ROOT="$PWD/app" node scripts/smoke.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
const root = process.env.TERMINAL_ROOT || '/opt/codex-terminal';
const { hashPassword } = await import(pathToFileURL(join(root, 'password.mjs')));
const { WebSocket, WebSocketServer } = createRequire(join(root, 'start.mjs'))('ws');
const base = 'http://127.0.0.1:' + (process.env.SMOKE_PORT || '7681');
// Herdr paints words using cursor positioning, so raw protocol output is not plain text.
const compact = text => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s/g, '');
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
    const env = { ...process.env, HOME: config, XDG_CONFIG_HOME: join(config, '.config'), CODEX_HOME: config, APP_PORTS: '3000', AUTH_PASSWORD: '', AUTH_USERNAME: authenticated ? 'smoke' : '', AUTH_PASSWORD_HASH: authenticated ? await hashPassword('smoke-password') : '' };
    for (const key of Object.keys(env)) if (key.startsWith('HERDR_') || key.startsWith('TMUX') || key === 'CODEX_THREAD_ID') delete env[key];
    const herdrEnv = { ...env, HERDR_SESSION: 'main' };
    const herdr = (...args) => {
      const output = execFileSync('herdr', args, { env: herdrEnv, encoding: 'utf8' });
      if(!output.trim()) return {};
      const response = JSON.parse(output);
      if(response.error) throw Error(JSON.stringify(response.error));
      return response.result;
    };
    const snapshot = () => herdr('api', 'snapshot').snapshot;
    await mkdir(join(config, 'bin'));
    await writeFile(join(config, 'bin/codex'), `#!/usr/bin/env node
const { createInterface } = require('node:readline');
if(process.argv[2] === 'app-server') {
  createInterface({input:process.stdin}).on('line', line => {
    const msg=JSON.parse(line);
    if(msg.id) console.log(JSON.stringify({id:msg.id,result:msg.id===1?{}:{rateLimits:{primary:{windowDurationMins:300,usedPercent:20},secondary:{windowDurationMins:10080,usedPercent:30}}}}));
  });
} else { console.log('CODEX_FIXTURE_'+(process.argv.includes('--yolo')?'yolo':'normal')+':'+process.cwd()); setInterval(()=>{},1000); }
`, { mode: 0o755 });
    env.PATH = join(config, 'bin') + ':' + env.PATH;
    herdrEnv.PATH = env.PATH;
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
      return { ws, output: () => output, has: (text, from = 0) => compact(output.slice(from)).includes(compact(text)), send: message => ws.send(JSON.stringify(message)) };
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
      await until(() => terminal.has('PTY_OK:/workspace'), 'PTY input/output');
      const original = snapshot().panes.find(pane => pane.focused);
      assert.equal(original.cwd, '/workspace');
      const rect = () => snapshot().layouts.flatMap(layout => layout.panes).find(pane => pane.pane_id === original.pane_id).rect;
      await until(() => rect().width < 120 && rect().height < 30, 'Herdr resize');
      terminal.send({ type: 'input', data: "printf 'SIZE_%s\\n' \"$(stty size)\"\r" });
      await until(() => terminal.has('SIZE_' + rect().height + ' ' + rect().width), 'pane PTY resize');
      terminal.send({ type: 'input', data: '\x02c' });
      await pause(250);
      terminal.send({ type: 'input', data: '\r' });
      await until(() => snapshot().tabs.length === 2, 'create tab');
      const created = snapshot().tabs.find(tab => tab.focused);
      terminal.send({ type: 'input', data: '\x02T' });
      await pause(250);
      terminal.send({ type: 'input', data: '\x15renamed\r' });
      await until(() => snapshot().tabs.some(tab => tab.label === 'renamed'), 'rename tab');
      terminal.send({ type: 'input', data: '\x02p' });
      await until(() => snapshot().focused_tab_id === original.tab_id, 'previous tab');
      terminal.send({ type: 'input', data: '\x02n' });
      await until(() => snapshot().focused_tab_id === created.tab_id, 'next tab');
      terminal.send({ type: 'input', data: '\x02v' });
      await until(() => snapshot().panes.length === 3, 'vertical split');
      const split = snapshot().focused_pane_id;
      terminal.send({ type: 'input', data: '\x02-' });
      await until(() => snapshot().panes.length === 4, 'horizontal split');
      herdr('pane', 'close', snapshot().focused_pane_id);
      await until(() => snapshot().panes.length === 3, 'close split');
      herdr('pane', 'run', split, 'cd /tmp');
      await until(() => snapshot().panes.find(p => p.pane_id === split).foreground_cwd === '/tmp', 'pane directory');
      // Quick Shell inherits the underlying pane directory.
      let mark = terminal.output().length;
      terminal.send({ type: 'input', data: '\x02\x1b[17~' });
      await pause(500);
      terminal.send({ type: 'input', data: "printf 'QUICK_%s\\n' \"$PWD\"\r" });
      await until(() => terminal.has('QUICK_/tmp', mark), 'Quick Shell directory');
      terminal.send({ type: 'input', data: 'exit\r' });
      await pause(500);
      for (const [sequence, text] of [[15, 'Press Enter to close'], [18, 'Open a Git checkout'], [19, '/apps/3000/']]) {
        mark = terminal.output().length;
        terminal.send({ type: 'input', data: '\x02\x1b[' + sequence + '~' });
        await until(() => terminal.has(text, mark), 'popup F-key ' + sequence);
        terminal.send({ type: 'input', data: '\r' });
        await pause(500);
      }
      mark = terminal.output().length;
      terminal.send({ type: 'input', data: '\x02\x1b[20~' });
      await until(() => terminal.has('Start Codex:', mark), 'Codex chooser');
      terminal.send({ type: 'input', data: '\r' });
      await pause(300);
      assert.equal(snapshot().tabs.length, 2, 'cancel keeps tabs');
      for (const [choice, mode] of [['n', 'normal'], ['y', 'yolo']]) {
        mark = terminal.output().length;
        terminal.send({ type: 'input', data: '\x02\x1b[20~' });
        await until(() => terminal.has('Start Codex:', mark), 'Codex chooser '+mode);
        terminal.send({ type: 'input', data: choice+'\r' });
        await until(() => snapshot().tabs.length === 3, 'Codex creates tab '+mode);
        const codexPane = snapshot().panes.find(p => p.focused);
        assert.equal(codexPane.workspace_id, original.workspace_id);
        assert.equal(codexPane.cwd, '/tmp');
        await until(() => terminal.has('CODEX_FIXTURE_'+mode+':/tmp', mark), 'Codex command '+mode);
        herdr('tab', 'close', codexPane.tab_id);
        herdr('tab', 'focus', created.tab_id);
        await pause(300);
      }
      herdr('tab', 'close', created.tab_id);
      await until(() => snapshot().tabs.length === 1, 'close tab');
      terminal.ws.close(); await once(terminal.ws, 'close');
      const reconnected = await connect({ external: true, origin: 'https://terminal.example' });
      await until(() => reconnected.has('PTY_OK:/workspace'), 'snapshot preserves output after reconnect');
      const shared = await connect();
      reconnected.send({ type: 'input', data: "printf 'SHARED_%s\\n' OK\r" });
      await until(() => shared.has('SHARED_OK'), 'shared terminal views');
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
      try { execFileSync('herdr', ['session', 'stop', 'main'], { env: herdrEnv }); } catch { /* already gone */ }
      await rm(config, { recursive: true, force: true });
    }
  }
} finally { appWs.close(); app.closeAllConnections(); app.close(); }
