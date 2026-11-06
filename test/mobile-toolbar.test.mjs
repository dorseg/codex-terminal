import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { terminalPage } from '../app/terminal.mjs';

test('mobile toolbar client JS is syntactically valid', () => {
  const script = readFileSync(new URL('../app/assets/terminal.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Script(script));
});

test('customized ttyd page contains toolbar with responsive styles', () => {
  const html = terminalPage('<html><head><meta name="viewport" content="width=1000"><title>ttyd</title></head><body><div id="terminal-container"></div></body></html>');
  assert.match(html, /id = 'mobile-terminal-keys'/);
  assert.match(html, /max-width:767px/);
  assert.match(html, /pointer:coarse/);
  assert.match(html, /Ctrl\+C/);
  assert.match(html, /ArrowUp/);
  assert.match(html, /--terminal-height/);
  assert.doesNotMatch(html, /width=1000/);
});
