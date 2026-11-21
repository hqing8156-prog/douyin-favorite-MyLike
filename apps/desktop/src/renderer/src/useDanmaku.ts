import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { DANMAKU_WINDOW_MS, type DanmakuItem, type Media } from '../../shared/contracts'
import { call } from './api'

const empty: DanmakuItem[] = []
const MAX_WORKS = 12
const MAX_WINDOWS = 400

type WindowCache = Map<number, DanmakuItem[]>
const works = new Map<string, WindowCache>()

function workCache(key: string): WindowCache {
  const existing = works.get(key)
  if (existing) {
    // Refresh recency so the most recently watched works survive the cap.
    works.delete(key)
    works.set(key, existing)
    return existing
  }
  const created = new Map<number, DanmakuItem[]>()
  works.set(key, created)
  while (works.size > MAX_WORKS) works.delete(works.keys().next().value!)
  return created
}
function store(key: string, window: number, items: DanmakuItem[]) {
  const cache = workCache(key)
  cache.delete(window)
  cache.set(window, items)
  while (cache.size > MAX_WINDOWS) cache.delete(cache.keys().next().value!)
}

/**
 * Loads the 32-second danmaku windows around the current playback position.
 * Windows are fetched from the shared page request lane, cached per work and
 * silently skipped on failure so playback never waits for them.
 */
export function useDanmaku(
  media: Media | null,
  accountId: string | null,
  video: RefObject<HTMLVideoElement | null>,
  enabled: boolean
): DanmakuItem[] {
  const info = media?.work.mediaType === 'video' ? (media.danmaku ?? null) : null
  const workId = media?.work.id ?? ''
  const durationMs = (info?.durationMs ?? 0) || media?.work.durationMs || 0
  const active = enabled && !!info && info.enabled && info.count > 0 && durationMs > 0
  const key = accountId && workId ? `${accountId}:${workId}` : ''
  const maxIndex = Math.max(0, Math.floor((durationMs - 1) / DANMAKU_WINDOW_MS))
  const [index, setIndex] = useState(0)
  const [version, setVersion] = useState(0)
  const generation = useRef(0)
  const inFlight = useRef(new Set<string>())
  const queue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    generation.current++
    setIndex(0)
    setVersion((value) => value + 1)
  }, [key])

  useEffect(() => {
    if (!active) return
    const read = () => {
      const seconds = video.current?.currentTime ?? 0
      const next = Math.max(0, Math.min(maxIndex, Math.floor((seconds * 1000) / DANMAKU_WINDOW_MS)))
      setIndex((current) => (current === next ? current : next))
    }
    read()
    const timer = setInterval(read, 1000)
    const node = video.current
    node?.addEventListener('seeked', read)
    node?.addEventListener('timeupdate', read)
    return () => {
      clearInterval(timer)
      node?.removeEventListener('seeked', read)
      node?.removeEventListener('timeupdate', read)
    }
  }, [active, video, key, maxIndex])

  useEffect(() => {
    if (!active || !key || !info || !accountId) return
    const current = generation.current
    const target = [index - 1, index, index + 1, index + 2].filter((value) => value >= 0 && value <= maxIndex)
    for (const slot of target) {
      const id = `${key}#${slot}`
      if (inFlight.current.has(id) || workCache(key).has(slot)) continue
      inFlight.current.add(id)
      const start = slot * DANMAKU_WINDOW_MS
      const end = Math.min(start + DANMAKU_WINDOW_MS, durationMs)
      queue.current = queue.current.then(async () => {
        if (generation.current !== current) {
          inFlight.current.delete(id)
          return
        }
        try {
          const page = await call(
            window.mylike.invoke('danmaku', {
              accountId,
              workId,
              token: info.token,
              durationMs,
              start,
              end
            })
          )
          if (generation.current === current) {
            store(key, slot, page.items)
            setVersion((value) => value + 1)
          }
        } catch {
          // Danmaku is optional; a failed window must not interrupt playback.
        } finally {
          inFlight.current.delete(id)
        }
      })
    }
  }, [active, key, index, maxIndex, durationMs, info, accountId, workId])

  return useMemo(() => {
    if (!active || !key) return empty
    const cache = workCache(key)
    const items: DanmakuItem[] = []
    const seen = new Set<string>()
    for (const window of [index - 1, index, index + 1]) {
      const found = cache.get(window)
      if (!found) continue
      for (const item of found) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        items.push(item)
      }
    }
    return items.sort((a, b) => a.timeMs - b.timeMs)
  }, [active, key, index, version])
}
