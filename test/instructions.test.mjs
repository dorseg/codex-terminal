import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installInstructions } from '../app/instructions.mjs';

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-instructions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('global instructions follow allowed ports and preserve personal content across restarts', t => {
  const dir = home(t);
  const path = join(dir, 'AGENTS.md');
  writeFileSync(path, 'Use my coding conventions.\n');
  installInstructions(new Set([3000, 5173]), dir);
  const first = readFileSync(path, 'utf8');
  assert.match(first, /^Use my coding conventions\.\n/);
  assert.match(first, /Allowed app ports: 3000, 5173/);
  assert.match(first, /Prefer port 3000/);
  assert.match(first, /proxy preserves the full/);
  installInstructions(new Set([3000, 5173]), dir);
  assert.equal(readFileSync(path, 'utf8'), first);
  writeFileSync(path, first + '\nMy additional instruction.\n');
  installInstructions(new Set([8080]), dir);
  const updated = readFileSync(path, 'utf8');
  assert.match(updated, /Allowed app ports: 8080/);
  assert.doesNotMatch(updated, /3000, 5173/);
  assert.match(updated, /My additional instruction/);
  assert.equal(updated.match(/codex-terminal:apps:start/g).length, 1);
  installInstructions(new Set(), dir);
  assert.match(readFileSync(path, 'utf8'), /proxying is disabled/);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /Allowed app ports/);
});

test('instructions initialize a new config home and honor nonempty global overrides', t => {
  const dir = home(t);
  const config = join(dir, 'custom-codex-home');
  const path = installInstructions(new Set([3000]), config);
  assert.equal(path, join(config, 'AGENTS.md'));
  const base = readFileSync(path, 'utf8');
  const override = join(config, 'AGENTS.override.md');
  writeFileSync(override, 'My override.\n');
  assert.equal(installInstructions(new Set([5173]), config), override);
  assert.match(readFileSync(override, 'utf8'), /^My override\.\n/);
  assert.match(readFileSync(override, 'utf8'), /Allowed app ports: 5173/);
  assert.equal(readFileSync(path, 'utf8'), base);
  writeFileSync(override, '\n');
  assert.equal(installInstructions(new Set([8080]), config), path);
  assert.match(readFileSync(path, 'utf8'), /Allowed app ports: 8080/);
});

test('browser instructions refresh when switching variants with the same Codex volume', t => {
  const dir = home(t);
  const path = join(dir, 'AGENTS.md');
  writeFileSync(path, 'Keep my project conventions.\n');
  installInstructions(new Set([3000]), dir, true);
  const browser = readFileSync(path, 'utf8');
  assert.match(browser, /Browser validation/);
  assert.match(browser, /playwright-cli open <local-url>/);
  assert.match(browser, /http:\/\/127\.0\.0\.1:<port>\/apps\/<port>\//);
  assert.match(browser, /headless automation/);
  installInstructions(new Set([3000]), dir, true);
  assert.equal(readFileSync(path, 'utf8'), browser);
  installInstructions(new Set([5173]), dir, false);
  const compact = readFileSync(path, 'utf8');
  assert.doesNotMatch(compact, /Browser validation|playwright-cli/);
  assert.match(compact, /^Keep my project conventions\.\n/);
  assert.match(compact, /Allowed app ports: 5173/);
  assert.equal(compact.match(/codex-terminal:apps:start/g).length, 1);
});

test('browser guidance honors global overrides and supports local testing without a public proxy', t => {
  const dir = home(t);
  const override = join(dir, 'AGENTS.override.md');
  writeFileSync(override, 'My personal override.\n');
  assert.equal(installInstructions(new Set(), dir, true), override);
  const instructions = readFileSync(override, 'utf8');
  assert.match(instructions, /^My personal override\.\n/);
  assert.match(instructions, /proxying is disabled/);
  assert.match(instructions, /Headless local testing works even when APP_PORTS is empty/);
  installInstructions(new Set(), dir, false);
  assert.doesNotMatch(readFileSync(override, 'utf8'), /Browser validation|playwright-cli/);
});
