import { prepareHerdr } from './herdr.mjs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { appPorts } from './apps.mjs';
import { installInstructions } from './instructions.mjs';
import { credentials, createAuthServer } from './auth.mjs';

let auth, ports, config, childEnv;
try {
  auth = credentials();
  ports = appPorts(process.env.APP_PORTS);
  installInstructions(ports);
  ({ config, env: childEnv } = prepareHerdr());
} catch (error) { console.error(error.message); process.exit(1); }
const args = ['serve', '--config', config, '--host', '127.0.0.1', '--port', '7682', '--', 'herdr', '--session', 'main'];
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.resolve('remobi')));
const child = spawn(process.execPath, [cli, ...args], { cwd: '/workspace', stdio: 'inherit', env: childEnv });
const server = createAuthServer({ ...auth, appPorts: ports, terminalEnv: childEnv });
let shuttingDown = false;
function stop(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  server?.shutdown();
  const stopper = spawn('herdr', ['session', 'stop', 'main'], { env: childEnv, stdio: 'ignore' });
  const forceStop = setTimeout(() => stopper.kill('SIGKILL'), 3000);
  const terminate = () => { clearTimeout(forceStop); child.kill(signal); };
  stopper.once('error', terminate);
  stopper.once('exit', terminate);
  setTimeout(() => { child.kill('SIGKILL'); process.exit(process.exitCode || 0); }, 6000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.on('error', error => { console.error(`Unable to start Remobi: ${error.message}`); process.exitCode = 1; stop(); });
child.on('exit', code => { process.exitCode ||= shuttingDown ? 0 : (code ?? 1); stop(); });
server.on('error', error => { console.error(`Unable to start terminal server: ${error.message}`); process.exitCode = 1; stop(); });
server?.listen(7681, '0.0.0.0');
