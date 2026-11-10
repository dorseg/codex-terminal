import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appPorts } from './apps.mjs';

async function showUsage() {
  const server = spawn('codex', ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: server.stdout });
  const timer = setTimeout(() => server.kill(), 10_000);
  server.stdin.on('error', () => {});
  server.on('error', () => lines.close());
  const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
  send({ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'remobi_drawer', title: 'Remobi Drawer', version: '1.0.0' },
  } });

  try {
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.id === 1 && message.result) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (message.id === 2) {
        const limits = message.result?.rateLimits;
        const windows = [limits?.primary, limits?.secondary];
        for (const [minutes, label] of [[300, '5-hour'], [10080, 'Weekly']]) {
          const limit = windows.find((window) => window?.windowDurationMins === minutes);
          const left = Number.isFinite(limit?.usedPercent)
            ? `${Math.round(Math.max(0, Math.min(100, 100 - limit.usedPercent)))}% left`
            : 'Unavailable';
          console.log(`${label}: ${left}`);
        }
        if (message.error) console.log(message.error.message);
        return;
      } else if (message.id === 1 && message.error) {
        throw new Error(message.error.message);
      }
    }
    throw new Error('Codex did not return usage limits.');
  } finally {
    clearTimeout(timer);
    lines.close();
    server.kill();
  }
}

async function showPorts() {
  const ports = appPorts(process.env.APP_PORTS);
  if (!ports.size) {
    console.log('No app ports configured.');
    return;
  }
  const statuses = await Promise.all([...ports].map(async (port) => {
    const path = `/apps/${port}/`;
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: 'manual', signal: AbortSignal.timeout(1500),
      });
      await response.body?.cancel();
      return `${path}  HTTP ${response.status}`;
    } catch {
      return `${path}  No response`;
    }
  }));
  console.log(statuses.join('\n'));
}

try {
  if (process.argv[2] === 'usage') await showUsage();
  else if (process.argv[2] === 'ports') await showPorts();
} catch (error) {
  console.log(`Unavailable: ${error.message}`);
}
