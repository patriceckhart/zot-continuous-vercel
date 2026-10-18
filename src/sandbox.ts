import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { APIError, Sandbox } from '@vercel/sandbox'
import { ConfigError, runtimeConfig, sandboxName, timeout } from './config.js'

export class ConflictError extends Error {}

type Env = Record<string, string | undefined>

function credentials(env: Env) {
  if (!env.VERCEL_TOKEN) return {}
  if (!env.VERCEL_PROJECT_ID || !env.VERCEL_TEAM_ID) {
    throw new ConfigError('VERCEL_TOKEN requires VERCEL_PROJECT_ID and VERCEL_TEAM_ID')
  }
  return { token: env.VERCEL_TOKEN, projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID }
}

async function existing(env: Env): Promise<Sandbox | null> {
  try {
    return await Sandbox.get({ name: sandboxName(env), resume: false, ...credentials(env) })
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) return null
    throw error
  }
}

const healthScript = `fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(1000) }).then(r => { process.exitCode = r.status === 404 ? 0 : 1 }).catch(() => { process.exitCode = 1 })`

async function description(sandbox: Sandbox) {
  let ready = false
  if (sandbox.status === 'running') {
    const probe = await sandbox.runCommand('node', ['-e', healthScript])
    ready = probe.exitCode === 0
  }
  return {
    name: sandbox.name,
    status: sandbox.status,
    ready,
    websocketUrl: ready ? sandbox.domain(3000).replace(/^https:/, 'wss:') + '/' : null,
    expiresAt: sandbox.expiresAt?.toISOString() ?? null,
  }
}

export async function status(env: Env) {
  const sandbox = await existing(env)
  return sandbox ? description(sandbox) : { name: sandboxName(env), status: 'absent', ready: false, websocketUrl: null }
}

export async function start(env: Env) {
  const config = runtimeConfig(env)
  const name = sandboxName(env)
  const current = await existing(env)
  if (current) {
    const state = await description(current)
    if (state.ready) return state
    throw new ConflictError('A sandbox already exists but is not ready. Inspect it, then explicitly delete it before starting again.')
  }
  const sandbox = await Sandbox.create({
    name, image: 'vercel/sandbox/universal', ports: [3000],
    persistent: false, timeout: timeout(env),
    ...credentials(env),
  })
  try {
    await sandbox.mkDir('/tmp/zot-bootstrap')
    const files = await Promise.all(['runner.mjs', 'bridge.mjs', 'probe.mjs', 'stop.mjs'].map(async name => ({
      path: `/tmp/zot-bootstrap/${name}`,
      content: await readFile(path.join(process.cwd(), 'sandbox', name)),
      mode: 0o600,
    })))
    await sandbox.writeFiles(files)
    await sandbox.runCommand({
      cmd: 'node', args: ['/tmp/zot-bootstrap/runner.mjs'],
      env: { ZOT_BOOTSTRAP_CONFIG: JSON.stringify(config) }, detached: true,
    })
    const probe = await sandbox.runCommand('node', ['/tmp/zot-bootstrap/probe.mjs'])
    if (probe.exitCode !== 0) throw new Error('Sandbox did not become ready')
    const state = await description(sandbox)
    if (!state.ready) throw new Error('Sandbox lost readiness during startup')
    return state
  } catch {
    // Startup owns this new VM. Never delete a pre-existing sandbox here.
    try { await sandbox.delete() } catch {
      throw new Error('Startup failed and cleanup failed. Inspect the named sandbox in the Vercel dashboard.')
    }
    throw new Error('Sandbox startup failed. The failed sandbox was deleted. Check configuration, database access, and provider credentials.')
  }
}

export async function stop(env: Env) {
  const sandbox = await existing(env)
  if (!sandbox) return { name: sandboxName(env), status: 'absent' }
  let graceful = false
  if (sandbox.status === 'running') {
    try {
      const result = await sandbox.runCommand('node', ['/tmp/zot-bootstrap/stop.mjs'])
      graceful = result.exitCode === 0
    } catch {}
  }
  await sandbox.delete()
  return { name: sandboxName(env), status: 'deleted', graceful }
}
