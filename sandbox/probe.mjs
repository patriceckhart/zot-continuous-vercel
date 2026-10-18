import { access } from 'node:fs/promises'

const deadline = Date.now() + 180000
let ready = false
while (Date.now() < deadline) {
  try {
    await access('/tmp/zot-host/ready')
    const response = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(1000) })
    if (response.status === 404) {
      ready = true
      break
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250))
}
process.exitCode = ready ? 0 : 1
