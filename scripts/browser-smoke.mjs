// Run as the image's default user with --network none and both volumes mounted.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

assert.equal(process.getuid(), 1000, 'browser automation must run as UID 1000');
const workspace = process.env.SMOKE_WORKSPACE || '/workspace';
const codex = process.env.CODEX_HOME || '/home/node/.codex';
await mkdir(codex, { recursive: true });
const directory = await mkdtemp(join(workspace, 'browser-smoke-'));
const sentinel = join(codex, `browser-smoke-${process.pid}`);
const screenshot = join(directory, 'page.png');
const run = promisify(execFile);
const session = `smoke-${process.pid}`;
const cli = async (...args) => {
  const { stdout, stderr } = await run('playwright-cli', [`-s=${session}`, ...args], {
    cwd: directory, timeout: 90000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
  });
  assert.doesNotMatch(stdout + stderr, /### Error|"isError":\s*true/, 'CLI command failed');
  return stdout;
};
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Browser fixture</title><h1>Local browser fixture</h1>' +
    '<button onclick="document.querySelector(\'output\').textContent=\'Clicked successfully\'">Click me</button><output>Waiting</output>');
});
try {
  await writeFile(sentinel, 'Codex volume remains writable\n');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await cli('open', `http://127.0.0.1:${server.address().port}`);
  const snapshot = await cli('snapshot');
  // CLI versions may inline the snapshot or link to an artifact.
  const snapshotPath = snapshot.match(/\[Snapshot\]\(([^)]+)\)/)?.[1];
  const contents = snapshotPath ? await readFile(join(directory, snapshotPath), 'utf8') : snapshot;
  assert.match(contents, /Local browser fixture/);
  const button = contents.match(/button "Click me" \[ref=([^\]]+)\]/)?.[1];
  assert.ok(button, contents);
  await cli('click', button);
  assert.match(await cli('eval', '() => document.querySelector("output").textContent'), /Clicked successfully/);
  await cli('screenshot', `--filename=${screenshot}`);
  const bytes = await readFile(screenshot);
  assert.ok(bytes.length > 100, 'nonempty screenshot saved to the workspace volume');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'valid PNG');
  assert.equal(await readFile(sentinel, 'utf8'), 'Codex volume remains writable\n');
  await cli('close');
  // Project settings must merge with the image's browser defaults.
  await mkdir(join(directory, '.playwright'));
  await writeFile(join(directory, '.playwright/cli.config.json'), JSON.stringify({
    browser: { contextOptions: { viewport: { width: 777, height: 555 } } },
  }));
  await cli('open', `http://127.0.0.1:${server.address().port}`);
  assert.match(await cli('eval', '() => window.innerWidth'), /\b777\b/);
  console.log('UID 1000 Chromium open, snapshot, click, screenshot, workspace/Codex writes and project configuration passed');
} finally {
  try { await cli('close'); } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    await rm(sentinel, { force: true });
  }
}
