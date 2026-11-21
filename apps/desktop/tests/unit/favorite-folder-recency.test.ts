import { afterEach, expect, it, vi } from 'vitest'
import {
  readFavoriteFolderCovers,
  recordFavoriteFolderVisit,
  recordFavoriteFolderVisits,
  sortFavoriteFoldersByVisit,
  sortFavoriteFoldersForSelection
} from '../../src/renderer/src/favorite-folder-recency'

afterEach(() => vi.unstubAllGlobals())

it('orders folders by most recent visit and then alphabetically when unvisited', () => {
  const folders = [
    { id: 'b', title: '旅行', localCount: 0, remoteCount: 0 },
    { id: 'd', title: '音乐', localCount: 0, remoteCount: 0 },
    { id: 'c', title: '历史', localCount: 0, remoteCount: 0 },
    { id: 'a', title: 'AI', localCount: 0, remoteCount: 0 }
  ]

  expect(sortFavoriteFoldersByVisit(folders, { b: 10, c: 20 }).map(({ id }) => id)).toEqual([
    'c',
    'b',
    'd',
    'a'
  ])
})

it('ranks local and cloud folders together by most recent visit', () => {
  const folders = [
    { id: 'cloud', title: '云端夹', localCount: 0, remoteCount: 0, localOnly: false },
    { id: 'local', title: '本地夹', localCount: 0, remoteCount: 0, localOnly: true }
  ]

  expect(sortFavoriteFoldersByVisit(folders, { cloud: 10, local: 20 }).map(({ id }) => id)).toEqual([
    'local',
    'cloud'
  ])
})

it('puts folders already containing the selection first, keeping visit order inside each group', () => {
  const folders = [
    { id: 'hot', title: '常访问', localCount: 0, remoteCount: 0 },
    { id: 'has', title: '已含所选', localCount: 0, remoteCount: 0 },
    { id: 'cold', title: '陌生', localCount: 0, remoteCount: 0 },
    { id: 'has-cold', title: '已含所选但很少访问', localCount: 0, remoteCount: 0 }
  ]

  expect(
    sortFavoriteFoldersForSelection(folders, { hot: 50, has: 20 }, { has: 2, 'has-cold': 1 }).map(
      ({ id }) => id
    )
  ).toEqual(['has', 'has-cold', 'hot', 'cold'])
  expect(sortFavoriteFoldersForSelection(folders, { hot: 50, has: 20 }, null).map(({ id }) => id)).toEqual([
    'hot',
    'has',
    'cold',
    'has-cold'
  ])
})

it('records newly added folders in selection order', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
  })

  const visits = recordFavoriteFolderVisits('account', ['first', 'second'])

  expect(visits.second!).toBeGreaterThan(visits.first!)
  expect(JSON.parse(values.get('mylike:favoriteFolderVisits:account') ?? '{}')).toEqual(visits)
})

it('keeps the thumbnail from the last folder visit', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
  })

  recordFavoriteFolderVisit('account', 'folder', 'https://example.test/last-visit.jpg')

  expect(readFavoriteFolderCovers('account')).toEqual({
    folder: 'https://example.test/last-visit.jpg'
  })
})
