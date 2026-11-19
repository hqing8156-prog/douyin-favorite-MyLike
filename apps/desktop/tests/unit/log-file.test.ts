import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LogFile } from '../../src/main/log-file'

it('persists serialized log entries in a local file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mylike-log-file-'))
  try {
    const logs = new LogFile(join(root, 'logs'))
    await Promise.all([
      logs.append('favorite-writeback.log', 'first failure'),
      logs.append('favorite-writeback.log', 'second failure')
    ])
    await expect(readFile(join(root, 'logs', 'favorite-writeback.log'), 'utf8')).resolves.toBe(
      'first failure\nsecond failure\n'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
