import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const COVER_CACHE_MAX_BYTES = 8_000_000

/** Stable, filesystem-safe cache name for a remote cover URL. */
export function coverCacheName(url: string): string {
  return `${createHash('sha256').update(url).digest('hex')}.img`
}

/** A custom directory only counts when it is an absolute path. */
export function coverCacheDir(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed && isAbsolute(trimmed) ? trimmed : null
}

/** Effective cache directory for a preference value. */
export function resolveCoverCacheDir(value: string | null | undefined, userData: string): string {
  return coverCacheDir(value) ?? join(userData, 'covers')
}

/**
 * Moves cached covers to a new directory when the preference changes. Files in
 * a user-selected directory other than our `.img` cache are never touched.
 */
export async function migrateCoverCache(source: string, destination: string): Promise<number> {
  if (resolve(source) === resolve(destination)) return 0
  let names: string[]
  try {
    names = await readdir(source)
  } catch {
    return 0
  }
  const covers = names.filter((name) => name.endsWith('.img'))
  if (!covers.length) return 0
  await mkdir(destination, { recursive: true })
  let moved = 0
  for (const name of covers) {
    const from = join(source, name),
      to = join(destination, name)
    try {
      if (existsSync(to)) {
        await unlink(from)
      } else {
        try {
          await rename(from, to)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
          await copyFile(from, to)
          await unlink(from)
        }
      }
      moved++
    } catch (error) {
      console.warn(
        `[cover] migrate ${name} failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return moved
}

/**
 * Covers are stored without an extension, so the protocol response derives its
 * content type from magic bytes instead of trusting the remote header.
 */
export function imageContentType(bytes: Uint8Array): string {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  const head = text(0, Math.min(bytes.length, 512)).trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && text(1, 4) === 'PNG') return 'image/png'
  if (bytes.length >= 6 && text(0, 4) === 'GIF8') return 'image/gif'
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && text(4, 8) === 'ftyp' && (text(8, 12) === 'avif' || text(8, 12) === 'avis'))
    return 'image/avif'
  return 'application/octet-stream'
}
