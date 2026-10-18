import { describe, expect, test } from 'bun:test'
import { createHandler } from '../src/handler.js'
import { ConfigError } from '../src/config.js'
import { ConflictError } from '../src/sandbox.js'

const token = 'synthetic-control-token-'.repeat(3)
const env = { CONTROL_API_TOKEN: token }
function request(method = 'GET', body?: string, authorization = `Bearer ${token}`) {
  return new Request('https://control.example/api', { method, body, headers: { authorization } })
}
function setup(extraEnv = {}) {
  const calls: string[] = []
  const operation = (name: string) => async () => {
    calls.push(name)
    return { status: name }
  }
  const operations = { start: operation('start'), status: operation('status'), stop: operation('stop') }
  return { calls, handler: createHandler(operations, { ...env, ...extraEnv }) }
}

describe('control API', () => {
  test('requires authentication before touching sandbox operations', async () => {
    const { handler, calls } = setup()
    for (const auth of ['', 'Bearer wrong', token]) {
      expect((await handler(request('GET', undefined, auth))).status).toBe(401)
    }
    expect(calls).toEqual([])
  })

  test('GET and POST dispatch only authenticated operations and disable caching', async () => {
    const { handler, calls } = setup()
    const status = await handler(request())
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect((await handler(request('POST'))).status).toBe(200)
    expect(calls).toEqual(['status', 'start'])
  })

  test('deletion requires explicit acknowledgement of workspace loss', async () => {
    const { handler, calls } = setup()
    for (const body of ['', '{}', 'null', '{"discardWorkspace":"true"}']) {
      expect((await handler(request('DELETE', body))).status).toBe(400)
    }
    expect(calls).toEqual([])
    expect((await handler(request('DELETE', '{"discardWorkspace":true}'))).status).toBe(200)
    expect(calls).toEqual(['stop'])
  })

  test('rejects arbitrary launch arguments, oversized bodies, and unsupported methods', async () => {
    const { handler, calls } = setup()
    expect((await handler(request('POST', '{"command":"danger"}'))).status).toBe(400)
    expect((await handler(request('DELETE', 'x'.repeat(2048)))).status).toBe(400)
    expect((await handler(request('PATCH'))).status).toBe(405)
    expect(calls).toEqual([])
  })

  test('prevents previews from controlling the production sandbox by default', async () => {
    const { handler, calls } = setup({ VERCEL_ENV: 'preview' })
    expect((await handler(request())).status).toBe(403)
    expect(calls).toEqual([])
    expect((await setup({ VERCEL_ENV: 'preview', ALLOW_PREVIEW_CONTROL: 'true' }).handler(request())).status).toBe(200)
  })

  test('redacts arbitrary SDK errors but preserves safe configuration and conflict errors', async () => {
    for (const [error, expectedStatus] of [
      [new Error('secret-dsn-and-token'), 502],
      [new ConfigError('ZOT_MODEL is required'), 400],
      [new ConflictError('Sandbox is not ready'), 409],
    ] as const) {
      const fail = async () => { throw error }
      const response = await createHandler({ start: fail, status: fail, stop: fail }, env)(request())
      expect(response.status).toBe(expectedStatus)
      expect(await response.text()).not.toContain('secret-dsn-and-token')
    }
  })

  test('fails closed when the control secret is not configured', async () => {
    const { handler, calls } = setup({ CONTROL_API_TOKEN: '' })
    expect((await handler(request())).status).toBe(400)
    expect(calls).toEqual([])
  })
})
