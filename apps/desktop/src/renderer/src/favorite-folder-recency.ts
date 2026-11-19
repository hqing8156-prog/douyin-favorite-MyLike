import type { FavoriteFolder } from '../../shared/contracts'

export function readFavoriteFolderVisits(accountId: string): Record<string, number> {
  const parsed: unknown = JSON.parse(
    window.localStorage.getItem(`mylike:favoriteFolderVisits:${accountId}`) ?? '{}'
  )
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
        )
      )
    : {}
}

export function readFavoriteFolderCovers(accountId: string): Record<string, string> {
  const parsed: unknown = JSON.parse(
    window.localStorage.getItem(`mylike:favoriteFolderCovers:${accountId}`) ?? '{}'
  )
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0
        )
      )
    : {}
}

export function recordFavoriteFolderVisit(
  accountId: string,
  folderId: string,
  coverUrl?: string | null
): Record<string, number> {
  const visits = recordFavoriteFolderVisits(accountId, [folderId])
  if (coverUrl) {
    const covers = readFavoriteFolderCovers(accountId)
    covers[folderId] = coverUrl
    window.localStorage.setItem(`mylike:favoriteFolderCovers:${accountId}`, JSON.stringify(covers))
  }
  return visits
}

export function recordFavoriteFolderVisits(accountId: string, folderIds: string[]): Record<string, number> {
  if (!folderIds.length) return readFavoriteFolderVisits(accountId)
  const visits = readFavoriteFolderVisits(accountId)
  const updated = { ...visits }
  const latestVisit = Math.max(Date.now(), ...Object.values(visits).map((visitedAt) => visitedAt + 1))
  for (const [index, folderId] of [...new Set(folderIds)].entries()) updated[folderId] = latestVisit + index
  window.localStorage.setItem(`mylike:favoriteFolderVisits:${accountId}`, JSON.stringify(updated))
  return updated
}

export function sortFavoriteFoldersByVisit(
  folders: FavoriteFolder[],
  visits: Record<string, number>
): FavoriteFolder[] {
  return [...folders].sort(
    (a, b) => (visits[b.id] ?? 0) - (visits[a.id] ?? 0) || a.title.localeCompare(b.title, 'zh-CN')
  )
}
