import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  coverCacheDir,
  coverCacheName,
  imageContentType,
  migrateCoverCache
} from '../../src/main/cover-cache'

it('hashes cover URLs into stable, filesystem-safe cache names', () => {
  expect(coverCacheName('https://p3.douyinpic.com/a.jpeg')).toMatch(/^[a-f0-9]{64}\.img$/)
  expect(coverCacheName('https://p3.douyinpic.com/a.jpeg')).toBe(
    coverCacheName('https://p3.douyinpic.com/a.jpeg')
  )
  expect(coverCacheName('https://p3.douyinpic.com/b.jpeg')).not.toBe(
    coverCacheName('https://p3.douyinpic.com/a.jpeg')
  )
})

it('only accepts absolute cache directories', () => {
  expect(coverCacheDir('')).toBeNull()
  expect(coverCacheDir('  ')).toBeNull()
  expect(coverCacheDir('covers')).toBeNull()
  const absolute = process.platform === 'win32' ? 'C:\\covers' : '/tmp/covers'
  expect(coverCacheDir(absolute)).toBe(absolute)
})

it('sniffs common image formats from magic bytes', () => {
  expect(imageContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
  expect(imageContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
  expect(imageContentType(Buffer.from('GIF89a'))).toBe('image/gif')
  expect(imageContentType(Buffer.from('RIFF0000WEBP'))).toBe('image/webp')
  expect(imageContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
    'image/svg+xml'
  )
  expect(imageContentType(Buffer.from('not an image'))).toBe('application/octet-stream')
})

it('migrates cached covers and leaves unrelated files alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mylike-cover-migrate-'))
  try {
    const source = join(root, 'old'),
      destination = join(root, 'new')
    mkdirSync(source)
    mkdirSync(destination)
    writeFileSync(join(source, 'a.img'), 'a')
    writeFileSync(join(source, 'b.img'), 'b')
    writeFileSync(join(source, 'keep.txt'), 'keep')
    writeFileSync(join(destination, 'b.img'), 'existing')

    expect(await migrateCoverCache(source, destination)).toBe(2)
    expect(readdirSync(destination).sort()).toEqual(['a.img', 'b.img'])
    expect(readdirSync(source)).toEqual(['keep.txt'])
    expect(await migrateCoverCache(source, source)).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
