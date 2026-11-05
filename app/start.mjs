import { spawn } from 'node:child_process';
import { credentials, createAuthServer } from './auth.mjs';

let auth;
try { auth = credentials(); } catch (error) { console.error(error.message); process.exit(1); }
const args = ['--writable', '--port', auth ? '7682' : '7681',
  ...(auth ? ['--interface', '127.0.0.1'] : []),
  '--client-option', 'fontSize=24', '--client-option', 'lineHeight=1.2',
  '--client-option', 'titleFixed=Codex Terminal',
  'tmux', 'new-session', '-A', '-s', 'main'];
const childEnv = { ...process.env };
delete childEnv.AUTH_USERNAME;
delete childEnv.AUTH_PASSWORD;
delete childEnv.AUTH_PASSWORD_HASH;
const child = spawn('ttyd', args, { stdio: 'inherit', env: childEnv });
const server = auth ? createAuthServer(auth) : null;
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
child.on('error', error => { console.error(`Unable to start ttyd: ${error.message}`); server?.shutdown(); process.exitCode = 1; });
child.on('exit', code => { server?.shutdown(); process.exitCode ||= code ?? (shuttingDown ? 0 : 1); });
server?.on('error', error => { console.error(`Unable to start login server: ${error.message}`); process.exitCode = 1; stop(); });
server?.listen(7681, '0.0.0.0');
