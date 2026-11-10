#!/bin/bash
set -euo pipefail
umask 077
# Azure Managed Run Command exposes named protected parameters as environment variables.
printf '%s' "$CODEX_VM_PAYLOAD" | base64 -d | python3 -c '
import json,sys,pathlib,base64,os
payload=json.load(sys.stdin)
root=pathlib.Path("/etc/codex-terminal")
root.mkdir(mode=0o700,parents=True,exist_ok=True)
for name,value in payload["files"].items():
 if "/" in name or name.startswith("."): raise SystemExit("Invalid configuration filename")
 p=root/name;p.write_bytes(base64.b64decode(value));p.chmod(0o600)
 if name=="oauth2-proxy.cfg": os.chown(p,65532,65532);p.chmod(0o400)
'
unset CODEX_VM_PAYLOAD
cloud-init status --wait >/dev/null
test -f /etc/codex-terminal/os-ready
python3 /etc/codex-terminal/codex-config.py
bash /etc/codex-terminal/boot-guards.sh
cat > /etc/systemd/system/codex-terminal.service <<'UNIT'
[Unit]
Description=Entra-protected personal Codex terminal
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/etc/codex-terminal
ExecStartPre=/sbin/apparmor_parser -r /etc/codex-terminal/apparmor.profile
ExecStartPre=/bin/sh /etc/codex-terminal/network-rules.sh
ExecStart=/usr/bin/docker compose -f compose.json up -d --remove-orphans
ExecStop=/usr/bin/docker compose -f compose.json stop
TimeoutStartSec=600
[Install]
WantedBy=multi-user.target
UNIT
cd /etc/codex-terminal
docker compose -f compose.json config --quiet
docker compose -f compose.json pull --quiet
docker compose -f compose.json run --rm --no-deps https caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl enable codex-terminal.service
systemctl start codex-terminal.service
docker compose -f compose.json up -d --remove-orphans
docker compose -f compose.json up -d --force-recreate auth https
printf 'CONFIGURATION_INSTALLED\n'
