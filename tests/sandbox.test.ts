import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { APIError, Sandbox } from '@vercel/sandbox'
import { start, status, stop } from '../src/sandbox.js'

const env = {
  CONTROL_API_TOKEN: 'synthetic-control-'.repeat(3),
  ZOT_HOST_TOKEN: 'synthetic-host-'.repeat(3),
  ZOT_CONTINUOUS_POSTGRES_DSN: 'postgresql://user:synthetic@db.example/zot?sslmode=verify-full',
  ZOT_WEB_ORIGIN: 'https://web.zot.sh',
  ZOT_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_API_KEY: 'synthetic-key',
}
const notFound = () => new APIError(new Response(null, { status: 404 }))
function fake() {
  return {
    name: 'zot-continuous', status: 'running', expiresAt: new Date('2099-01-01T00:00:00Z'),
    domain: () => 'https://sandbox.example',
    mkDir: mock(async () => {}),
    writeFiles: mock(async (_files: unknown[]) => {}),
    runCommand: mock(async (..._args: unknown[]) => ({ exitCode: 0 })),
    delete: mock(async () => {}),
  }
}
afterEach(() => mock.restore())

test('status does not create or resume a missing sandbox', async () => {
  const get = spyOn(Sandbox, 'get').mockRejectedValue(notFound())
  const create = spyOn(Sandbox, 'create')
  expect(await status(env)).toMatchObject({ status: 'absent', ready: false })
  expect(get).toHaveBeenCalledWith({ name: 'zot-continuous', resume: false })
  expect(create).not.toHaveBeenCalled()
})

test('start provisions a non-persistent sandbox and waits for readiness', async () => {
  spyOn(Sandbox, 'get').mockRejectedValue(notFound())
  const sandbox = fake()
  const create = spyOn(Sandbox, 'create').mockResolvedValue(sandbox as never)
  const result = await start(env)
  expect(result).toMatchObject({ ready: true, websocketUrl: 'wss://sandbox.example/' })
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ persistent: false, ports: [3000], timeout: 1800000 }))
  expect(sandbox.writeFiles.mock.calls[0][0]).toHaveLength(4)
  const launch = sandbox.runCommand.mock.calls[0][0] as { env: Record<string, string>, detached: boolean }
  expect(launch.detached).toBe(true)
  expect(Object.keys(launch.env)).toEqual(['ZOT_BOOTSTRAP_CONFIG'])
  expect(launch.env.ZOT_BOOTSTRAP_CONFIG).not.toContain(env.CONTROL_API_TOKEN)
  expect(sandbox.delete).not.toHaveBeenCalled()
})

test('start is idempotent for a ready existing host', async () => {
  const sandbox = fake()
  spyOn(Sandbox, 'get').mockResolvedValue(sandbox as never)
  const create = spyOn(Sandbox, 'create')
  expect(await start(env)).toMatchObject({ ready: true })
  expect(create).not.toHaveBeenCalled()
  expect(sandbox.writeFiles).not.toHaveBeenCalled()
})

test('start refuses to overwrite an existing unready or stopped workspace', async () => {
  const sandbox = fake()
  sandbox.status = 'stopped'
  spyOn(Sandbox, 'get').mockResolvedValue(sandbox as never)
  const create = spyOn(Sandbox, 'create')
  await expect(start(env)).rejects.toThrow('explicitly delete')
  expect(sandbox.runCommand).not.toHaveBeenCalled()
  expect(sandbox.delete).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

test('failed provisioning cleans up only the newly created sandbox', async () => {
  spyOn(Sandbox, 'get').mockRejectedValue(notFound())
  const sandbox = fake()
  sandbox.runCommand.mockRejectedValue(new Error('synthetic-secret-error'))
  spyOn(Sandbox, 'create').mockResolvedValue(sandbox as never)
  await expect(start(env)).rejects.toThrow('failed sandbox was deleted')
  expect(sandbox.delete).toHaveBeenCalledTimes(1)
})

test('startup readiness loss is not reported as success', async () => {
  spyOn(Sandbox, 'get').mockRejectedValue(notFound())
  const sandbox = fake()
  sandbox.runCommand.mockResolvedValueOnce({ exitCode: 0 }).mockResolvedValueOnce({ exitCode: 0 }).mockResolvedValueOnce({ exitCode: 1 })
  spyOn(Sandbox, 'create').mockResolvedValue(sandbox as never)
  await expect(start(env)).rejects.toThrow('failed sandbox was deleted')
  expect(sandbox.delete).toHaveBeenCalledTimes(1)
})

test('failed startup cleanup is reported without leaking raw SDK errors', async () => {
  spyOn(Sandbox, 'get').mockRejectedValue(notFound())
  const sandbox = fake()
  sandbox.runCommand.mockRejectedValue(new Error('synthetic-secret'))
  sandbox.delete.mockRejectedValue(new Error('synthetic-secret'))
  spyOn(Sandbox, 'create').mockResolvedValue(sandbox as never)
  await expect(start(env)).rejects.toThrow('cleanup failed')
})

test('SDK authorization failures never trigger create or deletion', async () => {
  spyOn(Sandbox, 'get').mockRejectedValue(new APIError(new Response(null, { status: 403 })))
  const create = spyOn(Sandbox, 'create')
  await expect(start(env)).rejects.toThrow()
  expect(create).not.toHaveBeenCalled()
})

test('stop tries graceful termination before deleting', async () => {
  const sandbox = fake()
  spyOn(Sandbox, 'get').mockResolvedValue(sandbox as never)
  expect(await stop(env)).toMatchObject({ status: 'deleted', graceful: true })
  expect(sandbox.runCommand).toHaveBeenCalledWith('node', ['/tmp/zot-bootstrap/stop.mjs'])
  expect(sandbox.delete).toHaveBeenCalledTimes(1)
})

test('stop still deletes a failed runner and reports non-graceful termination', async () => {
  const sandbox = fake()
  sandbox.runCommand.mockRejectedValue(new Error('unavailable'))
  spyOn(Sandbox, 'get').mockResolvedValue(sandbox as never)
  expect(await stop(env)).toMatchObject({ status: 'deleted', graceful: false })
  expect(sandbox.delete).toHaveBeenCalledTimes(1)
})
