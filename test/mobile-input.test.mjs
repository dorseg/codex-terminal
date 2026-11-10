import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../app/mobile-input.js', import.meta.url), 'utf8');

async function mobileTerminal() {
  const input = [];
  const listeners = new Map();
  const textarea = new EventTarget();
  textarea.value = '';
  textarea.setAttribute = () => {};
  const terminal = {
    textarea,
    element: { addEventListener: (type, handler) => listeners.set(type, handler) },
    input: data => input.push(data),
    onKey: handler => listeners.set('xtermKey', handler),
  };
  const bridge = { input: terminal.input };
  runInNewContext(`${script}\ninstallMobileInput(terminal);`, {
    terminal, matchMedia: () => ({ matches: true }), window: { term: bridge },
    queueMicrotask, setTimeout, clearTimeout,
  });
  await Promise.resolve();

  return {
    input, bridge, textarea,
    event(type, properties = {}) {
      let stopped = false;
      listeners.get(type)({ target: textarea, stopPropagation: () => { stopped = true; }, ...properties });
      return stopped;
    },
    edit(value, inputType = 'insertText', data) {
      textarea.value = value;
      assert.equal(this.event('input', { inputType, data }), true);
    },
    keypress(key) {
      listeners.get('xtermKey')({ key, domEvent: { type: 'keypress' } });
      terminal.input(key);
    },
  };
}

test('mobile keyboard text and replacement edits reach the terminal once', async () => {
  const terminal = await mobileTerminal();
  assert.equal(terminal.event('keydown', { key: 'Process', keyCode: 229 }), true);
  terminal.edit('helo', 'insertText', 'helo');
  terminal.edit('hello ', 'insertReplacementText', 'hello ');
  terminal.edit('hell', 'deleteContentBackward');
  assert.deepEqual(terminal.input, ['helo', '\x7flo ', '\x7f\x7f']);

  terminal.keypress(' ');
  terminal.edit('hell ', 'insertText', ' ');
  terminal.event('keyup');
  assert.equal(terminal.input.at(-1), ' ');
  assert.equal(terminal.input.length, 4);
});

test('mobile deletion still reaches the terminal after a toolbar key clears the textarea', async () => {
  const terminal = await mobileTerminal();
  terminal.edit('abc', 'insertText', 'abc');
  terminal.bridge.input('\x1b[D');
  assert.equal(terminal.textarea.value, '');

  let prevented = false;
  terminal.event('beforeinput', {
    inputType: 'deleteContentBackward', cancelable: true,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.deepEqual(terminal.input, ['abc', '\x1b[D', '\x7f']);
});
