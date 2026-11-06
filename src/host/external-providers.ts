import type { ExternalConfig } from '../shared/external.ts'
import { ExternalProviderRegistry } from './external-provider.ts'
import { ZentaoProvider } from './zentao.ts'
import { TapdProvider } from './tapd.ts'
import { GithubProvider } from './github.ts'

const validateNumericProjects = (config: ExternalConfig) => {
  if (config.mappings.some(m => !/^\d+$/.test(m.projectId))) throw new Error('provider requires numeric project IDs')
}

/** Add new providers here; synchronization and UI consume descriptors without platform branches. */
export function createBuiltinProviders(): ExternalProviderRegistry {
  return new ExternalProviderRegistry().register({
    descriptor: { id: 'zentao', name: 'ZenTao', scopeLabel: 'ext.projectId', defaultBaseUrl: '',
      settingsFields: [{ key: 'requestIntervalMs', label: 'ext.requestInterval', defaultValue: '200' }],
      authModes: [
        { id: 'password', label: 'ext.usernamePassword', fields: [{ key: 'username', label: 'ext.username', secret: false }, { key: 'password', label: 'ext.password' }] },
      ],
      capabilities: { itemTypes: ['bug', 'story', 'task'], projectDiscovery: true, accountDiscovery: false, pagination: 'page', incremental: false } },
    validate: config => {
      const pattern = config.mappingMode ? new RegExp(`^${config.mappingMode}:\\d+$`) : /^(execution:)?\d+$/
      if (config.mappings.some(m => !pattern.test(m.projectId))) throw new Error('ZenTao mapping IDs must match the selected mapping mode')
      const interval = Number(config.settings.requestIntervalMs ?? 200)
      if (!Number.isInteger(interval) || interval < 0 || interval > 10_000) throw new Error('request interval must be 0–10000 milliseconds')
    },
    create: config => new ZentaoProvider(config),
  }).register({
    descriptor: { id: 'tapd', name: 'TAPD', scopeLabel: 'ext.projectId', defaultBaseUrl: 'https://api.tapd.cn',
      authModes: [
        { id: 'basic', label: 'Basic Auth', fields: [{ key: 'apiUser', label: 'ext.apiUser' }, { key: 'apiPassword', label: 'ext.apiPassword' }] },
        { id: 'bearer', label: 'Bearer Token', fields: [{ key: 'accessToken', label: 'Access Token' }] },
      ],
      settingsFields: [
        { key: 'companyId', label: 'ext.companyId', defaultValue: '' },
        { key: 'terminalStatuses', label: 'ext.terminalStatuses', defaultValue: 'closed,resolved,done,rejected' },
        { key: 'urgentPriorities', label: 'ext.urgentPriorities', defaultValue: 'urgent,high,紧急,高' },
        { key: 'relaxedPriorities', label: 'ext.relaxedPriorities', defaultValue: 'low,nice to have,低' },
      ],
      capabilities: { itemTypes: ['bug', 'story', 'task'], projectDiscovery: true, accountDiscovery: false, pagination: 'cursor', incremental: false } },
    validate: config => {
      validateNumericProjects(config)
      if (config.settings.companyId && !/^\d+$/.test(config.settings.companyId)) throw new Error('invalid company ID')
      if (config.authMode === 'basic' && config.credentials.apiUser?.includes(':')) throw new Error('API username cannot contain a colon')
    },
    create: config => new TapdProvider(config),
  }).register({
    descriptor: { id: 'github', name: 'GitHub', scopeLabel: 'ext.projectId', defaultBaseUrl: 'https://api.github.com',
      authModes: [
        { id: 'token', label: 'ext.token', fields: [{ key: 'token', label: 'ext.token', secret: true }] },
      ],
      settingsFields: [
        { key: 'urgentLabels', label: 'ext.urgentPriorities', defaultValue: 'urgent,high,紧急,高' },
        { key: 'relaxedLabels', label: 'ext.relaxedPriorities', defaultValue: 'low,nice to have,低' },
        { key: 'requestIntervalMs', label: 'ext.requestInterval', defaultValue: '100' },
      ],
      capabilities: { itemTypes: ['issue'], projectDiscovery: true, accountDiscovery: true, pagination: 'page', incremental: false } },
    validate: config => {
      const base = (config.baseUrl || 'https://api.github.com').trim()
      if (!/^https?:\/\//.test(base)) throw new Error('GitHub API base URL must use http or https')
      if (config.mappings.some(m => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m.projectId))) throw new Error('GitHub project IDs must be owner/repo')
      const interval = Number(config.settings.requestIntervalMs ?? 100)
      if (!Number.isInteger(interval) || interval < 0 || interval > 10_000) throw new Error('request interval must be 0–10000 milliseconds')
    },
    create: config => new GithubProvider(config),
  })
}
