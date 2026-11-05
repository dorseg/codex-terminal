import { emitKeypressEvents } from 'node:readline';
import { hashPassword } from './password.mjs';

function hiddenPrompt(prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.removeListener('end', onEnd);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write('\n');
    };
    const onEnd = () => { cleanup(); reject(new Error('Password input ended.')); };
    const onKey = (text, key) => {
      if (key?.ctrl && (key.name === 'c' || key.name === 'd')) { cleanup(); reject(new Error('Cancelled.')); }
      else if (key?.name === 'return' || key?.name === 'enter') { cleanup(); resolve(value); }
      else if (key?.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
      else if (text && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    process.stderr.write(prompt);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKey);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

try {
  if (!process.stdin.isTTY || process.argv.length > 2) {
    throw new Error('Run hash-password interactively in a terminal, without password arguments.');
  }
  const password = await hiddenPrompt('Password: ');
  if (!password) throw new Error('Password must not be empty.');
  const confirmation = await hiddenPrompt('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  console.log(await hashPassword(password));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
