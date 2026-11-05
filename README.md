# Codex Terminal for Unraid

A compact Debian Bookworm Slim-based container with Codex CLI, ttyd, tmux, Git, and Node.js. No desktop required. The browser UI is exposed on port 7681. The default browser terminal font is 24px.

The image uses `node:24-bookworm-slim` for broad compatibility. ttyd 1.7.7 is downloaded from the upstream release and SHA-256 verified.

## Automated image builds

GitHub Actions builds and publishes `ghcr.io/dorseg/codex-terminal:latest` and a commit-specific tag on pushes to `main`, Sundays at 03:23 UTC, and on manual dispatch.

**Note:** Set the GHCR package visibility to **Public** in GitHub package settings if you want anonymous pulls from Unraid. The public repository's visibility does not automatically make the image public.

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

3. Open `http://UNRAID_IP:7681` on a **trusted local network**. To sign into Codex:

   ```sh
   codex login --device-auth
   ```

4. For remote access, **configure Cloudflare Access** with an identity restriction and MFA **before** publishing a Cloudflare Tunnel route to `http://UNRAID_IP:7681`. Never forward the raw port on your router. Cloudflare Access does not protect the local published port, so restrict local access with firewall/network rules as appropriate.

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

For a local checkout, run `node app/hash-password.mjs` instead.

In Unraid, add these as two **Variable** entries in the container settings. Paste the complete hash literally into `AUTH_PASSWORD_HASH`. For Docker CLI:

```sh
docker run -d --name codex-terminal -p 7681:7681 \
  -e AUTH_USERNAME='your-user' \
  -e AUTH_PASSWORD_HASH='scrypt$32768$8$3$PASTE_YOUR_SALT$PASTE_YOUR_HASH' \
  -v /mnt/user/appdata/codex-terminal/projects:/workspace \
  -v /mnt/user/appdata/codex-terminal/config:/home/node/.codex \
  ghcr.io/dorseg/codex-terminal:latest
```

Open the app, enter the credentials on the login page, and the terminal appears. This account is separate from `codex login`. Refreshing the page keeps the session; it expires eight hours after login or when the container restarts. Clear the site's cookies to sign out. Existing terminal connections remain open until disconnected or the container stops.

Enter your original password on the login page. The example hash above is a placeholder; replace it with the entire generated value. Keep the single quotes in shell commands so `$` characters are preserved. In a Compose YAML value, escape each `$` as `$$` to prevent interpolation.

Hashes contain the random salt and fixed scrypt cost settings (`N=32768`, `r=8`, `p=3`). Verification uses approximately 32 MiB per attempt, with at most two simultaneous verifications. No additional packages are required. Hashes remain sensitive: someone who obtains one can attempt offline password guessing. HTTPS is still needed to protect login traffic outside a trusted network.

`AUTH_PASSWORD` is no longer supported and causes a startup error when nonempty. To migrate, generate a hash, remove `AUTH_PASSWORD`, and set `AUTH_PASSWORD_HASH`. To change your password, generate a new hash and recreate the container; this also invalidates existing sessions.

If both variables are unset or empty, the app opens directly to the terminal. Setting only one nonempty variable prevents startup with a configuration error. Credential values are matched exactly. Five failed attempts from one address block further attempts for one minute; users behind the same reverse proxy share this limit.

When login is enabled, only the proxy listens publicly on port 7681; ttyd listens internally on `127.0.0.1:7682`. Use the default container command to enable this flow. HTTP is supported on trusted local networks; for remote access, keep the HTTPS and Cloudflare Access setup described above. The login cookie is HTTP-only and restricted to same-site requests.

## Development checks

Run authentication and launcher tests with Node.js 24:

```sh
node --test test/*.test.mjs
docker build -t codex-terminal:test .
```

The image publication workflow runs these tests before building and publishing.

## Persistence and updates

- The process runs as the unprivileged `node` user (UID 1000), not as root.
- ttyd opens or reattaches the tmux session named `main`. Browser disconnects need not stop Codex, as long as the container runs.
- Container restarts **do** terminate tmux and running Codex processes.
- Code and Codex credentials survive container recreation because they reside in mapped volumes.
- Weekly builds update base image, OS packages and Codex CLI. The pinned ttyd binary stays at version 1.7.7 until updated in Dockerfile.
- GitHub Actions publishes images; it does **not** automatically deploy or restart your Unraid container. Update when no Codex task is running.
- Never mount the Unraid Docker socket, privileged mode, or unrestricted host paths into this container.
