import { Fragment, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, LoaderCircle, Search, Star, X } from 'lucide-react'
import {
  WRITEBACK_BATCH_LIMIT,
  WRITEBACK_SESSION_TTL_MS,
  type FavoriteFolder,
  type FavoriteFolderDiff,
  type PendingFavoriteWrite,
  type Work
} from '../../shared/contracts'
import { call, type Perform } from './api'
import { CoverImage } from './CoverImage'
import './favorite-dialog.css'

const pendingKindLabels: Record<PendingFavoriteWrite['kind'], string> = {
  'folder-create': '新建收藏夹',
  'favorite-add': '收藏作品',
  'folder-add': '加入收藏夹',
  'folder-remove': '移出收藏夹'
}

type DiffState = { loading: boolean; error: string; data: FavoriteFolderDiff | null }

const checkedClock = (value: number) =>
  new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

function DiffCard({ work }: { work: Work }) {
  return (
    <div className="favorite-diff-card" title={`${work.title}\n${work.author}`}>
      <span className="favorite-diff-cover">
        <CoverImage url={work.coverUrl} />
      </span>
      <span className="favorite-diff-title">{work.title || work.id}</span>
      <span className="favorite-diff-meta">{work.author}</span>
    </div>
  )
}

/** Virtualized thumbnail grid: hundreds of differences keep the DOM small. */
function DiffGrid({ works, resetKey }: { works: Work[]; resetKey: string }) {
  const scroll = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(1)
  useEffect(() => {
    const node = scroll.current
    if (!node) return
    const update = () => setColumns(Math.max(1, Math.floor((node.clientWidth + 8) / 104)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const virtual = useVirtualizer({
    count: Math.ceil(works.length / columns),
    getScrollElement: () => scroll.current,
    estimateSize: () => 140,
    overscan: 3
  })
  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 })
  }, [resetKey])
  return (
    <div ref={scroll} className="favorite-diff-scroll">
      <div className="favorite-diff-canvas" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="favorite-diff-row"
            style={{ transform: `translateY(${row.start}px)`, height: row.size }}
          >
            {works.slice(row.index * columns, row.index * columns + columns).map((work) => (
              <DiffCard key={work.id} work={work} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function FolderDiffPanel({
  folder,
  state,
  retry
}: {
  folder: FavoriteFolder
  state: DiffState
  retry: () => void
}) {
  const [tab, setTab] = useState<'add' | 'remote'>('add')
  const [search, setSearch] = useState('')
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!state.loading) return
    const started = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [state.loading, folder.id])
  const data = state.data
  const query = search.trim().toLowerCase()
  const matches = (work: Work) =>
    !query || work.title.toLowerCase().includes(query) || work.author.toLowerCase().includes(query)
  const add = (data?.add ?? []).filter(matches)
  const remoteOnly = (data?.remoteOnly ?? []).filter(matches)
  const works = data?.localOnly ? add : tab === 'add' ? add : remoteOnly
  return (
    <section
      id={`favorite-diff-${folder.id}`}
      className="favorite-diff-panel"
      aria-label={`${folder.title} 差异`}
    >
      <header className="favorite-diff-head">
        <strong>{folder.title}</strong>
        {state.loading ? (
          <small className="favorite-diff-checking" role="status">
            正在核对…
          </small>
        ) : null}
        {data ? (
          <small className="favorite-diff-counts">
            本地 {data.localCount} · 云端 {data.remoteCount}
          </small>
        ) : null}
      </header>
      {state.loading && !data ? (
        <>
          <p className="favorite-diff-loading" role="status">
            <LoaderCircle size={16} className="spin" />
            正在核对云端{elapsed ? `（已等待 ${elapsed} 秒）` : ''}…
          </p>
          {elapsed >= 8 ? (
            <>
              <p className="favorite-diff-note">
                {elapsed >= 60
                  ? '已等待超过 1 分钟。抖音页面正常最多需要约 35 秒重新加载，加请求约 12 秒；请检查网络或登录状态，必要时重启应用后再试。'
                  : '抖音页面可能需要重新加载（最长约 35 秒），之后单个请求约 12 秒内会返回结果或报错。'}
              </p>
              <div className="favorite-diff-retry">
                <button type="button" onClick={retry}>
                  重新核对
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : state.error && !data ? (
        <div className="favorite-diff-error" role="alert">
          <span>{state.error}</span>
          <button type="button" disabled={state.loading} onClick={retry}>
            重试
          </button>
        </div>
      ) : null}
      {data ? (
        <>
          {data.localOnly ? null : (
            <div className="favorite-diff-tabs" role="tablist" aria-label="差异类型">
              <button type="button" role="tab" aria-selected={tab === 'add'} onClick={() => setTab('add')}>
                本地有、云端无 {data.add.length}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'remote'}
                onClick={() => setTab('remote')}
              >
                云端有、本地无 {data.remoteOnly.length}
              </button>
            </div>
          )}
          <p className="favorite-diff-summary">
            {data.localOnly
              ? `该收藏夹尚未创建到云端；写回时将新建收藏夹并写入 ${data.localCount} 条作品。`
              : tab === 'add'
                ? `这 ${data.add.length} 条只在本地：写回会补写到云端。`
                : `这 ${data.remoteOnly.length} 条只在云端：写回不会删除，如需一致请使用“同步收藏夹”。`}
          </p>
          {data.localOnly || data.add.length || data.remoteOnly.length ? (
            <div className="favorite-diff-toolbar">
              <Search size={14} />
              <input
                className="favorite-diff-search"
                aria-label="搜索差异作品"
                placeholder="搜索标题或作者"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <span>{works.length} 条</span>
            </div>
          ) : null}
          {works.length ? (
            <DiffGrid works={works} resetKey={`${tab}:${search}:${data.checkedAt}`} />
          ) : (
            <p className="favorite-writeback-empty">{query ? '没有匹配的作品。' : '没有差异。'}</p>
          )}
          {data.truncated ? (
            <p className="favorite-diff-note">差异过多，仅显示前 2000 条；数量为完整统计。</p>
          ) : null}
          <p className="favorite-diff-note">
            {data.localOnly
              ? `✓ 仅本地收藏夹，无需核对云端 · ${checkedClock(data.checkedAt)}`
              : data.complete
                ? `✓ 云端列表已完整核对 · ${checkedClock(data.checkedAt)}`
                : `⚠ 云端列表不完整（${data.skipped} 条无法读取），差异可能不完整；写回遇到这类作品会停止。`}
          </p>
        </>
      ) : null}
    </section>
  )
}

export function FavoriteWritebackDialog({
  accountId,
  folders,
  pendingWrites,
  busy,
  autoContinue,
  perform,
  close,
  notice
}: {
  accountId: string
  folders: FavoriteFolder[]
  pendingWrites: number
  busy: boolean
  autoContinue: boolean
  perform: Perform
  close: () => void
  notice?: (message: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])
  const [includeDefault, setIncludeDefault] = useState(false)
  const [pending, setPending] = useState<{
    total: number
    items: PendingFavoriteWrite[]
  } | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [columns, setColumns] = useState(3)
  const folderList = useRef<HTMLDivElement>(null)
  const diffMounted = useRef(true),
    diffSequence = useRef(0)
  useEffect(() => {
    // Dev Fast Refresh tears down and re-runs effects. Restore the flag in the
    // setup; otherwise an in-flight result is dropped and the panel spins forever.
    diffMounted.current = true
    return () => {
      diffMounted.current = false
    }
  }, [])
  useEffect(() => {
    const node = folderList.current
    if (!node) return
    // Keep the diff panel below a complete row: measure how many folder cards fit.
    const update = () => setColumns(Math.max(1, Math.floor((node.clientWidth + 10) / 250)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let live = true
    void call(window.mylike.invoke('favoriteWritebackPending', { accountId }))
      .then((result) => {
        if (live) setPending(result)
      })
      .catch(() => {
        if (live) setPending(null)
      })
    return () => {
      live = false
    }
  }, [accountId])
  useEffect(() => {
    if (pending?.items.length) setDetailsOpen(true)
  }, [pending])
  const changedFolders = folders.filter(
    (folder) =>
      folder.localOnly || folder.localCount !== folder.remoteCount || (folder.pendingWrites ?? 0) > 0
  )
  const visibleSelected = selectedFolders.filter((id) => changedFolders.some((folder) => folder.id === id))
  const selectedCount = visibleSelected.length + Number(includeDefault)

  useEffect(() => {
    dialog.current?.showModal()
    return () => {
      if (dialog.current?.open) dialog.current.close()
    }
  }, [])

  const loadDiff = (folderId: string) => {
    const sequence = ++diffSequence.current
    setDiffs((old) => ({
      ...old,
      [folderId]: { loading: true, error: '', data: old[folderId]?.data ?? null }
    }))
    const timeout = window.setTimeout(() => {
      if (!diffMounted.current || sequence !== diffSequence.current) return
      setDiffs((old) =>
        old[folderId]?.loading
          ? {
              ...old,
              [folderId]: {
                loading: false,
                error:
                  '核对超过 90 秒仍未返回：抖音页面或请求通道可能卡住了。可以重试；如果其他操作也变慢，请重启应用。',
                data: old[folderId]?.data ?? null
              }
            }
          : old
      )
    }, 90_000)
    void call(window.mylike.invoke('favoriteFolderDiff', { accountId, folderId }))
      .then((data) => {
        window.clearTimeout(timeout)
        if (!diffMounted.current || sequence !== diffSequence.current) return
        setDiffs((old) => ({ ...old, [folderId]: { loading: false, error: '', data } }))
      })
      .catch((error) => {
        window.clearTimeout(timeout)
        if (!diffMounted.current || sequence !== diffSequence.current) return
        setDiffs((old) => ({
          ...old,
          [folderId]: {
            loading: false,
            error: error instanceof Error ? error.message : '核对失败，请重试。',
            data: null
          }
        }))
      })
  }
  const toggleDiff = (folderId: string) => {
    if (expandedDiff === folderId) {
      setExpandedDiff(null)
      return
    }
    setExpandedDiff(folderId)
    // A pending request can be lost when the dialog remounts during a dev HMR
    // update, so only reuse a fully loaded result; otherwise ask again.
    if (!diffs[folderId]?.data) loadDiff(folderId)
  }

  const submit = () => {
    if (!selectedCount || busy) return
    const folderIds = [...visibleSelected]
    close()
    if (autoContinue) {
      void perform('启动自动续批', async () => {
        await call(
          window.mylike.invoke('favoriteSyncAutoStart', {
            accountId,
            folderIds,
            includeDefault
          })
        )
        notice?.('已开始自动续批；可在“任务”页查看进度并停止后续批次。')
      })
      return
    }
    void perform('写回云端收藏夹', async () => {
      const result = await call(
        window.mylike.invoke('favoriteSyncToCloud', {
          accountId,
          folderIds,
          includeDefault
        })
      )
      notice?.(
        [
          `写回完成：已写回 ${result.synced} 项`,
          result.skipped ? `跳过 ${result.skipped} 项不可见作品` : '',
          result.truncated ? `本次达到单次上限 ${WRITEBACK_BATCH_LIMIT} 项` : '',
          result.remaining ? `仍有 ${result.remaining} 项待写回。` : '队列已清空。'
        ]
          .filter(Boolean)
          .join('，')
      )
    })
  }

  return (
    <dialog
      ref={dialog}
      className="favorite-dialog favorite-writeback-dialog"
      aria-labelledby="favorite-writeback-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
    >
      <header className="favorite-dialog-heading">
        <h2 id="favorite-writeback-title">选择写回范围</h2>
        <button
          type="button"
          className="favorite-close"
          aria-label="关闭写回范围"
          disabled={busy}
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      <div className="favorite-writeback-body">
        <p className="favorite-writeback-note">
          当前有 {pendingWrites}{' '}
          项本地改动待写回。只显示本地与云端数量不一致或仍有待写回改动的收藏夹；云端数量为最近一次同步结果。
          点收藏夹右侧的“差异”可只读核对具体作品，不会修改云端或加入写回。
          只处理下方所选范围，未选择的改动会保留。已同步收藏夹会核对作品，并将本地有、云端缺少的作品加入写回；这项核对本身不会删除云端作品。
          写回只把本机新增内容写到云端，不会把云端的新增或删除带回本机；要获取云端变化请使用“同步收藏夹”。必要的默认收藏状态会一并写回。
        </p>
        <div className="favorite-writeback-selection">
          <button
            type="button"
            disabled={busy || (!changedFolders.length && !pendingWrites)}
            onClick={() => {
              setSelectedFolders(changedFolders.map((folder) => folder.id))
              setIncludeDefault(true)
            }}
          >
            全选
          </button>
          <button
            type="button"
            disabled={busy || (!changedFolders.length && !includeDefault)}
            onClick={() => {
              setSelectedFolders([])
              setIncludeDefault(false)
            }}
          >
            全不选
          </button>
        </div>
        <div ref={folderList} className="favorite-folder-list" aria-label="可写回的收藏夹">
          {Array.from(
            {
              length: Math.ceil((changedFolders.length + 1) / columns)
            },
            (_, rowIndex) => {
              const entries = [
                { kind: 'default' as const },
                ...changedFolders.map((folder) => ({ kind: 'folder' as const, folder }))
              ].slice(rowIndex * columns, rowIndex * columns + columns)
              const expanded = entries.find(
                (entry) => entry.kind === 'folder' && entry.folder.id === expandedDiff
              )
              return (
                <Fragment key={rowIndex}>
                  <div
                    className="favorite-folder-grid"
                    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                  >
                    {entries.map((entry) =>
                      entry.kind === 'default' ? (
                        <label className="favorite-folder-row favorite-writeback-row" key="default-favorites">
                          <span className="favorite-folder-cover">
                            <Star size={20} />
                          </span>
                          <span className="favorite-folder-name">
                            <span>默认收藏列表</span>
                            <small>尚未同步的默认收藏作品</small>
                          </span>
                          <input
                            type="checkbox"
                            aria-label="写回默认收藏列表"
                            checked={includeDefault}
                            disabled={busy}
                            onChange={(event) => setIncludeDefault(event.target.checked)}
                          />
                        </label>
                      ) : (
                        <div className="favorite-folder-row favorite-writeback-row" key={entry.folder.id}>
                          <button
                            type="button"
                            className="favorite-folder-open"
                            aria-expanded={expandedDiff === entry.folder.id}
                            aria-controls={
                              expandedDiff === entry.folder.id
                                ? `favorite-diff-${entry.folder.id}`
                                : undefined
                            }
                            aria-label={
                              expandedDiff === entry.folder.id
                                ? `收起 ${entry.folder.title} 的差异`
                                : `查看 ${entry.folder.title} 的差异`
                            }
                            disabled={busy}
                            onClick={() => toggleDiff(entry.folder.id)}
                          >
                            <span className="favorite-folder-cover">
                              <CoverImage url={entry.folder.coverUrl} size={20} />
                            </span>
                            <span className="favorite-folder-name">
                              <span>{entry.folder.title}</span>
                              <small>
                                {entry.folder.localOnly || !entry.folder.remoteId
                                  ? `仅本地 · ${entry.folder.localCount} 条`
                                  : `本地 ${entry.folder.localCount} 条 · 最近云端 ${entry.folder.remoteCount} 条${
                                      entry.folder.localCount === entry.folder.remoteCount
                                        ? ' · 有本地改动'
                                        : ''
                                    }`}
                              </small>
                            </span>
                            <ChevronDown size={14} className="favorite-folder-chevron" aria-hidden="true" />
                          </button>
                          <input
                            type="checkbox"
                            aria-label={`写回收藏夹 ${entry.folder.title}`}
                            checked={selectedFolders.includes(entry.folder.id)}
                            disabled={busy}
                            onChange={(event) =>
                              setSelectedFolders((selected) =>
                                event.target.checked
                                  ? [...selected, entry.folder.id]
                                  : selected.filter((id) => id !== entry.folder.id)
                              )
                            }
                          />
                        </div>
                      )
                    )}
                  </div>
                  {expanded?.kind === 'folder' ? (
                    <FolderDiffPanel
                      folder={expanded.folder}
                      state={diffs[expanded.folder.id] ?? { loading: true, error: '', data: null }}
                      retry={() => loadDiff(expanded.folder.id)}
                    />
                  ) : null}
                </Fragment>
              )
            }
          )}
          {changedFolders.length ? null : (
            <p className="favorite-writeback-empty">本地与云端收藏夹内容一致，暂无可写回的收藏夹。</p>
          )}
        </div>
        <details
          className="favorite-writeback-details"
          open={detailsOpen}
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        >
          <summary>
            待写回明细（{pending?.total ?? pendingWrites} 项）
            {pending && pending.items.length < pending.total ? ` · 显示前 ${pending.items.length} 项` : ''}
          </summary>
          {pending?.items.length ? (
            <ul className="favorite-writeback-list">
              {pending.items.map((item, index) => (
                <li key={`${item.kind}-${item.folderId ?? ''}-${item.workId ?? ''}-${index}`}>
                  <span className="favorite-writeback-kind">{pendingKindLabels[item.kind]}</span>
                  <span className="favorite-writeback-target">
                    {item.workTitle ?? item.workId ?? item.folderTitle ?? item.folderId ?? '—'}
                    {item.author ? <small>{item.author}</small> : null}
                    {item.kind !== 'folder-create' && item.folderTitle ? (
                      <small>{item.folderTitle}</small>
                    ) : null}
                  </span>
                  {!item.queued ? <span className="favorite-writeback-derived">写回时核对</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="favorite-writeback-empty">暂无待写回明细。</p>
          )}
          <p className="favorite-writeback-note">
            单次最多写回 {WRITEBACK_BATCH_LIMIT} 项；未处理完的会保留在队列中，可再次写回。
            同一范围内的连续写回会复用本次核对结果；更换范围、重启应用或超过{' '}
            {Math.round(WRITEBACK_SESSION_TTL_MS / 60_000)} 分钟会重新核对。
          </p>
        </details>
      </div>
      <button
        type="button"
        className="favorite-save"
        disabled={busy || selectedCount === 0}
        onClick={() => void submit()}
      >
        写回所选范围（{selectedCount}）
      </button>
    </dialog>
  )
}
