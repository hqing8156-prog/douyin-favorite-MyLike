import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Store } from '../../src/main/storage/database'
import type { Database } from '../../src/main/storage/client'
import type { Operation } from '../../src/main/douyin/page-request'
import { FavoriteActions } from '../../src/main/favorite-actions'
import { AppError } from '../../src/main/errors'

const roots: string[] = [],
  stores: Store[] = []
const work = {
  id: '1234567890123456789',
  title: '喜欢的作品',
  author: '作者',
  publishedAt: 1700000000,
  coverUrl: null,
  mediaType: 'video' as const,
  isLive: false
}
const localFolder = (store: Store, id: string, title: string, privateFolder: boolean) =>
  store.call('favoriteLocalFolderCreate', {
    accountId: 'a',
    remoteId: 'remote-a',
    id,
    title,
    private: privateFolder,
    queueWrite: false
  })
function setup(collected = false) {
  const root = mkdtempSync(join(tmpdir(), 'mylike-favorite-actions-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  for (const id of ['a', 'b']) {
    store.call('createAccount', { id, name: id })
    store.call('bindAccount', { accountId: id, remoteId: `remote-${id}`, nickname: id, avatarUrl: null })
  }
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [work, { ...work, id: '2' }],
    cursor: '0',
    hasMore: false
  })
  const queue = store.call('queueCreate', {
    accountId: 'a',
    source: { type: 'ids', ids: [work.id, '2'], sort: 'published' },
    mode: 'sequence',
    startWorkId: work.id
  })
  const scope = { accountId: 'a', queueId: queue.queueId, revision: queue.revision, workId: work.id }
  const platform = {
    collected,
    remoteId: 'remote-a',
    folders: [
      { collects_id_str: '9007199254740993999', collects_name: '旅行', total_number: 2, status: 0 },
      { collects_id_str: '8', collects_name: '音乐', total_number: 2, status: 1 }
    ],
    folderWorkIds: [work.id, '2'],
    folderAddVisible: true,
    badFolderItems: false,
    unavailableWorkIds: [] as string[],
    failure: '' as Operation | '',
    deleteFailure: '' as '' | 'EMPTY_RESPONSE' | 'API_REJECTED',
    deleteTakesEffect: false,
    createFailure: '' as '' | 'API_REJECTED',
    createTakesEffect: false,
    hold: null as (() => Promise<void>) | null,
    afterWrite: null as (() => void) | null,
    confirmedDespiteFailure: false
  }
  const calls: { operation: Operation; parameters: Record<string, string> }[] = []
  let identityCalls = 0
  const service = new FavoriteActions(
    { call: async (method: any, input: any) => store.call(method, input) } as Database,
    {
      request: async (_account, operation, parameters = {}) => {
        calls.push({ operation, parameters })
        if (operation === 'detail') {
          const detailId = parameters.aweme_id ?? work.id
          if (platform.unavailableWorkIds.includes(detailId))
            return {
              status_code: 0,
              aweme_detail: null,
              filter_detail: { aweme_id: detailId, filter_reason: 'core_dep', detail_msg: '' }
            }
          return {
            aweme_detail: {
              aweme_id: detailId,
              desc: work.title,
              collect_stat: platform.collected ? 1 : 0,
              aweme_type: 68,
              images: [{ url_list: [] }]
            }
          }
        }
        if (operation === 'folders') return { collects_list: platform.folders, has_more: 0, cursor: '0' }
        if (operation === 'folderItems')
          return {
            aweme_list: [
              ...platform.folderWorkIds.map((id) => ({
                aweme_id: id,
                desc: id === work.id ? work.title : '另一件收藏作品',
                author: { nickname: work.author }
              })),
              ...(platform.badFolderItems ? [null] : [])
            ],
            has_more: 0,
            cursor: '0'
          }
        if (operation === platform.failure) {
          if (platform.confirmedDespiteFailure) platform.collected = true
          throw new AppError('TIMEOUT', 'fixture timeout')
        }
        await platform.hold?.()
        if (operation === 'favoriteAdd') platform.collected = true
        if (operation === 'favoriteFolderAdd' && platform.folderAddVisible) {
          const workId = parameters.aweme_id
          if (workId && !platform.folderWorkIds.includes(workId)) platform.folderWorkIds.push(workId)
        }
        platform.afterWrite?.()
        if (operation === 'favoriteFolderCreate' && parameters.action === '2') {
          if (platform.deleteTakesEffect)
            platform.folders = platform.folders.filter(
              (folder) => folder.collects_id_str !== parameters.collects_id
            )
          if (platform.deleteFailure) throw new AppError(platform.deleteFailure, 'fixture delete failure')
        }
        if (operation === 'favoriteFolderCreate' && parameters.action === '1') {
          if (platform.createFailure && !platform.createTakesEffect)
            throw new AppError(platform.createFailure, 'fixture create failure')
          const folder = {
            collects_id_str: '9',
            collects_name: parameters.collects_name!,
            total_number: 0,
            status: parameters.secret === '1' ? 0 : 1
          }
          platform.folders.push(folder)
          if (platform.createFailure) throw new AppError(platform.createFailure, 'fixture create failure')
          return { status_code: 0, collects_info: folder }
        }
        return { status_code: 0 }
      }
    },
    async (_id, action) => action(() => {}),
    async (_id, check) => {
      identityCalls++
      check()
      return { ...store.call('accounts', undefined)[0]!, remoteId: platform.remoteId }
    },
    () => {}
  )
  const writes = () => calls.filter((call) => call.operation.startsWith('favorite'))
  return { store, service, scope, platform, calls, writes, identityCalls: () => identityCalls }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.call('close', undefined)
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mylike-favorite-actions-/)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
it('opens from the local snapshot without remote reads, then verifies cloud state when saving', async () => {
  const { service, scope, store, writes, calls, identityCalls } = setup()
  for (const folder of [
    { id: '9007199254740993999', title: '旅行', private: true },
    { id: '8', title: '音乐', private: false }
  ])
    store.call('favoriteRememberFolder', {
      accountId: 'a',
      remoteId: 'remote-a',
      folder: { ...folder, remoteCount: 2, localCount: 0 }
    })
  const editor = await service.open(scope)
  expect(editor).toMatchObject({
    collected: false,
    folders: [
      { id: '9007199254740993999', private: true },
      { id: '8', private: false }
    ]
  })
  expect(calls).toHaveLength(0)
  expect(identityCalls()).toBe(0)

  expect(writes()).toHaveLength(0)
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  await expect(service.save('a', editor.token, ['8', '9007199254740993999'])).resolves.toEqual({
    collected: true,
    foldersAdded: 2
  })
  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteAdd',
    'favoriteFolderAdd',
    'favoriteFolderAdd'
  ])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
  expect(store.call('favoriteStatus', { accountId: 'b', workId: scope.workId }).collected).toBe(false)
  expect(store.call('libraryOverview', { accountId: 'a' })).toMatchObject({
    likes: 2,
    favorites: 1,
    overlap: 1
  })
  expect(store.call('favoriteFolders', { accountId: 'a' }).map((folder) => folder.localCount)).toEqual([1, 1])
  expect(store.call('checkDatabase', {})).toMatchObject({ ok: true })
})

it('refreshes the folder list from the cloud only when explicitly requested', async () => {
  const { service, scope, store, calls, identityCalls } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })

  await service.open(scope)
  expect(calls).toHaveLength(0)
  expect(identityCalls()).toBe(0)

  const editor = await service.open(scope, true)
  expect(editor.folders.map(({ id }) => id)).toEqual(['9007199254740993999', '8'])
  expect(calls.map(({ operation }) => operation)).toEqual(['folders'])
  expect(identityCalls()).toBe(1)
})

it('opens the favorite editor locally without a verified cloud identity when writeback is off', async () => {
  const { service, store, calls, identityCalls } = setup()
  store.call('createAccount', { id: 'local', name: '本地账号' })
  store.call('savePage', {
    accountId: 'local',
    remoteId: null,
    items: [work],
    cursor: '0',
    hasMore: false
  } as any)
  const queue = store.call('queueCreate', {
    accountId: 'local',
    source: { type: 'ids', ids: [work.id], sort: 'published' },
    mode: 'sequence',
    startWorkId: work.id
  })
  const scope = { accountId: 'local', queueId: queue.queueId, revision: queue.revision, workId: work.id }

  await expect(service.open(scope, true)).resolves.toMatchObject({
    accountId: 'local',
    workId: work.id,
    collected: false
  })
  expect(calls).toHaveLength(0)
  expect(identityCalls()).toBe(0)
})

it('marks folders that already contain the work when opening the favorite editor', async () => {
  const { service, scope, store } = setup(true)
  for (const item of [work, { ...work, id: '2' }])
    store.call('favoriteConfirm', {
      accountId: 'a',
      remoteId: 'remote-a',
      work: item,
      folder: { id: '8', title: '音乐', remoteCount: 2, localCount: 0 },
      synced: true
    })

  const editor = await service.open(scope)

  expect(editor.folderIds).toEqual(['8'])
  expect(store.call('favoriteFolderMemberships', { accountId: 'a', workIds: [work.id, '2'] })).toEqual([
    { folderId: '8', count: 2 }
  ])
})
it('removes an existing folder membership from the favorite editor without uncollecting the work', async () => {
  const { service, scope, store, writes } = setup(true)
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 1, localCount: 0 },
    synced: true
  })

  const editor = await service.open(scope)
  await expect(service.save('a', editor.token, [], ['8'])).resolves.toEqual({
    collected: true,
    foldersAdded: 0
  })

  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderRemove'])
  expect(writes()[0]?.parameters.from_collects_id).toBe('8')
  expect(store.call('favoriteStatus', { accountId: 'a', workId: work.id }).collected).toBe(true)
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((folder) => folder.id === '8')?.localCount
  ).toBe(0)
})
it('blocks a conflicting collect editor until an unknown uncollect has been verified', async () => {
  const { service, scope, store, calls } = setup(true)
  // The editor opens from the local snapshot now, so seed the collected state locally.
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work })
  const editor = await service.open(scope)
  store.call('unlikeCreate', {
    accountId: 'a',
    id: 'remove',
    mode: 'single',
    source: 'favorites',
    workIds: [scope.workId]
  })
  store.call('unlikeReserve', { accountId: 'a', taskId: 'remove', workId: scope.workId })
  store.call('unlikeFinish', {
    accountId: 'a',
    taskId: 'remove',
    workId: scope.workId,
    status: 'unknown',
    reason: null,
    errorCode: 'TIMEOUT'
  })
  store.call('unlikeUpdate', { accountId: 'a', taskId: 'remove', status: 'paused', reason: null })
  calls.length = 0
  await expect(service.open(scope)).rejects.toThrow(/重新核验/)
  await expect(service.save('a', editor.token, ['8'])).rejects.toThrow(/重新核验/)
  expect(calls).toHaveLength(0)
  store.call('unlikeResolve', { accountId: 'a', taskId: 'remove', workId: scope.workId, liked: true })
  await expect(service.open(scope)).resolves.toMatchObject({ collected: true })
})
it('sends the default collection once and does not resend it when a fresh detail already confirms it', async () => {
  const { service, scope, platform, store, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  let editor = await service.open(scope)
  await service.save('a', editor.token, [])
  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd'])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  platform.collected = true
  editor = await service.open(scope)
  await service.save('a', editor.token, ['8'])
  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd', 'favoriteFolderAdd'])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  editor = await service.open(scope)
  await service.save('a', editor.token, [])
  expect(store.call('favoriteFolders', { accountId: 'a' })[0]?.localCount).toBe(1)
})
it('retains queued local-folder operations when an explicit writeback fails', async () => {
  const { service, scope, platform, store, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  const editor = await service.open(scope)
  const folder = localFolder(store, 'local-pending', '待写回', true)
  await service.save('a', editor.token, [folder.id])
  platform.failure = 'favoriteFolderAdd'
  await expect(service.syncToCloud('a', () => {})).rejects.toThrow(/未自动重试/)
  expect(writes().some((call) => call.operation === 'favoriteFolderAdd')).toBe(true)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
  expect(store.call('favoriteWriteOps', { accountId: 'a' }).map((operation) => operation.kind)).toEqual([
    'folder-add'
  ])
})
it('does not send a default favorite when the platform already reports it as collected', async () => {
  const { service, scope, platform, store, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  platform.collected = true
  const editor = await service.open(scope)
  await service.save('a', editor.token, [])
  await service.syncToCloud('a', () => {})
  expect(writes().filter((call) => call.operation === 'favoriteAdd')).toHaveLength(0)
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
})
it('refuses a changed account identity, switched work and deleted target folder before writing', async () => {
  const { service, scope, platform, store, writes } = setup()
  const editor = await service.open(scope)
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  platform.remoteId = 'remote-b'
  await expect(service.save('a', editor.token, [])).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
  platform.remoteId = 'remote-a'
  platform.folders = []
  await expect(service.save('a', editor.token, ['8'])).rejects.toMatchObject({ code: 'FOLDER_CHANGED' })
  store.call('queueMove', { accountId: 'a', queueId: scope.queueId, target: 0 })
  await expect(service.save('a', editor.token, [])).rejects.toMatchObject({ code: 'QUEUE_CHANGED' })
  expect(writes()).toHaveLength(0)
})
it('verifies favorite folders against the live remote list before presenting them', async () => {
  const { service, store } = setup()
  store.call('favoriteRememberFolder', {
    accountId: 'a',
    remoteId: 'remote-a',
    folder: { id: 'stale', title: '已删除的收藏夹', remoteCount: 3, localCount: 0 }
  })

  const folders = await service.refreshFolders('a')

  expect(folders.map(({ id, title }) => ({ id, title }))).toEqual([
    { id: '9007199254740993999', title: '旅行' },
    { id: '8', title: '音乐' }
  ])
})
it('preserves local folder management and hides a deleted cloud-linked folder on remote refresh', async () => {
  const { service, store } = setup()
  const folder = store.call('favoriteLocalFolderCreate', {
    accountId: 'a',
    remoteId: 'remote-a',
    id: 'local-managed',
    title: '原名称',
    private: true,
    queueWrite: false
  })
  store.call('favoriteLinkFolder', {
    accountId: 'a',
    folderId: folder.id,
    remoteId: '8',
    title: folder.title,
    private: true
  })
  store.call('favoriteLocalFolderEdit', {
    accountId: 'a',
    folderId: folder.id,
    title: '本机名称'
  })

  expect(await service.refreshFolders('a')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: folder.id,
        title: '本机名称',
        managedLocally: true,
        localOnly: false
      })
    ])
  )

  store.call('favoriteLocalFolderDelete', { accountId: 'a', folderId: folder.id })
  expect(await service.refreshFolders('a')).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: folder.id })])
  )
})
it('diffs a local-only folder without contacting the cloud or queueing writes', async () => {
  const { service, store, calls } = setup()
  const folder = localFolder(store, 'local-diff', '仅本地差异', true)
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work, folder })

  const diff = await service.diffFolder('a', folder.id)

  expect(diff).toMatchObject({
    folderId: folder.id,
    title: '仅本地差异',
    localOnly: true,
    complete: true,
    localCount: 1,
    remoteCount: 0,
    truncated: false
  })
  expect(diff.add.map((item) => item.id)).toEqual([work.id])
  expect(diff.remoteOnly).toEqual([])
  expect(calls.some((call) => call.operation === 'folderItems')).toBe(false)
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
})
it('reports both sides of a cloud folder diff without writing anything', async () => {
  const { service, store, calls } = setup()
  const extra = { ...work, id: '3', title: '只在本地' }
  const target = { id: '8', title: '音乐', remoteCount: 2, localCount: 0 }
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work, folder: target })
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work: extra, folder: target })
  const pendingBefore = store.call('favoriteWritePending', { accountId: 'a' })

  const diff = await service.diffFolder('a', '8')

  expect(diff).toMatchObject({
    folderId: '8',
    localOnly: false,
    complete: true,
    skipped: 0,
    localCount: 2,
    remoteCount: 2
  })
  expect(diff.add.map((item) => item.id)).toEqual(['3'])
  expect(diff.remoteOnly.map((item) => item.id)).toEqual(['2'])
  expect(diff.remoteOnly[0]).toMatchObject({ title: '另一件收藏作品', author: '作者' })
  expect(calls.some((call) => call.operation.startsWith('favorite'))).toBe(false)
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(pendingBefore)
})
it('marks a diff incomplete when a cloud row cannot be parsed', async () => {
  const { service, store, platform } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 2, localCount: 0 }
  })
  platform.badFolderItems = true

  const diff = await service.diffFolder('a', '8')

  expect(diff).toMatchObject({ complete: false, skipped: 1, localCount: 1 })
  expect(diff.remoteOnly.map((item) => item.id)).toEqual(['2'])
})
it('corrects a stale cached count from the latest cloud folder listing', async () => {
  const { service, store, platform } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 291, localCount: 0 }
  })
  platform.folderWorkIds = [work.id]
  platform.folders.find((folder) => folder.collects_id_str === '8')!.total_number = 1

  const diff = await service.diffFolder('a', '8')

  expect(diff).toMatchObject({
    complete: true,
    localCount: 1,
    remoteCount: 1,
    expectedRemoteCount: 1
  })
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((folder) => folder.id === '8')?.remoteCount
  ).toBe(1)
})
it('marks a diff incomplete when the item list is shorter than the latest cloud folder count', async () => {
  const { service, store, platform } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 10, localCount: 0 }
  })
  platform.folderWorkIds = [work.id]

  const diff = await service.diffFolder('a', '8')

  expect(diff).toMatchObject({
    complete: false,
    localCount: 1,
    remoteCount: 1,
    expectedRemoteCount: 2
  })
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((folder) => folder.id === '8')?.remoteCount
  ).toBe(2)
})
it('creates a cloud folder directly from the video view', async () => {
  const { service, scope, store, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  const editor = await service.open(scope)
  const folder = await service.createFolder('a', editor.token, '新的收藏夹', true)
  expect(folder).toMatchObject({ title: '新的收藏夹', private: true, localOnly: false, remoteId: '9' })
  expect(folder.id).toMatch(/^local-/)
  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderCreate'])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(false)
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, localCount: 0, localOnly: false, remoteId: '9' }
  ])
  await expect(service.createFolder('a', editor.token, '新的收藏夹', true)).rejects.toMatchObject({
    code: 'FOLDER_EXISTS'
  })
  await service.save('a', editor.token, [folder.id])
  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteFolderCreate',
    'favoriteAdd',
    'favoriteFolderAdd'
  ])
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, localCount: 1, localOnly: false }
  ])
})
it('syncs the default favorite immediately and local folder membership only on explicit writeback', async () => {
  const { service, scope, store, platform, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  const editor = await service.open(scope)
  const folder = localFolder(store, 'local-writeback', '待写回', true)
  await service.save('a', editor.token, [folder.id])

  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd'])
  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 2,
    remaining: 0,
    skipped: 0
  })

  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteAdd',
    'favoriteFolderCreate',
    'favoriteFolderAdd'
  ])
  expect(writes()[2]?.parameters.to_collects_id).toBe('9')
  expect(platform.folders.some((entry) => entry.collects_id_str === '9')).toBe(true)
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, remoteId: '9', localOnly: false, localCount: 1 }
  ])
})
it('writes only selected local folders while retaining unselected folder operations', async () => {
  const { service, scope, store, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  const editor = await service.open(scope)
  const first = localFolder(store, 'local-甲', '甲', true)
  const second = localFolder(store, 'local-乙', '乙', true)
  await service.save('a', editor.token, [first.id, second.id])
  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd'])
  const folderPending = (id: string) =>
    store.call('favoriteFolders', { accountId: 'a' }).find((folder) => folder.id === id)?.pendingWrites
  expect(folderPending(first.id)).toBeGreaterThan(0)
  expect(folderPending(second.id)).toBeGreaterThan(0)

  await expect(
    service.syncToCloud('a', () => {}, { folderIds: [first.id], includeDefault: false })
  ).resolves.toMatchObject({ synced: 2, remaining: 2, skipped: 0 })

  expect(folderPending(first.id)).toBe(0)
  expect(folderPending(second.id)).toBeGreaterThan(0)
  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteAdd',
    'favoriteFolderCreate',
    'favoriteFolderAdd'
  ])
  expect(store.call('favoriteWriteOps', { accountId: 'a' }).map((operation) => operation.folderId)).toEqual([
    second.id,
    second.id
  ])
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(2)
})
it('reuses one cloud reconciliation across consecutive writeback batches', async () => {
  const { service, store, calls, platform } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  platform.folderWorkIds = []
  platform.folders.find((folder) => folder.collects_id_str === '8')!.total_number = 0
  platform.unavailableWorkIds = Array.from({ length: 51 }, (_, index) => String(1000 + index))
  const folder = { id: '8', title: '音乐', remoteCount: 0, localCount: 0, private: false }
  for (let index = 0; index < 51; index++)
    store.call('favoriteConfirm', {
      accountId: 'a',
      remoteId: 'remote-a',
      work: { ...work, id: String(1000 + index) },
      folder,
      queueWrite: false
    })
  const scope = { folderIds: [folder.id], includeDefault: false }
  const progress: { phase: 'checking' | 'writing'; current: number; total: number }[] = []

  await expect(
    service.syncToCloud(
      'a',
      () => {},
      scope,
      (update) => progress.push(update)
    )
  ).resolves.toMatchObject({
    skipped: 50,
    remaining: 2,
    truncated: true
  })
  expect(progress[0]).toMatchObject({ phase: 'checking', current: 0, total: 0 })
  expect(progress).toContainEqual(expect.objectContaining({ phase: 'writing', current: 0, total: 100 }))
  expect(progress.at(-1)).toMatchObject({ phase: 'writing', current: 100, total: 100 })
  expect(calls.filter((call) => call.operation === 'folderItems')).toHaveLength(1)

  await expect(service.syncToCloud('a', () => {}, scope)).resolves.toMatchObject({
    skipped: 1,
    remaining: 0,
    truncated: false
  })
  expect(calls.filter((call) => call.operation === 'folderItems')).toHaveLength(1)
})
it('keeps edits created while writeback is disabled local after later enabling it', async () => {
  const { store, writes } = setup()
  const folder = localFolder(store, 'local-仅本地', '仅本地', false)
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(1)
  expect(writes()).toHaveLength(0)
  expect(folder.localOnly).toBe(true)
})
it('keeps the favorite and its folder membership local while writeback is disabled', async () => {
  const { service, scope, store, writes, calls, identityCalls } = setup()
  store.call('favoriteRememberFolder', {
    accountId: 'a',
    remoteId: 'remote-a',
    folder: { id: '8', title: '音乐', remoteCount: 2, localCount: 0 }
  })
  const editor = await service.open(scope)
  await expect(service.save('a', editor.token, ['8'])).resolves.toEqual({
    collected: true,
    foldersAdded: 1
  })
  expect(calls).toHaveLength(0)
  expect(identityCalls()).toBe(0)
  expect(writes()).toHaveLength(0)
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(2)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((folder) => folder.id === '8')?.localCount
  ).toBe(1)

  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 2,
    remaining: 0,
    skipped: 0
  })
  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd'])
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(0)
})
it('creates a local-only folder from the video view while writeback is disabled', async () => {
  const { service, scope, store, writes, calls, identityCalls } = setup()
  const editor = await service.open(scope)
  const folder = await service.createFolder('a', editor.token, '仅本地新建', true)
  expect(folder).toMatchObject({ title: '仅本地新建', private: true, localOnly: true, remoteId: null })
  expect(calls).toHaveLength(0)
  expect(identityCalls()).toBe(0)
  expect(writes()).toHaveLength(0)
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(1)

  await service.save('a', editor.token, [folder.id])
  expect(writes()).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(3)
})
it('stages local folder additions made while writeback was disabled after enabling it', async () => {
  const { service, scope, store, writes } = setup()
  const editor = await service.open(scope)
  const folder = localFolder(store, 'local-仅本地', '仅本地', true)
  await service.save('a', editor.token, [folder.id])

  expect(writes().map((call) => call.operation)).toEqual([])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(3)

  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 3,
    remaining: 0,
    skipped: 0
  })

  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteFolderCreate',
    'favoriteFolderAdd',
    'favoriteAdd'
  ])
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(0)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
})
it('writes local-only folders and their contents after an explicit writeback click', async () => {
  const { service, scope, store, writes, calls, identityCalls } = setup(true)
  const editor = await service.open(scope)
  const folder = localFolder(store, 'local-之前仅本地', '之前仅本地', true)
  await service.save('a', editor.token, [folder.id])

  expect(calls).toHaveLength(0)
  expect(identityCalls()).toBe(0)
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(3)
  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 3,
    remaining: 0,
    skipped: 0
  })

  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderCreate', 'favoriteFolderAdd'])
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, remoteId: '9', localOnly: false, localCount: 1 }
  ])
})
it('links a folder the platform reports as rejected but did create', async () => {
  const { service, scope, store, platform } = setup()
  const folder = localFolder(store, 'local-rejected', '新建收藏夹', true)
  const editor = await service.open(scope)
  await service.save('a', editor.token, [folder.id])
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  platform.createFailure = 'API_REJECTED'
  platform.createTakesEffect = true

  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 3,
    remaining: 0
  })

  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, title: '新建收藏夹', remoteId: '9', localOnly: false }
  ])
})
it('keeps the create queued when a rejected folder did not appear in the cloud', async () => {
  const { service, scope, store, platform } = setup()
  const folder = localFolder(store, 'local-rejected', '新建收藏夹', true)
  const editor = await service.open(scope)
  await service.save('a', editor.token, [folder.id])
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  platform.createFailure = 'API_REJECTED'
  platform.createTakesEffect = false

  await expect(service.syncToCloud('a', () => {})).rejects.toMatchObject({
    code: 'API_REJECTED'
  })
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, title: '新建收藏夹', remoteId: null, localOnly: true }
  ])
  expect(store.call('favoriteWriteOps', { accountId: 'a' }).map((op) => op.kind)).toEqual([
    'folder-create',
    'folder-add',
    'favorite-add'
  ])
})
it('retries an unconfirmed folder add once, then skips it so the queue continues', async () => {
  const { service, scope, store, platform, writes } = setup()
  const folder = localFolder(store, 'local-retry', '重试', true)
  const editor = await service.open(scope)
  await service.save('a', editor.token, [folder.id])
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  platform.folderWorkIds = ['2']
  platform.folderAddVisible = false

  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 2,
    skipped: 1,
    remaining: 0
  })

  const adds = writes().filter((call) => call.operation === 'favoriteFolderAdd')
  expect(adds.map((call) => call.parameters.item_type)).toEqual(['2', '68'])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((entry) => entry.id === folder.id)
  ).toMatchObject({ localCount: 1, localOnly: false })
})
it('skips an unconfirmed folder add when the platform reports the work unavailable', async () => {
  const { service, scope, store, platform, writes } = setup()
  const folder = localFolder(store, 'local-unavailable', '不可用', true)
  const editor = await service.open(scope)
  await service.save('a', editor.token, [folder.id])
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  platform.folderWorkIds = ['2']
  platform.folderAddVisible = false
  platform.unavailableWorkIds = [work.id]

  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 1,
    skipped: 2,
    remaining: 0
  })

  expect(writes().filter((call) => call.operation === 'favoriteFolderAdd')).toHaveLength(1)
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
})
it('renames a cloud-linked folder on both the cloud and locally', async () => {
  const { service, store, writes } = setup()
  const folder = localFolder(store, 'local-rename', '旧名称', true)
  store.call('favoriteLinkFolder', {
    accountId: 'a',
    folderId: folder.id,
    remoteId: '8',
    title: '旧名称',
    private: true
  })

  const updated = await service.renameFolder('a', folder.id, '新名称')

  expect(updated).toMatchObject({ title: '新名称', remoteId: '8', localOnly: false })
  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderCreate'])
  expect(writes()[0]?.parameters).toMatchObject({
    action: '0',
    collects_id: '8',
    collects_name: '新名称',
    secret: '1'
  })
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    expect.objectContaining({ id: folder.id, title: '新名称' })
  ])
})
it('renames a cloud-owned folder and updates its local title only after cloud success', async () => {
  const { service, store, writes } = setup()
  const folders = await service.refreshFolders('a')
  for (const folder of folders)
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })

  const updated = await service.renameCloudFolder('a', '8', '新音乐')

  expect(updated).toMatchObject({ id: '8', remoteId: '8', title: '新音乐', localOnly: false })
  expect(writes()[0]?.parameters).toMatchObject({
    action: '0',
    collects_id: '8',
    collects_name: '新音乐',
    secret: '0'
  })
  expect(store.call('favoriteFolders', { accountId: 'a' })).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: '8', title: '新音乐' })])
  )
})
it('deletes a cloud folder and clears its local memberships without deleting default favorites', async () => {
  const { service, store, writes } = setup()
  const folders = await service.refreshFolders('a')
  for (const folder of folders)
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteId: '8', remoteCount: 1, localCount: 0 },
    synced: true
  })

  const result = await service.deleteCloudFolder('a', '8')

  expect(result).toMatchObject({ folderId: '8', title: '音乐', localCount: 1 })
  expect(writes()[0]?.parameters).toMatchObject({ action: '2', collects_id: '8' })
  expect(store.call('favoriteFolders', { accountId: 'a' })).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: '8' })])
  )
  expect(store.call('favoriteHiddenFolderIds', { accountId: 'a' })).toContain('8')
  expect(store.call('favoriteStatus', { accountId: 'a', workId: work.id }).collected).toBe(true)
})
it('keeps the local folder visible when cloud deletion is not confirmed', async () => {
  const { service, store, platform } = setup()
  const folders = await service.refreshFolders('a')
  for (const folder of folders)
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })
  platform.failure = 'favoriteFolderCreate'

  await expect(service.deleteCloudFolder('a', '8')).rejects.toMatchObject({ code: 'TIMEOUT' })
  expect(store.call('favoriteFolders', { accountId: 'a' })).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: '8', title: '音乐' })])
  )
})
it('finishes a cloud deletion when an empty reply hides a deletion that did take effect', async () => {
  const { service, store, platform } = setup()
  const folders = await service.refreshFolders('a')
  for (const folder of folders)
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })
  platform.deleteFailure = 'EMPTY_RESPONSE'
  platform.deleteTakesEffect = true

  const result = await service.deleteCloudFolder('a', '8')

  expect(result).toMatchObject({ folderId: '8', title: '音乐' })
  expect(store.call('favoriteFolders', { accountId: 'a' })).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: '8' })])
  )
  expect(store.call('favoriteHiddenFolderIds', { accountId: 'a' })).toContain('8')
})
it('keeps a cloud folder when an empty reply leaves it in place', async () => {
  const { service, store, platform } = setup()
  const folders = await service.refreshFolders('a')
  for (const folder of folders)
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })
  platform.deleteFailure = 'EMPTY_RESPONSE'

  await expect(service.deleteCloudFolder('a', '8')).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  expect(store.call('favoriteFolders', { accountId: 'a' })).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: '8', title: '音乐' })])
  )
})
it('finishes a cloud deletion the platform reports as already gone', async () => {
  const { service, store, platform } = setup()
  const folders = await service.refreshFolders('a')
  for (const folder of folders)
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })
  platform.deleteFailure = 'API_REJECTED'
  platform.deleteTakesEffect = true

  await expect(service.deleteCloudFolder('a', '8')).resolves.toMatchObject({ folderId: '8' })
  expect(store.call('favoriteFolders', { accountId: 'a' })).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: '8' })])
  )
})
it('removes an empty cloud folder the platform no longer has', async () => {
  const { service, store, platform, writes } = setup()
  const folders = await service.refreshFolders('a')
  for (const folder of folders)
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })
  platform.folders = platform.folders.filter((folder) => folder.collects_id_str !== '8')

  const result = await service.reconcileFolders('a')

  expect(result).toMatchObject({ removed: 1, unlinked: 0 })
  expect(result.folders).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: '8' })]))
  expect(writes()).toHaveLength(0)
})
it('turns a missing cloud folder into a local-only folder when it still has works', async () => {
  const { service, store, platform } = setup()
  const folders = await service.refreshFolders('a')
  for (const folder of folders)
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteId: '8', remoteCount: 1, localCount: 0 },
    synced: true
  })
  platform.folders = platform.folders.filter((folder) => folder.collects_id_str !== '8')
  store.call('favoriteQueueWrite', {
    accountId: 'a',
    remoteId: 'remote-a',
    kind: 'folder-add',
    folderId: '8',
    workId: work.id
  })

  const result = await service.reconcileFolders('a')

  expect(result).toMatchObject({ removed: 0, unlinked: 1 })
  expect(result.folders).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: '8', title: '音乐', localOnly: true, remoteId: null, localCount: 1 })
    ])
  )
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ folderId: '8' })])
  )
})
it('keeps folders that are still in the cloud untouched', async () => {
  const { service, store } = setup()
  const folders = await service.refreshFolders('a')
  for (const folder of folders)
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })

  const result = await service.reconcileFolders('a')

  expect(result).toMatchObject({ removed: 0, unlinked: 0 })
  expect(result.folders.filter((folder) => !folder.localOnly)).toHaveLength(2)
})
it('renames a local-only folder without touching the cloud', async () => {
  const { service, store, writes } = setup()
  const folder = localFolder(store, 'local-rename-local', '旧名称', true)

  const updated = await service.renameFolder('a', folder.id, '新名称')

  expect(updated).toMatchObject({ title: '新名称', localOnly: true })
  expect(writes()).toHaveLength(0)
})
it('removes selected works from a cloud folder while keeping the default favorite', async () => {
  const { service, store, writes } = setup(true)
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 2, localCount: 0 },
    synced: true
  })

  const result = await service.removeFromFolder('a', '8', [work.id])

  expect(result).toEqual({ folderId: '8', folderTitle: '音乐', removed: 1 })
  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderRemove'])
  expect(store.call('favoriteStatus', { accountId: 'a', workId: work.id }).collected).toBe(true)
  expect(
    store.call('query', {
      accountId: 'a',
      source: 'favorites',
      folderId: '8',
      search: '',
      mediaType: 'all',
      year: null,
      month: null,
      sort: 'published',
      offset: 0,
      limit: 60
    }).total
  ).toBe(0)
})
it('removes selected works from a local-only folder without a cloud request', async () => {
  const { service, store, writes } = setup(true)
  const folder = localFolder(store, 'local-remove', '仅本地', true)
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder
  })

  const result = await service.removeFromFolder('a', folder.id, [work.id])

  expect(result).toEqual({ folderId: folder.id, folderTitle: '仅本地', removed: 1 })
  expect(writes()).toHaveLength(0)
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((entry) => entry.id === folder.id)
  ).toMatchObject({
    localCount: 0
  })
})
it('moves works between cloud folders by adding to the target before removing from the source', async () => {
  const { service, store, writes } = setup(true)
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  store.call('favoriteRememberFolder', {
    accountId: 'a',
    remoteId: 'remote-a',
    folder: { id: '9007199254740993999', title: '旅行', remoteCount: 12, localCount: 0 }
  })
  for (const item of [work, { ...work, id: '2' }])
    store.call('favoriteConfirm', {
      accountId: 'a',
      remoteId: 'remote-a',
      work: item,
      folder: { id: '8', title: '音乐', remoteCount: 2, localCount: 0 },
      synced: true
    })

  const result = await service.moveToFolder('a', '8', '9007199254740993999', [work.id, '2'])

  expect(result).toEqual({
    fromFolderId: '8',
    fromFolderTitle: '音乐',
    toFolderId: '9007199254740993999',
    toFolderTitle: '旅行',
    moved: 2,
    cloudSync: true
  })
  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteFolderAdd',
    'favoriteFolderRemove',
    'favoriteFolderAdd',
    'favoriteFolderRemove'
  ])
  expect(writes()[0]?.parameters.to_collects_id).toBe('9007199254740993999')
  expect(writes()[1]?.parameters.from_collects_id).toBe('8')
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  const foldersAfterMove = store.call('favoriteFolders', { accountId: 'a' })
  expect(foldersAfterMove.find((folder) => folder.id === '8')?.localCount).toBe(0)
  expect(foldersAfterMove.find((folder) => folder.id === '9007199254740993999')?.localCount).toBe(2)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: work.id }).collected).toBe(true)
})
it('moves works between local folders without cloud writes when writeback is off', async () => {
  const { service, store, writes } = setup(true)
  const from = localFolder(store, 'local-move-from', '原收藏夹', true)
  const to = localFolder(store, 'local-move-to', '目标收藏夹', false)
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work, folder: from })

  const result = await service.moveToFolder('a', from.id, to.id, [work.id])

  expect(result).toMatchObject({ moved: 1, cloudSync: false })
  expect(writes()).toHaveLength(0)
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).map(({ id, localCount }) => ({ id, localCount }))
  ).toEqual([
    { id: from.id, localCount: 0 },
    { id: to.id, localCount: 1 }
  ])
})
it('adds to multiple selected folders before removing unchecked memberships and the source', async () => {
  const { service, store, writes } = setup(true)
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  for (const folder of [
    { id: '8', title: '当前', remoteId: '8', remoteCount: 1, localCount: 0 },
    {
      id: '9007199254740993999',
      title: '原目标',
      remoteId: '9007199254740993999',
      remoteCount: 1,
      localCount: 0
    },
    { id: '9', title: '新目标', remoteId: '9', remoteCount: 0, localCount: 0 }
  ])
    store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })
  const localTarget = localFolder(store, 'local-multi-target', '本地目标', true)
  for (const folder of [
    { id: '8', title: '当前', remoteId: '8', remoteCount: 1, localCount: 0 },
    {
      id: '9007199254740993999',
      title: '原目标',
      remoteId: '9007199254740993999',
      remoteCount: 1,
      localCount: 0
    }
  ])
    store.call('favoriteConfirm', {
      accountId: 'a',
      remoteId: 'remote-a',
      work,
      folder,
      synced: true
    })

  const result = await service.updateFolderMemberships(
    'a',
    '8',
    ['9', localTarget.id],
    ['9007199254740993999'],
    [work.id]
  )

  expect(result).toEqual({
    fromFolderTitle: '当前',
    addedFolderTitles: ['新目标', '本地目标'],
    removedFolderTitles: ['原目标', '当前'],
    updated: 1,
    cloudSync: true
  })
  expect(
    writes().map((call) => [
      call.operation,
      call.parameters.to_collects_id ?? call.parameters.from_collects_id
    ])
  ).toEqual([
    ['favoriteFolderAdd', '9'],
    ['favoriteFolderRemove', '9007199254740993999'],
    ['favoriteFolderRemove', '8']
  ])
  expect(store.call('favoriteStatus', { accountId: 'a', workId: work.id }).collected).toBe(true)
  expect(
    store
      .call('favoriteFolders', { accountId: 'a' })
      .map(({ id, localCount }) => [id, localCount])
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
  ).toEqual([
    ['8', 0],
    ['9', 1],
    ['9007199254740993999', 0],
    [localTarget.id, 1]
  ])
})
it('adds liked works to selected folders locally without removing existing memberships', async () => {
  const { service, store, writes } = setup()
  const target = localFolder(store, 'local-liked-target', '待整理', false)
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 2, localCount: 0 }
  })

  const result = await service.addToFolders('a', [target.id], [work.id, '2'])

  expect(result).toEqual({ added: 2, folderTitles: ['待整理'], cloudSync: false })
  expect(writes()).toHaveLength(0)
  expect(store.call('favoriteFolderMemberships', { accountId: 'a', workIds: [work.id, '2'] })).toEqual([
    { folderId: '8', count: 1 },
    { folderId: target.id, count: 2 }
  ])
})
it('writes new selected folder memberships to cloud and skips already-present works', async () => {
  const { service, store, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  const folder = { id: '8', title: '音乐', remoteCount: 2, localCount: 0 }
  store.call('favoriteRememberFolder', { accountId: 'a', remoteId: 'remote-a', folder })
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work, folder, synced: true })

  const result = await service.addToFolders('a', [folder.id], [work.id, '2'])

  expect(result).toEqual({ added: 1, folderTitles: ['音乐'], cloudSync: true })
  expect(writes().map((entry) => entry.operation)).toEqual(['favoriteFolderAdd'])
  expect(writes()[0]?.parameters.aweme_id).toBe('2')
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((entry) => entry.id === folder.id)?.localCount
  ).toBe(2)
})
it('rejects a move to the same folder or an unknown folder and never drops a work whose add failed', async () => {
  const { service, store, platform } = setup(true)
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  store.call('favoriteRememberFolder', {
    accountId: 'a',
    remoteId: 'remote-a',
    folder: { id: '9007199254740993999', title: '旅行', remoteCount: 12, localCount: 0 }
  })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 1, localCount: 0 },
    synced: true
  })
  await expect(service.moveToFolder('a', '8', '8', [work.id])).rejects.toMatchObject({
    code: 'INVALID_INPUT'
  })
  await expect(service.moveToFolder('a', '8', 'missing-folder', [work.id])).rejects.toMatchObject({
    code: 'FOLDER_CHANGED'
  })
  await expect(service.moveToFolder('a', '8', '9007199254740993999', ['999999'])).rejects.toMatchObject({
    code: 'WORK_UNAVAILABLE'
  })

  platform.failure = 'favoriteFolderRemove'
  await expect(service.moveToFolder('a', '8', '9007199254740993999', [work.id])).rejects.toThrow(
    /1 条已加入目标收藏夹，但未能从原收藏夹移出/
  )
  const foldersAfterFailure = store.call('favoriteFolders', { accountId: 'a' })
  expect(foldersAfterFailure.find((folder) => folder.id === '8')?.localCount).toBe(1)
  expect(foldersAfterFailure.find((folder) => folder.id === '9007199254740993999')?.localCount).toBe(1)
})
it('preserves an already-synced default favorite without cloud reads when adding a local folder', async () => {
  const { service, scope, store, calls, identityCalls } = setup()
  store.call('favoriteRememberFolder', {
    accountId: 'a',
    remoteId: 'remote-a',
    folder: { id: '8', title: '音乐', remoteCount: 2, localCount: 0 }
  })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    favoriteAddIntent: true,
    synced: true
  })
  const editor = await service.open(scope)

  await service.save('a', editor.token, ['8'])

  expect(calls).toHaveLength(0)
  expect(identityCalls()).toBe(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(1)
})
it('removes a locally added cloud-folder membership without a cloud request', async () => {
  const { service, store, writes } = setup(true)
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 0, localCount: 0 }
  })

  const result = await service.removeFromFolder('a', '8', [work.id])

  expect(result).toEqual({ folderId: '8', folderTitle: '音乐', removed: 1 })
  expect(writes()).toHaveLength(0)
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((entry) => entry.id === '8')?.localCount
  ).toBe(0)
})
it('moves a locally added source membership without trying to remove it from the cloud source', async () => {
  const { service, store, writes } = setup(true)
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  store.call('favoriteRememberFolder', {
    accountId: 'a',
    remoteId: 'remote-a',
    folder: { id: '9007199254740993999', title: '旅行', remoteCount: 1, localCount: 0 }
  })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 0, localCount: 0 }
  })

  const result = await service.moveToFolder('a', '8', '9007199254740993999', [work.id])

  expect(result).toMatchObject({ moved: 1, cloudSync: true })
  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderAdd'])
  const folders = store.call('favoriteFolders', { accountId: 'a' })
  expect(folders.find((folder) => folder.id === '8')?.localCount).toBe(0)
  expect(folders.find((folder) => folder.id === '9007199254740993999')?.localCount).toBe(1)
})
it('drops a queued folder add when its work is moved out of the folder', async () => {
  const { service, store } = setup(true)
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  const from = localFolder(store, 'local-queued-from', '原收藏夹', true)
  const to = localFolder(store, 'local-queued-to', '目标收藏夹', true)
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: from,
    queueWrite: true
  })
  expect(
    store.call('favoriteWriteOps', { accountId: 'a' }).some((operation) => operation.folderId === from.id)
  ).toBe(true)

  await service.moveToFolder('a', from.id, to.id, [work.id])

  const operations = store.call('favoriteWriteOps', { accountId: 'a' })
  expect(
    operations.some((operation) => operation.folderId === from.id && operation.kind === 'folder-add')
  ).toBe(false)
  expect(
    operations.filter((operation) => operation.folderId === to.id).map((operation) => operation.kind)
  ).toEqual(['folder-create', 'folder-add'])
})
it('skips works that the platform confirms are unavailable and clears their queued writes', async () => {
  const { service, store, platform, writes } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    favoriteAddIntent: true,
    queueFavoriteAdd: true
  })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 0, localCount: 0 },
    queueWrite: true
  })
  platform.unavailableWorkIds = [work.id]

  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 1,
    remaining: 0,
    skipped: 1,
    skippedItems: [{ workId: work.id, kind: 'favorite-add' }]
  })
  expect(writes().some((call) => call.operation === 'favoriteAdd')).toBe(false)
  expect(writes().some((call) => call.operation === 'favoriteFolderAdd')).toBe(false)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(0)
})
it('writes locally saved folder items missing from cloud even when no write is pending', async () => {
  const { service, platform, store, writes } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 1, localCount: 0 }
  })
  store.call('favoriteQueueWrite', {
    accountId: 'a',
    remoteId: 'remote-a',
    kind: 'folder-add',
    folderId: '8',
    workId: work.id
  })
  const [operation] = store.call('favoriteWriteOps', { accountId: 'a' })
  if (!operation) throw new Error('Expected the folder addition to be queued.')
  store.call('favoriteWriteComplete', { accountId: 'a', operationId: operation.id })
  platform.folderWorkIds = []
  platform.folders.find((folder) => folder.collects_id_str === '8')!.total_number = 0

  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(0)
  const result = await service.syncToCloud('a', () => {}, { folderIds: ['8'], includeDefault: false })
  expect(result).toMatchObject({ synced: 2, remaining: 0, skipped: 0 })
  expect(result.completedItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'folder-add',
        folderId: '8',
        workId: work.id,
        outcome: 'visible-after-refresh'
      })
    ])
  )

  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd', 'favoriteFolderAdd'])
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(0)
})
it('writes listed local differences when the cloud count includes an unreadable item', async () => {
  const { service, store, platform, writes } = setup()
  const folder = { id: '8', title: '音乐', remoteCount: 2, localCount: 0 }
  for (const item of [work, { ...work, id: '2' }])
    store.call('favoriteConfirm', {
      accountId: 'a',
      remoteId: 'remote-a',
      work: item,
      folder,
      synced: true,
      queueWrite: false
    })
  platform.folderWorkIds = [work.id]
  const pendingBefore = store.call('favoriteWritePending', { accountId: 'a' })

  await expect(
    service.syncToCloud('a', () => {}, { folderIds: ['8'], includeDefault: false })
  ).resolves.toMatchObject({ synced: 2, remaining: 0, skipped: 0 })

  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd', 'favoriteFolderAdd'])
  expect(writes().at(-1)?.parameters.aweme_id).toBe('2')
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(pendingBefore)
  expect(platform.folderWorkIds).toContain('2')
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((entry) => entry.id === '8')?.remoteCount
  ).toBe(2)
})
it('retries once and skips a folder write the refreshed list still does not show', async () => {
  const { service, store, platform, writes } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 0, localCount: 0 },
    synced: true,
    queueWrite: true
  })
  platform.folderWorkIds = []
  platform.folders.find((folder) => folder.collects_id_str === '8')!.total_number = 0
  platform.folderAddVisible = false

  await expect(
    service.syncToCloud('a', () => {}, { folderIds: ['8'], includeDefault: false })
  ).resolves.toMatchObject({ synced: 1, remaining: 0, skipped: 1 })
  expect(writes().filter((call) => call.operation === 'favoriteFolderAdd')).toHaveLength(2)
  expect(
    store
      .call('favoriteWriteOps', { accountId: 'a' })
      .some((operation) => operation.kind === 'folder-add' && operation.workId === work.id)
  ).toBe(false)
})
it('preserves confirmed folder membership if a paused older synchronization later finishes', async () => {
  const { service, scope, store } = setup()
  let task = store.call('favoritesStart', { accountId: 'a', id: 'sync' })
  const save = (items: any[], folders?: any[]) => {
    task = store.call('favoritesSave', {
      accountId: 'a',
      remoteId: 'remote-a',
      taskId: 'sync',
      stage: task.stage,
      folderId: task.folderId,
      requestCursor: task.cursor,
      cursor: '0',
      hasMore: false,
      items,
      folders
    })
  }
  save([])
  save([], [{ id: '8', title: '音乐', remoteCount: 0 }])
  store.call('favoritesUpdate', { accountId: 'a', taskId: 'sync', status: 'paused', reason: null })
  const editor = await service.open(scope)
  await service.save('a', editor.token, ['8'])
  store.call('favoritesUpdate', { accountId: 'a', taskId: 'sync', status: 'running', reason: null })
  save([])
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([{ id: '8', localCount: 1 }])
})
