export class ConfigError extends Error {}

// Default zot release, Linux amd64 archive. Updated by .github/workflows/update-zot.yml.
export const DEFAULT_ZOT_VERSION = '0.4.42'
export const DEFAULT_ZOT_SHA256 = '74a7cbda5f0dc26cabda17af98b737aa8db05bbf79b92e264d93d5d118156882'

type Env = Record<string, string | undefined>

export interface OAuthToken {
  access_token: string
  refresh_token?: string
  expiry: string
  token_type?: string
  scope?: string
  client_id?: string
  id_token?: string
  account_id?: string
}

export interface RuntimeConfig {
  version: string
  sha256: string
  dsn: string
  storeName: string
  hostToken: string
  webOrigin: string
  provider: 'anthropic' | 'openai' | 'openai-codex'
  model: string
  tools: string
  trustRemoteDurability: boolean
  repository?: string
  branch: string
  gitToken?: string
  allowGitPush: boolean
  apiKey?: string
  oauth?: OAuthToken
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new ConfigError(`${name} is required`)
  return value
}

function secret(env: Env, name: string): string {
  const value = required(env, name)
  if (value.length < 32 || /\s/.test(value)) {
    throw new ConfigError(`${name} must contain at least 32 non-whitespace characters`)
  }
  return value
}

function boolean(env: Env, name: string): boolean {
  const value = env[name] || 'false'
  if (value !== 'true' && value !== 'false') throw new ConfigError(`${name} must be true or false`)
  return value === 'true'
}

export function controlToken(env: Env): string {
  return secret(env, 'CONTROL_API_TOKEN')
}

export function sandboxName(env: Env): string {
  const name = env.ZOT_SANDBOX_NAME || 'zot-continuous'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(name)) throw new ConfigError('Invalid ZOT_SANDBOX_NAME')
  return name
}

export function timeout(env: Env): number {
  const seconds = Number(env.ZOT_SANDBOX_TIMEOUT_SECONDS || '1800')
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 18000) {
    throw new ConfigError('ZOT_SANDBOX_TIMEOUT_SECONDS must be an integer from 60 to 18000')
  }
  return seconds * 1000
}

export function parseOAuth(value: string, name: string, codex: boolean): OAuthToken {
  let input: unknown
  try { input = JSON.parse(value) } catch { throw new ConfigError(`${name} must be valid JSON`) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError(`${name} must be an OAuth token object`)
  const object = input as Record<string, unknown>
  const allowed = ['access_token', 'refresh_token', 'expiry', 'token_type', 'scope', 'client_id', 'id_token', 'account_id']
  for (const [key, field] of Object.entries(object)) {
    if (!allowed.includes(key) || typeof field !== 'string' || /[\r\n\0]/.test(field)) {
      throw new ConfigError(`${name} contains an unsupported field or invalid value`)
    }
  }
  if (typeof object.access_token !== 'string' || !object.access_token.trim()) throw new ConfigError(`${name} needs access_token`)
  if (typeof object.expiry !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(object.expiry) || !Number.isFinite(Date.parse(object.expiry))) {
    throw new ConfigError(`${name} needs an RFC3339 expiry`)
  }
  if (Date.parse(object.expiry) <= Date.now() + 60000 && !object.refresh_token) throw new ConfigError(`${name} is expired or near expiry without a refresh_token`)
  if (codex && (typeof object.account_id !== 'string' || !object.account_id.trim())) throw new ConfigError(`${name} needs account_id for the ChatGPT account`)
  return object as unknown as OAuthToken
}

export function runtimeConfig(env: Env): RuntimeConfig {
  const dsn = required(env, 'ZOT_CONTINUOUS_POSTGRES_DSN')
  let database: URL
  try { database = new URL(dsn) } catch { throw new ConfigError('ZOT_CONTINUOUS_POSTGRES_DSN must be a PostgreSQL URL') }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !['verify-full', 'require'].includes(database.searchParams.get('sslmode') || '')) {
    throw new ConfigError('Use a PostgreSQL URL with sslmode=verify-full or sslmode=require')
  }
  const storeName = env.ZOT_STORE_NAME || 'main'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(storeName)) throw new ConfigError('Invalid ZOT_STORE_NAME')
  const hostToken = secret(env, 'ZOT_HOST_TOKEN')
  if (hostToken === controlToken(env)) throw new ConfigError('CONTROL_API_TOKEN and ZOT_HOST_TOKEN must differ')
  const origin = required(env, 'ZOT_WEB_ORIGIN')
  let parsedOrigin: URL
  try { parsedOrigin = new URL(origin) } catch { throw new ConfigError('ZOT_WEB_ORIGIN must be an HTTPS origin') }
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin) throw new ConfigError('ZOT_WEB_ORIGIN must be an HTTPS origin without a path')
  const provider = env.ZOT_PROVIDER || 'anthropic'
  if (!['anthropic', 'openai', 'openai-codex'].includes(provider)) throw new ConfigError('ZOT_PROVIDER must be anthropic, openai, or openai-codex')
  const model = required(env, 'ZOT_MODEL')
  if (model.startsWith('-') || /\s/.test(model)) throw new ConfigError('Invalid ZOT_MODEL')
  const tools = env.ZOT_TOOLS || 'read,glob'
  if (!/^[a-zA-Z0-9_,.-]+$/.test(tools)) throw new ConfigError('Invalid ZOT_TOOLS')
  const repository = env.GIT_REPOSITORY || undefined
  if (repository && !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new ConfigError('GIT_REPOSITORY must be a GitHub owner/repository pair')
  const branch = env.GIT_BRANCH || 'main'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || branch.split('/').some(part => part.endsWith('.lock'))) throw new ConfigError('Invalid GIT_BRANCH')
  const allowGitPush = boolean(env, 'GIT_ALLOW_PUSH')
  if (allowGitPush && (!repository || !env.GITHUB_TOKEN)) throw new ConfigError('GIT_ALLOW_PUSH requires GIT_REPOSITORY and GITHUB_TOKEN')
  const oauthName = provider === 'anthropic' ? 'CLAUDE_OAUTH_JSON' : 'CODEX_OAUTH_JSON'
  const oauth = provider !== 'openai' && env[oauthName] ? parseOAuth(env[oauthName]!, oauthName, provider === 'openai-codex') : undefined
  const apiKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'openai' ? env.OPENAI_API_KEY : undefined
  if (oauth && apiKey) throw new ConfigError('Configure either a subscription token or an API key for the selected provider, not both')
  if (!oauth && !apiKey) throw new ConfigError(provider === 'openai-codex' ? 'CODEX_OAUTH_JSON is required' : `Credentials for ${provider} are required`)
  const version = env.ZOT_VERSION || DEFAULT_ZOT_VERSION
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ConfigError('ZOT_VERSION must be a release version without v')
  const sha256 = env.ZOT_ARCHIVE_SHA256 || (version === DEFAULT_ZOT_VERSION ? DEFAULT_ZOT_SHA256 : '')
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ConfigError('ZOT_ARCHIVE_SHA256 must pin the Linux amd64 release archive')
  return {
    version, sha256, dsn, storeName, hostToken, webOrigin: origin,
    provider: provider as RuntimeConfig['provider'], model, tools,
    trustRemoteDurability: boolean(env, 'ZOT_POSTGRES_TRUST_REMOTE_DURABILITY'),
    repository, branch, gitToken: repository ? env.GITHUB_TOKEN : undefined,
    allowGitPush, apiKey, oauth,
  }
}
