# Codex Terminal for Unraid

A compact Debian Bookworm Slim-based container with Codex CLI, ttyd, tmux, Git, and Node.js. No desktop required. The browser UI is exposed on port 7681. The default browser terminal font is 18px.

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

## Persistence and updates

- The process runs as the unprivileged `node` user (UID 1000), not as root.
- ttyd opens or reattaches the tmux session named `main`. Browser disconnects need not stop Codex, as long as the container runs.
- Container restarts **do** terminate tmux and running Codex processes.
- Code and Codex credentials survive container recreation because they reside in mapped volumes.
- Weekly builds update base image, OS packages and Codex CLI. The pinned ttyd binary stays at version 1.7.7 until updated in Dockerfile.
- GitHub Actions publishes images; it does **not** automatically deploy or restart your Unraid container. Update when no Codex task is running.
- Never mount the Unraid Docker socket, privileged mode, or unrestricted host paths into this container.
