import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createBridge } from './bridge.mjs'

export const ROOT = '/tmp/zot-host'

/** @param {import('../src/config.js').RuntimeConfig} config */
export function zotArgs(config, root = ROOT) {
  const args = [
    'continuous', 'serve', '--backend', 'postgres',
    '--store-name', config.storeName, '--state-dir', `${root}/state`,
    '--cwd', `${root}/workspace`, '--provider', config.provider,
    '--model', config.model, '--tools', config.tools,
    '--no-ext', '--no-skills',
    '--token-file', `${root}/tokens`,
    '--web', '127.0.0.1:7787', '--web-origin', config.webOrigin,
  ]
  if (config.trustRemoteDurability) args.push('--postgres-trust-remote-durability')
  return args
}

/**
 * @param {import('../src/config.js').RuntimeConfig} config
 * @returns {Record<string, {oauth?: import('../src/config.js').OAuthToken, api_key?: string}>}
 */
export function credentials(config) {
  const provider = config.provider === 'openai-codex' ? 'openai' : config.provider
  return { [provider]: config.oauth ? { oauth: config.oauth } : { api_key: config.apiKey } }
}

export function verifyArchive(buffer, expected) {
  if (createHash('sha256').update(buffer).digest('hex') !== expected) throw new Error('Release archive checksum mismatch')
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'ignore', timeout: 90000, killSignal: 'SIGKILL' })
    child.once('error', () => reject(new Error('Bootstrap command failed')))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Bootstrap command failed')))
  })
}

async function waitForPort(port, child) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('zot exited before becoming ready')
    const connected = await new Promise(resolve => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.setTimeout(500)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (connected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('zot startup timed out')
}

export async function main() {
  process.umask(0o077)
  const config = JSON.parse(process.env.ZOT_BOOTSTRAP_CONFIG || '{}')
  delete process.env.ZOT_BOOTSTRAP_CONFIG
  if (process.arch !== 'x64' || process.platform !== 'linux') throw new Error('The pinned release requires Linux amd64')
  for (const directory of [ROOT, `${ROOT}/bin`, `${ROOT}/home`, `${ROOT}/state`, `${ROOT}/workspace`]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  await writeFile(`${ROOT}/runner.pid`, String(process.pid), { mode: 0o600 })
  await rm(`${ROOT}/ready`, { force: true })
  const response = await fetch(`https://github.com/patriceckhart/zot/releases/download/v${config.version}/zot_${config.version}_linux_amd64.tar.gz`, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error('Release download failed')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 150 * 1024 * 1024) throw new Error('Release archive is too large')
    chunks.push(chunk)
  }
  const archive = Buffer.concat(chunks)
  verifyArchive(archive, config.sha256)
  await writeFile(`${ROOT}/release.tar.gz`, archive, { mode: 0o600 })
  await run('tar', ['-xzf', `${ROOT}/release.tar.gz`, '-C', `${ROOT}/bin`, 'zot'])
  await chmod(`${ROOT}/bin/zot`, 0o700)
  await rm(`${ROOT}/release.tar.gz`)
  const askpass = `${ROOT}/git-askpass.mjs`
  await writeFile(askpass, '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2]?.toLowerCase().includes("username") ? "x-access-token" : (process.env.ZOT_GIT_TOKEN || ""))\n', { mode: 0o700 })
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass, ZOT_GIT_TOKEN: config.gitToken || '' }
  if (config.repository) {
    await run('git', ['check-ref-format', '--branch', config.branch], gitEnv)
    await run('git', ['clone', '--single-branch', '--branch', config.branch, '--', `https://github.com/${config.repository}.git`, `${ROOT}/workspace`], gitEnv)
  }
  await writeFile(`${ROOT}/home/auth.json`, JSON.stringify(credentials(config)), { mode: 0o600 })
  await writeFile(`${ROOT}/tokens`, `${config.hostToken} admin\n`, { mode: 0o600 })
  const env = {
    ...process.env, ZOT_HOME: `${ROOT}/home`,
    ZOT_CONTINUOUS_POSTGRES_DSN: config.dsn,
    GIT_TERMINAL_PROMPT: '0',
  }
  if (config.allowGitPush) Object.assign(env, { GIT_ASKPASS: askpass, ZOT_GIT_TOKEN: config.gitToken })
  const logs = createWriteStream(`${ROOT}/host.log`, { mode: 0o600 })
  const child = spawn(`${ROOT}/bin/zot`, zotArgs(config), { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logs, { end: false })
  child.stderr.pipe(logs, { end: false })
  const exited = new Promise(resolve => {
    child.once('error', () => resolve(1))
    child.once('exit', code => resolve(code ?? 1))
  })
  let stopping = false
  const stop = () => {
    if (stopping || !child.pid || child.exitCode !== null || child.signalCode !== null) return
    stopping = true
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    timer.unref()
  }
  logs.on('error', stop)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  let bridge
  try {
    await waitForPort(7787, child)
    bridge = createBridge({ upstreamPort: 7787, origin: config.webOrigin })
    await bridge.listen()
    await writeFile(`${ROOT}/ready`, 'ready\n', { mode: 0o600 })
    process.exitCode = await exited
  } finally {
    await rm(`${ROOT}/ready`, { force: true })
    if (bridge) await bridge.close()
    stop()
    await exited
    logs.end()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Keep provider, database, and Git errors out of the control API logs.
    console.error('Sandbox startup failed. Inspect /tmp/zot-host/host.log privately if it exists.')
    process.exitCode = 1
  })
}
