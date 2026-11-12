import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { captureTerminal } from '../app/terminal-copy.mjs';
import { createAuthServer } from '../app/auth.mjs';
import { hashPassword } from '../app/password.mjs';

const snapshot = JSON.stringify({ result: { snapshot: { focused_pane_id: 'w1:p2', panes: [{ pane_id: 'w1:p1' }, { pane_id: 'w1:p2' }] } } });
function fixture(steps) {
  const calls = [], children = [];
  const spawnCommand = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { child.killed = signal; };
    children.push(child);
    const step = steps.shift();
    setTimeout(() => {
      if (child.killed) return;
      if (step.error) return child.emit('error', Error('fixture'));
      child.stdout.write(step.out || '');
      child.stderr.write(step.stderr || '');
      if (!step.hang) child.emit('close', step.code ?? 0);
    }, step.delay || 0);
    return child;
  };
  return { spawnCommand, calls, children };
}

test('focus is resolved once and explicit pane extraction preserves Unicode and whitespace', async () => {
  const text = '  α 😀\t<&>\njoined soft wrap\n\n';
  const f = fixture([{ out: snapshot }, { out: text }]);
  const env = { HERDR_SESSION: 'main', HOME: '/prepared' };
  assert.deepEqual(await captureTerminal({ ...f, env }), { paneId: 'w1:p2', text });
  assert.deepEqual(f.calls.map(c => [c.command, c.args]), [
    ['herdr', ['api', 'snapshot']],
    ['herdr', ['pane', 'read', 'w1:p2', '--source', 'recent-unwrapped', '--lines', '500']],
  ]);
  for (const call of f.calls) { assert.equal(call.options.env, env); assert.equal(call.options.shell, false); }
});

test('empty output is a successful snapshot', async () => {
  assert.equal((await captureTerminal(fixture([{ out: snapshot }, {}]))).text, '');
});
for (const out of ['bad json', '{}', '{"error":"unavailable"}', '{"result":{"snapshot":{"panes":{}}}}', '{"result":{"snapshot":{"panes":[null]}}}']) {
  test('rejects malformed snapshot: ' + out, async () => {
    await assert.rejects(captureTerminal(fixture([{ out }])), /malformed/);
  });
}
for (const focused_pane_id of [null, '', 'missing']) {
  test('rejects unavailable focused pane: ' + focused_pane_id, async () => {
    const f = fixture([{ out: JSON.stringify({ result: { snapshot: { focused_pane_id, panes: [] } } }) }]);
    await assert.rejects(captureTerminal(f), /No focused/);
    assert.equal(f.calls.length, 1);
  });
}
for (const step of [{ code: 1 }, { error: true }]) {
  test('read failure is readable: ' + JSON.stringify(step), async () => {
    await assert.rejects(captureTerminal(fixture([{ out: snapshot }, step])), /Unable to/);
  });
}
test('spawn failure is readable', async () => {
  await assert.rejects(captureTerminal({ spawnCommand() { throw Error('ENOENT'); } }), /Unable to start/);
});
test('timeout covers both commands and kills the active child', async () => {
  const f = fixture([{ out: snapshot, delay: 35 }, { hang: true }]);
  await assert.rejects(captureTerminal({ ...f, timeoutMs: 70 }), /timed out/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.children[1].killed, 'SIGKILL');
});
for (const stream of ['out', 'stderr']) {
  test('output budget includes both commands and ' + stream, async () => {
    const f = fixture([{ out: snapshot }, { [stream]: 'x'.repeat(100) }]);
    await assert.rejects(captureTerminal({ ...f, maxBytes: Buffer.byteLength(snapshot) + 99 }), /2 MiB/);
    assert.equal(f.children[1].killed, 'SIGKILL');
  });
}

test('copy endpoint enforces auth/expiry, no-store, method and prepared environment', async t => {
  let time = 0, captures = 0;
  const env = { HERDR_SESSION: 'main' };
  const server = createAuthServer({ username: 'a', passwordHash: await hashPassword('secret'), now: () => time, sessionMs: 10, terminalEnv: env,
    capture: async options => { assert.equal(options.env, env); captures++; return { paneId: 'w1:p2', text: 'hi\n' }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
  let response = await request('/api/terminal/copy');
  assert.equal(response.status, 401); assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(captures, 0);
  const login = await request('/login', { method: 'POST', body: new URLSearchParams({ username: 'a', password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
  response = await request('/api/terminal/copy', { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { paneId: 'w1:p2', text: 'hi\n' });
  assert.equal((await request('/api/terminal/copy', { headers, method: 'POST' })).status, 405);
  time = 11;
  response = await request('/api/terminal/copy?fresh=1', { headers });
  assert.equal(response.status, 401); assert.match((await response.json()).error, /expired/); assert.equal(captures, 1);
});
test('capture errors return readable JSON with auth disabled', async t => {
  const server = createAuthServer({ capture: async () => { throw Error('No focused terminal pane is available.'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/terminal/copy`);
  assert.equal(response.status, 503); assert.match((await response.json()).error, /No focused/);
});
