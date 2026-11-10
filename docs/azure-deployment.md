# Deploy Codex Terminal on Azure with Microsoft Entra ID

Azure infrastructure and operations are maintained in the public, standalone
[Codex Terminal Azure Infrastructure repository](https://github.com/kilzid/codex-terminal-azure-infra).
Fork that repository to deploy into your own Azure account. The terminal application
continues to publish the image consumed by the infrastructure lockfile.

The infrastructure repository owns the VM, persistent disk, networking, HTTPS,
Entra authentication, sandbox policies, backups, monitoring, budgets and deployed
image digests. Its initial baseline is a Debian 12 Standard_B1ms VM. Only the
assigned immutable Entra user ID can reach the terminal; the shell has no Azure
identity or access to proxy credentials.

- [Fresh installation](https://github.com/kilzid/codex-terminal-azure-infra/blob/main/docs/fresh-install.md)
- [Adopt an existing deployment without restarting services](https://github.com/kilzid/codex-terminal-azure-infra/blob/main/docs/adoption.md)
- [Updates, domains, resizing and rollback](https://github.com/kilzid/codex-terminal-azure-infra/blob/main/docs/operations.md)
- [Workspace and conversation-history recovery](https://github.com/kilzid/codex-terminal-azure-infra/blob/main/docs/recovery.md)
- [Security, privacy and OIDC](https://github.com/kilzid/codex-terminal-azure-infra/blob/main/SECURITY.md)

Private account inputs and credentials belong in your fork's production environment
and an encrypted recovery copy outside Git. After initial bootstrap, merged main
changes deploy automatically and may interrupt active terminal sessions. Files and
saved conversation history persist; reopening conversations remains manual.
Domain registration and DNS-provider administration stay external.

There is one maintained infrastructure implementation. Older copies of the
infrastructure scripts are superseded by the standalone repository. Retain existing
private deployment state and administrator keys securely until migration and an
isolated backup-restoration test have completed; never publish them in this repository.
