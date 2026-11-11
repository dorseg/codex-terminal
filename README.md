<p align="center">
  <img src="docs/assets/social-preview.png" alt="Codex Terminal — Your browser. Your terminal." width="1280">
</p>

# Codex Terminal

A compact Debian Bookworm Slim-based container with Codex CLI, Remobi, Herdr, Git, and Node.js. The browser UI is exposed on port 7681.

Remobi provides a shared browser view of Herdr session `main`, starting Bash in `/workspace`. Connected browsers share the same terminal input, output, view, and size. Browser disconnects preserve running processes while the container stays running. Tabs appear at the top; narrow screens use Herdr's standard mobile layout. Mouse capture is enabled.

Press **Ctrl+B**, release, then **C** to create a tab (confirm its name with Enter), **N/P** to switch, **Shift+T** to rename, or **Shift+X** to close a tab. **V** and **-** split panes, **Z** toggles zoom, **W** opens workspaces, **B** toggles the sidebar, **E** opens scrollback, **X** closes a pane, and **?** opens help. The More drawer provides these controls. Swipe left/right switches tabs.

Five custom popups are available in **More**, or after **Ctrl+B** with **F5–F9**:

- **F5 AI Usage:** remaining 5-hour and weekly Codex quota; Enter closes.
- **F6 Quick Shell:** temporary Bash in the underlying pane's directory; exit closes.
- **F7 Diff:** local Git changes, or committed branch changes if clean, in the underlying directory.
- **F8 Ports:** configured app preview paths and response status; Enter closes.
- **F9 Codex:** choose normal or YOLO mode, or Enter to cancel. A choice creates and focuses a new tab in the originating workspace and directory. YOLO bypasses approvals and sandboxing.

The Docker image is available at `ghcr.io/dorseg/codex-terminal:latest`.

## Docker installation

1. On your Docker host, prepare persistent directories that the container's user (UID 1000) can write to:

   ```sh
   mkdir -p ./config ./projects
   sudo chown -R 1000:1000 ./config ./projects
   ```

2. Start the container from the same directory:

   ```sh
   docker run -d --name codex-terminal \
     -p 7681:7681 \
     -v "$(pwd)/projects:/workspace" \
     -v "$(pwd)/config:/home/node/.codex" \
     ghcr.io/dorseg/codex-terminal:latest
   ```

3. Open `http://DOCKER_HOST_IP:7681` on a **trusted local network** (or `http://localhost:7681` on the Docker host). To sign into Codex, run this in the browser terminal:

   ```sh
   codex login --device-auth
   ```

The terminal opens without a browser login by default. See [Optional terminal login](#optional-terminal-login) to require credentials.

## Remote access

For remote access, **configure Cloudflare Access** with an identity restriction and MFA **before** publishing a Cloudflare Tunnel route to `http://DOCKER_HOST_IP:7681`. Never forward the raw port on your router. Cloudflare Access does not protect the local published port, so restrict local access with firewall/network rules as appropriate.

## Unraid installation

1. Prepare persistent paths in Unraid Terminal:

   ```sh
   mkdir -p /mnt/user/appdata/codex-terminal/config /mnt/user/appdata/codex-terminal/projects
   chown -R 1000:1000 /mnt/user/appdata/codex-terminal/config /mnt/user/appdata/codex-terminal/projects
   ```

2. Go to **Docker → Add Container** and configure:

   | Setting | Value |
   | --- | --- |
   | Name | `codex-terminal` |
   | Repository | `ghcr.io/dorseg/codex-terminal:latest` |
   | Network | Bridge |
   | TCP port | host `7681` → container `7681` |
   | Projects path | `/mnt/user/appdata/codex-terminal/projects` → `/workspace` (RW) |
   | Codex config path | `/mnt/user/appdata/codex-terminal/config` → `/home/node/.codex` (RW) |
   | Web UI (optional) | `http://[IP]:[PORT:7681]/` |

   To enable [optional terminal login](#optional-terminal-login), add `AUTH_USERNAME` and `AUTH_PASSWORD_HASH` as two **Variable** entries in the container settings. Paste the complete generated hash literally into `AUTH_PASSWORD_HASH`.

3. Open `http://UNRAID_IP:7681` on a **trusted local network**. To sign into Codex:

   ```sh
   codex login --device-auth
   ```

4. For access outside your local network, follow the [remote access guidance](#remote-access) using your Unraid host's IP address.

## Web apps on the same URL

Run web apps inside the container and access them through the terminal's existing port or domain:

| Service | URL |
| --- | --- |
| Terminal | `http://DOCKER_HOST_IP:7681/` |
| App on port 3000 | `http://DOCKER_HOST_IP:7681/apps/3000/` |
| App on port 5173 | `http://DOCKER_HOST_IP:7681/apps/5173/` |

Add `APP_PORTS` when creating the container, keeping your existing volumes and optional login settings:

```sh
docker run -d --name codex-terminal \
  -p 7681:7681 \
  -e APP_PORTS='3000,5173' \
  -v "$(pwd)/projects:/workspace" \
  -v "$(pwd)/config:/home/node/.codex" \
  ghcr.io/dorseg/codex-terminal:latest
```

On Unraid, add a **Variable** named `APP_PORTS` with value `3000,5173`. No additional port mappings or tunnel routes are needed. For a tunnel domain, open `https://your-domain/apps/5173/`.

`APP_PORTS` is disabled when unset or empty. It accepts comma-separated ports from 1024 to 65535, excluding internal ports 7681 and 7682. Spaces and duplicates are accepted; invalid entries prevent startup. Recreate the container to change the allowlist. Start and stop apps yourself in the terminal; an allowed port does not need a running app at container startup. An unavailable app returns a gateway error while the terminal remains usable.

Apps may bind to `127.0.0.1` inside the container. Each app must serve its full `/apps/<port>/` prefix: the proxy preserves the path and query without rewriting HTML, assets, redirects, or cookies. Configure client routes, API URLs, WebSocket paths, redirects, and cookie paths for that prefix. For example, `/api` points outside the app; use `/apps/5173/api` or a base-aware relative URL instead. App cookies should use `Path=/apps/5173/`.

### Automatic Codex instructions

At startup, the container adds a managed web app section to the global `AGENTS.md` in `CODEX_HOME` (default `/home/node/.codex`). It lists the configured `APP_PORTS` and explains the proxy prefix, app configuration, live reload, and keeping servers running in dedicated Herdr tabs or panes. You can ask Codex to “build and run a task tracker” without repeating the port and proxy setup.

Existing personal instructions are preserved. If a nonempty global `AGENTS.override.md` exists, the managed section is placed there instead so Codex loads it. The section refreshes on container startup, including when proxying is disabled. The Codex config directory must be writable. Start a new Codex session to load updated instructions; project instructions can override these defaults. See the [official instruction discovery guide](https://developers.openai.com/codex/guides/agents-md).

### Vite example

In a Vite project's `vite.config.js`:

```js
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/apps/5173/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Replace with your public hostname when using a domain.
    allowedHosts: ['your-domain.example'],
  },
});
```

Start the project with `npm run dev`, then open `/apps/5173/` on the terminal's external URL. IP addresses and localhost are allowed by Vite by default. Vite's default live reload connects through the page's origin and base path; WebSocket upgrades are forwarded to the same app port. Remove conflicting custom live reload host/port settings that would direct the browser to the container's private address. See Vite's [base option](https://vite.dev/config/shared-options#base) and [server options](https://vite.dev/config/server-options) for your installed version.

When terminal login is enabled, app routes share the login and return to the requested app after sign-in. Without terminal login, allowlisted apps are accessible directly. Only run trusted apps: they share the terminal's browser origin and session privileges. The proxy strips the terminal session cookie from upstream requests and filters attempts to set that reserved cookie, but this does not isolate apps from the terminal. Follow the existing remote access guidance when using a public domain.

## Optional terminal login

Set both environment variables to require a browser login before accessing the terminal:

| Variable | Purpose |
| --- | --- |
| `AUTH_USERNAME` | Username for the shared terminal account |
| `AUTH_PASSWORD_HASH` | Salted scrypt hash for the shared terminal account |

Generate the hash first. This command prompts twice with hidden input; the password is never passed as a command argument. Copy the complete output beginning with `scrypt$`:

```sh
docker run --rm -it ghcr.io/dorseg/codex-terminal:latest \
  node /opt/codex-terminal/hash-password.mjs
```

For Docker CLI, add both variables when creating the container. Run this from the directory containing your `config` and `projects` directories:

```sh
docker run -d --name codex-terminal -p 7681:7681 \
  -e AUTH_USERNAME='your-user' \
  -e AUTH_PASSWORD_HASH='scrypt$32768$8$3$PASTE_YOUR_SALT$PASTE_YOUR_HASH' \
  -v "$(pwd)/projects:/workspace" \
  -v "$(pwd)/config:/home/node/.codex" \
  ghcr.io/dorseg/codex-terminal:latest
```

Open the app, enter the credentials on the login page, and the terminal appears. This account is separate from `codex login`. Refreshing the page keeps the session; it expires eight hours after login or when the container restarts. Clear the site's cookies to sign out. Existing terminal connections remain open until disconnected or the container stops.

Enter your original password on the login page. The example hash above is a placeholder; replace it with the entire generated value. Keep the single quotes in shell commands so `$` characters are preserved. In a Compose YAML value, escape each `$` as `$$` to prevent interpolation.

Keep password hashes private. HTTPS is still needed to protect login traffic outside a trusted network.

`AUTH_PASSWORD` is no longer supported and causes a startup error when nonempty. To migrate, generate a hash, remove `AUTH_PASSWORD`, and set `AUTH_PASSWORD_HASH`. To change your password, generate a new hash and recreate the container; this also invalidates existing sessions.

If both variables are unset or empty, the app opens directly to the terminal. Setting only one nonempty variable prevents startup with a configuration error. Credential values are matched exactly. Five failed attempts from one address block further attempts for one minute; users behind the same reverse proxy share this limit.

Use the default container command for terminal login to work. HTTP is supported on trusted local networks; for remote access, follow the [remote access guidance](#remote-access).

## Persistence and updates

- The process runs as the unprivileged `node` user (UID 1000), not as root.
- Remobi attaches to Herdr session `main`. The gateway remains on port 7681 and Remobi listens on loopback port 7682.
- Editable `CODEX_HOME/herdr/config.toml` and `CODEX_HOME/herdr/remobi.config.js` are seeded only when absent. Restart after editing. Herdr's standard config directory (`~/.config/herdr`, or under `XDG_CONFIG_HOME`) links to this persistent directory. A conflicting directory or link prevents startup; move it aside yourself after reviewing its contents.
- Herdr stores session state, sockets, and layout snapshots under the existing Codex volume. Layouts, directories, and focus return after a restart. Ordinary shells restart fresh; arbitrary app servers need restarting. Persistent pane-screen history stays disabled.
- Startup installs or updates Herdr's official Codex integration, preserving unrelated settings and hooks. It enables Codex hooks and records native conversation identity. Eligible conversations resume automatically after the browser attaches; missing or unsupported session references become fresh shells. Other agents' integrations remain user-installed. See [native restore](https://herdr.dev/tui/docs/session-state/) and [integrations](https://herdr.dev/tui/docs/integrations/).
- Shutdown closes gateway connections, requests a graceful Herdr session stop, and terminates Remobi, with a six-second launcher deadline.
- Existing project and Codex volumes remain usable. Legacy terminal configs, including `CODEX_HOME/remobi/remobi.config.js`, are ignored and left untouched. No live-session migration or compatibility mode is provided. Finish active work before recreating the container.
- Code and Codex credentials survive container recreation because they reside in mapped volumes.
- New images are published weekly and when app or build changes land on `main`. They include updates to the base image, OS packages, Codex CLI, and the stable `remobi@latest` release resolved at build time.
- There is no migration of live sessions. Finish active tasks before cutover; existing volumes need no data migration.
- To update, pull the latest image and recreate the container with the same settings and volume mappings. Published images do **not** automatically update your running container. Update when no Codex task is running.
- Never mount the Docker socket or unrestricted host paths into this container, or run it in privileged mode.

## Development

The image uses `node:24-bookworm-slim`. A dedicated stage downloads the latest stable Herdr binary for amd64 or arm64, verifies its published GitHub asset SHA-256 digest, and prints its version. Missing downloads or checksums fail the build. Only the binary is copied from that stage. Python is included at runtime for the official Codex hook. Remobi is installed separately as `remobi@latest`; its resolved version is printed during the build and is never saved to the repository manifest or lockfile. Native dependencies compile in the build stage; compiler tools are excluded from the runtime image. Remobi listens on `127.0.0.1:7682` behind the existing gateway on port 7681.

Use `scripts/build.sh` for local builds. It invokes BuildKit with `--no-cache-filter remobi,herdr`, so every invocation resolves and installs the stable Herdr release and npm latest tag even with cached dependencies and runtime layers. CI uses the same stage filter. Dockerfiles cannot declare an intrinsically uncached stage; direct Buildx invocations must also supply `--no-cache-filter remobi,herdr` (or `--no-cache`). No runtime update or live-session migration is performed.

Run authentication and launcher tests with Node.js 24, then build the image:

```sh
npm ci --omit=dev
npm test
./scripts/build.sh --load -t codex-terminal:test .
```

To run the native image smoke test locally after building:

```sh
docker run --rm -v "$(pwd)/scripts/smoke.mjs:/tmp/smoke.mjs:ro" \
  codex-terminal:test node /tmp/smoke.mjs
docker run --rm -v "$(pwd)/scripts/herdr-state-smoke.mjs:/tmp/herdr-state-smoke.mjs:ro" \
  codex-terminal:test node /tmp/herdr-state-smoke.mjs
```

Before release, check Android Chrome and iOS Safari on physical devices: open and close the keyboard, rotate the screen, use touch keys, scroll, copy/paste, and create, rename, close, and switch Herdr tabs from both touch controls and Ctrl+B bindings. Check top tabs at desktop width and the default narrow-screen layout. Verify restoration using a real Codex conversation before release. Connect a second browser to verify the shared view. Verify a real app and its live reload WebSocket through `/apps/3000/`.

To generate a password hash from a local checkout, run `node app/hash-password.mjs`.

GitHub Actions runs unit tests, then builds and publishes a commit-tagged image for amd64 and arm64. Both architectures run the gateway/browser-protocol smoke test and native persistence checks before the image is promoted to `latest`. Pushes affecting app code, tests, scripts, manifests, Dockerfile, or the workflow trigger builds; weekly and manual builds are also available. CI refreshes both Herdr and Remobi stages. README and documentation image changes do not trigger builds.
