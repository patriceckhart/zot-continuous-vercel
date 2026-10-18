import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createBridge } from '../sandbox/bridge.mjs'

async function setup(t, handler) {
  const upstream = http.createServer((_request, response) => response.end())
  const sockets = new Set()
  upstream.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  upstream.on('upgrade', handler)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const bridge = createBridge({ upstreamPort: upstream.address().port, origin: 'https://web.example', port: 0, host: '127.0.0.1' })
  const address = await bridge.listen()
  t.after(async () => {
    await bridge.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => upstream.close(resolve))
  })
  return address.port
}

function upgrade(port, origin = 'https://web.example', path = '/') {
  return http.request({
    hostname: '127.0.0.1', port, path,
    headers: {
      connection: 'Upgrade', upgrade: 'websocket', origin,
      'sec-websocket-key': 'c3ludGhldGljLWtleQ==', 'sec-websocket-version': '13',
    },
  })
}

test('bridge forwards upgrades and both stream directions without injecting credentials', { timeout: 3000 }, async t => {
  const port = await setup(t, (request, socket) => {
    assert.equal(request.headers.origin, 'https://web.example')
    assert.equal(request.headers.authorization, undefined)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', data => socket.write(data))
  })
  const request = upgrade(port)
  const upgraded = once(request, 'upgrade')
  request.end()
  const [response, socket] = await upgraded
  t.after(() => socket.destroy())
  assert.equal(response.statusCode, 101)
  const received = once(socket, 'data')
  socket.write('synthetic hello frame')
  assert.equal((await received)[0].toString(), 'synthetic hello frame')
})

test('bridge rejects unexpected browser origins, missing origins, and non-root paths', { timeout: 3000 }, async t => {
  let upgrades = 0
  const port = await setup(t, () => { upgrades += 1 })
  for (const [origin, path] of [['https://evil.example', '/'], ['', '/'], ['https://web.example', '/admin']]) {
    const request = upgrade(port, origin, path)
    const response = once(request, 'response')
    request.end()
    const [result] = await response
    result.resume()
    assert.equal(result.statusCode, 403)
  }
  assert.equal(upgrades, 0)
})

test('bridge does not expose an unauthenticated HTTP API', { timeout: 3000 }, async t => {
  const port = await setup(t, () => {})
  const response = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('bridge refuses non-upgrading upstream responses', { timeout: 3000 }, async t => {
  const port = await setup(t, (_request, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'))
  const request = upgrade(port)
  const response = once(request, 'response')
  request.end()
  const [result] = await response
  result.resume()
  assert.equal(result.statusCode, 502)
})
