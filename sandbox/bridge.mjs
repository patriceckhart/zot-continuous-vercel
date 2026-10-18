import http from 'node:http'

// TLS terminates at the Sandbox domain. zot still authenticates every WebSocket.
export function createBridge({ upstreamPort, origin, port = 3000, host = '0.0.0.0' }) {
  const server = http.createServer((_request, response) => {
    response.writeHead(404, { 'Cache-Control': 'no-store' })
    response.end()
  })
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/' || request.headers.origin !== origin || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const proxy = http.request({
      hostname: '127.0.0.1', port: upstreamPort, path: '/', method: 'GET',
      headers: { ...request.headers, host: `127.0.0.1:${upstreamPort}` },
    })
    proxy.setTimeout(10000, () => proxy.destroy())
    proxy.on('upgrade', (response, upstream, upstreamHead) => {
      proxy.setTimeout(0)
      upstream.setTimeout(0)
      sockets.add(upstream)
      upstream.on('close', () => sockets.delete(upstream))
      socket.write('HTTP/1.1 101 Switching Protocols\r\n')
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`)
      }
      socket.write('\r\n')
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) upstream.write(head)
      socket.on('error', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
      upstream.on('close', () => socket.destroy())
      socket.pipe(upstream).pipe(socket)
    })
    proxy.on('response', response => {
      response.resume()
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    })
    proxy.on('error', () => socket.destroy())
    socket.on('error', () => proxy.destroy())
    socket.on('close', () => proxy.destroy())
    proxy.end()
  })
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve(server.address())
      })
    }),
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(resolve)
    }),
  }
}
