# Azure VM example

Follow the [Azure deployment guide](../../../docs/azure-deployment.md) from a fresh
clone. It covers permissions, MFA, private inputs, provisioning, verification,
custom domains, backups, budgets, maintenance and cleanup.

For available commands:

```sh
python3 infra/azure/vm/manage_vm.py --help
```

All Azure administration uses the subscription explicitly supplied in the
private config file; it does not change the Azure CLI's default subscription.
