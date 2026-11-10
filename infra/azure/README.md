# Azure deployment example

Start with the [step-by-step Azure deployment guide](../../docs/azure-deployment.md).

The example deploys the published image on a dedicated Debian VM, with HTTPS,
Microsoft Entra ID authentication restricted to one user, persistent local disk,
Codex sandbox support, backups and budget alerts. It does not change the image or
the application's default behavior.

Files:

| Path | Purpose |
| --- | --- |
| `vm/main.bicep` | VM, network, firewall, public IP and nested deployments |
| `vm/manage_vm.py` | Account checks, provisioning, configuration and verification |
| `common.py` | Explicit-subscription tokens, Entra identity and private state |
| `vm/cloud-init.yml` | OS security updates and Docker installation |
| `vm/configure.sh` | Protected configuration and service startup |
| `vm/seccomp.json`, `vm/apparmor.profile` | Container policies supporting Codex's inner sandbox |
| `vm/boot-guards.sh`, `vm/network-rules.sh` | Metadata protection before Docker starts |
| `vm/domain.sh` | Custom-domain activation with rollback |
| `vm/backup.bicep`, `vm/monitor.bicep`, `budget.bicep` | Recovery points and alerts |
| `vm/test-issuer.mjs`, `vm/test-proxy-flow.py` | Synthetic OIDC authorization tests |

Local configuration, resource state and administrator keys belong in `.azure/`,
which Git and the Docker build context exclude. No real subscription, tenant,
domain, account, credential or key belongs in the example files.

Run local checks from the repository root:

```sh
python3 -m unittest discover -s infra/azure -p 'test_*.py' -v
az bicep build --file infra/azure/vm/main.bicep --outfile /tmp/codex-terminal-vm.json
```
