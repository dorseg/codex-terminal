import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
const input = createInterface({ input: process.stdin, output: process.stdout });
try {
  if (process.argv[2] === 'codex') {
    const workspace = process.env.HERDR_ACTIVE_WORKSPACE_ID;
    const cwd = process.env.HERDR_ACTIVE_PANE_CWD;
    if (!workspace || !cwd) throw Error('Missing originating Herdr workspace or directory');
    const choice = (await input.question('Start Codex: [n] normal, [y] YOLO (no approvals or sandbox), [Enter] cancel: ')).trim().toLowerCase();
    if (choice === 'n' || choice === 'y') {
      const herdr = (...args) => execFileSync('herdr', args, { encoding: 'utf8' });
      const result = JSON.parse(herdr('tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', 'Codex', '--focus')).result;
      const pane = result.root_pane?.pane_id;
      if (!pane) throw Error('Herdr did not return a new pane ID');
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      herdr('pane', 'run', pane, `cd -- ${quote(cwd)} && exec codex${choice === 'y' ? ' --yolo' : ''}`);
    }
  } else {
    await import('./drawer.mjs');
    await input.question('\nPress Enter to close. ');
  }
} catch (error) {
  console.error(error.message);
  await input.question('\nPress Enter to close. ');
} finally { input.close(); }
