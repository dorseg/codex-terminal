import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const bundlePath = process.argv[2];
const bundle = readFileSync(bundlePath, 'utf8');
const serverPath = process.argv[3] || join(dirname(bundlePath), 'cli.mjs');
const server = readFileSync(serverPath, 'utf8');
const mobileInput = readFileSync(new URL('../app/mobile-input.js', import.meta.url), 'utf8');
// Locate Remobi's call to open xterm, where its public textarea API is ready.
const openTerminal = /\b([\w$]+)\.open\([\w$]+\)(?=,document\.documentElement\.style\.background=)/g;
if ([...bundle.matchAll(openTerminal)].length !== 1) {
  throw new Error('Could not locate the Remobi terminal setup for the mobile input fix.');
}
let patched = bundle.replace(openTerminal, (open, terminal) => `${open},installMobileInput(${terminal}),installTerminalImages(${terminal})`);
// The drawer object exposes the same close handler used by its own actions.
const drawerReady = /document\.body\.appendChild\(([\w$]+)\.backdrop\),document\.body\.appendChild\(\1\.drawer\),await ([\w$]+)\.runDrawerCreated\(/g;
const drawerInterface = /\{backdrop:[\w$]+,drawer:[\w$]+,open:[\w$]+,close:[\w$]+,isOpen:[\w$]+\}/g;
const socketState = /window\.__remobiSockets=\[[\w$]+\]/g;
const drawerGrid = /id:"wt-drawer-grid"/g;
if ([...patched.matchAll(socketState)].length !== 1 ||
    [...patched.matchAll(drawerReady)].length !== 1 ||
    [...patched.matchAll(drawerInterface)].length !== 1 ||
    [...patched.matchAll(drawerGrid)].length !== 1) {
  throw new Error('Could not locate the Remobi drawer or connection setup for terminal copy and image attachments.');
}
patched = patched.replace(drawerReady, (match, drawer) => match.replace(',await ', `,installTerminalCopy(${drawer}),installImageAttachments(${drawer}),await `));
const mobileCopy = readFileSync(new URL('../app/mobile-copy.js', import.meta.url), 'utf8');
const imageAttachments = readFileSync(new URL('../app/image-attachments.js', import.meta.url), 'utf8');
// Remobi's default policy blocks the blob URLs used by local thumbnails.
// Validate both files before modifying either integration point.
const imagePolicy = /img-src 'self' data:;/g;
if ([...server.matchAll(imagePolicy)].length !== 1) {
  throw new Error('Could not locate the unique Remobi image security policy for image previews.');
}
const patchedServer = server.replace(imagePolicy, "img-src 'self' data: blob:;");
writeFileSync(serverPath, patchedServer);
writeFileSync(bundlePath, `${mobileInput}\n${mobileCopy}\n${imageAttachments}\n${patched}`);
