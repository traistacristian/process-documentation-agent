// Azure resources for the Process Documentation Agent (one resource group).
//   az deployment group create -g <rg> -f infra/main.bicep -p infra/main.parameters.json
//
// costProfile 'free' (default): only free-of-charge resources. App Service plan F1 (Free), data on the
// App Service's own persistent /home storage (1 GB), no storage account, no Key Vault, no Log Analytics
// or Application Insights, AI provider forced to the built-in rule engine, and a monthly budget alert.
// costProfile 'standard': the production layout described below (paid).
// Creates: App Service (Linux, Node 22) with a system-assigned managed identity, Azure Files share
// mounted as the data directory, Key Vault (RBAC) for the optional Claude API key, Log Analytics +
// Application Insights. SharePoint and Microsoft Foundry are reached with the managed identity, so
// no SharePoint secret exists anywhere.

@description('Short name used to derive resource names, e.g. "pda". 3-11 lowercase letters/digits.')
@minLength(3)
@maxLength(11)
param namePrefix string = 'pda'

param location string = resourceGroup().location

@description('SharePoint site that receives published documents, e.g. https://contoso.sharepoint.com/sites/ITOps')
param sharePointSiteUrl string

@description('Document library name on that site.')
param sharePointLibrary string = 'Documents'

@description('Top-level folder inside the library.')
param sharePointRootFolder string = 'IT Process Documentation'

@description('Filled in by scripts/Setup-EntraAndSharePoint.ps1. Empty on the first deployment.')
param entraApiClientId string = ''
param entraSpaClientId string = ''

@allowed([ 'foundry', 'anthropic', 'rules' ])
@description('foundry = Claude in Microsoft Foundry (managed identity), anthropic = Claude API key from Key Vault, rules = no AI.')
param aiProvider string = 'foundry'

@description('Foundry resource name (the {resource} in https://{resource}.services.ai.azure.com). Only for aiProvider=foundry.')
param foundryResourceName string = ''

param claudeModel string = 'claude-opus-5-5'

@allowed([ 'free', 'standard' ])
@description('free = no Azure charges (F1 plan, no paid services, rule-based engine). standard = production layout.')
param costProfile string = 'free'

@description('App Service plan SKU for costProfile=standard. P0v3 or higher recommended.')
param appServiceSku string = 'P0v3'

@description('E-mail that receives budget alerts. Empty = no budget is created.')
param budgetAlertEmail string = ''

@description('Monthly budget in the subscription currency; alerts at 1% (any spend at all) and 100%.')
param budgetAmount int = 1

@description('First day of the current month, yyyy-MM-01. Filled automatically.')
param budgetStartDate string = '${utcNow('yyyy-MM')}-01'

@description('The recorder of a process may not approve it.')
param requireSeparateApprover bool = false

var suffix = uniqueString(resourceGroup().id)
var webAppName = '${namePrefix}-app-${suffix}'
var storageName = take('${namePrefix}st${suffix}', 24)
var keyVaultName = take('${namePrefix}-kv-${suffix}', 24)
var shareName = 'pda-data'
var dataMount = '/mnt/pda-data'
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var paid = costProfile == 'standard'
var effectiveAi = paid ? aiProvider : 'rules'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (paid) {
  name: '${namePrefix}-logs-${suffix}'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 90 }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = if (paid) {
  name: '${namePrefix}-ai-${suffix}'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id, DisableLocalAuth: false }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (paid) {
  name: storageName
  location: location
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // App Service mounts Azure Files with the account key; the key is only stored in the App Service config.
    allowSharedKeyAccess: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = if (paid) {
  parent: storage
  name: 'default'
  properties: { shareDeleteRetentionPolicy: { enabled: true, days: 14 } }
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = if (paid) {
  parent: fileService
  name: shareName
  properties: { shareQuota: 100, enabledProtocols: 'SMB' }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = if (paid) {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${namePrefix}-plan-${suffix}'
  location: location
  kind: 'linux'
  // One instance: the prototype store (files on Azure Files) is not designed for concurrent writers.
  sku: paid ? { name: appServiceSku, capacity: 1 } : { name: 'F1', tier: 'Free', capacity: 1 }
  properties: { reserved: true }
}

var baseSettings = [
  // Free plan: /home is the App Service's own persistent storage (included, 1 GB on F1).
  { name: 'PDA_DATA_DIR', value: paid ? dataMount : '/home/pda-data' }
  { name: 'PDA_AUTH_MODE', value: 'entra' }
  { name: 'PDA_REPOSITORY_MODE', value: 'sharepoint' }
  { name: 'PDA_AI_PROVIDER', value: effectiveAi }
  { name: 'PDA_REQUIRE_SEPARATE_APPROVER', value: string(requireSeparateApprover) }
  { name: 'ENTRA_TENANT_ID', value: tenant().tenantId }
  { name: 'ENTRA_API_CLIENT_ID', value: entraApiClientId }
  { name: 'ENTRA_SPA_CLIENT_ID', value: entraSpaClientId }
  { name: 'SP_AUTH', value: 'managedIdentity' }
  { name: 'SP_TENANT_ID', value: tenant().tenantId }
  { name: 'SP_SITE_URL', value: sharePointSiteUrl }
  { name: 'SP_LIBRARY', value: sharePointLibrary }
  { name: 'SP_ROOT_FOLDER', value: sharePointRootFolder }
  { name: 'ANTHROPIC_MODEL', value: claudeModel }
  { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
  { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
  { name: 'NODE_ENV', value: 'production' }
]
var monitorSettings = paid ? [
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
] : []
var aiSettings = effectiveAi == 'foundry' ? [
  { name: 'ANTHROPIC_FOUNDRY_RESOURCE', value: foundryResourceName }
] : effectiveAi == 'anthropic' ? [
  // Resolved by App Service from Key Vault with the managed identity. The secret is created by the setup script.
  { name: 'ANTHROPIC_API_KEY', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=anthropic-api-key)' }
] : []

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    keyVaultReferenceIdentity: 'SystemAssigned'
    // Free plan: capped at 60 CPU minutes/day and sleeps when idle; the capture clients queue and retry.
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node server/index.js'
      alwaysOn: paid
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/healthz'
      appSettings: concat(baseSettings, monitorSettings, aiSettings)
      azureStorageAccounts: paid ? {
        pdadata: {
          type: 'AzureFiles'
          accountName: storage.name
          shareName: shareName
          mountPath: dataMount
          accessKey: storage.listKeys().keys[0].value
        }
      } : {}
    }
  }
  dependsOn: [ share ]
}

// Deployment credentials (FTP / basic auth to SCM) off: deploy with Entra ID (GitHub OIDC) only.
resource ftpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: web
  name: 'ftp'
  properties: { allow: false }
}
resource scmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: web
  name: 'scm'
  properties: { allow: false }
}

resource kvAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (paid) {
  scope: vault
  name: guid(vault.id, web.id, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: web.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource webDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (paid) {
  scope: web
  name: 'to-log-analytics'
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceConsoleLogs', enabled: true }
    ]
    metrics: [ { category: 'AllMetrics', enabled: true } ]
  }
}

output webAppName string = web.name
output url string = 'https://${web.properties.defaultHostName}'
output managedIdentityPrincipalId string = web.identity.principalId
output keyVaultName string = paid ? vault.name : ''
output storageAccountName string = paid ? storage.name : ''
output costProfile string = costProfile

// Budget alert (budgets themselves are free). Alerts on actual spend, so any charge e-mails you.
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = if (!empty(budgetAlertEmail)) {
  name: '${namePrefix}-budget'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    filter: {}
    notifications: {
      anySpend: { enabled: true, operator: 'GreaterThan', threshold: 1, contactEmails: [ budgetAlertEmail ], thresholdType: 'Actual' }
      fullBudget: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, contactEmails: [ budgetAlertEmail ], thresholdType: 'Actual' }
    }
  }
}
