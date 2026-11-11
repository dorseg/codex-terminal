import { readFileSync, writeFileSync } from 'node:fs';

const bundlePath = process.argv[2];
const bundle = readFileSync(bundlePath, 'utf8');
const mobileInput = readFileSync(new URL('../app/mobile-input.js', import.meta.url), 'utf8');
// Locate Remobi's call to open xterm, where its public textarea API is ready.
const openTerminal = /\b([\w$]+)\.open\([\w$]+\)(?=,document\.documentElement\.style\.background=)/g;
if ([...bundle.matchAll(openTerminal)].length !== 1) {
  throw new Error('Could not locate the Remobi terminal setup for the mobile input fix.');
}
const patched = bundle.replace(openTerminal, (open, terminal) => `${open},installMobileInput(${terminal})`);
writeFileSync(bundlePath, `${mobileInput}\n${patched}`);
