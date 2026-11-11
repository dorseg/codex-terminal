import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm, readFile, readlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashPassword } from '../app/password.mjs';

async function launch(t, { mode = 'normal', customHome = true, existingConfig = false, conflict = false, correctLink = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'remobi-launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = join(dir, 'fixture.mjs');
  await writeFile(fixture, `
console.log(JSON.stringify({ args:process.argv.slice(2), cwd:process.env.TEST_CWD, session:process.env.HERDR_SESSION, config:process.env.HERDR_CONFIG_PATH, socket:process.env.HERDR_SOCKET_PATH, workspace:process.env.HERDR_WORKSPACE_ID, sty:process.env.STY, zellij:process.env.ZELLIJ, tmux:process.env.TMUX, pane:process.env.TMUX_PANE, user:process.env.AUTH_USERNAME, password:process.env.AUTH_PASSWORD, hash:process.env.AUTH_PASSWORD_HASH }));
if (process.env.TEST_MODE === 'exit') process.exit(7);
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{console.log(signal);if(process.env.TEST_MODE !== 'stubborn')process.exit(0)});
setInterval(()=>{},1000);
`);
  const preload = join(dir, 'preload.mjs');
  await writeFile(preload, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Server } from 'node:http';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'remobi') return { url: 'file:///fixture/remobi/dist/src/index.mjs', shortCircuit: true };
  return next(specifier, context);
} });
const original = cp.spawn;
cp.execFileSync = (command, args, options) => {
  if(command !== 'herdr' || args.join(' ') !== 'integration install codex') throw Error('Unexpected integration command');
  if(process.env.TEST_MODE === 'integration-error') throw Error('fixture integration failed');
  return '';
};
cp.spawn = (command, args, options) => {
  if (command === 'herdr') return original(process.execPath, ['-e', process.env.TEST_MODE === 'stubborn' ? 'setInterval(()=>{},1000)' : 'process.exit(0)'], { ...options, env: process.env });
  if (!args[0].endsWith('/remobi/dist/cli.mjs')) throw Error('Unexpected CLI: '+args[0]);
  const testOptions = { ...options, cwd: ${JSON.stringify(dir)}, env: { ...options.env, TEST_CWD: options.cwd } };
  return process.env.TEST_MODE === 'error' ? original('/missing-remobi', [], testOptions) : original(command, [${JSON.stringify(fixture)}, ...args.slice(1)], testOptions);
};
syncBuiltinESMExports();
const listen = Server.prototype.listen;
Server.prototype.listen = function(port, ...args) { return listen.call(this, port === 7681 ? 0 : port, ...args); };
`);
  const env = { ...process.env, HOME: dir, APP_PORTS: '', AUTH_USERNAME: 'alice', AUTH_PASSWORD: '', AUTH_PASSWORD_HASH: await hashPassword('secret'), STY: 'old-screen', ZELLIJ: '1', HERDR_WORKSPACE_ID: 'old-workspace', HERDR_SESSION: 'wrong', HERDR_SOCKET_PATH: '/wrong', TMUX: '/inherited', TMUX_PANE: '%42', TEST_MODE: mode };
  if (customHome) env.CODEX_HOME = join(dir, 'config'); else delete env.CODEX_HOME;
  if (existingConfig) {
    await mkdir(join(env.CODEX_HOME, 'herdr'), { recursive: true });
    await writeFile(join(env.CODEX_HOME, 'herdr', 'config.toml'), 'onboarding = false\n# my settings\n');
    await writeFile(join(env.CODEX_HOME, 'herdr', 'remobi.config.js'), 'export default { name: "mine" };\n');
  }
  await mkdir(join(dir, 'config/remobi'), {recursive:true});
  await writeFile(join(dir,'config/remobi/remobi.config.js'), 'legacy untouched');
  if(correctLink) {
    await mkdir(join(dir, 'config/herdr'), {recursive:true});
    await mkdir(join(dir, '.config'), {recursive:true});
    await symlink(join(dir,'config/herdr'), join(dir,'.config/herdr'));
  }
  if(conflict) await mkdir(join(dir, '.config/herdr'), {recursive:true});
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
  const config = join(run.dir, customHome ? 'config' : '.codex', 'herdr', 'remobi.config.js');
  assert.deepEqual(info.args, ['serve', '--config', config, '--host', '127.0.0.1', '--port', '7682', '--', 'herdr', '--session', 'main']);
  assert.equal(await readFile(config, 'utf8'), await readFile(new URL('../app/remobi.config.js', import.meta.url), 'utf8'));
  assert.equal(info.session, 'main');
  assert.equal(info.config, join(config, '..', 'config.toml'));
  assert.equal(await readlink(join(run.dir, '.config/herdr')), join(config, '..'));
  assert.equal(await readFile(join(config, '..', 'config.toml'), 'utf8'), await readFile(new URL('../app/herdr.toml', import.meta.url), 'utf8'));
  assert.equal(info.cwd, '/workspace');
  for (const key of ['user', 'password', 'hash', 'tmux', 'pane', 'socket', 'workspace', 'sty', 'zellij']) assert.equal(info[key], undefined);
  assert.match(await readFile(join(config, '..', '..', 'AGENTS.md'), 'utf8'), /Codex Terminal web app environment/);
  run.child.kill(customHome ? 'SIGTERM' : 'SIGINT');
  assert.deepEqual(await run.exited, { code: 0, signal: null });
  assert.match(run.output(), customHome ? /SIGTERM/ : /SIGINT/);
});

test('launcher propagates child exit and handles spawn errors', { timeout: 10000 }, async t => {
  const failed = await launch(t, { mode: 'exit' });
  assert.equal((await failed.exited).code, 7);
  const missing = await launch(t, { mode: 'error' });
  assert.equal((await missing.exited).code, 1);
  assert.match(missing.stderr(), /Unable to start Remobi/);
});

test('launcher forces termination within six seconds', { timeout: 10000 }, async t => {
  const run = await launch(t, { mode: 'stubborn' });
  await run.ready();
  run.child.kill('SIGTERM');
  assert.equal((await run.exited).code, 0);
  assert.match(run.output(), /SIGTERM/);
});

test('launcher preserves an existing editable configuration', async t => {
  const run = await launch(t, { existingConfig: true, correctLink: true });
  await run.ready();
  assert.equal(await readFile(join(run.dir, 'config/herdr/remobi.config.js'), 'utf8'), 'export default { name: "mine" };\n');
  assert.equal(await readFile(join(run.dir,'config/herdr/config.toml'),'utf8'),'onboarding = false\n# my settings\n');
  assert.equal(await readFile(join(run.dir,'config/remobi/remobi.config.js'),'utf8'),'legacy untouched');
  run.child.kill('SIGTERM');
  assert.equal((await run.exited).code, 0);
});

for(const options of [{mode:'integration-error'}, {conflict:true}]) test('launcher fails clearly: '+JSON.stringify(options), async t => {
 const run=await launch(t, options); assert.equal((await run.exited).code,1); assert.match(run.stderr(), /integration|Conflicting Herdr/);
});
