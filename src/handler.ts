import { createHash, timingSafeEqual } from 'node:crypto'
import { ConfigError, controlToken } from './config.js'
import { ConflictError, start, status, stop } from './sandbox.js'

type Env = Record<string, string | undefined>
type Operations = {
  start: (env: Env) => Promise<unknown>
  status: (env: Env) => Promise<unknown>
  stop: (env: Env) => Promise<unknown>
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

async function smallBody(request: Request): Promise<string> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      if (size > 1024) {
        await reader.cancel()
        throw new ConfigError('Request body is too large')
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createHandler(operations: Operations = { start, status, stop }, env: Env = process.env) {
  return async (request: Request): Promise<Response> => {
    try {
      const expected = controlToken(env)
      const supplied = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1] || ''
      const hash = (value: string) => createHash('sha256').update(value).digest()
      if (!timingSafeEqual(hash(supplied), hash(expected))) return json({ error: 'Unauthorized' }, 401)
      if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production' && env.ALLOW_PREVIEW_CONTROL !== 'true') {
        return json({ error: 'Control API is disabled outside production. Use an isolated preview store and sandbox before enabling ALLOW_PREVIEW_CONTROL.' }, 403)
      }
      if (request.method === 'GET') return json(await operations.status(env))
      if (!['POST', 'DELETE'].includes(request.method)) return json({ error: 'Method not allowed' }, 405)
      const body = await smallBody(request)
      if (request.method === 'POST') {
        if (body.trim()) return json({ error: 'POST does not accept a request body. Configure the deployment environment instead.' }, 400)
        return json(await operations.start(env))
      }
      let confirmation: unknown
      try { confirmation = JSON.parse(body) } catch { return json({ error: 'DELETE requires a JSON confirmation body' }, 400) }
      if (!confirmation || typeof confirmation !== 'object' || (confirmation as Record<string, unknown>).discardWorkspace !== true) {
        return json({ error: 'Set discardWorkspace to true. Unpushed work and refreshed OAuth tokens will be lost.' }, 400)
      }
      return json(await operations.stop(env))
    } catch (error) {
      if (error instanceof ConfigError) return json({ error: error.message }, 400)
      if (error instanceof ConflictError) return json({ error: error.message }, 409)
      // SDK errors can contain credential-bearing requests. Never return or log them.
      return json({ error: 'Sandbox operation failed. Inspect the Vercel dashboard and verify configuration. No automatic takeover was attempted.' }, 502)
    }
  }
}
