import { HealthMonitor } from './health'
import type { HealthSnapshot } from '../shared/health'
import { FavoritesService } from './favorites'
import { FavoriteActions } from './favorite-actions'
import { app, dialog, shell, clipboard, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WRITEBACK_BATCH_LIMIT } from '../shared/contracts'
import type {
  Account,
  AiClassificationProgress,
  AuthorIdRefreshCheckpoint,
  Command,
  CoverRefreshCheckpoint,
  DataMaintenanceFailureReason,
  Diagnostics,
  DurationRefreshCheckpoint,
  Query,
  Snapshot,
  Work
} from '../shared/contracts'
import type { AppPreferences } from '../shared/preferences'
import { Database } from './storage/client'
import { DouyinEngine } from './douyin/engine'
import {
  parseIdentity,
  parseLikedPage,
  parseMedia,
  parseFavoriteFolders,
  parseFavoritesPage,
  parseCommentPage
} from './douyin/parse'
import { Authentication } from './authentication'
import type { AccessTarget } from './douyin/page-state'
import type { Operation } from './douyin/page-request'
import { AppError } from './errors'
import { version } from '../../package.json'
import { RequestLane } from './request-lane'
import { CollectionService } from './collection'
import { AccountService } from './accounts'
import { DataMaintenance } from './data-maintenance'
import { UnlikeService } from './unlike'
import { metadataBytes } from './storage/usage'
import { runtimeEventCategory, type RuntimeEventInput } from '../shared/runtime-events'
import { AiClassifier } from './ai-classifier'
import { LogFile } from './log-file'
import { migrateCoverCache, resolveCoverCacheDir } from './cover-cache'

type WritebackProgress = {
  phase: 'checking' | 'writing' | 'waiting'
  current: number
  total: number
  scopeRemaining: number
  nextBatchAt: number | null
  estimatedFinishAt: number | null
  autoContinue: boolean
  batchIntervalSec: number
  batch: number
}
type WritebackResult = {
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
}
type CoverRefreshTask = {
  accountId: string
  works: Work[]
  nextIndex: number
  updated: number
  failed: number
  lastRequestAt: number
  pauseReason: 'verification' | 'limited' | 'manual' | null
}
const COVER_REFRESH_REQUEST_INTERVAL_MS = 1_000

function recordMaintenanceFailure(reasons: Map<string, number>, reason: string): void {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
}

function maintenanceFailureReasons(reasons: Map<string, number>): DataMaintenanceFailureReason[] {
  return [...reasons].map(([reason, count]) => ({ reason, count }))
}

function maintenanceFailureReason(error: unknown): string {
  if (error instanceof AppError) return `${error.code}：${error.message}`
  if (error instanceof Error) return error.message
  return '未知错误'
}

function maintenanceFailureSummary(reasons: Map<string, number>): string {
  return [...reasons].map(([reason, count]) => `${reason} ${count} 条`).join('；') || '无'
}

export class Application {
  private readonly health = new HealthMonitor()
  private readonly logs = new LogFile(join(app.getPath('userData'), 'logs'))
  private readonly healthRuns = new Map<string, Promise<HealthSnapshot>>()
  private readonly healthAfterAuth = new Set<string>()
  private readonly accessChecks = new Map<string, { accountId: string; operation: string; at: number }>()
  private playerVisible = false
  private busy = false
  private coverRefreshTask: CoverRefreshTask | null = null
  private coverRefreshRunning = false
  private coverRefreshAccountId: string | null = null
  private coverRefreshStopRequested = false
  private durationRefreshProgress: Snapshot['durationRefresh'] = null
  private durationRefreshRunning = false
  private durationRefreshStopRequested = false
  private authorIdRefreshProgress: Snapshot['authorIdRefresh'] = null
  private authorIdRefreshRunning = false
  private authorIdRefreshStopRequested = false
  private aiClassification: AiClassificationProgress | null = null
  private epoch = 0
  private libraryRevision = 0
  private mediaEpoch = 0
  private activeComments: { queueId: string; revision: number; cancelled: boolean } | null = null
  private activeMedia: {
    accountId: string
    workId: string
    queueId: string | null
    cancelled: boolean
  } | null = null
  private favoriteSync: {
    accountId: string
    promise: Promise<void>
    startedAt: number
    progress: WritebackProgress
  } | null = null
  private favoriteSyncStopRequested = false
  private favoriteSyncLast: {
    accountId: string
    status: 'completed' | 'stopped' | 'failed'
    message: string | null
    at: number
  } | null = null
  private closing = false
  private accountAction: Promise<unknown> | null = null
  private readonly accounts: AccountService
  private readonly maintenance: DataMaintenance
  private readonly lane = new RequestLane()
  private readonly favorites: FavoritesService
  private readonly favoriteActions: FavoriteActions
  private readonly aiClassifier: AiClassifier
  private readonly collection: CollectionService
  private readonly unlike: UnlikeService
  private readonly authentication: Authentication
  private admission: Promise<void> = Promise.resolve()
  constructor(
    readonly database: Database,
    readonly engine: DouyinEngine,
    private readonly changed: () => void,
    private readonly parent: () => BrowserWindow | null = () => null
  ) {
    // Touch the AI log at startup so the folder is never empty when users go
    // looking for a recovery file.
    void this.logs.append('ai-classification.log', `===== ${new Date().toISOString()} 应用启动 =====`)
    engine.setObserver((accountId, event) => this.record(accountId, event))
    this.authentication = new Authentication(
      engine,
      this.run.bind(this),
      async (accountId, target, check, kind) => {
        await this.verifyAccess(accountId, target, check, kind === 'login')
        if (this.healthAfterAuth.delete(accountId))
          setTimeout(() => {
            if (!this.closing) void this.checkHealth(accountId).catch(() => {})
          }, 0)
      },
      changed,
      this.record.bind(this)
    )
    engine.setAttentionHandler((event) => {
      if (event.type === 'closed') this.healthAfterAuth.delete(event.accountId)
      if (event.type === 'required') this.clearAccessChecks(event.accountId)
      if (!this.closing) this.authentication.handle(event)
    })
    this.collection = new CollectionService(
      database,
      engine,
      this.run.bind(this),
      this.identity.bind(this),
      (committed) => {
        if (committed) this.libraryRevision++
        changed()
      },
      undefined,
      this.record.bind(this)
    )
    this.favorites = new FavoritesService(
      database,
      engine,
      this.run.bind(this),
      this.identity.bind(this),
      (committed) => {
        if (committed) this.libraryRevision++
        changed()
      },
      undefined,
      this.record.bind(this)
    )
    this.unlike = new UnlikeService(
      database,
      engine,
      this.run.bind(this),
      this.identity.bind(this),
      (committed) => {
        if (committed) this.libraryRevision++
        changed()
      }
    )
    this.favoriteActions = new FavoriteActions(
      database,
      engine,
      this.run.bind(this),
      this.identity.bind(this),
      () => {
        this.libraryRevision++
        changed()
      },
      // Writeback is background work: playback and other interactive requests
      // keep priority between queued platform writes.
      (action) => this.lane.run(true, action)
    )
    this.aiClassifier = new AiClassifier(
      database,
      engine,
      this.run.bind(this),
      this.identity.bind(this),
      () => {
        this.libraryRevision++
        changed()
      },
      this.record.bind(this),
      (progress) => {
        this.aiClassification = progress
        changed()
      },
      (line) => void this.logs.append('ai-classification.log', line),
      this.runBackground.bind(this),
      (accountId, operation, parameters) =>
        this.lane.run(false, () => engine.request(accountId, operation, parameters)),
      (accountId, check) => this.lane.run(false, () => this.identity(accountId, check))
    )
    this.accounts = new AccountService(
      database,
      engine,
      this.exclusive.bind(this),
      this.active.bind(this),
      this.quiesce.bind(this),
      changed
    )
    this.maintenance = new DataMaintenance()
  }
  private record(accountId: string, event: RuntimeEventInput) {
    if (!this.closing && event.operation) {
      if (event.operation !== 'self' || event.code)
        this.health.observe(accountId, event.operation, event.code, undefined, false, event.rule)
      this.changed()
    }
    if (this.closing || !runtimeEventCategory(event)) return
    void this.database
      .call('appendRuntimeEvent', { accountId, event })
      .then(() => this.changed())
      .catch(() => console.error('[MyLike] Runtime record could not be saved.'))
  }
  async snapshot(): Promise<Snapshot> {
    const accounts = await this.database.call('accounts', undefined)
    const active = await this.database.call('setting', { key: 'activeAccount' })
    const theme = await this.database.call('setting', { key: 'theme' })
    const activeAccountId = accounts.some((a) => a.id === active) ? active : (accounts[0]?.id ?? null)
    const favoriteWritePending = activeAccountId
      ? await this.database.call('favoriteWritePending', { accountId: activeAccountId })
      : 0
    return {
      accounts,
      coverRefresh: await this.coverRefreshSnapshot(activeAccountId),
      durationRefresh: await this.durationRefreshSnapshot(activeAccountId),
      authorIdRefresh: await this.authorIdRefreshSnapshot(activeAccountId),
      favoriteWritePending,
      favoriteSync:
        activeAccountId && this.favoriteSync?.accountId === activeAccountId
          ? {
              ...this.favoriteSync.progress,
              remaining: favoriteWritePending,
              startedAt: this.favoriteSync.startedAt
            }
          : null,
      favoriteSyncLast:
        activeAccountId && this.favoriteSyncLast?.accountId === activeAccountId
          ? {
              status: this.favoriteSyncLast.status,
              message: this.favoriteSyncLast.message,
              at: this.favoriteSyncLast.at
            }
          : null,
      aiClassification: this.aiClassification?.accountId === activeAccountId ? this.aiClassification : null,
      aiPendingAssignments: activeAccountId
        ? await this.database.call('aiAssignmentStats', { accountId: activeAccountId })
        : { likes: 0, favorites: 0 },
      activeAccountId,
      theme: theme === 'light' ? 'light' : 'dark',
      engine: this.engine.snapshot(),
      authentication: this.authentication.snapshot(),
      health: activeAccountId ? this.health.snapshot(activeAccountId) : null,
      busy: this.busy,
      collection: activeAccountId
        ? await this.database.call('collection', { accountId: activeAccountId })
        : null,
      recovery: activeAccountId ? this.engine.recovery(activeAccountId) : [],
      accessChecks: [...this.accessChecks.values()].filter((item) => item.accountId === activeAccountId),
      collectionActivity: this.collection.activity,
      unlike: activeAccountId ? await this.database.call('unlikeTask', { accountId: activeAccountId }) : null,
      favorites: activeAccountId
        ? await this.database.call('favoritesTask', { accountId: activeAccountId })
        : null,
      favoritesActivity: this.favorites.activity,
      favoritesUpdate: activeAccountId
        ? await this.database.call('favoritesTask', { accountId: activeAccountId, mode: 'update' })
        : null,
      libraryRevision: this.libraryRevision,
      playback: activeAccountId
        ? await this.database.call('queueState', { accountId: activeAccountId })
        : null,
      playbackPreferences: await this.database.call('playbackPreferences', {}),
      appPreferences: await this.database.call('appPreferences', {}),
      version
    }
  }
  get favoriteSyncRunning(): boolean {
    return this.favoriteSync !== null
  }
  /** Resolves when the current writeback stops, finishes or is cancelled. */
  whenFavoriteSyncIdle(): Promise<void> {
    return this.favoriteSync?.promise ?? Promise.resolve()
  }
  /** Approximate number of queued operations still waiting for the platform. */
  async pendingFavoriteWrites(): Promise<number> {
    const accountId = this.favoriteSync?.accountId
    return accountId ? this.database.call('favoriteWritePending', { accountId }) : 0
  }
  /** Sleeps between batches; wakes promptly for stop, close or account changes. */
  private async waitForWritebackBatch(ms: number, epoch: number): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (this.favoriteSyncStopRequested || this.closing || epoch !== this.epoch) return
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, end - Date.now()))))
    }
  }
  private async prepareFavoriteWriteback(accountId: string): Promise<AppPreferences> {
    await this.active(accountId)
    const preferences = await this.database.call('appPreferences', {})
    if (!preferences.syncFavoritesToCloud)
      throw new AppError('SYNC_DISABLED', '请先在设置中启用收藏夹云端写回。')
    this.assertAvailable(accountId, [
      'folders',
      'folderItems',
      'favoriteAdd',
      'favoriteFolderAdd',
      'favoriteFolderRemove',
      'favoriteFolderCreate',
      'detail'
    ])
    await Promise.all([this.collection.pause(), this.favorites.pause()])
    await this.favoriteActions.idle()
    await this.lane.idle()
    if (this.collection.running || this.favorites.running || this.unlike.running)
      throw new AppError('BUSY', '请先停止其他采集或取消点赞 / 收藏任务，再写回收藏夹。')
    return preferences
  }
  private async runFavoriteWritebackBatch(
    accountId: string,
    scope: { folderIds: string[]; includeDefault: boolean },
    progress: WritebackProgress,
    perOpMs: { value: number }
  ): Promise<WritebackResult> {
    progress.batch++
    progress.phase = 'checking'
    progress.current = 0
    progress.total = 0
    progress.nextBatchAt = null
    this.changed()
    const batchStartedAt = Date.now()
    const result = await this.runUnlaned(accountId, (check) =>
      this.favoriteActions.syncToCloud(accountId, check, scope, (update) => {
        progress.phase = update.phase
        progress.current = update.current
        progress.total = update.total
        progress.scopeRemaining = update.scopeRemaining
        const now = Date.now()
        if (update.current > 0) perOpMs.value = Math.max(1, (now - batchStartedAt) / update.current)
        if (update.phase === 'writing')
          progress.estimatedFinishAt = progress.autoContinue
            ? now +
              update.scopeRemaining * perOpMs.value +
              Math.max(0, Math.ceil(update.scopeRemaining / WRITEBACK_BATCH_LIMIT) - 1) *
                progress.batchIntervalSec *
                1000
            : null
        this.changed()
      })
    )
    await this.logs.append(
      'favorite-writeback.log',
      [
        `===== ${new Date().toISOString()} 写回批次 ${progress.batch} 完成`,
        `范围 folderIds=${scope.folderIds.join(',')} includeDefault=${scope.includeDefault}`,
        `本批处理 ${result.synced} 个操作，跳过 ${result.skipped} 个作品；范围剩余 ${result.scopeRemaining} 个操作；全局队列剩余 ${result.remaining} 个操作`,
        ...result.completedItems.map(
          (item) =>
            `已处理 kind=${item.kind} outcome=${item.outcome} folderId=${item.folderId ?? ''} workId=${item.workId ?? ''} title=${item.title ?? ''}`
        ),
        ...result.skippedItems.map(
          (item) => `跳过 workId=${item.workId} kind=${item.kind} reason=${item.reason}`
        )
      ].join('\n')
    )
    return result
  }
  /** Runs the detached auto-continue loop; the start command returns immediately. */
  private async runFavoriteWritebackAuto(
    accountId: string,
    scope: { folderIds: string[]; includeDefault: boolean },
    progress: WritebackProgress,
    settle: () => void,
    epoch: number
  ): Promise<void> {
    const perOpMs = { value: 1500 }
    let stopped = false
    let skipped = 0
    try {
      while (true) {
        const result = await this.runFavoriteWritebackBatch(accountId, scope, progress, perOpMs)
        skipped += result.skipped
        if (result.scopeRemaining === 0 || this.favoriteSyncStopRequested || epoch !== this.epoch) break
        const latest = await this.database.call('appPreferences', {})
        progress.autoContinue = latest.autoContinueWriteback
        progress.batchIntervalSec = latest.writebackBatchIntervalSec
        if (!progress.autoContinue) {
          stopped = true
          break
        }
        const intervalMs = progress.batchIntervalSec * 1000
        progress.phase = 'waiting'
        progress.nextBatchAt = Date.now() + intervalMs
        progress.estimatedFinishAt =
          progress.nextBatchAt +
          progress.scopeRemaining * perOpMs.value +
          Math.max(0, Math.ceil(progress.scopeRemaining / WRITEBACK_BATCH_LIMIT) - 1) * intervalMs
        this.changed()
        await this.waitForWritebackBatch(intervalMs, epoch)
        if (this.favoriteSyncStopRequested || epoch !== this.epoch) break
      }
      if (this.favoriteSyncStopRequested) stopped = true
      if (epoch !== this.epoch) throw new AppError('CANCELLED', '操作已停止，旧结果已丢弃。')
      this.favoriteSyncLast = {
        accountId,
        status: stopped ? 'stopped' : 'completed',
        message: skipped ? `跳过 ${skipped} 个不可用作品，详情见本地写回日志` : null,
        at: Date.now()
      }
    } catch (error) {
      const code = error instanceof AppError ? error.code : ''
      if (!['CANCELLED', 'CLOSING'].includes(code)) {
        await this.recordWritebackFailure(accountId, error)
        this.favoriteSyncLast = {
          accountId,
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
          at: Date.now()
        }
      }
    } finally {
      this.favoriteSync = null
      this.favoriteSyncStopRequested = false
      settle()
      this.changed()
    }
  }
  private async recordWritebackFailure(accountId: string, error: unknown): Promise<void> {
    const code = error instanceof AppError ? error.code : 'WRITEBACK_ERROR'
    if (['CANCELLED', 'CLOSING'].includes(code)) return
    const message = error instanceof Error ? error.message : String(error)
    const pending = await this.database.call('favoriteWriteOps', { accountId }).catch((queueError) => {
      console.error('[MyLike] Failed to read pending writeback operations for the failure log.', queueError)
      return []
    })
    const listed = pending.slice(0, 100)
    await this.logs.append(
      'favorite-writeback.log',
      [
        `===== ${new Date().toISOString()} 写回失败：${code} ${message}`,
        ...(error instanceof AppError && error.diagnostic ? [`诊断：${error.diagnostic}`] : []),
        `剩余 ${pending.length} 项：`,
        ...listed.map(
          (operation) =>
            `${operation.kind}\t${operation.folderId ?? ''}\t${operation.workId ?? ''}\t${operation.title ?? ''}`
        ),
        pending.length > listed.length ? `…其余 ${pending.length - listed.length} 项未列出` : ''
      ]
        .filter(Boolean)
        .join('\n') + '\n'
    )
  }
  async applyAppearance(theme?: 'dark' | 'light'): Promise<void> {
    const value = theme ?? (await this.database.call('setting', { key: 'theme' }))
    const light = value === 'light' && !this.playerVisible
    const color = this.playerVisible ? '#111113' : light ? '#f7f8fb' : '#101014'
    const win = this.parent()
    if (!win || win.isDestroyed()) return
    win.setBackgroundColor(color)
    if (process.platform === 'win32')
      win.setTitleBarOverlay({ color, symbolColor: light ? '#202436' : '#ececf2', height: 30 })
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.admission
    let release!: () => void
    this.admission = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await action()
    } finally {
      release()
    }
  }
  private async active(accountId: string): Promise<Account> {
    const snapshot = await this.snapshot()
    const account = snapshot.accounts.find((a) => a.id === accountId)
    if (!account || snapshot.activeAccountId !== accountId)
      throw new AppError('ACCOUNT_CHANGED', '操作账号已变化，请重新选择。')
    return account
  }
  private async run<T>(
    accountId: string,
    operation: (check: () => void) => Promise<T>,
    background = false
  ): Promise<T> {
    const started = Date.now()
    try {
      return await this.lane.run(background, () => this.guarded(accountId, operation))
    } finally {
      const elapsed = Date.now() - started
      // Surfaces operations that keep the shared request lane busy for long.
      if (elapsed > 15_000) console.warn(`[lane] waited+held ${elapsed}ms background=${background}`)
    }
  }
  /**
   * Runs a batch that acquires the platform lane per request instead of holding
   * it for the whole operation. Writeback uses this so playback can fetch media
   * between queued platform writes.
   */
  private async runUnlaned<T>(accountId: string, operation: (check: () => void) => Promise<T>): Promise<T> {
    return this.guarded(accountId, operation)
  }
  private async coverRefreshSnapshot(accountId: string | null): Promise<Snapshot['coverRefresh']> {
    if (!accountId) return null
    const task =
      this.coverRefreshTask?.accountId === accountId
        ? this.coverRefreshTask
        : await this.database.call('coverRefreshCheckpoint', { accountId })
    if (!task) return null
    const running = this.coverRefreshRunning && this.coverRefreshAccountId === accountId
    const total = 'works' in task ? task.works.length : task.workIds.length
    return {
      accountId,
      current: task.nextIndex,
      total,
      updated: task.updated,
      failed: task.failed,
      status: running ? 'running' : 'paused',
      pauseReason: running ? task.pauseReason : (task.pauseReason ?? 'interrupted')
    }
  }
  private async durationRefreshSnapshot(accountId: string | null): Promise<Snapshot['durationRefresh']> {
    if (!accountId) return null
    if (this.durationRefreshProgress?.accountId === accountId) return this.durationRefreshProgress
    const task = await this.database.call('durationRefreshCheckpoint', { accountId })
    if (!task) return null
    return {
      accountId,
      current: task.nextIndex,
      total: task.workIds.length,
      updated: task.updated,
      failed: task.failed,
      status: 'paused',
      pauseReason: task.pauseReason ?? 'interrupted',
      stopping: false
    }
  }
  private async authorIdRefreshSnapshot(accountId: string | null): Promise<Snapshot['authorIdRefresh']> {
    if (!accountId) return null
    if (this.authorIdRefreshProgress?.accountId === accountId) return this.authorIdRefreshProgress
    const task = await this.database.call('authorIdRefreshCheckpoint', { accountId })
    if (!task) return null
    return {
      accountId,
      current: task.nextIndex,
      total: task.workIds.length,
      updated: task.updated,
      failed: task.failed,
      status: 'paused',
      pauseReason: task.pauseReason ?? 'interrupted',
      stopping: false
    }
  }
  private async saveCoverRefreshTask(task: CoverRefreshTask): Promise<void> {
    const checkpoint: CoverRefreshCheckpoint = {
      accountId: task.accountId,
      workIds: task.works.map((work) => work.id),
      nextIndex: task.nextIndex,
      updated: task.updated,
      failed: task.failed,
      lastRequestAt: task.lastRequestAt,
      pauseReason: task.pauseReason
    }
    await this.database.call('saveCoverRefreshCheckpoint', { checkpoint })
  }
  private async fetchMissingCovers(accountId: string) {
    if (this.coverRefreshRunning || this.durationRefreshRunning || this.authorIdRefreshRunning)
      throw new AppError('BUSY', '另一个元数据补全任务正在运行。')
    this.coverRefreshRunning = true
    this.coverRefreshAccountId = accountId
    this.coverRefreshStopRequested = false
    try {
      return await this.runBackground(accountId, async (check) => {
        await Promise.all([this.favorites.pause(), this.collection.pause()])
        await this.lane.run(true, () => this.identity(accountId, check))
        const previous =
          this.coverRefreshTask?.accountId === accountId
            ? this.coverRefreshTask
            : await this.database.call('coverRefreshCheckpoint', { accountId })
        if (previous?.failed === 0 && previous.nextIndex > 0) {
          const completedWorkIds =
            'works' in previous
              ? previous.works.slice(0, previous.nextIndex).map((work) => work.id)
              : previous.workIds.slice(0, previous.nextIndex)
          await this.database.call('coverRefreshMarkCompleted', {
            accountId,
            workIds: completedWorkIds
          })
        }
        const previousTotal = previous
          ? 'works' in previous
            ? previous.works.length
            : previous.workIds.length
          : 0
        const works: Work[] = []
        for (let offset = 0; ; offset += 120) {
          check()
          const page = await this.database.call('missingCoverWorks', { accountId, offset, limit: 120 })
          works.push(...page)
          if (page.length < 120) break
        }
        const task: CoverRefreshTask = {
          accountId,
          works,
          nextIndex: 0,
          updated: previous?.updated ?? 0,
          failed: previous?.failed ?? 0,
          lastRequestAt: previous?.lastRequestAt ?? 0,
          pauseReason: null
        }
        this.coverRefreshTask = task
        await this.logs.append(
          'cover-refresh.log',
          `${new Date().toISOString()} ${previous ? `刷新断点：上次进度 ${previous.nextIndex}/${previousTotal}，剩余待处理 ${task.works.length} 条` : `开始获取：待处理 ${task.works.length} 条`}，累计已获取 ${task.updated} 张，失败 ${task.failed} 条。`
        )
        if (!works.length) {
          this.coverRefreshTask = null
          await this.database.call('deleteCoverRefreshCheckpoint', { accountId })
          this.changed()
          return {
            total: 0,
            updated: 0,
            failed: 0,
            failureReasons: [],
            deferred: 0,
            needsVerification: false,
            stopped: false
          }
        }
        await this.saveCoverRefreshTask(task)
        this.changed()

        let deferred = 0
        let needsVerification = false
        const failureReasons = new Map<string, number>()
        const updatedBeforeRun = task.updated
        const failedBeforeRun = task.failed
        for (let index = task.nextIndex; index < task.works.length; index++) {
          const work = task.works[index]!
          if (this.coverRefreshStopRequested) {
            task.pauseReason = 'manual'
            await this.saveCoverRefreshTask(task)
            break
          }
          const remainingDelay = COVER_REFRESH_REQUEST_INTERVAL_MS - (Date.now() - task.lastRequestAt)
          if (remainingDelay > 0) await new Promise<void>((resolve) => setTimeout(resolve, remainingDelay))
          if (this.coverRefreshStopRequested) {
            task.pauseReason = 'manual'
            await this.saveCoverRefreshTask(task)
            break
          }
          check()
          let pauseAfterCurrent = false
          try {
            const response = await this.lane.run(true, () =>
              this.engine.request(accountId, 'detail', {
                aweme_id: work.id,
                publish_video_strategy_type: '2',
                pc_client_type: '1'
              })
            )
            task.lastRequestAt = Date.now()
            check()
            const media = parseMedia(response)
            if (media.work.id !== work.id)
              throw new AppError('INVALID_RESPONSE', '作品详情与请求目标不一致。')
            if (!media.work.coverUrl) {
              task.failed++
              recordMaintenanceFailure(failureReasons, '详情未提供封面地址')
              await this.logs.append(
                'cover-refresh.log',
                `${new Date().toISOString()} 作品失败 ${index + 1}/${task.works.length}，作品 ${work.id}，原因：详情未提供封面地址。\n`
              )
            } else {
              await this.database.call('coverRefreshSaveWork', { accountId, work: media.work })
              task.updated++
            }
            task.nextIndex = index + 1
            this.changed()
          } catch (error) {
            task.lastRequestAt = Date.now()
            if (error instanceof AppError && error.code === 'CANCELLED') throw error
            if (
              error instanceof AppError &&
              [
                'RATE_LIMITED',
                'UPSTREAM_RISK_CONTROL',
                'AUTH_REQUIRED',
                'VERIFICATION_REQUIRED',
                'NETWORK_ERROR',
                'TIMEOUT',
                'BROWSER_NOT_READY',
                'BROWSER_CRASHED',
                'PAGE_CHANGED'
              ].includes(error.code)
            ) {
              deferred = task.works.length - index
              needsVerification = ['AUTH_REQUIRED', 'VERIFICATION_REQUIRED'].includes(error.code)
              task.pauseReason = needsVerification ? 'verification' : 'limited'
              await this.logs.append(
                'cover-refresh.log',
                `${new Date().toISOString()} 暂停于 ${index + 1}/${task.works.length}，作品 ${work.id}，错误 ${error.code}：${error.message}`
              )
              this.record(accountId, {
                kind: 'task',
                operation: 'coverRefresh',
                message: needsVerification
                  ? `需要在抖音窗口完成登录或验证；已获取 ${task.updated} 张缩略图，完成后可继续，当前作品会重试。`
                  : `抖音暂时限制详情读取，已获取 ${task.updated} 张缩略图，剩余 ${deferred} 条待稍后继续。`,
                code: error.code
              })
              pauseAfterCurrent = true
            } else {
              task.failed++
              recordMaintenanceFailure(failureReasons, maintenanceFailureReason(error))
              task.nextIndex = index + 1
              this.changed()
              console.warn(`[cover] refresh failed for work ${work.id}`, error)
              await this.logs.append(
                'cover-refresh.log',
                `${new Date().toISOString()} 作品失败 ${index + 1}/${task.works.length}，作品 ${work.id}，${error instanceof AppError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
          await this.saveCoverRefreshTask(task)
          if (task.nextIndex > 0 && task.nextIndex % 50 === 0)
            await this.logs.append(
              'cover-refresh.log',
              `${new Date().toISOString()} 进度 ${task.nextIndex}/${task.works.length}，已获取 ${task.updated} 张，失败 ${task.failed} 条。`
            )
          if (pauseAfterCurrent) break
          if (this.coverRefreshStopRequested) {
            task.pauseReason = 'manual'
            await this.saveCoverRefreshTask(task)
            await this.logs.append(
              'cover-refresh.log',
              `${new Date().toISOString()} 手动停止于 ${task.nextIndex}/${task.works.length}，已获取 ${task.updated} 张，失败 ${task.failed} 条。`
            )
            break
          }
        }

        const completed = task.nextIndex >= task.works.length
        if (!completed)
          await this.logs.append(
            'cover-refresh.log',
            `${new Date().toISOString()} 任务暂停（${task.pauseReason ?? 'interrupted'}）：${task.nextIndex}/${task.works.length}，已获取 ${task.updated} 张，失败 ${task.failed} 条。`
          )
        if (task.updated) this.libraryRevision++
        if (completed) {
          const failureSummary = maintenanceFailureSummary(failureReasons)
          await this.logs.append(
            'cover-refresh.log',
            `${new Date().toISOString()} 获取结束：本轮检查 ${task.works.length} 条，获取 ${task.updated - updatedBeforeRun} 张，失败 ${task.failed - failedBeforeRun} 条；失败原因：${failureSummary}。`
          )
          this.record(accountId, {
            kind: 'task',
            operation: 'coverRefresh',
            message: `封面补全结束：本轮检查 ${task.works.length} 条，获取 ${task.updated - updatedBeforeRun} 张，失败 ${task.failed - failedBeforeRun} 条；失败原因：${failureSummary}。`
          })
          this.coverRefreshTask = null
          await this.database.call('deleteCoverRefreshCheckpoint', { accountId })
        }
        this.changed()
        return {
          total: task.works.length,
          updated: task.updated - updatedBeforeRun,
          failed: task.failed - failedBeforeRun,
          failureReasons: maintenanceFailureReasons(failureReasons),
          deferred: completed ? 0 : deferred || task.works.length - task.nextIndex,
          needsVerification,
          stopped: !completed && task.pauseReason === 'manual'
        }
      })
    } finally {
      this.coverRefreshRunning = false
      this.coverRefreshAccountId = null
      this.coverRefreshStopRequested = false
      this.changed()
    }
  }
  private stopMissingCovers(accountId: string): null {
    if (this.coverRefreshRunning && this.coverRefreshAccountId === accountId) {
      this.coverRefreshStopRequested = true
      this.changed()
    }
    return null
  }
  private async syncVideoDurations(accountId: string) {
    if (this.durationRefreshRunning || this.coverRefreshRunning || this.authorIdRefreshRunning)
      throw new AppError('BUSY', '另一个元数据补全任务正在运行。')
    this.durationRefreshRunning = true
    this.durationRefreshStopRequested = false
    const progress: NonNullable<Snapshot['durationRefresh']> = {
      accountId,
      current: 0,
      total: 0,
      updated: 0,
      failed: 0,
      status: 'running',
      pauseReason: null,
      stopping: false
    }
    this.durationRefreshProgress = progress
    try {
      this.changed()
      return await this.runBackground(accountId, async (check) => {
        await Promise.all([this.favorites.pause(), this.collection.pause()])
        await this.lane.run(true, () => this.identity(accountId, check))
        const checkpoint = await this.database.call('durationRefreshCheckpoint', { accountId })
        const works: Work[] = []
        for (let offset = 0; ; offset += 120) {
          check()
          const page = await this.database.call('missingDurationWorks', { accountId, offset, limit: 120 })
          works.push(...page)
          progress.total = works.length
          this.changed()
          if (page.length < 120) break
        }
        if (!checkpoint && !works.length)
          return {
            total: 0,
            updated: 0,
            failed: 0,
            failureReasons: [],
            deferred: 0,
            needsVerification: false,
            stopped: false
          }

        const task: DurationRefreshCheckpoint = checkpoint ?? {
          accountId,
          workIds: works.map((work) => work.id),
          nextIndex: 0,
          updated: 0,
          failed: 0,
          lastRequestAt: Date.now(),
          pauseReason: null
        }
        const missingById = new Map(works.map((work) => [work.id, work]))
        progress.total = task.workIds.length
        progress.current = task.nextIndex
        progress.updated = task.updated
        progress.failed = task.failed
        progress.pauseReason = null
        await this.database.call('saveDurationRefreshCheckpoint', {
          checkpoint: { ...task, pauseReason: null }
        })
        task.pauseReason = null
        this.changed()

        let deferred = 0
        let needsVerification = false
        const failureReasons = new Map<string, number>()
        const failedBeforeRun = task.failed
        for (let index = task.nextIndex; index < task.workIds.length; index++) {
          if (this.durationRefreshStopRequested) {
            task.nextIndex = index
            task.pauseReason = 'manual'
            await this.database.call('saveDurationRefreshCheckpoint', { checkpoint: task })
            progress.current = task.nextIndex
            progress.status = 'paused'
            progress.pauseReason = 'manual'
            deferred = task.workIds.length - index
            this.changed()
            break
          }
          const workId = task.workIds[index]!
          const work = missingById.get(workId)
          if (!work) {
            task.nextIndex = index + 1
            await this.database.call('saveDurationRefreshCheckpoint', { checkpoint: task })
            progress.current = task.nextIndex
            this.changed()
            continue
          }
          const remainingDelay = COVER_REFRESH_REQUEST_INTERVAL_MS - (Date.now() - task.lastRequestAt)
          if (remainingDelay > 0) await new Promise<void>((resolve) => setTimeout(resolve, remainingDelay))
          if (this.durationRefreshStopRequested) {
            task.nextIndex = index
            task.pauseReason = 'manual'
            await this.database.call('saveDurationRefreshCheckpoint', { checkpoint: task })
            progress.current = task.nextIndex
            progress.status = 'paused'
            progress.pauseReason = 'manual'
            deferred = task.workIds.length - index
            this.changed()
            break
          }
          check()
          let media: ReturnType<typeof parseMedia>
          try {
            const response = await this.lane.run(true, () =>
              this.engine.request(accountId, 'detail', {
                aweme_id: workId,
                publish_video_strategy_type: '2',
                pc_client_type: '1'
              })
            )
            task.lastRequestAt = Date.now()
            check()
            media = parseMedia(response)
            if (media.work.id !== workId) throw new AppError('INVALID_RESPONSE', '作品详情与请求目标不一致。')
          } catch (error) {
            task.lastRequestAt = Date.now()
            if (error instanceof AppError && ['CANCELLED', 'CLOSING'].includes(error.code)) throw error
            if (
              error instanceof AppError &&
              [
                'RATE_LIMITED',
                'UPSTREAM_RISK_CONTROL',
                'AUTH_REQUIRED',
                'VERIFICATION_REQUIRED',
                'NETWORK_ERROR',
                'TIMEOUT',
                'BROWSER_NOT_READY',
                'BROWSER_CRASHED',
                'PAGE_CHANGED'
              ].includes(error.code)
            ) {
              task.nextIndex = index
              needsVerification = ['AUTH_REQUIRED', 'VERIFICATION_REQUIRED'].includes(error.code)
              task.pauseReason = needsVerification ? 'verification' : 'limited'
              await this.database.call('saveDurationRefreshCheckpoint', { checkpoint: task })
              progress.current = task.nextIndex
              progress.status = 'paused'
              progress.pauseReason = task.pauseReason
              deferred = task.workIds.length - index
              this.changed()
              break
            }
            task.failed++
            recordMaintenanceFailure(failureReasons, maintenanceFailureReason(error))
            task.nextIndex = index + 1
            task.pauseReason = null
            await this.database.call('saveDurationRefreshCheckpoint', { checkpoint: task })
            progress.current = task.nextIndex
            progress.failed = task.failed
            this.changed()
            console.warn(`[duration] refresh failed for work ${workId}`, error)
            await this.logs.append(
              'duration-refresh.log',
              `${new Date().toISOString()} 作品失败 ${index + 1}/${task.workIds.length}，作品 ${workId}，${error instanceof AppError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}\n`
            )
            continue
          }
          if (media.work.durationMs && media.work.durationMs > 0) {
            await this.database.call('updateWork', { work: media.work })
            task.updated++
          } else {
            task.failed++
            recordMaintenanceFailure(failureReasons, '详情未提供有效视频时长')
            await this.logs.append(
              'duration-refresh.log',
              `${new Date().toISOString()} 作品失败 ${index + 1}/${task.workIds.length}，作品 ${workId}，原因：详情未提供有效视频时长（durationMs=${media.work.durationMs ?? 0}）。\n`
            )
          }
          task.nextIndex = index + 1
          task.pauseReason = null
          await this.database.call('saveDurationRefreshCheckpoint', { checkpoint: task })
          progress.current = task.nextIndex
          progress.updated = task.updated
          progress.failed = task.failed
          this.changed()
        }
        const stopped = this.durationRefreshStopRequested
        const completed = task.nextIndex >= task.workIds.length
        if (completed) {
          await this.database.call('deleteDurationRefreshCheckpoint', { accountId })
          if (task.updated) this.libraryRevision++
        }
        const result = {
          total: task.workIds.length,
          updated: task.updated,
          failed: task.failed - failedBeforeRun,
          failureReasons: maintenanceFailureReasons(failureReasons),
          deferred: completed ? 0 : deferred || task.workIds.length - task.nextIndex,
          needsVerification,
          stopped
        }
        await this.logs.append(
          'duration-refresh.log',
          `${new Date().toISOString()} ${stopped ? '手动停止' : result.deferred ? '稍后继续' : '同步结束'}：未同步 ${result.failed + result.deferred} 条（失败 ${result.failed} 条，待处理 ${result.deferred} 条）；失败原因：${maintenanceFailureSummary(failureReasons)}。\n`
        )
        return result
      })
    } finally {
      this.durationRefreshRunning = false
      this.durationRefreshStopRequested = false
      this.durationRefreshProgress = null
      this.changed()
    }
  }
  private stopVideoDurationSync(accountId: string): null {
    if (this.durationRefreshRunning && this.durationRefreshProgress?.accountId === accountId) {
      this.durationRefreshStopRequested = true
      this.durationRefreshProgress.stopping = true
      this.changed()
    }
    return null
  }
  private async syncMissingAuthorIds(accountId: string) {
    if (this.authorIdRefreshRunning || this.coverRefreshRunning || this.durationRefreshRunning)
      throw new AppError('BUSY', '另一个元数据补全任务正在运行。')
    this.authorIdRefreshRunning = true
    this.authorIdRefreshStopRequested = false
    const progress: NonNullable<Snapshot['authorIdRefresh']> = {
      accountId,
      current: 0,
      total: 0,
      updated: 0,
      failed: 0,
      status: 'running',
      pauseReason: null,
      stopping: false
    }
    this.authorIdRefreshProgress = progress
    try {
      this.changed()
      return await this.runBackground(accountId, async (check) => {
        await Promise.all([this.favorites.pause(), this.collection.pause()])
        await this.lane.run(true, () => this.identity(accountId, check))
        const checkpoint = await this.database.call('authorIdRefreshCheckpoint', { accountId })
        const works: Work[] = []
        for (let offset = 0; ; offset += 120) {
          check()
          const page = await this.database.call('missingAuthorIdWorks', {
            accountId,
            offset,
            limit: 120
          })
          works.push(...page)
          progress.total = works.length
          this.changed()
          if (page.length < 120) break
        }
        if (!checkpoint && !works.length)
          return {
            total: 0,
            updated: 0,
            failed: 0,
            failureReasons: [],
            deferred: 0,
            needsVerification: false,
            stopped: false
          }

        const task: AuthorIdRefreshCheckpoint = checkpoint ?? {
          accountId,
          workIds: works.map((work) => work.id),
          nextIndex: 0,
          updated: 0,
          failed: 0,
          lastRequestAt: Date.now(),
          pauseReason: null
        }
        const missingById = new Map(works.map((work) => [work.id, work]))
        progress.total = task.workIds.length
        progress.current = task.nextIndex
        progress.updated = task.updated
        progress.failed = task.failed
        progress.pauseReason = null
        await this.database.call('saveAuthorIdRefreshCheckpoint', {
          checkpoint: { ...task, pauseReason: null }
        })
        task.pauseReason = null
        this.changed()

        let deferred = 0
        let needsVerification = false
        const failureReasons = new Map<string, number>()
        const failedBeforeRun = task.failed
        for (let index = task.nextIndex; index < task.workIds.length; index++) {
          if (this.authorIdRefreshStopRequested) {
            task.nextIndex = index
            task.pauseReason = 'manual'
            await this.database.call('saveAuthorIdRefreshCheckpoint', { checkpoint: task })
            progress.current = task.nextIndex
            progress.status = 'paused'
            progress.pauseReason = 'manual'
            deferred = task.workIds.length - index
            this.changed()
            break
          }
          const workId = task.workIds[index]!
          if (!missingById.has(workId)) {
            task.nextIndex = index + 1
            await this.database.call('saveAuthorIdRefreshCheckpoint', { checkpoint: task })
            progress.current = task.nextIndex
            this.changed()
            continue
          }
          const before = missingById.get(workId)!
          const hadAuthorId = !!before.authorId && /^[A-Za-z0-9_-]{8,200}$/.test(before.authorId)
          const hadCover = !!before.coverUrl && before.coverUrl.trim() !== ''
          const hadDuration = (before.durationMs ?? 0) > 0
          const hadAuthorUrl = !!before.authorUrl && before.authorUrl.trim() !== ''
          const remainingDelay = COVER_REFRESH_REQUEST_INTERVAL_MS - (Date.now() - task.lastRequestAt)
          if (remainingDelay > 0) await new Promise<void>((resolve) => setTimeout(resolve, remainingDelay))
          if (this.authorIdRefreshStopRequested) {
            task.nextIndex = index
            task.pauseReason = 'manual'
            await this.database.call('saveAuthorIdRefreshCheckpoint', { checkpoint: task })
            progress.current = task.nextIndex
            progress.status = 'paused'
            progress.pauseReason = 'manual'
            deferred = task.workIds.length - index
            this.changed()
            break
          }
          check()
          let media: ReturnType<typeof parseMedia>
          try {
            const response = await this.lane.run(true, () =>
              this.engine.request(accountId, 'detail', {
                aweme_id: workId,
                publish_video_strategy_type: '2',
                pc_client_type: '1'
              })
            )
            task.lastRequestAt = Date.now()
            check()
            media = parseMedia(response)
            if (media.work.id !== workId) throw new AppError('INVALID_RESPONSE', '作品详情与请求目标不一致。')
          } catch (error) {
            task.lastRequestAt = Date.now()
            if (error instanceof AppError && ['CANCELLED', 'CLOSING'].includes(error.code)) throw error
            if (
              error instanceof AppError &&
              [
                'RATE_LIMITED',
                'UPSTREAM_RISK_CONTROL',
                'AUTH_REQUIRED',
                'VERIFICATION_REQUIRED',
                'NETWORK_ERROR',
                'TIMEOUT',
                'BROWSER_NOT_READY',
                'BROWSER_CRASHED',
                'PAGE_CHANGED'
              ].includes(error.code)
            ) {
              task.nextIndex = index
              needsVerification = ['AUTH_REQUIRED', 'VERIFICATION_REQUIRED'].includes(error.code)
              task.pauseReason = needsVerification ? 'verification' : 'limited'
              await this.database.call('saveAuthorIdRefreshCheckpoint', { checkpoint: task })
              progress.current = task.nextIndex
              progress.status = 'paused'
              progress.pauseReason = task.pauseReason
              deferred = task.workIds.length - index
              this.changed()
              break
            }
            task.failed++
            recordMaintenanceFailure(failureReasons, maintenanceFailureReason(error))
            task.nextIndex = index + 1
            task.pauseReason = null
            await this.database.call('saveAuthorIdRefreshCheckpoint', { checkpoint: task })
            progress.current = task.nextIndex
            progress.failed = task.failed
            this.changed()
            console.warn(`[author-id] refresh failed for work ${workId}`, error)
            await this.logs.append(
              'author-id-refresh.log',
              `${new Date().toISOString()} 作品失败 ${index + 1}/${task.workIds.length}，作品 ${workId}，${error instanceof AppError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}\n`
            )
            continue
          }
          await this.database.call('updateWork', { work: media.work })
          const authorIdFilled = !!media.work.authorId && !hadAuthorId
          const coverFilled = !!media.work.coverUrl && !hadCover
          const durationFilled = (media.work.durationMs ?? 0) > 0 && !hadDuration
          const authorUrlFilled = !!media.work.authorUrl && !hadAuthorUrl
          if (authorIdFilled || coverFilled || durationFilled || authorUrlFilled) {
            task.updated++
            this.libraryRevision++
          } else {
            task.failed++
            recordMaintenanceFailure(failureReasons, '详情未提供可补齐的字段')
            await this.logs.append(
              'author-id-refresh.log',
              `${new Date().toISOString()} 作品失败 ${index + 1}/${task.workIds.length}，作品 ${workId}，原因：详情未提供可补齐的字段。\n`
            )
          }
          task.nextIndex = index + 1
          task.pauseReason = null
          await this.database.call('saveAuthorIdRefreshCheckpoint', { checkpoint: task })
          progress.current = task.nextIndex
          progress.updated = task.updated
          progress.failed = task.failed
          this.changed()
        }
        const stopped = this.authorIdRefreshStopRequested
        const completed = task.nextIndex >= task.workIds.length
        if (completed) {
          await this.database.call('deleteAuthorIdRefreshCheckpoint', { accountId })
        }
        const result = {
          total: task.workIds.length,
          updated: task.updated,
          failed: task.failed - failedBeforeRun,
          failureReasons: maintenanceFailureReasons(failureReasons),
          deferred: completed ? 0 : deferred || task.workIds.length - task.nextIndex,
          needsVerification,
          stopped
        }
        await this.logs.append(
          'author-id-refresh.log',
          `${new Date().toISOString()} ${stopped ? '手动停止' : result.deferred ? '稍后继续' : '补全结束'}：未补齐 ${result.failed + result.deferred} 条（失败 ${result.failed} 条，待处理 ${result.deferred} 条）；失败原因：${maintenanceFailureSummary(failureReasons)}。\n`
        )
        return result
      })
    } finally {
      this.authorIdRefreshRunning = false
      this.authorIdRefreshStopRequested = false
      this.authorIdRefreshProgress = null
      this.changed()
    }
  }
  private stopMissingAuthorIds(accountId: string): null {
    if (this.authorIdRefreshRunning && this.authorIdRefreshProgress?.accountId === accountId) {
      this.authorIdRefreshStopRequested = true
      this.authorIdRefreshProgress.stopping = true
      this.changed()
    }
    return null
  }
  private async resetMissingAuthorIds(accountId: string): Promise<null> {
    if (this.authorIdRefreshRunning)
      throw new AppError('BUSY', '作者 ID 补全正在运行，请先停止后再清除断点。')
    await this.active(accountId)
    await this.database.call('deleteAuthorIdRefreshCheckpoint', { accountId })
    this.authorIdRefreshProgress = null
    this.changed()
    return null
  }
  private async runBackground<T>(
    accountId: string,
    operation: (check: () => void) => Promise<T>
  ): Promise<T> {
    const epoch = this.epoch
    const check = () => {
      if (this.closing) throw new AppError('CLOSING', '应用正在退出，未发送新的请求。')
      if (epoch !== this.epoch) throw new AppError('CANCELLED', '操作已停止，旧结果已丢弃。')
    }
    await this.exclusive(async () => {
      check()
      if (this.accountAction) throw new AppError('BUSY', '账号操作正在收口，请稍候。')
      await this.active(accountId)
      check()
    })
    const result = await operation(check)
    check()
    return result
  }
  private async guarded<T>(accountId: string, operation: (check: () => void) => Promise<T>): Promise<T> {
    const epoch = this.epoch
    const check = () => {
      if (epoch !== this.epoch) throw new AppError('CANCELLED', '操作已停止，旧结果已丢弃。')
    }
    await this.exclusive(async () => {
      if (this.closing) throw new AppError('CLOSING', '应用正在退出，未发送新的请求。')
      if (this.accountAction) throw new AppError('BUSY', '账号操作正在收口，请稍候。')
      check()
      await this.active(accountId)
      this.busy = true
    })
    this.changed()
    try {
      const result = await operation(check)
      check()
      return result
    } finally {
      this.busy = false
      this.changed()
    }
  }
  private async identity(accountId: string, check: () => void): Promise<Account> {
    const identity = parseIdentity(await this.engine.request(accountId, 'self'))
    check()
    try {
      const account = await this.database.call('bindAccount', { accountId, ...identity })
      check()
      this.health.observe(accountId, 'self')
      return account
    } catch (error) {
      if (error instanceof AppError) this.health.observe(accountId, 'self', error.code)
      if (error instanceof AppError && ['IDENTITY_MISMATCH', 'DUPLICATE_ACCOUNT'].includes(error.code))
        this.engine.requireAttention(accountId, 'login', { operation: 'self', parameters: {} })
      throw error
    }
  }
  private async verifyAccess(
    accountId: string,
    target: AccessTarget | null,
    check: () => void,
    loginCheck = false
  ): Promise<Account> {
    const account = await this.active(accountId)
    this.assertAvailable(accountId, target ? [target.operation] : [])
    check()
    let identity: ReturnType<typeof parseIdentity>
    try {
      identity = parseIdentity(
        await this.engine.request(accountId, 'self', {}, { recovery: true, loginCheck })
      )
    } catch (error) {
      // Before login, self can reject with HTTP 200 instead of an empty user.
      // Only this identity check uses the two-second login cadence. Explicit
      // HTTP rate limits and failures of the blocked business API stay distinct.
      if (loginCheck && error instanceof AppError && error.code === 'API_REJECTED')
        throw new AppError('LOGIN_PENDING', '尚未取得已登录身份，请完成窗口中的登录。')
      throw error
    }
    check()
    if (account.remoteId && account.remoteId !== identity.remoteId)
      throw new AppError(
        'IDENTITY_MISMATCH',
        '窗口登录的身份与这个账号不一致，请切回原账号或添加新的本地账号。'
      )
    if (target && target.operation !== 'self') {
      const data = await this.engine.request(
        accountId,
        target.operation,
        target.operation === 'likes' || target.operation === 'folders'
          ? { ...target.parameters, sec_user_id: identity.remoteId }
          : target.parameters,
        { recovery: true }
      )
      check()
      if (target.operation === 'likes') parseLikedPage(data)
      else if (target.operation === 'folders') parseFavoriteFolders(data)
      else if (['favorites', 'folderItems'].includes(target.operation)) parseFavoritesPage(data)
      else if (target.operation === 'detail') {
        if (String(data.aweme_detail?.aweme_id) !== target.parameters.aweme_id)
          throw new AppError('WORK_UNAVAILABLE', '原作品详情尚未恢复，请稍后重试。')
      }
    }
    check()
    const state = await this.engine.pageState(accountId)
    check()
    if (!state.ready) throw new AppError('BROWSER_NOT_READY', '抖音页面尚未就绪，请稍候核验。')
    if (state.captcha) throw new AppError('VERIFICATION_REQUIRED', '请先完成抖音窗口中的安全验证。')
    const bound = await this.database.call('bindAccount', { accountId, ...identity })
    check()
    // Only the complete read-only recovery check grants this UI evidence.
    // A healthy self response followed by a failed target must not unlock it.
    this.health.observe(accountId, 'self')
    const at = Date.now()
    for (const operation of new Set(['self', target?.operation ?? 'self']))
      this.accessChecks.set(JSON.stringify([accountId, operation]), { accountId, operation, at })
    return bound
  }
  private async checkHealth(accountId: string): Promise<HealthSnapshot> {
    const existing = this.healthRuns.get(accountId)
    if (existing) return existing
    const run = (async () => {
      await this.active(accountId)
      this.engine.allowAttention()
      this.health.begin(accountId)
      this.changed()
      let completed = false
      try {
        await this.run(accountId, async (check) => {
          const identityWaiting = this.engine.recovery(accountId).some((r) => r.operation === 'self')
          let identity: Account
          try {
            identity = await this.verifyAccess(accountId, null, check, true)
          } catch (caught) {
            const error =
              caught instanceof AppError
                ? caught
                : new AppError('STORAGE_ERROR', '暂时无法读取本地账号信息。')
            if (error instanceof AppError) {
              this.health.observe(accountId, 'self', error.code, error.retryAt, !identityWaiting, error.rule)
              if (
                [
                  'AUTH_REQUIRED',
                  'LOGIN_PENDING',
                  'IDENTITY_MISMATCH',
                  'DUPLICATE_ACCOUNT',
                  'VERIFICATION_REQUIRED'
                ].includes(error.code)
              ) {
                this.healthAfterAuth.add(accountId)
                this.engine.requireAttention(
                  accountId,
                  error.code === 'VERIFICATION_REQUIRED' ? 'verification' : 'login',
                  { operation: 'self', parameters: {} }
                )
              }
            }
            if (error instanceof AppError && ['CANCELLED', 'ACCOUNT_CHANGED', 'CLOSING'].includes(error.code))
              throw error
            return
          }
          const likes = await this.database.call('collection', { accountId })
          const favorites = await this.database.call('favoritesTask', { accountId })
          const targets: AccessTarget[] = [
            {
              operation: 'likes',
              parameters: { sec_user_id: identity.remoteId!, max_cursor: '0', count: '18' }
            },
            { operation: 'favorites', parameters: { cursor: '0', count: '20' } },
            {
              operation: 'folders',
              parameters: { sec_user_id: identity.remoteId!, cursor: '0', count: '20' }
            }
          ]
          if (likes?.errorCode && likes.cursor !== '0')
            targets.push({
              operation: 'likes',
              parameters: { sec_user_id: identity.remoteId!, max_cursor: likes.cursor, count: '18' }
            })
          if (favorites?.stage === 'folder' && favorites.folderId)
            targets.push({
              operation: 'folderItems',
              parameters: { collects_id: favorites.folderId, cursor: favorites.cursor, count: '20' }
            })
          for (const issue of (favorites?.issues ?? []).slice(0, 5))
            targets.push({
              operation: 'folderItems',
              parameters: { collects_id: issue.folderId, cursor: '0', count: '20' }
            })
          const original = this.engine.recoveryTarget(accountId)
          if (original && ['likes', 'favorites', 'folders', 'folderItems'].includes(original.operation))
            targets.push(original)
          const seen = new Set<string>(),
            failed = new Set<string>()
          let attention = false
          for (const target of targets) {
            check()
            const key = JSON.stringify(target)
            if (seen.has(key)) continue
            seen.add(key)
            let attempted = false
            try {
              this.engine.assertAvailable(accountId, target.operation)
              attempted = true
              const data = await this.engine.request(accountId, target.operation, target.parameters, {
                recovery: true
              })
              const page =
                target.operation === 'likes'
                  ? parseLikedPage(data, { allowEmpty: true })
                  : target.operation === 'folders'
                    ? parseFavoriteFolders(data, { allowEmpty: true })
                    : parseFavoritesPage(data, { allowEmpty: true })
              // Refresh folder-item evidence even after a completed sync. Otherwise
              // its old successful entry expires while the manual check never revisits it.
              if (
                'folders' in page &&
                page.folders.length &&
                !targets.some((t) => t.operation === 'folderItems')
              )
                targets.push({
                  operation: 'folderItems',
                  parameters: { collects_id: page.folders[0]!.id, cursor: '0', count: '20' }
                })
              if (page.hasMore && ('folders' in page ? !page.folders.length : !page.items.length))
                throw new AppError('EMPTY_PAGE', '暂时未能取得可用内容，请稍后核验。')
              check()
              if (failed.has(target.operation)) continue
              this.health.observe(accountId, target.operation)
            } catch (error) {
              if (!(error instanceof AppError)) throw error
              if (['CANCELLED', 'ACCOUNT_CHANGED', 'CLOSING'].includes(error.code)) throw error
              // One failed operation counts once per explicit round, even with several folders.
              const first = !failed.has(target.operation)
              failed.add(target.operation)
              this.health.observe(
                accountId,
                target.operation,
                error.code,
                error.retryAt,
                first && attempted,
                error.rule
              )
              if (['AUTH_REQUIRED', 'VERIFICATION_REQUIRED'].includes(error.code)) {
                this.healthAfterAuth.add(accountId)
                attention = true
                this.engine.requireAttention(
                  accountId,
                  error.code === 'AUTH_REQUIRED' ? 'login' : 'verification',
                  target
                )
                break
              }
            }
          }
          // A healthy folder cannot erase the failure of another checked folder.
          for (const operation of failed) {
            const entry = this.health.snapshot(accountId).entries.find((e) => e.operation === operation)
            if (entry?.status === 'normal') this.health.observe(accountId, operation, 'INVALID_RESPONSE')
          }
          if ((favorites?.issues?.length ?? 0) > 5)
            this.health.observe(accountId, 'folderItems', 'MORE_CHECKS')
          if (!attention) {
            this.engine.hide(accountId)
            this.authentication.stop()
          }
        })
        completed = true
        return this.health.snapshot(accountId)
      } catch (error) {
        if (
          error instanceof AppError &&
          ['CANCELLED', 'ACCOUNT_CHANGED', 'CLOSING', 'BUSY'].includes(error.code)
        )
          throw error
        const failure =
          error instanceof AppError ? error : new AppError('STORAGE_ERROR', '暂时无法完成本地检查。')
        this.health.observe(accountId, 'self', failure.code, failure.retryAt, true, failure.rule)
        completed = true
        this.record(accountId, {
          kind: 'task',
          operation: 'self',
          code: failure.code,
          message: '状态核验未完成，请查看诊断详情。'
        })
        return this.health.snapshot(accountId)
      } finally {
        this.health.finish(accountId, completed)
        this.changed()
      }
    })()
    const result = run.then(() => this.health.snapshot(accountId))
    this.healthRuns.set(accountId, result)
    try {
      return await result
    } finally {
      if (this.healthRuns.get(accountId) === result) this.healthRuns.delete(accountId)
    }
  }
  private async collectionAction(
    accountId: string,
    source: 'likes' | 'favorites',
    action: 'top' | 'down' | 'stop' | 'folders' | 'rescan'
  ) {
    await this.active(accountId)
    if (action === 'rescan') {
      if (this.coverRefreshRunning || this.durationRefreshRunning || this.authorIdRefreshRunning)
        throw new AppError('BUSY', '请先停止元数据补全任务，再重新扫描列表。')
      if (this.collection.running || this.favorites.running || this.unlike.running)
        throw new AppError('BUSY', '请先停止当前任务，再重新扫描列表。')
      // A list rescan refreshes author IDs directly, so the old detail-scan
      // checkpoint is stale. Clear it; the next detail run re-queries current data.
      await this.database.call('deleteAuthorIdRefreshCheckpoint', { accountId })
      this.authorIdRefreshProgress = null
      this.changed()
      if (source === 'favorites') {
        await this.execute('favoritesStart', { accountId, mode: 'sync' })
        return
      }
      await this.exclusive(async () => {
        await this.active(accountId)
        this.assertAvailable(accountId, ['likes'])
        if (this.collection.running || this.favorites.running || this.unlike.running)
          throw new AppError('BUSY', '请先停止其他采集或取消点赞 / 收藏任务。')
        await this.collection.start(accountId, 'full')
      })
      return
    }
    if (source === 'favorites') {
      if (action === 'stop') {
        const normal = await this.database.call('favoritesTask', { accountId }),
          top = await this.database.call('favoritesTask', { accountId, mode: 'update' })
        for (const task of [normal, top])
          if (task && task.status !== 'completed' && task.status !== 'stopped')
            await this.execute('favoritesControl', {
              accountId,
              taskId: task.id,
              mode: task.mode,
              action: 'stop'
            })
      } else
        await this.execute('favoritesStart', {
          accountId,
          mode: action === 'top' ? 'update' : 'sync',
          ...(action === 'folders' ? { stage: 'folders' } : {})
        })
      return
    }
    const task = await this.database.call('collection', { accountId })
    if (action === 'stop') {
      if (task && task.status !== 'completed' && task.status !== 'stopped')
        await this.execute('collectionControl', { accountId, taskId: task.id, action: 'stop' })
      return
    }
    if (action === 'top') {
      await this.execute('collectionStart', { accountId, mode: 'incremental' })
      return
    }
    if (task && task.status !== 'completed') {
      // Finish an interrupted head before continuing its preserved historical cursor.
      this.assertAvailable(accountId, ['likes'])
      if (task.mode === 'incremental') {
        await this.exclusive(async () => {
          await this.active(accountId)
          if (this.collection.running || this.favorites.running || this.unlike.running)
            throw new AppError('BUSY', '请先停止当前任务。')
          this.assertAvailable(accountId, ['likes'])
          await this.database.call('updateCollection', {
            accountId,
            taskId: task.id,
            status: task.status,
            reason: task.reason,
            mode: 'update'
          })
          await this.collection.control(accountId, task.id, 'resume')
        })
      } else await this.execute('collectionControl', { accountId, taskId: task.id, action: 'resume' })
    } else {
      const checkpoint = await this.database.call('checkpoint', { accountId })
      const mode = task?.tailCursor != null && !checkpoint?.hasMore ? 'recheck' : 'update'
      await this.execute('collectionStart', { accountId, mode })
    }
  }
  private clearAccessChecks(accountId: string): void {
    for (const [key, item] of this.accessChecks)
      if (item.accountId === accountId) this.accessChecks.delete(key)
  }
  private assertAvailable(accountId: string, operations: Operation[]): void {
    for (const operation of new Set<Operation>(['self', ...operations]))
      this.engine.assertAvailable(accountId, operation)
  }
  private async favoriteReadOperation(
    accountId: string,
    mode: 'sync' | 'update' = 'sync',
    probe = false
  ): Promise<Operation> {
    const task = await this.database.call('favoritesTask', { accountId, mode })
    if (mode === 'update' || !task || task.status === 'completed' || (probe && task.status === 'partial'))
      return 'favorites'
    if (task.status === 'partial')
      return task.incomplete || !task.foldersDeferred ? 'favorites' : 'folderItems'
    return task.stage === 'all' ? 'favorites' : task.stage === 'folders' ? 'folders' : 'folderItems'
  }
  private async quiesce(): Promise<void> {
    await this.unlike.stop()
    await this.favoriteActions.idle(true)
    const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
    this.epoch++
    this.engine.release()

    await Promise.all([paused, this.whenFavoriteSyncIdle()])
    await this.lane.idle()
  }
  async execute(command: Command, input: any): Promise<unknown> {
    if (this.closing) throw new AppError('CLOSING', '应用正在退出。')
    if (
      [
        'login',
        'probe',
        'collectionStart',
        'favoritesStart',
        'favoritesProbe',
        'unlikeStart',
        'collectPage',
        'favoriteEditor',
        'favoriteSave',
        'favoriteCreateFolder',
        'favoriteFolderEditLocal',
        'favoriteFolderRenameCloud',
        'favoriteFolderDeleteCloud',
        'favoriteFolderRemoveWorks',
        'favoriteFolderMoveWorks',
        'favoriteFolderUpdateWorks',
        'favoriteFolderAddWorks',
        'aiClassifyFavorites',
        'aiSuggestFolders',
        'aiResumeClassification',
        'aiImportClassificationLog',
        'favoriteFoldersRefresh',
        'favoriteFolderDiff',
        'favoriteSyncToCloud',
        'favoriteSyncAutoStart'
      ].includes(command) ||
      (['collectionControl', 'favoritesControl', 'unlikeControl'].includes(command) &&
        input.action === 'resume')
    )
      this.engine.allowAttention()
    if (
      ['collectionControl', 'favoritesControl', 'unlikeControl'].includes(command) &&
      input.action === 'stop' &&
      this.authentication.snapshot()?.accountId === input.accountId
    )
      this.engine.dismissAttention(input.accountId)
    if (
      this.accountAction &&
      ![
        'snapshot',
        'query',
        'runtimeEvents',
        'diagnostics',
        'dataInfo',
        'theme',
        'windowPresentation'
      ].includes(command)
    )
      throw new AppError('BUSY', '账号操作正在收口，请稍候。')
    if (
      this.unlike.running &&
      [
        'createAccount',
        'switchAccount',
        'collectPage',
        'collectionStart',
        'deleteLocal',
        'favoriteEditor',
        'favoriteSave',
        'favoriteCreateFolder',
        'favoriteFolderCreateLocal',
        'favoriteFolderEditLocal',
        'favoriteFolderRenameCloud',
        'favoriteFolderDeleteCloud',
        'favoriteFolderDeleteLocal',
        'favoriteFolderMoveWorks',
        'favoriteFolderUpdateWorks',
        'favoriteFolderAddWorks',
        'aiClassifyFavorites',
        'aiSuggestFolders',
        'aiResumeClassification',
        'aiImportClassificationLog',
        'favoriteFoldersRefresh',
        'favoriteFolderDiff',
        'favoriteSyncToCloud',
        'favoriteSyncAutoStart',
        'unlikeVerify'
      ].includes(command)
    )
      throw new AppError('BUSY', '请先停止取消点赞或收藏任务，等待当前请求结果保存。')
    switch (command) {
      case 'appPreferences': {
        const previous = await this.database.call('appPreferences', {})
        const value = await this.database.call('appPreferences', input)
        if (value.coverCachePath !== previous.coverCachePath) {
          const userData = app.getPath('userData')
          const source = resolveCoverCacheDir(previous.coverCachePath, userData)
          const destination = resolveCoverCacheDir(value.coverCachePath, userData)
          void migrateCoverCache(source, destination)
            .then((moved) => {
              if (moved) console.info(`[cover] migrated ${moved} covers to ${destination}`)
            })
            .catch((error) =>
              console.warn(
                `[cover] migration failed: ${error instanceof Error ? error.message : String(error)}`
              )
            )
        }
        this.parent()?.webContents.setZoomFactor(value.zoom)
        this.changed()
        return value
      }
      case 'checkDatabase':
        return this.database.call('checkDatabase', {})
      case 'copyText':
        clipboard.writeText(input.text)
        return null
      case 'openAuthorProfile':
        await this.active(input.accountId)
        await this.engine.openAuthorProfile(input.accountId, input.authorId, input.authorUrl)
        return null
      case 'copyDiagnostics': {
        const diagnostic = await this.execute('diagnostics', {})
        await clipboard.writeText(
          JSON.stringify(
            {
              application: 'MyLike',
              version,
              platform: process.platform,
              arch: process.arch,
              runtime: diagnostic
            },
            null,
            2
          )
        )
        return null
      }
      case 'openReleases':
        try {
          await shell.openExternal('https://github.com/hqing8156-prog/douyin-favorite-MyLike/releases')
        } catch {
          throw new AppError('OPEN_BROWSER_FAILED', '无法打开系统默认浏览器，请稍后重试。')
        }
        return null
      case 'snapshot':
        return this.snapshot()
      case 'runtimeEvents':
        await this.active(input.accountId)
        return this.database.call('runtimeEvents', { accountId: input.accountId })
      case 'createAccount':
        return this.exclusive(async () => {
          if (this.lane.pending || this.collection.running || this.favorites.running || this.unlike.running)
            throw new AppError('BUSY', '请先暂停采集并等待当前请求结束。')
          const account = await this.database.call('createAccount', { id: randomUUID(), name: input.name })
          this.epoch++
          this.engine.release()

          await this.database.call('setting', { key: 'activeAccount', value: account.id })
          this.changed()
          return account
        })
      case 'switchAccount':
        return this.exclusive(async () => {
          if (this.lane.pending || this.collection.running || this.favorites.running || this.unlike.running)
            throw new AppError('BUSY', '请先暂停采集，等待请求收口后再切换账号。')
          if (!(await this.database.call('accounts', undefined)).some((a) => a.id === input.accountId))
            throw new AppError('ACCOUNT_NOT_FOUND', '账号不存在。')
          if (this.busy) throw new AppError('BUSY', '请先停止当前请求。')
          this.epoch++
          this.engine.release()

          await this.database.call('setting', { key: 'activeAccount', value: input.accountId })
          this.changed()
          return null
        })
      case 'login':
        return this.run(input.accountId, async (check) => {
          const target = this.engine.recoveryTarget(input.accountId)
          // A temporarily unavailable business API is not a captcha. Opening
          // the page must not put otherwise healthy media requests behind a
          // fabricated verification requirement or clear the API's wait.
          if (
            target &&
            target.operation !== 'self' &&
            this.engine.recovery(input.accountId).some((state) => state.operation === target.operation)
          ) {
            await this.engine.show(input.accountId)
            return null
          }
          const interaction = this.authentication.snapshot()
          const kind =
            interaction && interaction.accountId === input.accountId
              ? interaction.kind
              : (await this.engine.pageState(input.accountId)).captcha
                ? 'verification'
                : 'login'
          check()
          await this.active(input.accountId)
          check()
          await this.authentication.open(input.accountId, kind, target)
          return null
        })
      case 'renameAccount':
        return this.accounts.rename(input.accountId, input.name)
      case 'logoutAccount':
      case 'removeAccount': {
        this.health.clear(input.accountId)
        this.healthAfterAuth.delete(input.accountId)
        this.clearAccessChecks(input.accountId)
        const action =
          command === 'logoutAccount'
            ? this.accounts.logout(input.accountId)
            : this.accounts.remove(input.accountId)
        this.accountAction = action
        try {
          return await action
        } finally {
          if (this.accountAction === action) this.accountAction = null
        }
      }
      case 'checkHealth':
        return this.checkHealth(input.accountId)
      case 'collectionAction': {
        try {
          await this.collectionAction(input.accountId, input.source, input.action)
          return null
        } catch (error) {
          if (error instanceof AppError)
            this.health.observe(
              input.accountId,
              input.source === 'likes' ? 'likes' : input.action === 'folders' ? 'folders' : 'favorites',
              error.code,
              error.retryAt
            )
          this.changed()
          throw error
        }
      }
      case 'probe':
        return this.run(input.accountId, async (check) => {
          const account = await this.verifyAccess(
            input.accountId,
            this.authentication.target(input.accountId) ?? this.engine.recoveryTarget(input.accountId),
            check
          )
          check()
          this.engine.hide(input.accountId)
          this.authentication.stop()
          this.record(input.accountId, { kind: 'auth', message: '手动身份核验成功，窗口已收起。' })
          return account
        })
      case 'releaseEngine': {
        await this.unlike.stop()
        await this.favoriteActions.idle(true)
        const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
        this.epoch++
        this.engine.release()
        await paused
        return null
      }
      case 'stopRequest': {
        const accountId = this.engine.snapshot().accountId
        if (accountId) this.engine.dismissAttention(accountId)
        await this.unlike.stop()
        await this.favoriteActions.idle(true)
        const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
        this.epoch++
        this.engine.cancel()
        await paused
        return null
      }
      case 'collectPage':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['likes'])
        if (this.collection.running || this.favorites.running)
          throw new AppError('BUSY', '请先暂停自动采集，再进行单页检查。')
        return this.run(input.accountId, async (check) => {
          const account = await this.identity(input.accountId, check)
          check()
          const saved = await this.database.call('checkpoint', { accountId: input.accountId })
          const checkpoint = input.continue ? saved : null
          if (checkpoint && !checkpoint.hasMore)
            throw new AppError('NO_MORE', '当前断点已到列表末尾；可从头采集检查新增。')
          const cursor = checkpoint?.cursor ?? '0'
          const page = parseLikedPage(
            await this.engine.request(input.accountId, 'likes', {
              sec_user_id: account.remoteId!,
              max_cursor: cursor,
              min_cursor: '0',
              count: '18',
              publish_video_strategy_type: '2',
              pc_client_type: '1'
            })
          )
          check()
          if (page.hasMore && page.cursor === cursor)
            throw new AppError('CURSOR_STALLED', '分页游标没有前进，已停止以避免重复空转。')
          const result = await this.database.call('savePage', {
            accountId: input.accountId,
            remoteId: account.remoteId!,
            preserveCheckpoint: !input.continue && !!saved?.hasMore,
            ...page
          })
          this.libraryRevision++
          this.record(input.accountId, {
            kind: 'task',
            message: `单页检查完成：接收 ${result.received} 条，新增 ${result.added} 条。`
          })
          this.changed()
          return result
        })
      case 'favoriteFolders':
        await this.active(input.accountId)
        return this.database.call('favoriteFolders', input)
      case 'favoriteFolderMemberships':
        await this.active(input.accountId)
        return this.database.call('favoriteFolderMemberships', input)
      case 'favoriteWritebackPending':
        await this.active(input.accountId)
        return this.database.call('favoriteWritebackPending', input)
      case 'favoriteFolderDiff': {
        await this.active(input.accountId)
        console.info(
          `[diff] start folder=${input.folderId} lanePending=${this.lane.pending} busy=${this.busy} writeback=${!!this.favoriteSync} ai=${this.aiClassification?.status ?? 'none'}`
        )
        const ai = this.aiClassification
        if (ai && ai.accountId === input.accountId && ai.status === 'running')
          throw new AppError('BUSY', 'AI 分类正在运行，请等它完成后再核对收藏夹差异。')
        const folder = (await this.database.call('favoriteFolders', { accountId: input.accountId })).find(
          (entry) => entry.id === input.folderId
        )
        if (!folder) throw new AppError('FOLDER_CHANGED', '收藏夹已变化，请重新核对。')
        if (!folder.localOnly) this.assertAvailable(input.accountId, ['folderItems'])
        if (this.collection.running || this.favorites.running || this.unlike.running)
          throw new AppError('BUSY', '请先暂停采集或取消点赞 / 收藏任务，再核对收藏夹差异。')
        try {
          return await this.favoriteActions.diffFolder(input.accountId, input.folderId)
        } catch (error) {
          console.warn(
            `[diff] failed folder=${input.folderId} code=${error instanceof AppError ? error.code : 'INTERNAL_ERROR'}`,
            error instanceof Error ? error.message : error
          )
          throw error
        }
      }
      case 'favoriteFolderCreateLocal': {
        const account = await this.active(input.accountId)
        const preferences = await this.database.call('appPreferences', {})
        const folder = await this.database.call('favoriteLocalFolderCreate', {
          accountId: input.accountId,
          remoteId: account.remoteId ?? '',
          id: `local-${randomUUID()}`,
          title: input.title,
          private: input.private,
          queueWrite: !!account.remoteId && preferences.syncFavoritesToCloud
        })
        this.libraryRevision++
        this.changed()
        return folder
      }
      case 'favoriteFolderEditLocal':
        await this.active(input.accountId)
        await this.favorites.pause()
        {
          const result = await this.favoriteActions.renameFolder(input.accountId, input.folderId, input.title)
          this.libraryRevision++
          return result
        }
      case 'favoriteFolderRenameCloud':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['favoriteFolderCreate'])
        await this.favorites.pause()
        {
          let result
          try {
            result = await this.favoriteActions.renameCloudFolder(
              input.accountId,
              input.folderId,
              input.title
            )
          } catch (error) {
            if (error instanceof AppError && error.code === 'WRITE_UNCONFIRMED')
              this.record(input.accountId, {
                kind: 'request',
                operation: 'favoriteFolderRenameCloud',
                message: '云端收藏夹改名未获成功确认。',
                responseType: 'api-error',
                code: error.code
              })
            throw error
          }
          this.libraryRevision++
          return result
        }
      case 'favoriteFolderDeleteCloud':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['favoriteFolderCreate'])
        await this.favorites.pause()
        {
          const result = await this.favoriteActions.deleteCloudFolder(input.accountId, input.folderId)
          this.libraryRevision++
          return result
        }
      case 'favoriteFolderDeleteLocal':
        await this.active(input.accountId)
        {
          const result = await this.database.call('favoriteLocalFolderDelete', input)
          this.libraryRevision++
          this.changed()
          return result
        }
      case 'favoriteFoldersRefresh':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['folders'])
        if (this.collection.running || this.favorites.running || this.unlike.running)
          throw new AppError('BUSY', '请先停止其他采集或取消点赞 / 收藏任务，再核实收藏夹。')
        return this.favoriteActions.refreshFolders(input.accountId)
      case 'favoriteSyncToCloud': {
        if (this.favoriteSync) throw new AppError('BUSY', '写回正在进行，请等待完成或停止后再试。')
        const preferences = await this.prepareFavoriteWriteback(input.accountId)
        let settle!: () => void
        const promise = new Promise<void>((resolve) => (settle = resolve))
        const progress: WritebackProgress = {
          phase: 'checking',
          current: 0,
          total: 0,
          scopeRemaining: 0,
          nextBatchAt: null,
          estimatedFinishAt: null,
          autoContinue: false,
          batchIntervalSec: preferences.writebackBatchIntervalSec,
          batch: 0
        }
        this.favoriteSync = {
          accountId: input.accountId,
          promise,
          startedAt: Date.now(),
          progress
        }
        this.favoriteSyncStopRequested = false
        this.favoriteSyncLast = null
        const scope = { folderIds: input.folderIds, includeDefault: input.includeDefault }
        const epoch = this.epoch
        try {
          const result = await this.runFavoriteWritebackBatch(input.accountId, scope, progress, {
            value: 1500
          })
          if (epoch !== this.epoch) throw new AppError('CANCELLED', '操作已停止，旧结果已丢弃。')
          this.favoriteSyncLast = {
            accountId: input.accountId,
            status: this.favoriteSyncStopRequested ? 'stopped' : 'completed',
            message: result.skipped ? `跳过 ${result.skipped} 个不可用作品，详情见本地写回日志` : null,
            at: Date.now()
          }
          return result
        } catch (error) {
          if (!(error instanceof AppError && ['CANCELLED', 'CLOSING'].includes(error.code))) {
            await this.recordWritebackFailure(input.accountId, error)
            this.favoriteSyncLast = {
              accountId: input.accountId,
              status: 'failed',
              message: error instanceof Error ? error.message : String(error),
              at: Date.now()
            }
          }
          throw error
        } finally {
          this.favoriteSync = null
          this.favoriteSyncStopRequested = false
          settle()
          this.changed()
        }
      }
      case 'favoriteSyncAutoStart': {
        if (this.favoriteSync) throw new AppError('BUSY', '写回正在进行，请等待完成或停止后再试。')
        const autoPreferences = await this.database.call('appPreferences', {})
        if (!autoPreferences.autoContinueWriteback)
          throw new AppError('AUTO_DISABLED', '请先在任务页开启自动续批。')
        const preferences = await this.prepareFavoriteWriteback(input.accountId)
        let settle!: () => void
        const promise = new Promise<void>((resolve) => (settle = resolve))
        const progress: WritebackProgress = {
          phase: 'checking',
          current: 0,
          total: 0,
          scopeRemaining: 0,
          nextBatchAt: null,
          estimatedFinishAt: null,
          autoContinue: true,
          batchIntervalSec: preferences.writebackBatchIntervalSec,
          batch: 0
        }
        this.favoriteSync = {
          accountId: input.accountId,
          promise,
          startedAt: Date.now(),
          progress
        }
        this.favoriteSyncStopRequested = false
        this.favoriteSyncLast = null
        const scope = { folderIds: input.folderIds, includeDefault: input.includeDefault }
        void this.runFavoriteWritebackAuto(input.accountId, scope, progress, settle, this.epoch).catch(
          (error) => console.error('[MyLike] Writeback loop failed.', error)
        )
        return { started: true }
      }
      case 'favoriteSyncStop':
        this.favoriteSyncStopRequested = true
        return null
      case 'favoriteFolderRemoveWorks':
        await this.active(input.accountId)
        await Promise.all([this.collection.pause(), this.favorites.pause()])
        await this.favoriteActions.idle()
        await this.lane.idle()
        if (this.collection.running || this.favorites.running || this.unlike.running)
          throw new AppError('BUSY', '请先停止其他采集或取消点赞 / 收藏任务，再移出收藏夹。')
        return this.favoriteActions.removeFromFolder(input.accountId, input.folderId, input.workIds)
      case 'favoriteFolderMoveWorks': {
        await this.active(input.accountId)
        await Promise.all([this.collection.pause(), this.favorites.pause()])
        await this.favoriteActions.idle()
        await this.lane.idle()
        if (this.collection.running || this.favorites.running || this.unlike.running)
          throw new AppError('BUSY', '请先停止其他采集或取消点赞 / 收藏任务，再移动收藏夹内容。')
        return this.favoriteActions.moveToFolder(
          input.accountId,
          input.fromFolderId,
          input.toFolderId,
          input.workIds
        )
      }
      case 'favoriteFolderUpdateWorks': {
        await this.active(input.accountId)
        await Promise.all([this.collection.pause(), this.favorites.pause()])
        await this.favoriteActions.idle()
        await this.lane.idle()
        if (this.collection.running || this.favorites.running || this.unlike.running)
          throw new AppError('BUSY', '请先停止其他采集或取消点赞 / 收藏任务，再更新收藏夹内容。')
        return this.favoriteActions.updateFolderMemberships(
          input.accountId,
          input.fromFolderId,
          input.addFolderIds,
          input.removeFolderIds,
          input.workIds
        )
      }
      case 'favoriteFolderAddWorks':
        await this.active(input.accountId)
        await Promise.all([this.collection.pause(), this.favorites.pause()])
        await this.favoriteActions.idle()
        await this.lane.idle()
        if (this.collection.running || this.favorites.running || this.unlike.running)
          throw new AppError('BUSY', '请先停止其他采集或取消点赞 / 收藏任务，再添加到收藏夹。')
        return this.favoriteActions.addToFolders(input.accountId, input.addFolderIds, input.workIds)
      case 'favoriteStatus':
        await this.active(input.accountId)
        return this.database.call('favoriteStatus', input)
      case 'favoriteEditor':
        await this.active(input.accountId)
        {
          const preferences = await this.database.call('appPreferences', {})
          if (preferences.syncFavoritesToCloud) this.assertAvailable(input.accountId, ['detail', 'folders'])
        }
        return this.favoriteActions.open(input, input.refresh)
      case 'favoriteSave':
        await this.active(input.accountId)
        {
          const preferences = await this.database.call('appPreferences', {})
          if (preferences.syncFavoritesToCloud)
            this.assertAvailable(input.accountId, ['detail', 'folders', 'favoriteFolderRemove'])
          else if (input.removeFolderIds.length)
            this.assertAvailable(input.accountId, ['favoriteFolderRemove'])
        }
        await this.favorites.pause()
        return this.favoriteActions.save(input.accountId, input.token, input.folderIds, input.removeFolderIds)
      case 'favoriteCreateFolder':
        await this.active(input.accountId)
        {
          const preferences = await this.database.call('appPreferences', {})
          if (preferences.syncFavoritesToCloud)
            this.assertAvailable(input.accountId, ['favoriteFolderCreate'])
        }
        await this.favorites.pause()
        return this.favoriteActions.createFolder(input.accountId, input.token, input.name, input.private)
      case 'aiClassifyFavorites':
        await this.active(input.accountId)
        await this.favorites.pause()
        if (this.aiClassification?.status === 'running')
          throw new AppError('BUSY', 'AI 分类正在运行，请等待当前分类完成。')
        return this.aiClassifier.runClassification(input.accountId, {
          folderIds: input.folderIds,
          createAiFolders: input.createAiFolders,
          aiFolderNames: input.aiFolderNames,
          source: input.source,
          onlyUnclassified: input.onlyUnclassified
        })
      case 'aiSuggestFolders':
        await this.active(input.accountId)
        await this.favorites.pause()
        return this.aiClassifier.suggestFolderNames(input.accountId, input.source)
      case 'aiResumeClassification':
        await this.active(input.accountId)
        await this.favorites.pause()
        return this.run(input.accountId, (check) =>
          this.aiClassifier.resumeClassification(input.accountId, input.source, check, {
            createMissingFolders: input.createMissingFolders
          })
        )
      case 'aiImportClassificationLog':
        await this.active(input.accountId)
        await this.favorites.pause()
        return this.run(input.accountId, (check) =>
          this.aiClassifier.importClassificationLog(input.accountId, input.source, input.text, check, {
            createMissingFolders: input.createMissingFolders
          })
        )
      case 'fetchMissingCovers':
        return this.fetchMissingCovers(input.accountId)
      case 'stopMissingCovers':
        return this.stopMissingCovers(input.accountId)
      case 'syncVideoDurations':
        return this.syncVideoDurations(input.accountId)
      case 'stopVideoDurationSync':
        return this.stopVideoDurationSync(input.accountId)
      case 'syncMissingAuthorIds':
        return this.syncMissingAuthorIds(input.accountId)
      case 'stopMissingAuthorIds':
        return this.stopMissingAuthorIds(input.accountId)
      case 'resetMissingAuthorIds':
        return this.resetMissingAuthorIds(input.accountId)
      case 'aiTestConnection':
        return this.aiClassifier.testConnection(input.provider)
      case 'favoritesStart':
        return this.exclusive(async () => {
          await this.active(input.accountId)
          this.assertAvailable(input.accountId, [
            input.stage === 'folders'
              ? 'folders'
              : await this.favoriteReadOperation(input.accountId, input.mode)
          ])
          if (this.collection.running || this.unlike.running)
            throw new AppError('BUSY', '请先暂停喜欢采集或取消点赞 / 收藏任务。')
          return input.stage
            ? this.favorites.start(input.accountId, input.mode, input.stage)
            : this.favorites.start(input.accountId, input.mode)
        })
      case 'favoritesProbe':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, [
          await this.favoriteReadOperation(input.accountId, 'sync', true)
        ])
        if (this.collection.running || this.unlike.running || this.favorites.running)
          throw new AppError('BUSY', '请先暂停自动任务，再进行收藏检查。')
        return this.favorites.probe(input.accountId)
      case 'favoritesControl':
        await this.active(input.accountId)
        if (input.action === 'resume' && (this.collection.running || this.unlike.running))
          throw new AppError('BUSY', '请先暂停喜欢采集或取消点赞 / 收藏任务。')
        return input.action === 'resume'
          ? this.exclusive(async () => {
              this.assertAvailable(input.accountId, [
                await this.favoriteReadOperation(input.accountId, input.mode)
              ])
              if (this.collection.running || this.unlike.running)
                throw new AppError('BUSY', '其他任务正在运行。')
              return this.favorites.control(input.accountId, input.taskId, input.action, input.mode)
            })
          : this.favorites.control(input.accountId, input.taskId, input.action, input.mode)
      case 'collectionStart':
        return this.exclusive(async () => {
          await this.active(input.accountId)
          this.assertAvailable(input.accountId, ['likes'])
          if (this.unlike.running || this.favorites.running)
            throw new AppError('BUSY', '请先停止其他采集或取消点赞 / 收藏任务。')
          return this.collection.start(input.accountId, input.mode)
        })
      case 'collectionControl':
        await this.active(input.accountId)
        if (input.action === 'resume' && (this.unlike.running || this.favorites.running))
          throw new AppError('BUSY', '请先停止取消点赞 / 收藏任务。')
        if (input.action === 'resume')
          return this.exclusive(() => {
            this.assertAvailable(input.accountId, ['likes'])
            if (this.unlike.running || this.favorites.running)
              throw new AppError('BUSY', '请先停止收藏同步或取消点赞 / 收藏任务。')
            return this.collection.control(input.accountId, input.taskId, input.action)
          })
        return this.collection.control(input.accountId, input.taskId, input.action)
      case 'unlikeStart':
        await this.active(input.accountId)
        this.assertAvailable(
          input.accountId,
          input.source === 'favorites' ? ['detail', 'favoriteRemove'] : ['unlike']
        )
        await Promise.all([this.collection.pause(), this.favorites.pause()])
        await this.favoriteActions.idle()
        await this.lane.idle()
        return this.exclusive(async () => {
          await this.active(input.accountId)
          if (this.lane.pending || this.collection.running || this.favorites.running)
            throw new AppError('BUSY', '请等待当前页面请求结束。')
          this.assertAvailable(
            input.accountId,
            input.source === 'favorites' ? ['detail', 'favoriteRemove'] : ['unlike']
          )
          return this.unlike.start(input.accountId, input.workIds, input.mode, input.source)
        })
      case 'unlikeControl': {
        await this.active(input.accountId)
        if (input.action === 'resume') {
          const task = await this.database.call('unlikeTask', input)
          this.assertAvailable(
            input.accountId,
            task?.source === 'favorites' ? ['detail', 'favoriteRemove'] : ['unlike']
          )
          await Promise.all([this.collection.pause(), this.favorites.pause()])
          await this.favoriteActions.idle()
          await this.lane.idle()
          return this.exclusive(async () => {
            await this.active(input.accountId)
            if (this.lane.pending || this.collection.running || this.favorites.running)
              throw new AppError('BUSY', '请等待当前页面请求结束。')
            this.assertAvailable(
              input.accountId,
              task?.source === 'favorites' ? ['detail', 'favoriteRemove'] : ['unlike']
            )
            return this.unlike.resume(input.accountId, input.taskId)
          })
        }
        const task = await this.database.call('unlikeTask', input)
        if (task?.status === 'running') await this.unlike.stop()
        if ((await this.database.call('unlikeTask', input))?.status !== 'stopped')
          await this.database.call('unlikeUpdate', {
            ...input,
            status: 'stopped',
            reason: '已停止后续未发送项。'
          })
        this.changed()
        return this.database.call('unlikeTask', input)
      }
      case 'unlikeVerify':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['detail'])
        return this.unlike.verify(input.accountId, input.taskId, input.workId)
      case 'unlikeItems':
      case 'unlikeHistory':
        await this.active(input.accountId)
        return this.database.call(command, input)
      case 'query':
        return this.database.call('query', input as Query)
      case 'libraryOverview':
        await this.active(input.accountId)
        return {
          ...(await this.database.call('libraryOverview', input)),
          metadataBytes: await metadataBytes(app.getPath('userData'))
        }
      case 'matchingIds':
        return this.database.call('matchingIds', input)
      case 'deleteLocal': {
        return this.exclusive(async () => {
          await this.active(input.accountId)
          const result = await this.database.call('deleteLocal', input)
          this.libraryRevision++
          this.changed()
          return result
        })
      }
      case 'queueCreate':
      case 'queueResume':
      case 'queueMove':
      case 'queueProgress':
      case 'queueEnd':
      case 'queueReplay':
      case 'queueDismiss':
        return this.exclusive(async () => {
          await this.active(input.accountId)
          const result = await this.database.call(command, input)
          if (command !== 'queueProgress') {
            if (['queueCreate', 'queueDismiss'].includes(command)) this.mediaEpoch++
            const comments = this.activeComments
            if (
              comments &&
              (comments.queueId !== result.queueId ||
                comments.revision !== result.revision ||
                command === 'queueDismiss')
            ) {
              comments.cancelled = true
              this.engine.cancel()
            }
            const active = this.activeMedia
            // A prefetched next item becomes the current item when advancing.
            // Keep that read alive; unrelated targets still cancel immediately.
            if (
              active &&
              !(
                active.accountId === result.accountId &&
                active.queueId === result.queueId &&
                active.workId === result.work.id &&
                !result.completed
              )
            ) {
              active.cancelled = true
              this.engine.cancel()
            }
            this.changed()
          }
          return result
        })
      case 'queueItems':
        await this.active(input.accountId)
        return this.database.call('queueItems', input)
      case 'cancelMedia':
        return this.exclusive(async () => {
          await this.active(input.accountId)
          const queue = await this.database.call('queueState', { accountId: input.accountId })
          if (!queue || queue.queueId !== input.queueId || queue.revision !== input.revision)
            throw new AppError('QUEUE_CHANGED', '播放会话已变化。')
          this.mediaEpoch++
          if (this.activeComments) this.activeComments.cancelled = true
          if (this.activeMedia || this.activeComments) this.engine.cancel()
          return null
        })
      case 'playbackPreferences': {
        const preferences = await this.database.call('playbackPreferences', input)
        this.changed()
        return preferences
      }
      case 'backup':
        return this.database.call('backup', { reason: 'manual' })
      case 'dataInfo':
        if (input.accountId) await this.active(input.accountId)
        return this.maintenance.info()
      case 'openDataFolder':
        return this.maintenance.open(input.target)
      case 'openLogFile':
        return this.maintenance.openLog(input.name)
      case 'pickCoverCacheDirectory': {
        const options = {
          title: '选择封面缓存目录',
          buttonLabel: '使用此目录',
          properties: ['openDirectory' as const, 'createDirectory' as const]
        }
        const win = this.parent()
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      }
      case 'clearCache':
        await this.active(input.accountId)
        await this.quiesce()
        return this.exclusive(async () => {
          await this.active(input.accountId)
          await this.engine.clearCaches(input.accountId)
          this.changed()
          return null
        })
      case 'media': {
        const epoch = this.mediaEpoch
        const request = {
          accountId: input.accountId,
          workId: input.workId,
          queueId: input.playback?.queueId ?? null,
          cancelled: false
        }
        return this.run(input.accountId, async (check) => {
          const guard = () => {
            check()
            if (epoch !== this.mediaEpoch || request.cancelled)
              throw new AppError('CANCELLED', '已切换播放目标，旧取链已取消。')
          }
          guard()
          const validateQueue = async () => {
            if (!input.playback) return
            const queue = await this.database.call('queueState', { accountId: input.accountId })
            if (
              !queue ||
              queue.queueId !== input.playback.queueId ||
              !(
                (queue.revision === input.playback.revision &&
                  [queue.work.id, queue.next?.id].includes(input.workId)) ||
                (queue.revision > input.playback.revision &&
                  queue.work.id === input.workId &&
                  !queue.completed)
              )
            )
              throw new AppError('QUEUE_CHANGED', '播放目标已变化，旧取链已丢弃。')
          }
          await validateQueue()
          guard()
          this.activeMedia = request
          try {
            await this.identity(input.accountId, guard)
            guard()
            const media = parseMedia(
              await this.engine.request(input.accountId, 'detail', {
                aweme_id: input.workId,
                publish_video_strategy_type: '2',
                pc_client_type: '1'
              })
            )
            guard()
            if (media.work.id !== input.workId)
              throw new AppError('INVALID_RESPONSE', '作品详情与请求目标不一致。')
            await this.database.call('updateWork', { work: media.work })
            this.libraryRevision++
            this.changed()
            await validateQueue()
            guard()
            return media
          } finally {
            this.activeMedia = null
          }
        })
      }
      case 'comments': {
        const { accountId, workId, queueId, revision, commentId, cursor } = input
        const operation = commentId ? 'commentReplies' : 'comments'
        return this.run(accountId, async (check) => {
          const request = { queueId, revision, cancelled: false }
          const assertScope = async () => {
            check()
            if (request.cancelled) throw new AppError('CANCELLED', '作品已切换，旧评论请求已取消。')
            const queue = await this.database.call('queueState', { accountId })
            if (
              !queue ||
              queue.queueId !== queueId ||
              queue.revision !== revision ||
              queue.work.id !== workId
            )
              throw new AppError('QUEUE_CHANGED', '作品已切换，请重新加载评论。')
          }
          await assertScope()
          this.engine.assertAvailable(accountId, operation)
          this.activeComments = request
          try {
            await this.identity(accountId, check)
            await assertScope()
            const parameters: Record<string, string> = { cursor, count: '20', item_type: '0' }
            if (commentId) {
              parameters.item_id = workId
              parameters.comment_id = commentId
            } else {
              Object.assign(parameters, { aweme_id: workId, insert_ids: '', rcFT: '' })
            }
            await assertScope()
            const data = await this.engine.request(accountId, operation, parameters)
            await assertScope()
            return parseCommentPage(data, workId, cursor)
          } finally {
            if (this.activeComments === request) this.activeComments = null
          }
        })
      }
      case 'theme':
        await this.database.call('setting', { key: 'theme', value: input.theme })
        await this.applyAppearance(input.theme)
        this.changed()
        return null
      case 'openProject':
        try {
          await shell.openExternal('https://github.com/hqing8156-prog/douyin-favorite-MyLike')
        } catch {
          throw new AppError('OPEN_BROWSER_FAILED', '无法打开系统默认浏览器，请检查默认浏览器设置后重试。')
        }
        return null
      case 'windowPresentation':
        this.playerVisible = input.player
        await this.applyAppearance()
        return null
      case 'diagnostics':
        return {
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          node: process.versions.node,
          sqlite: await this.database.call('sqliteVersion', undefined),
          packaged: app.isPackaged,
          processes: app.getAppMetrics().map((metric) => ({
            type: metric.type,
            memoryMB: Math.round(metric.memory.workingSetSize / 1000)
          }))
        } satisfies Diagnostics
    }
  }
  async close(): Promise<void> {
    this.closing = true
    this.engine.setObserver(null)
    this.authentication.stop()
    await this.accountAction?.catch(() => {})
    await this.unlike.stop()
    await this.favoriteActions.idle(true)
    const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
    this.epoch++
    this.engine.release()

    await Promise.all([paused, this.whenFavoriteSyncIdle()])
    await this.lane.idle()
    // Window preferences must never prevent inflight business results from being saved.
    const win = this.parent()
    if (win && !win.isDestroyed()) {
      try {
        const preferences = await this.database.call('appPreferences', {})
        if (preferences.rememberWindow)
          await this.database.call('windowState', {
            state: { ...win.getNormalBounds(), maximized: win.isMaximized() }
          })
      } catch {
        console.error('[MyLike] Window preferences could not be saved; task shutdown completed.')
      }
    }
    await this.database.close()
  }
}
