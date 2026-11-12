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
const require = createRequire(join(root, 'start.mjs'));
const { WebSocket, WebSocketServer } = require('ws');
// Remobi already depends on this emulator; use it to observe the current view.
const { Terminal } = require('@xterm/headless');
const base = 'http://127.0.0.1:' + (process.env.SMOKE_PORT || '7681');
// Herdr paints words using cursor positioning, so raw protocol output is not plain text.
const compact = text => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s/g, '');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(250); }
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
      const output = execFileSync('herdr', args, { env: herdrEnv, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
      if(!output.trim()) return {};
      const response = JSON.parse(output);
      if(response.error) throw Error(JSON.stringify(response.error));
      return response.result;
    };
    const snapshot = () => herdr('api', 'snapshot').snapshot;
    // Distinct prompts let the test wait for the browser's focused pane and popups.
    await writeFile(join(config, '.bashrc'), 'if [[ -n $HERDR_ACTIVE_PANE_ID ]]; then PS1="SMOKE_POPUP> "; else PS1="SMOKE_$HERDR_PANE_ID> "; fi\n');
    const prompt = pane => 'SMOKE_' + pane + '>';
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
      const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
      const ws = new WebSocket(base.replace('http:', 'ws:') + path, { headers: { cookie, origin, ...(external ? { host: 'terminal.example', 'x-forwarded-proto': 'https' } : {}) } });
      clients.add(ws);
      ws.once('close', () => screen.dispose());
      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'snapshot') screen.reset();
        if (['snapshot', 'output'].includes(msg.type)) {
          output += msg.data;
          screen.write(msg.data, () => { if (msg.type === 'snapshot') snapshot = true; });
        }
      });
      await once(ws, 'open');
      await until(() => snapshot, 'terminal snapshot');
      return {
        ws,
        has: text => compact(output).includes(compact(text)),
        visible: text => {
          const lines = Array.from({ length: screen.rows }, (_, row) => screen.buffer.active.getLine(screen.buffer.active.viewportY + row)?.translateToString(true) || '').join('\n');
          return compact(lines).includes(compact(text));
        },
        send: message => {
          if (message.type === 'resize') screen.resize(message.cols, message.rows);
          ws.send(JSON.stringify(message));
        },
      };
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
      const clientPage = await (await request('/')).text();
      assert.match(clientPage, /<html/i);
      assert.ok(clientPage.includes('function installTerminalCopy('), 'image includes the copy client patch');
      const terminal = await connect();
      terminal.send({ type: 'resize', cols: 100, rows: 30 });
      // Remobi's first snapshot can arrive before Herdr and its shell are ready.
      await until(() => {
        try { return snapshot().panes.length > 0; } catch { return false; }
      }, 'Herdr initial pane', 60000);
      const original = snapshot().panes.find(pane => pane.focused);
      await until(() => terminal.visible(prompt(original.pane_id)), 'Herdr rendered shell', 60000);
      terminal.send({ type: 'input', data: "printf 'PTY_%s:%s\\n' OK \"$PWD\"\r" });
      await until(() => terminal.has('PTY_OK:/workspace'), 'PTY input/output');
      assert.equal(original.cwd, '/workspace');
      const rect = () => snapshot().layouts.flatMap(layout => layout.panes).find(pane => pane.pane_id === original.pane_id).rect;
      await until(() => rect().width < 120 && rect().height < 30, 'Herdr resize');
      // Layout rectangles include UI space such as the scrollbar gutter.
      // Read the actual pane PTY and verify its change for a known browser resize.
      const shellPid = herdr('pane', 'process-info', '--pane', original.pane_id).process_info.shell_pid;
      assert.ok(Number.isInteger(shellPid), 'Herdr returns the shell PID');
      const ptySize = () => execFileSync('stty', ['-F', '/proc/' + shellPid + '/fd/0', 'size'], { encoding: 'utf8', timeout: 5000 }).trim().split(/\s+/).map(Number);
      const [rows, cols] = ptySize();
      terminal.send({ type: 'resize', cols: 120, rows: 40 });
      await until(() => {
        const size = ptySize();
        return size[0] === rows + 10 && size[1] === cols + 20;
      }, 'pane PTY resize');
      terminal.send({ type: 'input', data: "printf 'SIZE_%s\\n' \"$(stty size)\"\r" });
      await until(() => terminal.has('SIZE_' + (rows + 10) + ' ' + (cols + 20)), 'resized shell input/output');
      terminal.send({ type: 'resize', cols: 100, rows: 30 });
      await until(() => { const size = ptySize(); return size[0] === rows && size[1] === cols; }, 'restore browser dimensions');
      terminal.send({ type: 'input', data: '\x02c' });
      await until(() => terminal.visible('new tab'), 'new tab name prompt');
      terminal.send({ type: 'input', data: '\r' });
      await until(() => snapshot().tabs.length === 2, 'create tab');
      const created = snapshot().tabs.find(tab => tab.focused);
      const createdPane = snapshot().focused_pane_id;
      await until(() => terminal.visible(prompt(createdPane)), 'new tab rendered');
      terminal.send({ type: 'input', data: '\x02T' });
      await until(() => terminal.visible('rename tab'), 'rename tab prompt');
      terminal.send({ type: 'input', data: '\x15renamed\r' });
      await until(() => snapshot().tabs.some(tab => tab.label === 'renamed'), 'rename tab');
      await until(() => !terminal.visible('rename tab') && terminal.visible(prompt(createdPane)), 'rename prompt closed');
      terminal.send({ type: 'input', data: '\x02p' });
      await until(() => snapshot().focused_tab_id === original.tab_id, 'previous tab');
      await until(() => terminal.visible(prompt(original.pane_id)), 'previous tab rendered');
      terminal.send({ type: 'input', data: '\x02n' });
      await until(() => snapshot().focused_tab_id === created.tab_id, 'next tab');
      await until(() => terminal.visible(prompt(createdPane)), 'next tab rendered');
      terminal.send({ type: 'input', data: '\x02v' });
      await until(() => snapshot().panes.length === 3, 'vertical split');
      await until(() => terminal.visible(prompt(snapshot().focused_pane_id)), 'vertical split rendered');
      terminal.send({ type: 'input', data: '\x02-' });
      await until(() => snapshot().panes.length === 4, 'horizontal split');
      await until(() => terminal.visible(prompt(snapshot().focused_pane_id)), 'horizontal split rendered');
      herdr('pane', 'close', snapshot().focused_pane_id);
      await until(() => snapshot().panes.length === 3, 'close split');
      const split = snapshot().focused_pane_id;
      await until(() => terminal.visible(prompt(split)), 'remaining split rendered');
      assert.equal(snapshot().focused_tab_id, created.tab_id, 'splits stay in the selected tab');
      // Two panes with distinct output: copy must use the single focused pane.
      const neighbor = snapshot().panes.find(pane => pane.tab_id === created.tab_id && pane.pane_id !== split);
      assert.ok(neighbor, 'copy fixture has a neighboring pane');
      herdr('pane', 'run', neighbor.pane_id, "printf 'COPY_OTHER_%s\\n' PANE");
      herdr('pane', 'run', split, "printf 'COPY_FOCUSED_%s\\n' PANE");
      await until(() => terminal.visible('COPY_FOCUSED_PANE'), 'copy fixture output');
      const copied = await request('/api/terminal/copy');
      assert.equal(copied.status, 200);
      assert.equal(copied.headers.get('cache-control'), 'no-store');
      const capture = await copied.json();
      assert.equal(capture.paneId, split);
      assert.ok(capture.text.includes('COPY_FOCUSED_PANE'));
      assert.ok(!capture.text.includes('COPY_OTHER_PANE'));
      herdr('pane', 'run', split, 'cd /tmp');
      await until(() => snapshot().panes.find(p => p.pane_id === split).foreground_cwd === '/tmp', 'pane directory');
      // Quick Shell inherits the underlying pane directory.
      terminal.send({ type: 'input', data: '\x02\x1b[17~' });
      await until(() => terminal.visible('SMOKE_POPUP>'), 'Quick Shell prompt');
      terminal.send({ type: 'input', data: "printf 'QUICK_%s\\n' \"$PWD\"\r" });
      await until(() => terminal.visible('QUICK_/tmp'), 'Quick Shell directory');
      terminal.send({ type: 'input', data: 'exit\r' });
      await until(() => !terminal.visible('SMOKE_POPUP>') && terminal.visible(prompt(split)), 'Quick Shell closed');
      assert.equal(snapshot().panes.length, 3, 'closing Quick Shell preserves tiled panes');
      for (const [sequence, text] of [[15, 'Press Enter to close'], [18, 'Open a Git checkout'], [19, '/apps/3000/']]) {
        terminal.send({ type: 'input', data: '\x02\x1b[' + sequence + '~' });
        await until(() => terminal.visible(text), 'popup F-key ' + sequence);
        await until(() => terminal.visible('Press Enter to close'), 'popup close prompt ' + sequence);
        terminal.send({ type: 'input', data: '\r' });
        await until(() => !terminal.visible('Press Enter to close') && terminal.visible(prompt(split)), 'popup closed ' + sequence);
      }
      terminal.send({ type: 'input', data: '\x02\x1b[20~' });
      await until(() => terminal.visible('Start Codex:'), 'Codex chooser');
      terminal.send({ type: 'input', data: '\r' });
      await until(() => !terminal.visible('Start Codex:') && terminal.visible(prompt(split)), 'Codex chooser canceled');
      assert.equal(snapshot().tabs.length, 2, 'cancel keeps tabs');
      for (const [choice, mode] of [['n', 'normal'], ['y', 'yolo']]) {
        terminal.send({ type: 'input', data: '\x02\x1b[20~' });
        await until(() => terminal.visible('Start Codex:'), 'Codex chooser '+mode);
        terminal.send({ type: 'input', data: choice+'\r' });
        await until(() => snapshot().tabs.length === 3, 'Codex creates tab '+mode);
        const codexPane = snapshot().panes.find(p => p.focused);
        assert.equal(codexPane.workspace_id, original.workspace_id);
        assert.equal(codexPane.cwd, '/tmp');
        await until(() => terminal.visible('CODEX_FIXTURE_'+mode+':/tmp'), 'Codex command '+mode);
        herdr('tab', 'close', codexPane.tab_id);
        herdr('tab', 'focus', created.tab_id);
        await until(() => terminal.visible(prompt(split)), 'originating tab rendered after Codex');
      }
      herdr('tab', 'close', created.tab_id);
      await until(() => snapshot().tabs.length === 1, 'close tab');
      await until(() => terminal.visible(prompt(original.pane_id)), 'original tab rendered');
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
    } catch (error) {
      try {
        const state = snapshot();
        console.error('Herdr smoke snapshot:', JSON.stringify(state));
        if (state.focused_pane_id) console.error('Focused pane:', execFileSync('herdr', ['pane', 'read', state.focused_pane_id], { env: herdrEnv, encoding: 'utf8', timeout: 5000 }));
      } catch (diagnostic) { console.error('Unable to collect Herdr diagnostics:', diagnostic.message); }
      throw error;
    } finally {
      for (const ws of clients) ws.terminate();
      if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
      try { execFileSync('herdr', ['session', 'stop', 'main'], { env: herdrEnv, timeout: 5000, stdio: 'ignore' }); } catch { /* already gone */ }
      await rm(config, { recursive: true, force: true });
    }
  }
} finally { appWs.close(); app.closeAllConnections(); app.close(); }
