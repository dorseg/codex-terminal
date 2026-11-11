// Native persistence checks; no agent account or network service required.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
const binary = process.env.HERDR_BIN || 'herdr';
const root = process.env.TERMINAL_ROOT || '/opt/codex-terminal';
const phase = process.env.SMOKE_STATE_PHASE;
const dir = process.env.SMOKE_STATE_HOME || await mkdtemp('/tmp/herdr-state-');
const env = { ...process.env, HOME: dir, CODEX_HOME: join(dir, '.codex'), XDG_CONFIG_HOME: join(dir, '.config'), HERDR_SESSION: 'main', TERM: 'xterm-256color' };
for (const key of Object.keys(env)) if ((key.startsWith('HERDR_') && key !== 'HERDR_SESSION') || key === 'CODEX_THREAD_ID') delete env[key];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i=0;i<120;i++) { try { if(await check()) return; } catch {} await pause(100); }
  throw Error('Timed out: '+label);
}
const cli = (...args) => {
  const output = execFileSync(binary, args, { env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  if(args[0] === 'pane' && args[1] === 'read') return { text: output };
  if (!output.trim()) return {};
  const response = JSON.parse(output);
  if(response.error) throw Error(JSON.stringify(response.error));
  return response.result;
};
const snapshot = () => cli('api','snapshot').snapshot;
let client;
async function attach(cols = 120, rows = 40) {
  // util-linux script provides a real terminal while keeping this test portable.
  const quote = value => "'"+value.replaceAll("'", "'\\''")+"'";
  client = spawn('script', ['-qefc', `stty cols ${cols} rows ${rows}; exec ${quote(binary)} --session main`, '/dev/null'], { env, cwd: '/workspace', stdio: ['pipe','pipe','pipe'] });
  client.stdout.resume(); client.stderr.resume();
  await until(() => snapshot().panes.length > 0, 'client attach');
}
async function stop() {
  execFileSync(binary, ['session','stop','main'], { env, timeout: 5000, stdio: 'pipe' });
  if(client.exitCode === null) await Promise.race([once(client,'exit'), pause(3000)]);
  if(client.exitCode === null) client.kill('SIGKILL');
}
try {
  let original, pane, before;
  if (phase !== 'restore') {
  await mkdir(join(dir,'.config'), {recursive:true});
  await mkdir(join(env.CODEX_HOME,'herdr'), {recursive:true});
  await symlink(join(env.CODEX_HOME,'herdr'), join(dir,'.config/herdr'));
  await writeFile(join(dir,'.config/herdr/config.toml'), await readFile(join(root,'herdr.toml')));
  await writeFile(join(env.CODEX_HOME,'config.toml'), 'model = "fixture-model"\n[features]\nunrelated = true\n');
  await writeFile(join(env.CODEX_HOME,'hooks.json'), JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'echo preserved-hook'}]}]}}));
  execFileSync(binary, ['integration','install','codex'], { env, stdio: 'pipe' });
  const hooks = await readFile(join(env.CODEX_HOME,'hooks.json'),'utf8');
  assert.match(hooks, /herdr-agent-state/);
  assert.match(hooks, /preserved-hook/);
  execFileSync(binary, ['integration','install','codex'], { env, stdio: 'pipe' });
  assert.equal(await readFile(join(env.CODEX_HOME,'hooks.json'),'utf8'),hooks,'integration install is idempotent');
  const settings = await readFile(join(env.CODEX_HOME,'config.toml'),'utf8');
  assert.match(settings, /model = "fixture-model"/);
  assert.match(settings, /unrelated = true/);
  assert.match(settings, /hooks = true/);
  await attach();
  original = snapshot().panes[0];
  assert.equal(original.cwd, '/workspace');
  cli('pane','run',original.pane_id, 'export ORDINARY_SHELL_SENTINEL=lost; cd /tmp');
  await until(() => snapshot().panes[0].foreground_cwd === '/tmp','live cwd');
  cli('pane','split',original.pane_id,'--direction','right','--cwd','/workspace','--no-focus');
  const created = cli('tab','create','--cwd','/workspace','--label','restore-agent','--focus');
  pane = created.root_pane.pane_id;
  // Deterministic Codex stand-in records the official native session reference.
  await mkdir(join(dir,'bin'));
  await writeFile(join(dir,'bin/codex'), `#!/bin/sh\nprintf 'FIXTURE_%s:%s\\n' "$1" "$2"\nexec sleep 600\n`, {mode:0o755});
  // PATH is inherited by shells and survives in their startup environment.
  cli('pane','run',pane, `export PATH="${join(dir,'bin')}:$PATH"; codex start fixture-conversation`);
  await until(() => cli('pane','read',pane).text?.includes('FIXTURE_start'), 'fixture agent');
  cli('pane','report-agent-session',pane,'--source','herdr:codex','--agent','codex','--agent-session-id','fixture-conversation','--seq','1');
  before = snapshot();
  await writeFile(join(dir, 'expected.json'), JSON.stringify({ original, pane, before }));
  await stop();
  } else ({ original, pane, before } = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')));
  if (phase !== 'save') {
  env.PATH = join(dir,'bin')+':'+env.PATH;
  // Reattaching at a different viewport must preserve the saved split structure.
  await attach(100, 30);
  await until(() => snapshot().tabs.length === before.tabs.length,'layout restore');
  const after = snapshot();
  assert.deepEqual(after.tabs.map(t=>t.label),before.tabs.map(t=>t.label));
  assert.equal(after.panes.length, before.panes.length);
  // Rectangles change with viewport size and may still reflect headless geometry.
  const structure = state => state.layouts.map(layout => ({
    tab: layout.tab_id,
    splits: layout.splits.map(({ id, direction, ratio }) => ({ id, direction, ratio })),
  }));
  assert.deepEqual(structure(after), structure(before));
  assert.equal(after.panes.find(p=>p.pane_id === original.pane_id).cwd,'/tmp');
  cli('pane','run',original.pane_id, 'printf "SHELL_RESTART_%s\\n" "${ORDINARY_SHELL_SENTINEL-unset}"');
  await until(() => cli('pane','read',original.pane_id).text?.includes('SHELL_RESTART_unset'),'ordinary shell restarts');
  await until(() => cli('pane','read',pane).text?.includes('FIXTURE_resume:fixture-conversation'),'native agent resume');
  console.log('Herdr layout, directory, fresh shell and native agent resume passed');
  } else console.log('Herdr state saved for container recreation');
} finally {
  try { await stop(); } catch {}
  if (!process.env.SMOKE_STATE_HOME) await rm(dir,{recursive:true,force:true});
}
