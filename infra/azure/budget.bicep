targetScope = 'subscription'
param budgetName string
param resourceGroups array
param monthlyBudget int
param startDate string
param contactEmail string

// Include service-managed networking and backup RGs as well as the application RG.
resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: budgetName
  properties: {
    amount: monthlyBudget
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: { startDate: startDate }
    filter: { dimensions: { name: 'ResourceGroupName', operator: 'In', values: map(resourceGroups, rg => toLower(rg)) } }
    notifications: toObject([30, 60, 90], threshold => 'actual-${threshold}', threshold => {
      enabled: true
      operator: 'GreaterThanOrEqualTo'
      threshold: threshold
      thresholdType: 'Actual'
      contactEmails: [contactEmail]
    })
  }
}
