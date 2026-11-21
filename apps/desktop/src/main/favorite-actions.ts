import { randomUUID } from 'node:crypto'
import { WRITEBACK_BATCH_LIMIT, WRITEBACK_SESSION_TTL_MS } from '../shared/contracts'
import type {
  Account,
  FavoriteEditor,
  FavoriteFolder,
  FavoriteFolderDiff,
  PlaybackScope,
  Work
} from '../shared/contracts'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import {
  parseFavoriteState,
  parseFavoriteFolders,
  parseFavoriteFolder,
  parseFavoritesPage,
  parseWriteResult
} from './douyin/parse'
import { AppError } from './errors'

type Scope = PlaybackScope & { workId: string }
type Run = <T>(accountId: string, action: (check: () => void) => Promise<T>) => Promise<T>
type Platform = <T>(action: () => Promise<T>) => Promise<T>
type WritebackProgress = {
  phase: 'checking' | 'writing'
  current: number
  total: number
  scopeRemaining: number
}
/** Space between individual platform writes; batch spacing is a separate setting. */
const WRITEBACK_WRITE_INTERVAL_MS = 1000
/**
 * Failures that do not prove a write was ignored. A follow-up cloud listing
 * decides: for a deletion an absent folder means the write took effect; for a
 * create a folder with the same title means it exists despite the reply.
 */
const UNCONFIRMED_WRITE_CODES = new Set([
  'EMPTY_RESPONSE',
  'END_UNCONFIRMED',
  'TIMEOUT',
  'NETWORK_ERROR',
  'API_REJECTED',
  'WRITE_UNCONFIRMED'
])
function unconfirmedWrite(code: string): boolean {
  return UNCONFIRMED_WRITE_CODES.has(code)
}
function folderSecret(folder: FavoriteFolder): string {
  if (folder.private === undefined)
    throw new AppError('FOLDER_CHANGED', '无法确认云端收藏夹的隐私状态，请重新核实收藏夹后重试。')
  return folder.private ? '1' : '0'
}
type Editor = {
  scope: Scope
  remoteId: string
  expires: number
  folders: FavoriteFolder[]
  folderIds: string[]
}

/** Explicit user-requested writes only; never retry a write as an authentication probe. */
export class FavoriteActions {
  private editors = new Map<string, Editor>()
  private writes = new Set<Promise<unknown>>()
  private locked = new Set<string>()
  private writeEpoch = 0
  /** Cloud reconciliation reused by consecutive batches of the same writeback scope. */
  private syncPlan: {
    accountId: string
    scope: string
    scanned: Set<string>
    refreshedAt: number
  } | null = null
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly engine: Pick<DouyinEngine, 'request'>,
    private readonly run: Run,
    private readonly identity: (accountId: string, check: () => void) => Promise<Account>,
    private readonly changed: () => void,
    /** Serializes one platform request at a time; writeback releases it between items. */
    private readonly platform: Platform = (action) => action()
  ) {}
  async idle(stop = false): Promise<void> {
    if (stop) this.writeEpoch++
    await Promise.allSettled([...this.writes])
  }
  private async accountSnapshot(accountId: string): Promise<Account> {
    const account = (await this.db.call('accounts', undefined)).find((entry) => entry.id === accountId)
    if (!account) throw new AppError('AUTH_REQUIRED', '请先选择账号。')
    return account
  }
  private async guard(scope: Scope, check: () => void): Promise<void> {
    check()
    const queue = await this.db.call('queueState', { accountId: scope.accountId })
    if (
      !queue ||
      queue.queueId !== scope.queueId ||
      queue.revision !== scope.revision ||
      queue.work.id !== scope.workId
    )
      throw new AppError('QUEUE_CHANGED', '播放作品已变化，请为当前作品重新打开收藏。')
    await this.db.call('favoriteWriteGuard', { accountId: scope.accountId, workId: scope.workId })
    check()
  }
  private async folders(
    accountId: string,
    check: () => void,
    remoteId = '',
    platform: Platform = (action) => action()
  ): Promise<FavoriteFolder[]> {
    const local = await this.db.call('favoriteFolders', { accountId })
    const byRemoteId = new Map(local.map((folder) => [folder.remoteId ?? folder.id, folder]))
    const hiddenRemoteIds = new Set(await this.db.call('favoriteHiddenFolderIds', { accountId }))
    const result = new Map<string, FavoriteFolder>(),
      visited = new Set<string>()
    let cursor = '0'
    for (let page = 0; page < 100; page++) {
      check()
      const data = parseFavoriteFolders(
        await platform(() =>
          this.engine.request(accountId, 'folders', {
            cursor,
            count: '20',
            ...(remoteId ? { sec_user_id: remoteId } : {})
          })
        )
      )
      check()
      for (const folder of data.folders) {
        if (hiddenRemoteIds.has(folder.id)) continue
        const known = byRemoteId.get(folder.id)
        const mapped = {
          ...folder,
          title: known?.managedLocally ? known.title : folder.title,
          id: known?.id ?? folder.id,
          remoteId: folder.id,
          localOnly: false,
          managedLocally: known?.managedLocally ?? false,
          localCount: known?.localCount ?? 0
        }
        result.set(mapped.id, mapped)
      }
      if (!data.hasMore) {
        for (const folder of local.filter((entry) => entry.localOnly)) result.set(folder.id, folder)
        return [...result.values()]
      }
      visited.add(cursor)
      if (visited.has(data.cursor))
        throw new AppError('CURSOR_STALLED', '收藏夹列表游标重复，请稍后重新读取。')
      cursor = data.cursor
    }
    throw new AppError('TOO_MANY_FOLDERS', '收藏夹列表过长，本次未完整读取，未发送收藏请求。')
  }
  async refreshFolders(accountId: string): Promise<FavoriteFolder[]> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const folders = await this.folders(accountId, check, account.remoteId)
      check()
      return folders
    })
  }
  private async remoteFolderWorkIds(
    accountId: string,
    remoteFolderId: string,
    expectedCount: number,
    check: () => void,
    platform: Platform = (action) => action()
  ): Promise<Set<string>> {
    const workIds = new Set<string>()
    const visited = new Set<string>()
    let cursor = '0'
    for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
      check()
      if (visited.has(cursor)) throw new AppError('CURSOR_STALLED', '收藏夹分页游标重复，未继续写回。')
      visited.add(cursor)
      const page = parseFavoritesPage(
        await platform(() =>
          this.engine.request(accountId, 'folderItems', {
            collects_id: remoteFolderId,
            cursor,
            count: '20'
          })
        )
      )
      check()
      if (page.skipped.length)
        throw new AppError('INVALID_ITEMS', '云端收藏夹包含无法读取的作品，已停止写回以避免遗漏。')
      for (const work of page.items) workIds.add(work.id)
      if (!page.hasMore) {
        if (workIds.size !== expectedCount)
          console.warn(
            `[writeback] cloud folder=${remoteFolderId} reports=${expectedCount} readable=${workIds.size}; proceeding with readable IDs`
          )
        return workIds
      }
      cursor = page.cursor
    }
    throw new AppError('TOO_MANY_ITEMS', '收藏夹分页过多，已停止写回。')
  }
  /** Read-only cloud listing for the writeback diff; unreadable rows only mark it incomplete. */
  private async remoteFolderWorks(
    accountId: string,
    remoteFolderId: string,
    expectedCount: number,
    check: () => void
  ): Promise<{ works: Work[]; complete: boolean; skipped: number }> {
    const works = new Map<string, Work>()
    const visited = new Set<string>()
    let complete = true,
      skipped = 0,
      cursor = '0'
    for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
      check()
      if (visited.has(cursor)) throw new AppError('CURSOR_STALLED', '收藏夹分页游标重复，已停止核对。')
      visited.add(cursor)
      const page = parseFavoritesPage(
        // diffFolder runs inside the request lane, so request directly; queueing
        // through platform() here would wait on the lane it already holds.
        await this.engine.request(accountId, 'folderItems', {
          collects_id: remoteFolderId,
          cursor,
          count: '20'
        })
      )
      check()
      if (page.skipped.length) {
        complete = false
        skipped += page.skipped.length
      }
      for (const work of page.items) works.set(work.id, work)
      console.info(
        `[diff] cloud page ${pageNumber + 1} folder=${remoteFolderId} items=${page.items.length} hasMore=${page.hasMore}`
      )
      if (!page.hasMore) {
        const listed = [...works.values()]
        return {
          works: listed,
          complete: complete && listed.length === expectedCount,
          skipped
        }
      }
      cursor = page.cursor
    }
    throw new AppError('TOO_MANY_ITEMS', '收藏夹分页过多，已停止核对。')
  }
  /**
   * Read-only comparison used by the writeback dialog. It never queues or sends
   * a write, and it reports which side each difference belongs to.
   */
  async diffFolder(accountId: string, folderId: string): Promise<FavoriteFolderDiff> {
    const limit = 2000
    console.info(`[diff] requested folder=${folderId}`)
    return this.run(accountId, async (check) => {
      console.info(`[diff] lane acquired folder=${folderId}`)
      const folder = (await this.db.call('favoriteFolders', { accountId })).find(
        (entry) => entry.id === folderId
      )
      if (!folder) throw new AppError('FOLDER_CHANGED', '收藏夹已变化，请重新核对。')
      const local = await this.db.call('favoriteFolderWorks', { accountId, folderId })
      console.info(`[diff] local folder=${folderId} works=${local.length} localOnly=${!!folder.localOnly}`)
      const base = {
        folderId,
        title: folder.title,
        localCount: local.length,
        checkedAt: Date.now()
      }
      if (folder.localOnly || !folder.remoteId)
        return {
          ...base,
          localOnly: true,
          complete: true,
          skipped: 0,
          remoteCount: 0,
          add: local.slice(0, limit),
          remoteOnly: [],
          truncated: local.length > limit
        }
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验抖音账号。')
      const cloudFolders = await this.folders(accountId, check, account.remoteId)
      const cloudFolder = cloudFolders.find((entry) => entry.remoteId === folder.remoteId)
      if (!cloudFolder) throw new AppError('FOLDER_CHANGED', '云端收藏夹已变化，请重新核对。')
      const expectedRemoteCount = cloudFolder.remoteCount
      await this.db.call('favoriteFolderSetRemoteCount', {
        accountId,
        accountRemoteId: account.remoteId,
        folderId,
        folderRemoteId: folder.remoteId,
        remoteCount: expectedRemoteCount
      })
      this.changed()
      const remote = await this.remoteFolderWorks(accountId, folder.remoteId, expectedRemoteCount, check)
      const localIds = new Set(local.map((work) => work.id))
      const remoteIds = new Set(remote.works.map((work) => work.id))
      const add = local.filter((work) => !remoteIds.has(work.id))
      const remoteOnly = remote.works.filter((work) => !localIds.has(work.id))
      console.info(
        `[diff] done folder=${folderId} add=${add.length} remoteOnly=${remoteOnly.length} remote=${remote.works.length}/${expectedRemoteCount} complete=${remote.complete}`
      )
      return {
        ...base,
        localOnly: false,
        complete: remote.complete,
        skipped: remote.skipped,
        remoteCount: remote.works.length,
        expectedRemoteCount,
        add: add.slice(0, limit),
        remoteOnly: remoteOnly.slice(0, limit),
        truncated: add.length > limit || remoteOnly.length > limit
      }
    })
  }
  async open(scope: Scope, refreshFolders = false): Promise<FavoriteEditor> {
    return this.run(scope.accountId, async (check) => {
      await this.guard(scope, check)
      const preferences = await this.db.call('appPreferences', {})
      refreshFolders = refreshFolders && preferences.syncFavoritesToCloud
      const account = refreshFolders
        ? await this.identity(scope.accountId, check)
        : await this.accountSnapshot(scope.accountId)
      if (preferences.syncFavoritesToCloud && !account.remoteId)
        throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const state = await this.db.call('favoriteStatus', {
        accountId: scope.accountId,
        workId: scope.workId
      })
      const folders = refreshFolders
        ? await this.folders(scope.accountId, check, account.remoteId ?? undefined)
        : await this.db.call('favoriteFolders', { accountId: scope.accountId })
      const folderIds = (
        await this.db.call('favoriteFolderMemberships', {
          accountId: scope.accountId,
          workIds: [scope.workId]
        })
      ).map((entry) => entry.folderId)
      await this.guard(scope, check)
      for (const [token, editor] of this.editors) {
        if (editor.expires < Date.now() || editor.scope.accountId === scope.accountId)
          this.editors.delete(token)
      }
      const token = randomUUID()
      this.editors.set(token, {
        scope: { ...scope },
        remoteId: account.remoteId ?? '',
        expires: Date.now() + 10 * 60_000,
        folders,
        folderIds
      })
      const overview = await this.db.call('libraryOverview', { accountId: scope.accountId })
      return {
        token,
        accountId: scope.accountId,
        workId: scope.workId,
        collected: state.collected,
        localCount: overview.favorites,
        folders,
        folderIds
      }
    })
  }
  private editor(accountId: string, token: string): Editor {
    const editor = this.editors.get(token)
    if (!editor || editor.scope.accountId !== accountId || editor.expires < Date.now())
      throw new AppError('EDITOR_EXPIRED', '收藏选择已失效，请重新读取后再保存。')
    return editor
  }
  private write<T>(token: string, action: () => Promise<T>): Promise<T> {
    if (this.locked.has(token)) throw new AppError('BUSY', '收藏操作正在保存，请等待结果。')
    this.locked.add(token)
    const promise = action().finally(() => {
      this.writes.delete(promise)
      this.locked.delete(token)
    })
    this.writes.add(promise)
    return promise
  }
  save(
    accountId: string,
    token: string,
    folderIds: string[],
    removeFolderIds: string[] = []
  ): Promise<{ collected: true; foldersAdded: number }> {
    const epoch = this.writeEpoch
    return this.write(token, () =>
      this.run(accountId, async (check) => {
        const valid = () => {
          check()
          if (epoch !== this.writeEpoch)
            throw new AppError('CANCELLED', '后续收藏操作已停止，已确认的结果保留。')
        }
        const editor = this.editor(accountId, token)
        await this.guard(editor.scope, valid)
        const preferences = await this.db.call('appPreferences', {})
        const knownFolders = preferences.syncFavoritesToCloud
          ? null
          : await this.db.call('favoriteFolders', { accountId })
        let needsCloudIdentity = preferences.syncFavoritesToCloud
        if (!needsCloudIdentity && knownFolders) {
          for (const id of removeFolderIds) {
            const folder = knownFolders.find((entry) => entry.id === id)
            if (!folder?.remoteId || folder.localOnly) continue
            const unsynced = await this.db.call('favoriteFolderUnsyncedWorkIds', {
              accountId,
              folderId: folder.id
            })
            if (!unsynced.includes(editor.scope.workId)) {
              needsCloudIdentity = true
              break
            }
          }
        }
        const account = needsCloudIdentity
          ? await this.identity(accountId, check)
          : await this.accountSnapshot(accountId)
        if (preferences.syncFavoritesToCloud && account.remoteId !== editor.remoteId)
          throw new AppError('IDENTITY_MISMATCH', '当前抖音身份已变化，未发送收藏请求。')
        if (!preferences.syncFavoritesToCloud && editor.remoteId && account.remoteId !== editor.remoteId)
          throw new AppError('IDENTITY_MISMATCH', '当前抖音身份已变化，未发送收藏请求。')
        let state: { work: Work; collected: boolean; type?: string }
        let stateSynced: boolean
        let folders: FavoriteFolder[]
        if (preferences.syncFavoritesToCloud) {
          state = parseFavoriteState(
            await this.engine.request(accountId, 'detail', { aweme_id: editor.scope.workId }),
            editor.scope.workId
          )
          stateSynced = state.collected
          folders = await this.folders(accountId, valid, account.remoteId ?? undefined)
        } else {
          const queue = await this.db.call('queueState', { accountId })
          if (!queue || queue.queueId !== editor.scope.queueId || queue.work.id !== editor.scope.workId)
            throw new AppError('QUEUE_CHANGED', '播放作品已变化，请为当前作品重新打开收藏。')
          const localStatus = await this.db.call('favoriteStatus', {
            accountId,
            workId: editor.scope.workId
          })
          state = { work: queue.work, collected: localStatus.collected }
          stateSynced = localStatus.synced
          folders = knownFolders ?? (await this.db.call('favoriteFolders', { accountId }))
        }
        const targets = [...new Set(folderIds)].map((id) => {
          const folder = folders.find((entry) => entry.id === id)
          if (!folder) throw new AppError('FOLDER_CHANGED', '所选收藏夹已变化，请重新读取后再保存。')
          return folder
        })
        const removals = [...new Set(removeFolderIds)].map((id) => {
          if (!editor.folderIds.includes(id))
            throw new AppError('INVALID_INPUT', '只能取消当前作品已加入的收藏夹。')
          if (targets.some((folder) => folder.id === id))
            throw new AppError('INVALID_INPUT', '同一收藏夹不能同时加入和移出。')
          const folder = folders.find((entry) => entry.id === id)
          if (!folder) throw new AppError('FOLDER_CHANGED', '要移出的收藏夹已变化，请重新读取后再保存。')
          return folder
        })
        let inflight = false,
          collected = state.collected,
          foldersAdded = 0,
          foldersRemoved = 0
        const removeMemberships = async () => {
          for (const folder of removals) {
            const cloud = !folder.localOnly && !!folder.remoteId
            const unsynced = cloud
              ? new Set(
                  await this.db.call('favoriteFolderUnsyncedWorkIds', {
                    accountId,
                    folderId: folder.id
                  })
                )
              : new Set<string>()
            if (cloud && !unsynced.has(state.work.id)) {
              await this.guard(editor.scope, valid)
              inflight = true
              parseWriteResult(
                await this.engine.request(accountId, 'favoriteFolderRemove', {
                  aweme_id: state.work.id,
                  item_ids: state.work.id,
                  item_type: '2',
                  from_collects_id: folder.remoteId!,
                  collects_name: folder.title
                })
              )
              inflight = false
            }
            await this.db.call('favoriteForgetFolderWork', {
              accountId,
              remoteId: editor.remoteId,
              folderId: folder.id,
              workId: state.work.id
            })
            foldersRemoved++
            this.changed()
          }
        }
        try {
          await this.guard(editor.scope, valid)
          if (!preferences.syncFavoritesToCloud) {
            // Cloud writeback is off: collection and additions stay local.
            await this.db.call('favoriteConfirm', {
              accountId,
              remoteId: editor.remoteId,
              work: state.work,
              favoriteAddIntent: true,
              synced: stateSynced
            })
            this.changed()
            for (const folder of targets) {
              await this.db.call('favoriteConfirm', {
                accountId,
                remoteId: editor.remoteId,
                work: state.work,
                folder,
                queueWrite: false
              })
              foldersAdded++
              this.changed()
            }
            await removeMemberships()
            this.editors.delete(token)
            return { collected: true, foldersAdded }
          }
          if (!collected) {
            if (state.type === undefined)
              throw new AppError('INVALID_RESPONSE', '无法确认作品类型，未发送收藏请求。')
            inflight = true
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteAdd', {
                aweme_id: state.work.id,
                aweme_type: state.type
              })
            )
            inflight = false
            collected = true
          }
          await this.db.call('favoriteConfirm', {
            accountId,
            remoteId: editor.remoteId,
            work: state.work,
            favoriteAddIntent: !state.collected,
            synced: true
          })
          this.changed()
          for (const folder of targets) {
            if (folder.localOnly) {
              // Locally created folders stay local until an explicit writeback
              // when the user allows cloud writeback.
              await this.db.call('favoriteConfirm', {
                accountId,
                remoteId: editor.remoteId,
                work: state.work,
                folder,
                queueWrite: preferences.syncFavoritesToCloud
              })
              foldersAdded++
              this.changed()
              continue
            }
            await this.guard(editor.scope, valid)
            inflight = true
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderAdd', {
                aweme_id: state.work.id,
                item_ids: state.work.id,
                item_type: '2',
                to_collects_id: folder.remoteId ?? folder.id,
                collects_name: folder.title,
                update_collects_sort: 'true'
              })
            )
            inflight = false
            await this.db.call('favoriteConfirm', {
              accountId,
              remoteId: editor.remoteId,
              work: state.work,
              folder: { ...folder, remoteCount: folder.remoteCount + 1 },
              synced: true
            })
            foldersAdded++
            this.changed()
          }
          await removeMemberships()
          this.editors.delete(token)
          return { collected: true, foldersAdded }
        } catch (error) {
          this.editors.delete(token)
          const code = error instanceof AppError ? error.code : 'STORAGE_ERROR'
          throw new AppError(
            code,
            `${collected ? '作品已收藏，已确认的结果已同步到本地。' : ''}${
              foldersAdded || foldersRemoved
                ? `已确认加入 ${foldersAdded} 个收藏夹、移出 ${foldersRemoved} 个收藏夹。`
                : ''
            }${
              inflight && code !== 'API_REJECTED'
                ? '部分操作结果未确认，未自动重发；请重新读取，并在抖音原页核对。'
                : error instanceof AppError
                  ? error.message
                  : '本地保存未完成，请重新读取核对。'
            }`
          )
        }
      })
    )
  }
  createFolder(accountId: string, token: string, name: string, secret: boolean): Promise<FavoriteFolder> {
    return this.write(token, () =>
      this.run(accountId, async (check) => {
        const editor = this.editor(accountId, token)
        await this.guard(editor.scope, check)
        const preferences = await this.db.call('appPreferences', {})
        const account = preferences.syncFavoritesToCloud
          ? await this.identity(accountId, check)
          : await this.accountSnapshot(accountId)
        if (preferences.syncFavoritesToCloud && account.remoteId !== editor.remoteId)
          throw new AppError('IDENTITY_MISMATCH', '当前抖音身份已变化，收藏夹未创建。')
        if (!preferences.syncFavoritesToCloud && editor.remoteId && account.remoteId !== editor.remoteId)
          throw new AppError('IDENTITY_MISMATCH', '当前抖音身份已变化，收藏夹未创建。')
        const existing = preferences.syncFavoritesToCloud
          ? await this.folders(accountId, check, account.remoteId ?? undefined)
          : await this.db.call('favoriteFolders', { accountId })
        if (existing.some((folder) => folder.title === name))
          throw new AppError('FOLDER_EXISTS', '已有同名收藏夹，请直接选择。')
        await this.guard(editor.scope, check)
        if (!preferences.syncFavoritesToCloud) {
          // Writeback is off: the folder belongs to the local library only and
          // is created on the platform by a later explicit writeback.
          const id = `local-${randomUUID()}`
          const folder = (await this.db.call('favoriteLocalFolderCreate', {
            accountId,
            remoteId: editor.remoteId,
            id,
            title: name,
            private: secret,
            queueWrite: false
          })) as FavoriteFolder
          editor.folders.unshift(folder)
          this.changed()
          return folder
        }
        // A folder created from the video view is a real cloud collection. Create
        // it on the platform first, then link a local record so the following
        // save adds the work to that cloud folder immediately.
        const response = await this.engine.request(accountId, 'favoriteFolderCreate', {
          action: '1',
          collects_name: name,
          secret: secret ? '1' : '0'
        })
        parseWriteResult(response)
        const remote = { ...parseFavoriteFolder(response.collects_info), localCount: 0 }
        const id = `local-${randomUUID()}`
        await this.db.call('favoriteLocalFolderCreate', {
          accountId,
          remoteId: editor.remoteId,
          id,
          title: name,
          private: secret,
          queueWrite: false
        })
        await this.db.call('favoriteLinkFolder', {
          accountId,
          folderId: id,
          remoteId: remote.remoteId ?? remote.id,
          title: remote.title,
          remoteCount: remote.remoteCount,
          private: remote.private
        })
        const folder = (await this.db.call('favoriteFolders', { accountId })).find(
          (entry) => entry.id === id
        )!
        editor.folders.unshift(folder)
        this.changed()
        return folder
      })
    )
  }
  async renameFolder(accountId: string, folderId: string, title: string): Promise<FavoriteFolder> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const folders = await this.db.call('favoriteFolders', { accountId })
      const folder = folders.find((entry) => entry.id === folderId)
      if (!folder?.managedLocally)
        throw new AppError('LOCAL_FOLDER_ONLY', '只有本地创建的收藏夹可以在本机改名。')
      if (folders.some((entry) => entry.id !== folderId && entry.title === title))
        throw new AppError('FOLDER_EXISTS', '已有同名收藏夹，请选择其他名称。')
      // Keep the cloud visibility unchanged when renaming a linked folder.
      if (folder.remoteId && !folder.localOnly) {
        parseWriteResult(
          await this.engine.request(accountId, 'favoriteFolderCreate', {
            action: '0',
            collects_id: folder.remoteId,
            collects_name: title,
            secret: folderSecret(folder)
          })
        )
      }
      const updated = await this.db.call('favoriteLocalFolderEdit', { accountId, folderId, title })
      this.changed()
      return updated
    })
  }
  async renameCloudFolder(accountId: string, folderId: string, title: string): Promise<FavoriteFolder> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const folders = await this.db.call('favoriteFolders', { accountId })
      const folder = folders.find((entry) => entry.id === folderId)
      if (!folder?.remoteId || folder.localOnly || folder.managedLocally)
        throw new AppError('FOLDER_CHANGED', '云端收藏夹已变化，请重新读取。')
      if (folders.some((entry) => entry.id !== folderId && entry.title === title))
        throw new AppError('FOLDER_EXISTS', '已有同名收藏夹，请选择其他名称。')
      parseWriteResult(
        await this.engine.request(accountId, 'favoriteFolderCreate', {
          action: '0',
          collects_id: folder.remoteId,
          collects_name: title,
          secret: folderSecret(folder)
        })
      )
      const updated = await this.db.call('favoriteCloudFolderEdit', { accountId, folderId, title })
      this.changed()
      return updated
    })
  }
  async deleteCloudFolder(
    accountId: string,
    folderId: string
  ): Promise<{ folderId: string; title: string; localCount: number }> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const folder = (await this.db.call('favoriteFolders', { accountId })).find(
        (entry) => entry.id === folderId
      )
      if (!folder?.remoteId || folder.localOnly)
        throw new AppError('FOLDER_CHANGED', '云端收藏夹已变化，请重新读取。')
      const remoteId = folder.remoteId
      try {
        parseWriteResult(
          await this.engine.request(accountId, 'favoriteFolderCreate', {
            action: '2',
            collects_id: remoteId
          })
        )
      } catch (error) {
        // The platform sometimes acknowledges a folder deletion with an empty
        // or unexplained reply (and rejects a folder that is already gone).
        // Only the cloud listing decides whether the folder still exists; when
        // it is absent the deletion did take effect, so finish it locally
        // instead of asking the user to retry a folder that is already gone.
        if (!(error instanceof AppError) || !unconfirmedWrite(error.code)) throw error
        const remaining = await this.folders(accountId, check, account.remoteId)
        if (remaining.some((entry) => entry.remoteId === remoteId)) throw error
      }
      const result = await this.db.call('favoriteCloudFolderDelete', { accountId, folderId })
      this.changed()
      return result
    })
  }
  /**
   * Reads the live cloud folder list and aligns the local list with it:
   * cloud-deleted folders are removed when nothing local depends on them, and
   * otherwise become local-only folders (their works stay; writeback recreates
   * the cloud folder). Returns the reconciled local list for the renderer.
   */
  async reconcileFolders(accountId: string): Promise<{
    folders: FavoriteFolder[]
    removed: number
    unlinked: number
  }> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验抖音账号。')
      const live = await this.folders(accountId, check, account.remoteId)
      const liveRemoteIds = [...new Set(live.flatMap((folder) => (folder.remoteId ? [folder.remoteId] : [])))]
      const result = await this.db.call('favoriteFoldersReconcile', { accountId, liveRemoteIds })
      if (result.removed || result.unlinked) this.changed()
      return {
        removed: result.removed,
        unlinked: result.unlinked,
        folders: (await this.db.call('favoriteFolders', { accountId })) as FavoriteFolder[]
      }
    })
  }
  async removeFromFolder(
    accountId: string,
    folderId: string,
    workIds: string[]
  ): Promise<{ folderId: string; folderTitle: string; removed: number }> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const folder = (await this.db.call('favoriteFolders', { accountId })).find(
        (entry) => entry.id === folderId
      )
      if (!folder) throw new AppError('FOLDER_CHANGED', '收藏夹已不存在，请重新读取。')
      const targets = [...new Set(workIds)]
      const cloud = !folder.localOnly && !!folder.remoteId
      // A work added locally while writeback was off is not in the cloud folder
      // yet. Removing it locally is final, so do not send a pointless (and
      // possibly rejected) cloud removal for it.
      const unsynced = cloud
        ? new Set(await this.db.call('favoriteFolderUnsyncedWorkIds', { accountId, folderId }))
        : new Set<string>()
      let removed = 0
      try {
        for (const workId of targets) {
          check()
          if (cloud && !unsynced.has(workId)) {
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderRemove', {
                aweme_id: workId,
                item_ids: workId,
                item_type: '2',
                from_collects_id: folder.remoteId!,
                collects_name: folder.title
              })
            )
          }
          await this.db.call('favoriteForgetFolderWork', {
            accountId,
            remoteId: account.remoteId,
            folderId,
            workId
          })
          removed++
        }
      } catch (error) {
        this.changed()
        const code = error instanceof AppError ? error.code : 'WRITE_UNCONFIRMED'
        const message = error instanceof Error ? error.message : '移出收藏夹失败。'
        throw new AppError(code, `${removed ? `已从“${folder.title}”移出 ${removed} 条；` : ''}${message}`)
      }
      this.changed()
      return { folderId, folderTitle: folder.title, removed }
    })
  }
  async moveToFolder(
    accountId: string,
    fromFolderId: string,
    toFolderId: string,
    workIds: string[]
  ): Promise<{
    fromFolderId: string
    fromFolderTitle: string
    toFolderId: string
    toFolderTitle: string
    moved: number
    cloudSync: boolean
  }> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      if (fromFolderId === toFolderId) throw new AppError('INVALID_INPUT', '目标收藏夹不能与原收藏夹相同。')
      const folders = await this.db.call('favoriteFolders', { accountId })
      const from = folders.find((entry) => entry.id === fromFolderId)
      if (!from) throw new AppError('FOLDER_CHANGED', '原收藏夹已不存在，请重新读取。')
      const to = folders.find((entry) => entry.id === toFolderId)
      if (!to) throw new AppError('FOLDER_CHANGED', '目标收藏夹已不存在，请重新读取。')
      const fromRemoteId = from.remoteId ?? (from.localOnly ? null : from.id)
      const toRemoteId = to.remoteId ?? (to.localOnly ? null : to.id)
      if (fromRemoteId && fromRemoteId === toRemoteId)
        throw new AppError('INVALID_INPUT', '目标收藏夹与原收藏夹是同一个云端收藏夹。')
      const targets = [...new Set(workIds)]
      const works = await this.db.call('worksByIds', { workIds: targets })
      const byId = new Map(works.map((entry) => [entry.id, entry]))
      if (targets.some((id) => !byId.has(id)))
        throw new AppError('WORK_UNAVAILABLE', '部分作品已不在本地列表中，请刷新后重试。')
      const preferences = await this.db.call('appPreferences', {})
      // A move is add-then-remove: the target membership is written first so a
      // failed add can never drop a work from the source folder. With cloud
      // writeback disabled both sides stay local, matching the favorite editor.
      const cloudSync = !!preferences.syncFavoritesToCloud
      const remoteFrom = cloudSync && !!fromRemoteId
      const remoteTo = cloudSync && !!toRemoteId
      const unsyncedSource = remoteFrom
        ? new Set(
            await this.db.call('favoriteFolderUnsyncedWorkIds', {
              accountId,
              folderId: from.id
            })
          )
        : new Set<string>()
      let moved = 0,
        added = 0
      try {
        for (const workId of targets) {
          check()
          const work = byId.get(workId)!
          if (remoteTo) {
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderAdd', {
                aweme_id: work.id,
                item_ids: work.id,
                item_type: '2',
                to_collects_id: toRemoteId!,
                collects_name: to.title,
                update_collects_sort: 'true'
              })
            )
          }
          await this.db.call('favoriteConfirm', {
            accountId,
            remoteId: account.remoteId,
            work,
            folder: remoteTo ? { ...to, remoteCount: to.remoteCount + 1 } : to,
            queueWrite: cloudSync && !remoteTo,
            synced: remoteTo
          })
          added++
          this.changed()
          if (remoteFrom && !unsyncedSource.has(work.id)) {
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderRemove', {
                aweme_id: work.id,
                item_ids: work.id,
                item_type: '2',
                from_collects_id: fromRemoteId!,
                collects_name: from.title
              })
            )
          }
          await this.db.call('favoriteForgetFolderWork', {
            accountId,
            remoteId: account.remoteId,
            folderId: from.id,
            workId: work.id,
            synced: cloudSync
          })
          moved++
          this.changed()
        }
      } catch (error) {
        this.changed()
        const code = error instanceof AppError ? error.code : 'WRITE_UNCONFIRMED'
        const message = error instanceof Error ? error.message : '移动到其他收藏夹失败。'
        throw new AppError(
          code,
          `${
            moved
              ? `已移动 ${moved} 条；`
              : added
                ? `${added} 条已加入目标收藏夹，但未能从原收藏夹移出；`
                : ''
          }${message}`
        )
      }
      this.changed()
      return {
        fromFolderId: from.id,
        fromFolderTitle: from.title,
        toFolderId: to.id,
        toFolderTitle: to.title,
        moved,
        cloudSync
      }
    })
  }
  async updateFolderMemberships(
    accountId: string,
    fromFolderId: string,
    addFolderIds: string[],
    removeFolderIds: string[],
    workIds: string[]
  ): Promise<{
    fromFolderTitle: string
    addedFolderTitles: string[]
    removedFolderTitles: string[]
    updated: number
    cloudSync: boolean
  }> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      if (addFolderIds.includes(fromFolderId) || removeFolderIds.includes(fromFolderId))
        throw new AppError('INVALID_INPUT', '原收藏夹不能同时作为目标收藏夹。')
      if (addFolderIds.some((id) => removeFolderIds.includes(id)))
        throw new AppError('INVALID_INPUT', '同一收藏夹不能同时加入和移出。')

      const folders = await this.db.call('favoriteFolders', { accountId })
      const from = folders.find((folder) => folder.id === fromFolderId)
      if (!from) throw new AppError('FOLDER_CHANGED', '原收藏夹已不存在，请重新读取。')
      const additions = [...new Set(addFolderIds)].map((id) => {
        const folder = folders.find((entry) => entry.id === id)
        if (!folder) throw new AppError('FOLDER_CHANGED', '目标收藏夹已不存在，请重新读取。')
        return folder
      })
      const removals = [...new Set(removeFolderIds)].map((id) => {
        const folder = folders.find((entry) => entry.id === id)
        if (!folder) throw new AppError('FOLDER_CHANGED', '要移出的收藏夹已不存在，请重新读取。')
        return folder
      })
      const targets = [...new Set(workIds)]
      const works = await this.db.call('worksByIds', { workIds: targets })
      const byId = new Map(works.map((entry) => [entry.id, entry]))
      if (targets.some((id) => !byId.has(id)))
        throw new AppError('WORK_UNAVAILABLE', '部分作品已不在本地列表中，请刷新后重试。')

      const preferences = await this.db.call('appPreferences', {})
      const cloudSync = !!preferences.syncFavoritesToCloud
      const remoteFromId = from.remoteId ?? (from.localOnly ? null : from.id)
      const remoteAddIds = additions.map((folder) =>
        cloudSync ? (folder.remoteId ?? (folder.localOnly ? null : folder.id)) : null
      )
      const remoteRemoveIds = removals.map((folder) =>
        cloudSync ? (folder.remoteId ?? (folder.localOnly ? null : folder.id)) : null
      )
      const existingMemberships = await Promise.all(
        [from, ...removals].map(async (folder) => ({
          folderId: folder.id,
          workIds: new Set(await this.db.call('favoriteFolderWorkIds', { accountId, folderId: folder.id })),
          unsynced: new Set(
            await this.db.call('favoriteFolderUnsyncedWorkIds', { accountId, folderId: folder.id })
          )
        }))
      )
      const membershipByFolder = new Map(existingMemberships.map((entry) => [entry.folderId, entry]))
      const remoteAdditions = additions.map((folder, index) => ({
        folder,
        remoteId: remoteAddIds[index]
      }))
      let updated = 0,
        added = 0,
        removed = 0
      try {
        for (const workId of targets) {
          check()
          const work = byId.get(workId)!
          for (const { folder, remoteId } of remoteAdditions) {
            if (remoteId) {
              parseWriteResult(
                await this.engine.request(accountId, 'favoriteFolderAdd', {
                  aweme_id: work.id,
                  item_ids: work.id,
                  item_type: '2',
                  to_collects_id: remoteId,
                  collects_name: folder.title,
                  update_collects_sort: 'true'
                })
              )
            }
            await this.db.call('favoriteConfirm', {
              accountId,
              remoteId: account.remoteId,
              work,
              folder: remoteId ? { ...folder, remoteCount: folder.remoteCount + 1 } : folder,
              queueWrite: cloudSync && !remoteId,
              synced: !!remoteId
            })
            added++
            this.changed()
          }

          for (const [index, folder] of removals.entries()) {
            const membership = membershipByFolder.get(folder.id)!
            if (!membership.workIds.has(work.id)) continue
            const remoteId = remoteRemoveIds[index]
            if (remoteId && !membership.unsynced.has(work.id)) {
              parseWriteResult(
                await this.engine.request(accountId, 'favoriteFolderRemove', {
                  aweme_id: work.id,
                  item_ids: work.id,
                  item_type: '2',
                  from_collects_id: remoteId,
                  collects_name: folder.title
                })
              )
            }
            await this.db.call('favoriteForgetFolderWork', {
              accountId,
              remoteId: account.remoteId,
              folderId: folder.id,
              workId: work.id,
              synced: cloudSync
            })
            removed++
            this.changed()
          }

          const sourceMembership = membershipByFolder.get(from.id)!
          if (sourceMembership.workIds.has(work.id)) {
            if (cloudSync && remoteFromId && !sourceMembership.unsynced.has(work.id)) {
              parseWriteResult(
                await this.engine.request(accountId, 'favoriteFolderRemove', {
                  aweme_id: work.id,
                  item_ids: work.id,
                  item_type: '2',
                  from_collects_id: remoteFromId,
                  collects_name: from.title
                })
              )
            }
            await this.db.call('favoriteForgetFolderWork', {
              accountId,
              remoteId: account.remoteId,
              folderId: from.id,
              workId: work.id,
              synced: cloudSync
            })
            removed++
            this.changed()
          }
          updated++
        }
      } catch (error) {
        this.changed()
        const code = error instanceof AppError ? error.code : 'WRITE_UNCONFIRMED'
        const message = error instanceof Error ? error.message : '更新收藏夹失败。'
        throw new AppError(
          code,
          `${updated ? `已更新 ${updated} 条作品；` : ''}${
            added || removed ? `已确认加入 ${added} 项、移出 ${removed} 项；` : ''
          }${message}`
        )
      }
      this.changed()
      return {
        fromFolderTitle: from.title,
        addedFolderTitles: additions.map((folder) => folder.title),
        removedFolderTitles: [...removals.map((folder) => folder.title), from.title],
        updated,
        cloudSync
      }
    })
  }
  async addToFolders(
    accountId: string,
    addFolderIds: string[],
    workIds: string[]
  ): Promise<{ added: number; folderTitles: string[]; cloudSync: boolean }> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const folders = await this.db.call('favoriteFolders', { accountId })
      const additions = [...new Set(addFolderIds)].map((id) => {
        const folder = folders.find((entry) => entry.id === id)
        if (!folder) throw new AppError('FOLDER_CHANGED', '目标收藏夹已不存在，请重新读取。')
        return folder
      })
      const targets = [...new Set(workIds)]
      const works = await this.db.call('worksByIds', { workIds: targets })
      const byId = new Map(works.map((entry) => [entry.id, entry]))
      if (targets.some((id) => !byId.has(id)))
        throw new AppError('WORK_UNAVAILABLE', '部分作品已不在本地列表中，请刷新后重试。')

      const preferences = await this.db.call('appPreferences', {})
      const cloudSync = !!preferences.syncFavoritesToCloud
      const memberships = await Promise.all(
        additions.map(async (folder) => ({
          folder,
          workIds: new Set(await this.db.call('favoriteFolderWorkIds', { accountId, folderId: folder.id })),
          remoteId: cloudSync ? (folder.remoteId ?? (folder.localOnly ? null : folder.id)) : null,
          remoteCount: folder.remoteCount
        }))
      )
      let updated = 0,
        added = 0
      try {
        for (const workId of targets) {
          check()
          const work = byId.get(workId)!
          let changed = false
          for (const membership of memberships) {
            if (membership.workIds.has(work.id)) continue
            if (membership.remoteId) {
              parseWriteResult(
                await this.engine.request(accountId, 'favoriteFolderAdd', {
                  aweme_id: work.id,
                  item_ids: work.id,
                  item_type: '2',
                  to_collects_id: membership.remoteId,
                  collects_name: membership.folder.title,
                  update_collects_sort: 'true'
                })
              )
            }
            await this.db.call('favoriteConfirm', {
              accountId,
              remoteId: account.remoteId,
              work,
              folder: membership.remoteId
                ? { ...membership.folder, remoteCount: membership.remoteCount + 1 }
                : membership.folder,
              queueWrite: cloudSync && !membership.remoteId,
              synced: !!membership.remoteId
            })
            if (membership.remoteId) membership.remoteCount++
            membership.workIds.add(work.id)
            added++
            changed = true
            this.changed()
          }
          if (changed) updated++
        }
      } catch (error) {
        this.changed()
        const code = error instanceof AppError ? error.code : 'WRITE_UNCONFIRMED'
        const message = error instanceof Error ? error.message : '添加到收藏夹失败。'
        throw new AppError(code, `${added ? `已添加 ${added} 项；` : ''}${message}`)
      }
      this.changed()
      return { added, folderTitles: additions.map((folder) => folder.title), cloudSync }
    })
  }
  async syncToCloud(
    accountId: string,
    check: () => void,
    scope?: { folderIds: string[]; includeDefault: boolean },
    onProgress?: (progress: WritebackProgress) => void
  ): Promise<{
    synced: number
    remaining: number
    scopeRemaining: number
    skipped: number
    completedItems: {
      kind: string
      folderId: string | null
      workId: string | null
      title: string | null
      outcome: string
    }[]
    skippedItems: { workId: string; kind: string; reason: string }[]
    truncated: boolean
  }> {
    onProgress?.({ phase: 'checking', current: 0, total: 0, scopeRemaining: 0 })
    const request = <T>(action: () => Promise<T>): Promise<T> =>
      this.platform(() => {
        check()
        return action()
      })
    const account = await request(() => this.identity(accountId, check))
    if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验抖音账号。')
    const folders = await this.db.call('favoriteFolders', { accountId })
    const folderIds = scope?.folderIds ?? folders.map((folder) => folder.id)
    const includeDefault = scope?.includeDefault ?? true
    if (!includeDefault && folderIds.length === 0)
      throw new AppError('INVALID_INPUT', '请选择要写回的收藏夹或默认收藏列表。')
    if (folderIds.some((id) => !folders.some((folder) => folder.id === id)))
      throw new AppError('FOLDER_CHANGED', '收藏夹列表已变化，请重新选择写回范围。')
    const scopeKey = `${includeDefault ? '1' : '0'}|${[...folderIds].sort().join(',')}`
    const started = Date.now()
    if (
      !this.syncPlan ||
      this.syncPlan.accountId !== accountId ||
      this.syncPlan.scope !== scopeKey ||
      started - this.syncPlan.refreshedAt > WRITEBACK_SESSION_TTL_MS
    )
      this.syncPlan = { accountId, scope: scopeKey, scanned: new Set(), refreshedAt: started }
    else this.syncPlan.refreshedAt = started
    const plan = this.syncPlan
    const foldersToScan = folders.filter(
      (entry) => folderIds.includes(entry.id) && !entry.localOnly && !plan.scanned.has(entry.id)
    )
    const cloudFolders = foldersToScan.length
      ? await this.folders(accountId, check, account.remoteId, request)
      : []
    const remoteWorkIdsByFolder = new Map<string, Set<string>>()
    for (const folder of foldersToScan) {
      // The first batch of a scope reconciles the whole cloud folder. Later
      // batches reuse that result instead of re-reading every page: locally
      // added members are already staged by favoriteStageLocalFolders, and the
      // per-item detail check still covers the default favorite state.
      const remoteFolderId = folder.remoteId ?? folder.id
      const cloudFolder = cloudFolders.find((entry) => entry.remoteId === remoteFolderId)
      if (!cloudFolder) throw new AppError('FOLDER_CHANGED', '云端收藏夹已变化，请重新选择写回范围。')
      await this.db.call('favoriteFolderSetRemoteCount', {
        accountId,
        accountRemoteId: account.remoteId,
        folderId: folder.id,
        folderRemoteId: remoteFolderId,
        remoteCount: cloudFolder.remoteCount
      })
      this.changed()
      const [localWorkIds, remoteWorkIds] = await Promise.all([
        this.db.call('favoriteFolderWorkIds', { accountId, folderId: folder.id }),
        this.remoteFolderWorkIds(accountId, remoteFolderId, cloudFolder.remoteCount, check, request)
      ])
      remoteWorkIdsByFolder.set(folder.id, remoteWorkIds)
      for (const workId of localWorkIds) {
        if (remoteWorkIds.has(workId)) continue
        await this.db.call('favoriteQueueWrite', {
          accountId,
          remoteId: account.remoteId,
          kind: 'favorite-add',
          workId
        })
        await this.db.call('favoriteQueueWrite', {
          accountId,
          remoteId: account.remoteId,
          kind: 'folder-add',
          folderId: folder.id,
          workId
        })
      }
      plan.scanned.add(folder.id)
    }
    await this.db.call('favoriteStageLocalFolders', {
      accountId,
      remoteId: account.remoteId,
      folderIds,
      includeDefault
    })
    const staged = await this.db.call('favoriteWriteOps', { accountId })
    const selected = new Set(folderIds)
    const selectedFolderWorks = new Set(
      staged
        .filter((operation) => operation.kind === 'folder-add' && selected.has(operation.folderId ?? ''))
        .map((operation) => operation.workId)
        .filter((workId): workId is string => !!workId)
    )
    const alreadyRemoteFolderAdds = staged.filter(
      (operation) =>
        operation.kind === 'folder-add' &&
        selected.has(operation.folderId ?? '') &&
        !!operation.workId &&
        remoteWorkIdsByFolder.get(operation.folderId ?? '')?.has(operation.workId)
    )
    for (const operation of alreadyRemoteFolderAdds)
      await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
    const alreadyRemoteFolderAddIds = new Set(alreadyRemoteFolderAdds.map((operation) => operation.id))
    const operations = staged.filter((operation) =>
      operation.kind === 'favorite-add'
        ? includeDefault || selectedFolderWorks.has(operation.workId ?? '')
        : selected.has(operation.folderId ?? '') && !alreadyRemoteFolderAddIds.has(operation.id)
    )
    const batch = operations.slice(0, WRITEBACK_BATCH_LIMIT)
    let synced = alreadyRemoteFolderAdds.length
    let skipped = 0
    let processed = 0
    const report = () =>
      onProgress?.({
        phase: 'writing',
        current: processed,
        total: batch.length,
        scopeRemaining: operations.length - processed
      })
    report()
    const skippedWorkIds = new Set<string>()
    const completedItems: {
      kind: string
      folderId: string | null
      workId: string | null
      title: string | null
      outcome: string
    }[] = alreadyRemoteFolderAdds.map((operation) => ({
      kind: operation.kind,
      folderId: operation.folderId,
      workId: operation.workId,
      title: operation.title,
      outcome: 'already-in-folder'
    }))
    const folderAddsToVerify: (typeof batch)[number][] = []
    const skippedItems: { workId: string; kind: string; reason: string }[] = []
    for (const operation of batch) {
      check()
      if (operation.workId && skippedWorkIds.has(operation.workId)) {
        await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
        processed++
        report()
        continue
      }
      try {
        let outcome = 'request-accepted'
        if (operation.kind === 'favorite-add') {
          const state = parseFavoriteState(
            await request(() => this.engine.request(accountId, 'detail', { aweme_id: operation.workId! })),
            operation.workId!
          )
          check()
          if (!state.collected)
            parseWriteResult(
              await request(() =>
                this.engine.request(accountId, 'favoriteAdd', {
                  aweme_id: state.work.id,
                  aweme_type: state.type
                })
              )
            )
          else outcome = 'already-collected'
        } else if (operation.kind === 'folder-create') {
          const folders = await this.folders(accountId, check, account.remoteId ?? '', request)
          const existing = folders.find((folder) => !folder.localOnly && folder.title === operation.title)
          let remoteFolder: FavoriteFolder
          if (existing) {
            remoteFolder = existing
            outcome = 'already-existed'
          } else {
            const create = () =>
              request(() =>
                this.engine.request(accountId, 'favoriteFolderCreate', {
                  action: '1',
                  collects_name: operation.title!,
                  secret: operation.private ? '1' : '0'
                })
              )
            try {
              const response = await create()
              parseWriteResult(response)
              remoteFolder = { ...parseFavoriteFolder(response.collects_info), localCount: 0 }
            } catch (error) {
              // A rejected or unanswered create may still have taken effect, or
              // the platform may reject a duplicate that already exists. Let a
              // fresh listing decide before reporting failure.
              if (!(error instanceof AppError) || !unconfirmedWrite(error.code)) throw error
              const after = await this.folders(accountId, check, account.remoteId ?? '', request)
              const created = after.find((folder) => !folder.localOnly && folder.title === operation.title)
              if (!created) throw error
              remoteFolder = created
              outcome = 'already-existed'
            }
          }
          await this.db.call('favoriteLinkFolder', {
            accountId,
            folderId: operation.folderId!,
            remoteId: remoteFolder.remoteId ?? remoteFolder.id,
            title: remoteFolder.title,
            remoteCount: remoteFolder.remoteCount,
            private: remoteFolder.private
          })
        } else {
          const folder = (await this.db.call('favoriteFolders', { accountId })).find(
            (entry) => entry.id === operation.folderId
          )
          if (!folder?.remoteId || folder.localOnly)
            throw new AppError(
              'FOLDER_UNSYNCED',
              `收藏夹“${folder?.title ?? operation.folderId}”尚未创建到云端。`
            )
          if (operation.kind === 'folder-add') {
            if (!operation.workId) throw new AppError('INVALID_INPUT', '收藏夹写回缺少作品标识。')
            const workId = operation.workId,
              remoteId = folder.remoteId,
              title = folder.title
            parseWriteResult(
              await request(() =>
                this.engine.request(accountId, 'favoriteFolderAdd', {
                  aweme_id: workId,
                  item_ids: workId,
                  item_type: '2',
                  to_collects_id: remoteId,
                  collects_name: title,
                  update_collects_sort: 'true'
                })
              )
            )
          } else {
            if (operation.kind !== 'folder-remove' || !operation.workId)
              throw new AppError('INVALID_INPUT', '收藏夹写回操作类型无效。')
            const workId = operation.workId,
              remoteId = folder.remoteId,
              title = folder.title
            parseWriteResult(
              await request(() =>
                this.engine.request(accountId, 'favoriteFolderRemove', {
                  aweme_id: workId,
                  item_ids: workId,
                  item_type: '2',
                  from_collects_id: remoteId,
                  collects_name: title
                })
              )
            )
            await this.db.call('favoriteForgetFolderWork', {
              accountId,
              remoteId: account.remoteId,
              folderId: folder.id,
              workId
            })
          }
        }
        if (operation.kind === 'folder-add' && operation.folderId) {
          folderAddsToVerify.push(operation)
          const folder = (await this.db.call('favoriteFolders', { accountId })).find(
            (entry) => entry.id === operation.folderId
          )
          if (folder && !folder.localOnly)
            await this.db.call('favoriteRememberFolder', {
              accountId,
              remoteId: account.remoteId,
              folder
            })
        } else {
          await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
          completedItems.push({
            kind: operation.kind,
            folderId: operation.folderId,
            workId: operation.workId,
            title: operation.title,
            outcome
          })
          synced++
        }
        processed++
        report()
        // Space out platform writes; a tight burst trips the same risk control
        // that makes every later item fail.
        await new Promise<void>((resolve) => setTimeout(resolve, WRITEBACK_WRITE_INTERVAL_MS))
      } catch (error) {
        const code = error instanceof AppError ? error.code : ''
        const skippable = operation.kind === 'favorite-add' || operation.kind === 'folder-add'
        if (skippable && (code === 'WORK_UNAVAILABLE' || code === 'CONTENT_UNAVAILABLE')) {
          if (operation.workId && !skippedWorkIds.has(operation.workId)) {
            skippedWorkIds.add(operation.workId)
            skipped++
            skippedItems.push({
              workId: operation.workId,
              kind: operation.kind,
              reason: error instanceof Error ? error.message : String(error)
            })
          }
          await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
          processed++
          report()
          continue
        }
        const remaining = await this.db.call('favoriteWritePending', { accountId })
        const message = error instanceof Error ? error.message : '云端写回失败。'
        const target = [
          `kind=${operation.kind}`,
          operation.folderId ? `folderId=${operation.folderId}` : '',
          operation.workId ? `workId=${operation.workId}` : ''
        ]
          .filter(Boolean)
          .join(' ')
        this.syncPlan = null
        throw new AppError(
          error instanceof AppError ? error.code : 'WRITE_UNCONFIRMED',
          `${synced ? `已完成 ${synced} 项；` : ''}写回失败（${target}）：${message}队列中仍有 ${remaining} 项，未自动重试。`
        )
      }
    }
    if (folderAddsToVerify.length) {
      const currentCloudFolders = await this.folders(accountId, check, account.remoteId, request)
      const currentLocalFolders = await this.db.call('favoriteFolders', { accountId })
      const unconfirmed: (typeof batch)[number][] = []
      for (const folderId of new Set(
        folderAddsToVerify.map((operation) => operation.folderId).filter((id): id is string => !!id)
      )) {
        const folder = currentLocalFolders.find((entry) => entry.id === folderId)
        const remoteFolderId = folder?.remoteId ?? folderId
        const cloudFolder = currentCloudFolders.find((entry) => entry.remoteId === remoteFolderId)
        if (!folder || !cloudFolder)
          throw new AppError('FOLDER_CHANGED', '写回后无法核实目标云端收藏夹，待写回操作已保留。')
        await this.db.call('favoriteFolderSetRemoteCount', {
          accountId,
          accountRemoteId: account.remoteId,
          folderId,
          folderRemoteId: remoteFolderId,
          remoteCount: cloudFolder.remoteCount
        })
        const remoteWorkIds = await this.remoteFolderWorkIds(
          accountId,
          remoteFolderId,
          cloudFolder.remoteCount,
          check,
          request
        )
        for (const operation of folderAddsToVerify.filter((entry) => entry.folderId === folderId)) {
          if (!operation.workId) continue
          if (!remoteWorkIds.has(operation.workId)) {
            unconfirmed.push(operation)
            continue
          }
          await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
          completedItems.push({
            kind: operation.kind,
            folderId: operation.folderId,
            workId: operation.workId,
            title: operation.title,
            outcome: 'visible-after-refresh'
          })
          synced++
        }
      }
      if (unconfirmed.length) {
        // A single work the platform silently drops must not stall the whole
        // queue. Explicitly unavailable works are skipped; every other item
        // gets one more add attempt. Items still missing after that are
        // skipped and reported, while the local folder membership stays so a
        // later writeback's cloud reconciliation can try again.
        const pending = new Map(unconfirmed.map((operation) => [operation.id, operation]))
        const skip = async (operation: (typeof unconfirmed)[number], reason: string) => {
          await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
          skipped++
          skippedItems.push({
            workId: operation.workId!,
            kind: operation.kind,
            reason
          })
          pending.delete(operation.id)
        }
        const retried: (typeof unconfirmed)[number][] = []
        for (const operation of unconfirmed) {
          const folder = currentLocalFolders.find((entry) => entry.id === operation.folderId)
          if (!folder?.remoteId || !operation.workId) continue
          // The web folder API takes 2 for videos. Image galleries carry
          // aweme_type 68 and are silently dropped when sent as 2, so retry
          // them with their own type.
          let itemType = '2'
          try {
            const state = parseFavoriteState(
              await request(() => this.engine.request(accountId, 'detail', { aweme_id: operation.workId! })),
              operation.workId!
            )
            if (state.work.mediaType === 'gallery') itemType = state.type || '68'
          } catch (error) {
            const code = error instanceof AppError ? error.code : ''
            if (code !== 'CONTENT_UNAVAILABLE' && code !== 'WORK_UNAVAILABLE') throw error
            await skip(operation, error instanceof Error ? error.message : String(error))
            continue
          }
          await new Promise<void>((resolve) => setTimeout(resolve, WRITEBACK_WRITE_INTERVAL_MS))
          try {
            parseWriteResult(
              await request(() =>
                this.engine.request(accountId, 'favoriteFolderAdd', {
                  aweme_id: operation.workId!,
                  item_ids: operation.workId!,
                  item_type: itemType,
                  to_collects_id: folder.remoteId!,
                  collects_name: folder.title,
                  update_collects_sort: 'true'
                })
              )
            )
            retried.push(operation)
          } catch (error) {
            const code = error instanceof AppError ? error.code : ''
            if (code !== 'CONTENT_UNAVAILABLE' && code !== 'WORK_UNAVAILABLE') throw error
            await skip(operation, error instanceof Error ? error.message : String(error))
          }
        }
        if (retried.length) {
          const refreshedCloudFolders = await this.folders(accountId, check, account.remoteId, request)
          for (const folderId of new Set(retried.map((operation) => operation.folderId))) {
            const folder = currentLocalFolders.find((entry) => entry.id === folderId)
            const cloudFolder = refreshedCloudFolders.find(
              (entry) => entry.remoteId === (folder?.remoteId ?? folderId)
            )
            if (!folder?.remoteId || !cloudFolder)
              throw new AppError('FOLDER_CHANGED', '写回后无法核实目标云端收藏夹，待写回操作已保留。')
            await this.db.call('favoriteFolderSetRemoteCount', {
              accountId,
              accountRemoteId: account.remoteId,
              folderId: folder.id,
              folderRemoteId: folder.remoteId,
              remoteCount: cloudFolder.remoteCount
            })
            const remoteWorkIds = await this.remoteFolderWorkIds(
              accountId,
              folder.remoteId,
              cloudFolder.remoteCount,
              check,
              request
            )
            for (const operation of retried.filter((entry) => entry.folderId === folderId)) {
              if (!operation.workId || !pending.has(operation.id)) continue
              if (!remoteWorkIds.has(operation.workId)) {
                await skip(
                  operation,
                  '平台接受写回但刷新后仍未出现在收藏夹；已跳过（本机关联保留，下次写回会再核对）。'
                )
                continue
              }
              await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
              completedItems.push({
                kind: operation.kind,
                folderId: operation.folderId,
                workId: operation.workId,
                title: operation.title,
                outcome: 'visible-after-retry'
              })
              synced++
              pending.delete(operation.id)
            }
          }
        }
        if (pending.size) {
          this.syncPlan = null
          const remaining = [...pending.values()]
          const first = remaining[0]!
          const diagnostic = remaining
            .map((operation) => `${operation.folderId ?? ''}:${operation.workId ?? ''}`)
            .join(',')
          throw new AppError(
            'WRITE_UNCONFIRMED',
            `云端接口接受了写回请求，但刷新后仍有 ${remaining.length} 个作品未出现在收藏夹列表；队列已保留。folderId=${first.folderId ?? ''} workId=${first.workId ?? ''}`,
            undefined,
            undefined,
            `未确认项目 folderId:workId=${diagnostic}`
          )
        }
      }
    }
    const remaining = await this.db.call('favoriteWritePending', { accountId })
    // The plan only covers this scope. Once its queue is drained, the next run
    // starts with a fresh cloud reconciliation.
    if (operations.length <= batch.length) this.syncPlan = null
    this.changed()
    return {
      synced,
      remaining,
      scopeRemaining: operations.length - batch.length,
      skipped,
      completedItems,
      skippedItems,
      truncated: operations.length > batch.length
    }
  }
}
