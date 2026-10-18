import { readFile } from 'node:fs/promises'

try {
  const pid = Number(await readFile('/tmp/zot-host/runner.pid', 'utf8'))
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid runner PID')
  const command = await readFile(`/proc/${pid}/cmdline`, 'utf8')
  if (!command.split('\0').includes('/tmp/zot-bootstrap/runner.mjs')) throw new Error('Runner identity mismatch')
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { process.exit(0) }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  process.exitCode = 1
} catch {
  process.exitCode = 1
}
