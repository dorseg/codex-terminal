import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function installInstructions(ports, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), browserAvailable = existsSync('/opt/playwright-browsers') && existsSync('/usr/local/bin/playwright-cli')) {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const override = join(codexHome, 'AGENTS.override.md');
  const path = existsSync(override) && readFileSync(override, 'utf8').trim() ? override : join(codexHome, 'AGENTS.md');
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const routing = ports.size ? `
- Allowed app ports: ${[...ports].join(', ')}. Prefer port ${[...ports][0]} for a new app unless it is already in use; use another allowed port if available. Use a fixed port and disable automatic port fallback.
- Apps are accessed through the terminal's public origin at /apps/<port>/, proxied to http://127.0.0.1:<port> inside this container. Bind the app to 127.0.0.1. Only the terminal's port 7681 is published; do not require extra Docker port mappings.
- The proxy preserves the full /apps/<port>/ prefix. Configure the app's base path, assets, client routes, API requests, redirects, and cookie paths accordingly. In Vite, set base: '/apps/<port>/', server.host: '127.0.0.1', server.port to the chosen port, and server.strictPort: true. Vite transforms source asset paths using base; do not double-prefix them.
- Keep live reload WebSockets on the public page's origin and app prefix. Do not direct the browser to a private container address or internal app port. If the dev server checks hostnames, allow the user's external hostname explicitly.
- When asked to build and run a web app, install dependencies, start it in a dedicated named Herdr tab or pane so it remains running, and verify the prefixed URL responds through http://127.0.0.1:7681/apps/<port>/ from inside the container.
- Tell the user to open /apps/<port>/ on the same browser origin they use for this terminal. Do not invent the external hostname or assume the external port is 7681. Apps share the terminal's optional login.
` : '\n- Web app proxying is disabled because APP_PORTS is empty. Before promising a browser preview, explain that the container must be recreated with APP_PORTS listing the desired app ports.\n';
  const browser = browserAvailable ? `
### Browser validation

- This image includes global playwright-cli (@playwright/cli) and matching Chromium, configured for headless automation as the node user. Use playwright-cli --help to discover commands. No browser download, project initialization, or skill installation is needed.
- When creating or modifying a web app, use playwright-cli to validate the relevant user flows: open the page, inspect its snapshot, interact with controls, verify the result, and save a screenshot when useful. Report what was tested and any checks that could not run.
- Open the app directly inside the container at http://127.0.0.1:<port>/apps/<port>/ when it uses the proxy base path, or its actual local URL otherwise. Headless local testing works even when APP_PORTS is empty; public previews still require the app proxy configuration above.
- Typical commands: playwright-cli open <local-url>, playwright-cli snapshot, playwright-cli click <ref-from-snapshot>, playwright-cli screenshot --filename=/workspace/screenshot.png, and playwright-cli close. Close the browser session after validation while leaving the app running for the user.
- Global browser defaults live in /home/node/.playwright/cli.config.json. Project .playwright/cli.config.json (or --config), PLAYWRIGHT_MCP_* variables, and command-line options can override those defaults.
` : '';
  const block = `<!-- codex-terminal:apps:start -->\n## Codex Terminal web app environment\n\nWhen creating or running web apps in this container, use these environment defaults unless the user or project instructions say otherwise.\n${routing}${browser}<!-- codex-terminal:apps:end -->\n`;
  const managed = /<!-- codex-terminal:apps:start -->[\s\S]*?<!-- codex-terminal:apps:end -->\n?/g;
  const updated = previous.includes('<!-- codex-terminal:apps:start -->')
    ? previous.replace(managed, () => block)
    : previous + (previous && !previous.endsWith('\n\n') ? (previous.endsWith('\n') ? '\n' : '\n\n') : '') + block;
  if (updated !== previous) writeFileSync(path, updated, { mode: 0o600 });
  return path;
}
