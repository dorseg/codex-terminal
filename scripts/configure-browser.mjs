// Resolve Chromium from the CLI's own dependency, never a separately installed Playwright.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(join(process.argv[2], 'package.json'));
const { chromium } = require('playwright');
const executablePath = chromium.executablePath();
await access(executablePath, constants.R_OK | constants.X_OK);
console.log(`Playwright ${require('playwright/package.json').version}`);
console.log(execFileSync(executablePath, ['--version'], { encoding: 'utf8' }).trim());
const directory = join(homedir(), '.playwright');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'cli.config.json'), JSON.stringify({
  browser: {
    browserName: 'chromium',
    launchOptions: { executablePath, headless: true },
  },
}, null, 2) + '\n');
