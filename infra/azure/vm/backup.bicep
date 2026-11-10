param location string
param prefix string
param vmId string
param vmName string

resource vault 'Microsoft.RecoveryServices/vaults@2024-04-01' = {
  name: '${prefix}-backup'
  location: location
  sku: { name: 'RS0', tier: 'Standard' }
  properties: { publicNetworkAccess: 'Enabled' }
}
resource policy 'Microsoft.RecoveryServices/vaults/backupPolicies@2024-04-01' = {
  parent: vault
  name: 'vm-daily-seven-days'
  properties: {
    backupManagementType: 'AzureIaasVM'
    instantRpRetentionRangeInDays: 2
    timeZone: 'UTC'
    schedulePolicy: {
      schedulePolicyType: 'SimpleSchedulePolicy'
      scheduleRunFrequency: 'Daily'
      scheduleRunTimes: ['2020-01-01T03:00:00Z']
    }
    retentionPolicy: {
      retentionPolicyType: 'LongTermRetentionPolicy'
      dailySchedule: {
        retentionTimes: ['2020-01-01T03:00:00Z']
        retentionDuration: { count: 7, durationType: 'Days' }
      }
    }
  }
}
resource protectedVM 'Microsoft.RecoveryServices/vaults/backupFabrics/protectionContainers/protectedItems@2024-04-01' = {
  name: '${vault.name}/Azure/iaasvmcontainer;iaasvmcontainerv2;${resourceGroup().name};${vmName}/vm;iaasvmcontainerv2;${resourceGroup().name};${vmName}'
  properties: { protectedItemType: 'Microsoft.Compute/virtualMachines', policyId: policy.id, sourceResourceId: vmId }
}
