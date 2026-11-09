import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashPassword } from '../app/password.mjs';

async function launch(t, { mode = 'normal', customHome = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'termbeam-launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = join(dir, 'fixture.mjs');
  await writeFile(fixture, `
console.log(JSON.stringify({ args:process.argv.slice(2), cwd:process.env.TEST_CWD, config:process.env.TERMBEAM_CONFIG_DIR, initialCwd:process.env.TERMBEAM_CWD, user:process.env.AUTH_USERNAME, password:process.env.AUTH_PASSWORD, hash:process.env.AUTH_PASSWORD_HASH }));
if (process.env.TEST_MODE === 'exit') process.exit(7);
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{console.log(signal);if(process.env.TEST_MODE !== 'stubborn')process.exit(0)});
setInterval(()=>{},1000);
`);
  const preload = join(dir, 'preload.mjs');
  await writeFile(preload, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Server } from 'node:http';
const original = cp.spawn;
cp.spawn = (command, args, options) => {
  if (!args[0].endsWith('/termbeam/bin/termbeam.js')) throw Error('Unexpected CLI: '+args[0]);
  const testOptions = { ...options, cwd: ${JSON.stringify(dir)}, env: { ...options.env, TEST_CWD: options.cwd } };
  return process.env.TEST_MODE === 'error' ? original('/missing-termbeam', [], testOptions) : original(command, [${JSON.stringify(fixture)}, ...args.slice(1)], testOptions);
};
syncBuiltinESMExports();
const listen = Server.prototype.listen;
Server.prototype.listen = function(port, ...args) { return listen.call(this, port === 7681 ? 0 : port, ...args); };
`);
  const env = { ...process.env, HOME: dir, APP_PORTS: '', AUTH_USERNAME: 'alice', AUTH_PASSWORD: '', AUTH_PASSWORD_HASH: await hashPassword('secret'), TERMBEAM_CONFIG_DIR: '/ignored', TERMBEAM_CWD: '/ignored', PTY_CWD: '/ignored', TEST_MODE: mode };
  if (customHome) env.CODEX_HOME = join(dir, 'config'); else delete env.CODEX_HOME;
  const child = spawn(process.execPath, ['--import', preload, resolve('app/start.mjs')], { env });
  t.after(() => child.kill('SIGKILL'));
  let output = '', stderr = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const ready = async () => {
    const timeout = Date.now() + 5000;
    while (!output.includes('\n')) {
      if (Date.now() > timeout || child.exitCode !== null) throw Error(stderr || 'Launcher did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return JSON.parse(output.split('\n')[0]);
  };
  return { child, dir, ready, exited, output: () => output, stderr: () => stderr };
}

for (const customHome of [true, false]) test('launcher sets CLI, cwd, private environment and config, customHome=' + customHome, { timeout: 10000 }, async t => {
  const run = await launch(t, { customHome });
  const info = await run.ready();
  assert.deepEqual(info.args, ['--no-tunnel', '--no-password', '--host', '127.0.0.1', '--port', '7682', '/bin/bash']);
  assert.equal(info.cwd, '/workspace');
  assert.equal(info.initialCwd, '/workspace');
  assert.equal(info.config, join(run.dir, customHome ? 'config' : '.codex', 'termbeam'));
  for (const key of ['user', 'password', 'hash']) assert.equal(info[key], undefined);
  assert.match(await readFile(join(info.config, '..', 'AGENTS.md'), 'utf8'), /Codex Terminal web app environment/);
  run.child.kill(customHome ? 'SIGTERM' : 'SIGINT');
  assert.deepEqual(await run.exited, { code: 0, signal: null });
  assert.match(run.output(), customHome ? /SIGTERM/ : /SIGINT/);
});

test('launcher propagates child exit and handles spawn errors', { timeout: 10000 }, async t => {
  const failed = await launch(t, { mode: 'exit' });
  assert.equal((await failed.exited).code, 7);
  const missing = await launch(t, { mode: 'error' });
  assert.equal((await missing.exited).code, 1);
  assert.match(missing.stderr(), /Unable to start TermBeam/);
});

test('launcher forces termination after five seconds', { timeout: 10000 }, async t => {
  const run = await launch(t, { mode: 'stubborn' });
  await run.ready();
  run.child.kill('SIGTERM');
  assert.equal((await run.exited).code, 0);
  assert.match(run.output(), /SIGTERM/);
});
