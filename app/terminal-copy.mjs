import { spawn } from 'node:child_process';

// One budget covers focus lookup and extraction, including stderr.
export async function captureTerminal({ env = process.env, spawnCommand = spawn, timeoutMs = 5000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let remaining = maxBytes;
  function command(args) {
    return new Promise((resolve, reject) => {
      let child, settled = false;
      const chunks = [];
      function finish(error, value) {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener('abort', abort);
        if (error) child?.kill('SIGKILL');
        error ? reject(error) : resolve(value);
      }
      const abort = () => finish(Error('Terminal capture timed out. Please retry.'));
      if (controller.signal.aborted) return abort();
      try { child = spawnCommand('herdr', args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
      catch { return finish(Error('Unable to start Herdr for terminal capture.')); }
      controller.signal.addEventListener('abort', abort, { once: true });
      for (const [stream, stdout] of [[child.stdout, true], [child.stderr, false]]) {
        stream.on('data', chunk => {
          remaining -= chunk.length;
          if (remaining < 0) return finish(Error('Terminal capture exceeds the 2 MiB output limit.'));
          if (!settled && stdout) chunks.push(chunk);
        });
      }
      child.once('error', () => finish(Error('Unable to start Herdr for terminal capture.')));
      child.once('close', code => code === 0
        ? finish(null, Buffer.concat(chunks).toString('utf8'))
        : finish(Error('Unable to read the terminal pane. It may have closed; please retry.')));
    });
  }
  try {
    const raw = await command(['api', 'snapshot']);
    let snapshot;
    try {
      const response = JSON.parse(raw);
      if (response.error) throw Error();
      snapshot = response.result.snapshot;
      if (!snapshot || !Array.isArray(snapshot.panes) ||
          !snapshot.panes.every(pane => pane && typeof pane.pane_id === 'string')) throw Error();
    } catch { throw Error('Herdr returned a malformed focus snapshot. Please retry.'); }
    const paneId = snapshot.focused_pane_id;
    if (typeof paneId !== 'string' || !paneId || !snapshot.panes.some(pane => pane.pane_id === paneId)) {
      throw Error('No focused terminal pane is available. Please retry.');
    }
    const text = await command(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '500']);
    return { paneId, text };
  } finally { clearTimeout(timer); }
}
