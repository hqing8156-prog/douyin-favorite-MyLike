import { useEffect, useState } from 'react'
import { FolderHeart } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Covers are served through the app protocol so they can be cached on disk:
 * remote signed URLs expire, local copies keep the list readable.
 */
export const cachedCoverUrl = (url: string): string => `mylike://cover/?url=${encodeURIComponent(url)}`

export function CoverImage({
  url,
  size = 18,
  fallback
}: {
  url: string | null | undefined
  size?: number
  fallback?: ReactNode
}) {
  const cached = url ? cachedCoverUrl(url) : null
  const [src, setSrc] = useState<string | null>(cached)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setSrc(cached)
    setFailed(false)
  }, [cached])
  if (!url || !src || failed) return fallback === undefined ? <FolderHeart size={size} /> : fallback
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        // A failed cache read falls back to the original address once, so a
        // broken cache directory never hides an otherwise reachable cover.
        if (src !== url) setSrc(url)
        else setFailed(true)
      }}
    />
  )
}
