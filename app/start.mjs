import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { appPorts } from './apps.mjs';
import { installInstructions } from './instructions.mjs';
import { credentials, createAuthServer } from './auth.mjs';

let auth, ports, config;
try {
  auth = credentials();
  ports = appPorts(process.env.APP_PORTS);
  installInstructions(ports);
  const dir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'remobi');
  mkdirSync(dir, { recursive: true });
  config = join(dir, 'remobi.config.js');
  try { writeFileSync(config, '// Customize Remobi controls, gestures, and appearance. Restart to apply.\nexport default {};\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
} catch (error) { console.error(error.message); process.exit(1); }
const args = ['serve', '--config', config, '--host', '127.0.0.1', '--port', '7682', '--', 'tmux', 'new-session', '-A', '-s', 'main', '-c', '/workspace', '/bin/bash'];
const childEnv = { ...process.env };
delete childEnv.AUTH_USERNAME;
delete childEnv.AUTH_PASSWORD;
delete childEnv.AUTH_PASSWORD_HASH;
delete childEnv.TMUX;
delete childEnv.TMUX_PANE;
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.resolve('remobi')));
const child = spawn(process.execPath, [cli, ...args], { cwd: '/workspace', stdio: 'inherit', env: childEnv });
const server = createAuthServer({ ...auth, appPorts: ports });
let shuttingDown = false;
function stop(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  server?.shutdown();
  child.kill(signal);
  setTimeout(() => child.kill('SIGKILL'), 5000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.on('error', error => { console.error(`Unable to start Remobi: ${error.message}`); server?.shutdown(); process.exitCode = 1; });
child.on('exit', code => { server?.shutdown(); process.exitCode ||= code ?? (shuttingDown ? 0 : 1); });
server.on('error', error => { console.error(`Unable to start terminal server: ${error.message}`); process.exitCode = 1; stop(); });
server?.listen(7681, '0.0.0.0');
