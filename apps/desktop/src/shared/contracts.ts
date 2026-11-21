import type { HealthSnapshot } from './health'
import { z } from 'zod'
import type { RuntimeEvent } from './runtime-events'
import type { RecoveryState } from './recovery-state'
import { appPreferencesPatchSchema, playbackPreferencesSchema, type AppPreferences } from './preferences'
export { playbackPreferencesSchema, shortcutKeys } from './preferences'

export const MAX_BATCH_SIZE = 1000
/** The danmaku endpoint returns at most one 32-second window per request. */
export const DANMAKU_WINDOW_MS = 32_000
/** Keeps one writeback run short enough to review and to limit continuous writes. */
export const WRITEBACK_BATCH_LIMIT = 100
/** Reuse one cloud reconciliation across consecutive writeback batches. */
export const WRITEBACK_SESSION_TTL_MS = 30 * 60_000
export const idSchema = z.string().uuid()
export const workIdSchema = z.string().regex(/^\d{1,30}$/)
/** Folder ids are remote numeric ids or locally generated `local-<uuid>` ids. */
export const folderIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
export const filterSchema = z.object({
  accountId: idSchema,
  search: z.string().max(200).default(''),
  mediaType: z.enum(['all', 'video', 'gallery', 'text']).default('all'),
  durationGreaterThanMs: z.number().int().min(0).max(86_400_000).nullable().optional(),
  year: z.number().int().min(2000).max(2200).nullable().default(null),
  month: z.number().int().min(1).max(12).nullable().default(null),
  sort: z.enum(['published', 'collected']).default('published'),
  source: z.enum(['likes', 'favorites', 'all']).optional(),
  folderId: folderIdSchema.nullable().optional()
})
export const querySchema = filterSchema.extend({
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(120).default(60)
})
export const playbackScopeSchema = z.object({
  accountId: idSchema,
  queueId: idSchema,
  revision: z.number().int().min(0)
})
export const playbackPositionSchema = z.object({
  seconds: z.number().finite().min(0).max(86400),
  slide: z.number().int().min(0).max(1000),
  musicSeconds: z.number().finite().min(0).max(86400)
})
const queueSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('filter'), filter: filterSchema.omit({ accountId: true }) }),
  z.object({
    type: z.literal('ids'),
    source: z.enum(['likes', 'favorites']).optional(),
    ids: z.array(workIdSchema).min(1).max(100000),
    sort: z.enum(['published', 'collected']).default('published')
  })
])

const favoriteWritebackSchema = z
  .object({
    accountId: idSchema,
    folderIds: z.array(z.string().min(1).max(100)).max(1000).default([]),
    includeDefault: z.boolean().default(false)
  })
  .refine((input) => input.includeDefault || input.folderIds.length > 0)

export const commands = {
  snapshot: z.object({}),
  checkHealth: z.object({ accountId: idSchema }),
  collectionAction: z.object({
    accountId: idSchema,
    source: z.enum(['likes', 'favorites']),
    action: z.enum(['top', 'down', 'stop', 'folders', 'rescan'])
  }),
  createAccount: z.object({ name: z.string().trim().min(1).max(40) }),
  switchAccount: z.object({ accountId: idSchema }),
  renameAccount: z.object({ accountId: idSchema, name: z.string().trim().min(1).max(40) }),
  logoutAccount: z.object({ accountId: idSchema }),
  removeAccount: z.object({ accountId: idSchema }),
  login: z.object({ accountId: idSchema }),
  probe: z.object({ accountId: idSchema }),
  releaseEngine: z.object({}),
  collectPage: z.object({ accountId: idSchema, continue: z.boolean() }),
  collectionStart: z.object({ accountId: idSchema, mode: z.enum(['update', 'incremental', 'recheck']) }),
  runtimeEvents: z.object({ accountId: idSchema }),
  favoritesStart: z.object({
    accountId: idSchema,
    mode: z.enum(['sync', 'update']).optional(),
    stage: z.enum(['all', 'folders']).optional()
  }),
  favoritesProbe: z.object({ accountId: idSchema }),
  favoritesControl: z.object({
    accountId: idSchema,
    taskId: idSchema,
    action: z.enum(['pause', 'resume', 'stop']),
    mode: z.enum(['sync', 'update']).optional()
  }),
  favoriteFolders: z.object({ accountId: idSchema }),
  favoriteFoldersRefresh: z.object({ accountId: idSchema }),
  favoriteFoldersReconcile: z.object({ accountId: idSchema }),
  favoriteFolderMemberships: z.object({
    accountId: idSchema,
    workIds: z.array(workIdSchema).min(1).max(MAX_BATCH_SIZE)
  }),
  favoriteSyncToCloud: favoriteWritebackSchema,
  favoriteSyncAutoStart: favoriteWritebackSchema,
  favoriteWritebackPending: z.object({ accountId: idSchema }),
  favoriteSyncStop: z.object({}),
  favoriteFolderDiff: z.object({ accountId: idSchema, folderId: folderIdSchema }),
  favoriteFolderRemoveWorks: z.object({
    accountId: idSchema,
    folderId: folderIdSchema,
    workIds: z.array(workIdSchema).min(1).max(MAX_BATCH_SIZE)
  }),
  favoriteFolderMoveWorks: z
    .object({
      accountId: idSchema,
      fromFolderId: folderIdSchema,
      toFolderId: folderIdSchema,
      workIds: z.array(workIdSchema).min(1).max(MAX_BATCH_SIZE)
    })
    .refine((input) => input.fromFolderId !== input.toFolderId),
  favoriteFolderUpdateWorks: z
    .object({
      accountId: idSchema,
      fromFolderId: folderIdSchema,
      addFolderIds: z
        .array(folderIdSchema)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length),
      removeFolderIds: z
        .array(folderIdSchema)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length),
      workIds: z.array(workIdSchema).min(1).max(MAX_BATCH_SIZE)
    })
    .refine(
      (input) =>
        !input.addFolderIds.includes(input.fromFolderId) &&
        !input.removeFolderIds.includes(input.fromFolderId) &&
        input.addFolderIds.every((id) => !input.removeFolderIds.includes(id))
    ),
  favoriteFolderAddWorks: z.object({
    accountId: idSchema,
    addFolderIds: z
      .array(folderIdSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    workIds: z.array(workIdSchema).min(1).max(MAX_BATCH_SIZE)
  }),
  favoriteFolderCreateLocal: z.object({
    accountId: idSchema,
    title: z.string().trim().min(1).max(30),
    private: z.boolean()
  }),
  favoriteFolderEditLocal: z.object({
    accountId: idSchema,
    folderId: z.string().min(1).max(100),
    title: z.string().trim().min(1).max(30)
  }),
  favoriteFolderDeleteLocal: z.object({
    accountId: idSchema,
    folderId: z.string().min(1).max(100)
  }),
  favoriteFolderRenameCloud: z.object({
    accountId: idSchema,
    folderId: folderIdSchema,
    title: z.string().trim().min(1).max(30)
  }),
  favoriteFolderDeleteCloud: z.object({
    accountId: idSchema,
    folderId: folderIdSchema
  }),
  favoriteStatus: z.object({ accountId: idSchema, workId: workIdSchema }),
  favoriteEditor: playbackScopeSchema.extend({
    workId: workIdSchema,
    refresh: z.boolean().optional()
  }),
  favoriteSave: z.object({
    accountId: idSchema,
    token: idSchema,
    folderIds: z
      .array(folderIdSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    removeFolderIds: z
      .array(folderIdSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length)
      .default([])
  }),
  favoriteCreateFolder: z.object({
    accountId: idSchema,
    token: idSchema,
    name: z.string().trim().min(1).max(30),
    private: z.boolean()
  }),
  aiClassifyFavorites: z
    .object({
      accountId: idSchema,
      folderIds: z
        .array(folderIdSchema)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length),
      createAiFolders: z.boolean(),
      aiFolderNames: z.array(z.string().trim().min(1).max(30)).max(30),
      onlyUnclassified: z.boolean().default(false)
    })
    .extend({ source: z.enum(['likes', 'favorites']).optional() }),
  aiSuggestFolders: z.object({
    accountId: idSchema,
    source: z.enum(['likes', 'favorites']).optional()
  }),
  aiResumeClassification: z.object({
    accountId: idSchema,
    source: z.enum(['likes', 'favorites']),
    createMissingFolders: z.boolean().default(true)
  }),
  aiImportClassificationLog: z.object({
    accountId: idSchema,
    source: z.enum(['likes', 'favorites']),
    text: z.string().min(1).max(4_000_000),
    createMissingFolders: z.boolean().default(true)
  }),
  fetchMissingCovers: z.object({ accountId: idSchema }),
  stopMissingCovers: z.object({ accountId: idSchema }),
  syncVideoDurations: z.object({ accountId: idSchema }),
  stopVideoDurationSync: z.object({ accountId: idSchema }),
  syncMissingAuthorIds: z.object({ accountId: idSchema }),
  stopMissingAuthorIds: z.object({ accountId: idSchema }),
  resetMissingAuthorIds: z.object({ accountId: idSchema }),
  aiTestConnection: z.object({ provider: z.enum(['deepseek', 'siliconflow']) }),
  collectionControl: z.object({
    accountId: idSchema,
    taskId: idSchema,
    action: z.enum(['pause', 'resume', 'stop'])
  }),
  stopRequest: z.object({}),
  query: querySchema,
  libraryOverview: z.object({ accountId: idSchema }),
  matchingIds: filterSchema,
  deleteLocal: z.object({ accountId: idSchema, workIds: z.array(workIdSchema).min(1).max(100000) }),
  unlikeStart: z.object({
    accountId: idSchema,
    workIds: z.array(workIdSchema).min(1).max(MAX_BATCH_SIZE),
    source: z.enum(['likes', 'favorites']).default('likes'),
    mode: z.enum(['single', 'batch'])
  }),
  unlikeControl: z.object({ accountId: idSchema, taskId: idSchema, action: z.enum(['resume', 'stop']) }),
  unlikeItems: z.object({
    accountId: idSchema,
    taskId: idSchema,
    offset: z.number().int().min(0).max(1000),
    limit: z.number().int().min(1).max(100).default(50),
    issuesOnly: z.boolean().optional()
  }),
  unlikeHistory: z.object({ accountId: idSchema }),
  unlikeVerify: z.object({ accountId: idSchema, taskId: idSchema, workId: workIdSchema }),
  queueCreate: z.object({
    accountId: idSchema,
    source: queueSourceSchema,
    mode: z.enum(['sequence', 'shuffle']),
    startWorkId: workIdSchema.optional()
  }),
  queueResume: z.object({ accountId: idSchema, queueId: idSchema }),
  queueMove: z.object({
    accountId: idSchema,
    queueId: idSchema,
    target: z.union([z.enum(['next', 'previous']), z.number().int().min(0).max(99999)])
  }),
  queueProgress: playbackScopeSchema.extend({
    position: playbackPositionSchema,
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  }),
  queueEnd: playbackScopeSchema.extend({ advance: z.boolean(), position: playbackPositionSchema }),
  queueReplay: playbackScopeSchema,
  queueDismiss: playbackScopeSchema,
  cancelMedia: playbackScopeSchema,
  queueItems: z.object({
    accountId: idSchema,
    queueId: idSchema,
    offset: z.number().int().min(0).max(100000),
    limit: z.number().int().min(1).max(100).default(50)
  }),
  playbackPreferences: z.object({ preferences: playbackPreferencesSchema }),
  appPreferences: z.object({ preferences: appPreferencesPatchSchema }),
  checkDatabase: z.object({}),
  copyText: z.object({ text: z.string().max(1024) }),
  openAuthorProfile: z
    .object({
      accountId: idSchema,
      authorId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,200}$/)
        .optional(),
      authorUrl: z
        .string()
        .max(2048)
        .regex(/^https:\/\/[^\s]+$/)
        .optional()
    })
    .refine((value) => !!value.authorId || !!value.authorUrl, {
      message: '需要作者 ID 或作者主页链接。'
    }),
  copyDiagnostics: z.object({}),
  openReleases: z.object({}),
  backup: z.object({}),
  dataInfo: z.object({ accountId: idSchema.nullable() }),
  openDataFolder: z.object({ target: z.enum(['data', 'backups', 'logs']) }),
  openLogFile: z.object({ name: z.enum(['cover-refresh', 'duration-refresh']) }),
  pickCoverCacheDirectory: z.object({}),
  clearCache: z.object({ accountId: idSchema }),
  media: z.object({
    accountId: idSchema,
    workId: workIdSchema,
    playback: z.object({ queueId: idSchema, revision: z.number().int().min(0) }).optional()
  }),
  comments: playbackScopeSchema.extend({
    workId: workIdSchema,
    commentId: workIdSchema.optional(),
    cursor: workIdSchema.default('0')
  }),
  danmaku: z
    .object({
      accountId: idSchema,
      workId: workIdSchema,
      token: z.string().min(1).max(4096),
      durationMs: z.number().int().min(0).max(864_000_000),
      start: z.number().int().min(0).max(864_000_000),
      end: z.number().int().min(0).max(864_000_000)
    })
    .refine((value) => value.end > value.start && value.end - value.start <= DANMAKU_WINDOW_MS, {
      message: '弹幕窗口必须不超过 32 秒。'
    }),
  theme: z.object({ theme: z.enum(['dark', 'light']) }),
  windowPresentation: z.object({ player: z.boolean() }),
  openProject: z.object({}),
  diagnostics: z.object({})
}
export type Command = keyof typeof commands
export type Query = z.infer<typeof querySchema>
export type Filter = z.infer<typeof filterSchema>
export type PlaybackPreferences = z.infer<typeof playbackPreferencesSchema>
export type PlaybackPosition = z.infer<typeof playbackPositionSchema>
export type PlaybackScope = z.infer<typeof playbackScopeSchema>
export type QueueCreate = z.infer<typeof commands.queueCreate>
export interface QueueState extends PlaybackScope {
  source?: 'likes' | 'favorites' | 'all'
  mode: 'sequence' | 'shuffle'
  index: number
  total: number
  position: PlaybackPosition
  completed: boolean
  work: Work
  next: Work | null
}
export interface Account {
  id: string
  name: string
  remoteId: string | null
  nickname: string | null
  avatarUrl: string | null
  createdAt: number
  lastVerifiedAt: number | null
}
export interface Work {
  id: string
  title: string
  author: string
  authorId?: string | null
  authorUrl?: string | null
  publishedAt: number
  coverUrl: string | null
  mediaType: 'video' | 'gallery' | 'text'
  isLive: boolean
  durationMs?: number
  /** Douyin work type. 163 is an article/text work; 68 is an image gallery. */
  awemeType?: number | null
}
export interface DanmakuInfo {
  /** Total danmaku the platform reports for this work. */
  count: number
  /** Whether the platform allows danmaku on this work. */
  enabled: boolean
  /** Per-work credential the danmaku endpoint requires. */
  token: string
  /** Work duration in milliseconds, in the unit the danmaku endpoint expects. */
  durationMs: number
}
export interface DanmakuItem {
  id: string
  /** Position in the video, milliseconds. */
  timeMs: number
  text: string
  /** CSS hex color when the platform supplied one. */
  color: string | null
}
export interface DanmakuPage {
  items: DanmakuItem[]
  start: number
  end: number
  total: number
}
export interface Media {
  work: Work
  caption?: string
  videos: string[]
  images: { url: string; liveUrl: string | null }[]
  music: string | null
  /** Present for video works; null when the platform exposes no danmaku data. */
  danmaku?: DanmakuInfo | null
}
export type CommentMediaSource = { url: string; type: 'image' | 'video' }
export interface WorkComment {
  id: string
  text: string
  author: string
  avatarUrl: string | null
  attachments: CommentMediaSource[][]
  publishedAt: number | null
  likes: number
  replies: number
}
export interface CommentPage {
  items: WorkComment[]
  nextCursor: string | null
}
export interface LibraryPage {
  items: Work[]
  total: number
  years: number[]
}
export interface LibraryOverview {
  metadataBytes: number
  accountId: string
  total: number
  videos: number
  galleries: number
  live: number
  recent: Work[]
  likes: number
  favorites: number
  overlap: number
  folders: number
  years: { year: number | null; count: number }[]
  authors: {
    authorId: string
    name: string
    videos: number
    galleries: number
    texts: number
    total: number
  }[]
}
export type EngineStatus = 'stopped' | 'starting' | 'ready' | 'visible' | 'failed'
export interface CollectionTask {
  id: string
  accountId: string
  mode: 'update' | 'full' | 'incremental' | 'recheck'
  phase: 'head' | 'backfill'
  status: 'running' | 'paused' | 'stopped' | 'completed'
  cursor: string
  backfillCursor: string | null
  tailCursor?: string | null
  pages: number
  received: number
  added: number
  reason: string | null
  errorCode: string | null
  updatedAt: number
}
export interface UnlikeTask {
  id: string
  accountId: string
  source: 'likes' | 'favorites'
  mode: 'single' | 'batch'
  remoteId: string
  status: 'running' | 'paused' | 'stopped' | 'completed'
  reason: string | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
  total: number
  pending: number
  inflight: number
  success: number
  failed: number
  unknown: number
}
export interface UnlikeItem {
  position: number
  workId: string
  title: string
  status: 'pending' | 'inflight' | 'success' | 'failed' | 'unknown'
  reason: string | null
  errorCode: string | null
}
export interface AiClassificationProgress {
  accountId: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  phase: string
  current: number
  total: number
  startedAt: number
  error?: string
}
export interface AiClassificationResult {
  classified: number
  failed: number
  failedItems: { workId: string; category: string; reason: string }[]
  foldersCreated: number
  foldersUsed: number
  unmatched: number
  folderCounts: { title: string; count: number }[]
}
export interface FavoriteSyncLast {
  status: 'completed' | 'stopped' | 'failed'
  message: string | null
  at: number
}
export interface FavoriteSyncProgress {
  phase: 'checking' | 'writing' | 'waiting'
  /** Operations completed in the current batch. */
  current: number
  /** Operations in the current batch (0 while the cloud folder is being checked). */
  total: number
  /** Pending operations across the account. */
  remaining: number
  /** Operations still queued for the current writeback scope. */
  scopeRemaining: number
  startedAt: number
  /** Set while waiting for the next batch. */
  nextBatchAt: number | null
  /** Estimated completion time, or null when auto-continue is off. */
  estimatedFinishAt: number | null
  autoContinue: boolean
  batchIntervalSec: number
  /** 1-based batch number of the current run. */
  batch: number
}
export interface CoverRefreshProgress {
  accountId: string
  current: number
  total: number
  updated: number
  failed: number
  status: 'running' | 'paused'
  pauseReason: 'verification' | 'limited' | 'manual' | 'interrupted' | null
}
export interface DataMaintenanceFailureReason {
  reason: string
  count: number
}
export interface DurationRefreshProgress {
  accountId: string
  current: number
  total: number
  updated: number
  failed: number
  status: 'running' | 'paused'
  pauseReason: 'verification' | 'limited' | 'manual' | 'interrupted' | null
  stopping: boolean
}
export interface DurationRefreshCheckpoint {
  accountId: string
  workIds: string[]
  nextIndex: number
  updated: number
  failed: number
  lastRequestAt: number
  pauseReason: 'verification' | 'limited' | 'manual' | null
}
export interface AuthorIdRefreshProgress {
  accountId: string
  current: number
  total: number
  updated: number
  failed: number
  status: 'running' | 'paused'
  pauseReason: 'verification' | 'limited' | 'manual' | 'interrupted' | null
  stopping: boolean
}
export interface AuthorIdRefreshCheckpoint {
  accountId: string
  workIds: string[]
  nextIndex: number
  updated: number
  failed: number
  lastRequestAt: number
  pauseReason: 'verification' | 'limited' | 'manual' | null
}
export interface CoverRefreshCheckpoint {
  accountId: string
  workIds: string[]
  nextIndex: number
  updated: number
  failed: number
  lastRequestAt: number
  pauseReason: 'verification' | 'limited' | 'manual' | null
}
export interface Snapshot {
  aiClassification: AiClassificationProgress | null
  /** AI assignments saved but not yet applied locally, per source. */
  aiPendingAssignments: { likes: number; favorites: number }
  coverRefresh: CoverRefreshProgress | null
  durationRefresh: DurationRefreshProgress | null
  authorIdRefresh: AuthorIdRefreshProgress | null
  favoriteWritePending: number
  favoriteSync: FavoriteSyncProgress | null
  favoriteSyncLast: FavoriteSyncLast | null
  health?: HealthSnapshot | null
  recovery?: RecoveryState[]
  accessChecks?: { accountId: string; operation: string; at: number }[]
  favorites: FavoritesTask | null
  favoritesUpdate?: FavoritesTask | null
  favoritesActivity: 'requesting' | 'waiting' | 'recycling' | 'confirming' | 'cooling' | 'probing' | null
  accounts: Account[]
  activeAccountId: string | null
  theme: 'dark' | 'light'
  engine: { status: EngineStatus; accountId: string | null }
  authentication: {
    accountId: string
    kind: 'login' | 'verification'
    status: 'waiting' | 'checking' | 'failed'
    code?: string | null
    retryAt?: number
    message: string
  } | null
  busy: boolean
  collection: CollectionTask | null
  collectionActivity: 'requesting' | 'waiting' | 'recycling' | 'confirming' | 'cooling' | 'probing' | null
  unlike: UnlikeTask | null
  libraryRevision: number
  playback: QueueState | null
  playbackPreferences: PlaybackPreferences
  appPreferences: AppPreferences
  version: string
}
export interface PageResult {
  received: number
  added: number
  hasMore: boolean
  cursor: string
}
export interface Diagnostics {
  electron: string
  chromium: string
  node: string
  sqlite: string
  packaged: boolean
  processes: { type: string; memoryMB: number }[]
}
export interface DataInfo {
  folder: string
  metadataBytes: number
  backupsBytes: number
  backupsCount: number
}
export interface FavoriteFolder {
  id: string
  remoteId?: string | null
  localOnly?: boolean
  managedLocally?: boolean
  title: string
  remoteCount: number
  localCount: number
  /** Local operations not yet written back to the cloud for this folder. */
  pendingWrites?: number
  private?: boolean
  coverUrl?: string | null
}
export interface PendingFavoriteWrite {
  kind: 'favorite-add' | 'folder-add' | 'folder-remove' | 'folder-create'
  folderId: string | null
  folderTitle: string | null
  workId: string | null
  workTitle: string | null
  author: string | null
  coverUrl: string | null
  /** Already in favorite_write_ops; false means it will be staged during writeback. */
  queued: boolean
}
/** Read-only comparison between a local favorite folder and its cloud copy. */
export interface FavoriteFolderDiff {
  folderId: string
  title: string
  localOnly: boolean
  /** False when cloud rows are unreadable or the list count mismatches the folder total. */
  complete: boolean
  /** Cloud rows that could not be parsed; they are excluded from both sides. */
  skipped: number
  localCount: number
  remoteCount: number
  /** Count reported by the latest cloud folder listing. */
  expectedRemoteCount?: number
  /** Local works the cloud folder lacks; an explicit writeback adds them. */
  add: Work[]
  /** Cloud works missing locally; writeback never deletes them. */
  remoteOnly: Work[]
  /** True when a list was capped for the IPC payload; counts stay exact. */
  truncated: boolean
  checkedAt: number
}
export interface FavoriteEditor {
  token: string
  accountId: string
  workId: string
  collected: boolean
  localCount: number
  folders: FavoriteFolder[]
  /** Folders that already contain this work. */
  folderIds: string[]
}
export interface FavoritesTask {
  id: string
  accountId: string
  stage: 'all' | 'folders' | 'folder'
  folderId: string | null
  /** Display title of the folder currently being verified, when known. */
  folderTitle?: string | null
  cursor: string
  status: 'running' | 'paused' | 'stopped' | 'completed' | 'partial'
  mode?: 'sync' | 'update'
  skipped?: number
  incomplete?: number
  foldersDeferred?: number
  issues?: { folderId: string; title: string; reason: string; errorCode: string }[]
  pages: number
  received: number
  added: number
  foldersDone: number
  foldersTotal: number
  reason: string | null
  errorCode: string | null
  updatedAt: number
}
export interface Outputs {
  appPreferences: AppPreferences
  checkDatabase: { ok: boolean; checkedAt: number; issues: number }
  copyText: null
  openAuthorProfile: null
  copyDiagnostics: null
  openReleases: null
  favoritesStart: FavoritesTask
  favoritesProbe: { stage: string; count: number; skipped: number; hasMore: boolean }
  favoritesControl: FavoritesTask
  favoriteFolders: FavoriteFolder[]
  favoriteFoldersRefresh: FavoriteFolder[]
  favoriteFoldersReconcile: { folders: FavoriteFolder[]; removed: number; unlinked: number }
  favoriteFolderMemberships: { folderId: string; count: number }[]
  favoriteSyncToCloud: {
    synced: number
    remaining: number
    scopeRemaining: number
    skipped: number
    skippedItems: { workId: string; kind: string; reason: string }[]
    truncated: boolean
  }
  favoriteWritebackPending: { total: number; items: PendingFavoriteWrite[] }
  favoriteSyncAutoStart: { started: true }
  favoriteSyncStop: null
  favoriteFolderDiff: FavoriteFolderDiff
  favoriteFolderRemoveWorks: { folderId: string; folderTitle: string; removed: number }
  favoriteFolderMoveWorks: {
    fromFolderId: string
    fromFolderTitle: string
    toFolderId: string
    toFolderTitle: string
    moved: number
    cloudSync: boolean
  }
  favoriteFolderUpdateWorks: {
    fromFolderTitle: string
    addedFolderTitles: string[]
    removedFolderTitles: string[]
    updated: number
    cloudSync: boolean
  }
  favoriteFolderAddWorks: {
    added: number
    folderTitles: string[]
    cloudSync: boolean
  }
  favoriteFolderCreateLocal: FavoriteFolder
  favoriteFolderEditLocal: FavoriteFolder
  favoriteFolderDeleteLocal: { folderId: string; title: string; localCount: number }
  favoriteFolderRenameCloud: FavoriteFolder
  favoriteFolderDeleteCloud: { folderId: string; title: string; localCount: number }
  favoriteStatus: { collected: boolean; synced: boolean }
  favoriteEditor: FavoriteEditor
  favoriteSave: { collected: true; foldersAdded: number }
  favoriteCreateFolder: FavoriteFolder
  checkHealth: HealthSnapshot
  collectionAction: null
  aiClassifyFavorites: {
    classified: number
    failed: number
    failedItems: { workId: string; category: string; reason: string }[]
    foldersCreated: number
    foldersUsed: number
    unmatched: number
    folderCounts: { title: string; count: number }[]
  }
  aiResumeClassification: AiClassificationResult
  aiImportClassificationLog: AiClassificationResult
  aiSuggestFolders: { folderNames: string[] }
  fetchMissingCovers: {
    total: number
    updated: number
    failed: number
    failureReasons: DataMaintenanceFailureReason[]
    deferred: number
    needsVerification: boolean
    stopped: boolean
  }
  stopMissingCovers: null
  syncVideoDurations: {
    total: number
    updated: number
    failed: number
    failureReasons: DataMaintenanceFailureReason[]
    deferred: number
    needsVerification: boolean
    stopped: boolean
  }
  stopVideoDurationSync: null
  syncMissingAuthorIds: {
    total: number
    updated: number
    failed: number
    failureReasons: DataMaintenanceFailureReason[]
    deferred: number
    needsVerification: boolean
    stopped: boolean
  }
  stopMissingAuthorIds: null
  resetMissingAuthorIds: null
  aiTestConnection: null
  snapshot: Snapshot
  createAccount: Account
  switchAccount: null
  renameAccount: Account
  logoutAccount: null
  removeAccount: null
  login: null
  probe: Account
  releaseEngine: null
  collectPage: PageResult
  runtimeEvents: RuntimeEvent[]
  collectionStart: CollectionTask
  collectionControl: CollectionTask
  stopRequest: null
  query: LibraryPage
  libraryOverview: LibraryOverview
  matchingIds: string[]
  deleteLocal: { removed: number }
  unlikeStart: UnlikeTask
  unlikeControl: UnlikeTask
  unlikeItems: { items: UnlikeItem[]; total: number }
  unlikeHistory: UnlikeTask[]
  unlikeVerify: UnlikeTask
  queueCreate: QueueState
  queueResume: QueueState
  queueMove: QueueState
  queueProgress: QueueState
  queueEnd: QueueState
  queueReplay: QueueState
  queueDismiss: QueueState
  cancelMedia: null
  queueItems: { items: { index: number; work: Work }[]; total: number }
  playbackPreferences: PlaybackPreferences
  backup: { fileName: string }
  dataInfo: DataInfo
  openDataFolder: null
  openLogFile: null
  pickCoverCacheDirectory: string | null
  clearCache: null
  media: Media
  comments: CommentPage
  danmaku: DanmakuPage
  theme: null
  windowPresentation: null
  openProject: null
  diagnostics: Diagnostics
}
export type Result<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string; retryAt?: number } }
export interface DesktopAPI {
  invoke<K extends Command>(command: K, input: z.input<(typeof commands)[K]>): Promise<Result<Outputs[K]>>
  onChanged(callback: () => void): () => void
  onBeforeQuit(callback: () => Promise<void>): () => void
}
