import { CollectionActions } from './CollectionActions'
import { useEffect, useMemo, useState } from 'react'
import { Cloud, CloudOff, Pencil, Sparkles, Trash2 } from 'lucide-react'
import type { FavoriteFolder, FavoritesTask, Snapshot } from '../../shared/contracts'
import type { RecoveryState } from '../../shared/recovery-state'
import { taskRecovery } from '../../shared/task-recovery'
import { call, type Perform } from './api'
import { Select } from './Select'
import { LocalFoldersDialog } from './LocalFoldersDialog'
import { FavoriteFolderManagementDialog } from './FavoriteFolderManagementDialog'
import {
  readFavoriteFolderVisits,
  recordFavoriteFolderVisit,
  sortFavoriteFoldersByVisit
} from './favorite-folder-recency'

export function FavoriteIssues({ task }: { task: FavoritesTask | null }) {
  return task?.issues?.length ? (
    <details className="favorite-sync-issues">
      <summary>未完成的收藏夹（{task.issues.length}）</summary>
      <ul>
        {task.issues.map((issue) => (
          <li key={issue.folderId}>
            <strong>{issue.title}</strong>
            <small>
              {taskRecovery(issue.errorCode)?.message ?? '暂时未能同步这个收藏夹，可以稍后重试。'}
            </small>
            <details className="runtime-details">
              <summary>诊断详情</summary>
              <small>{'ID ' + issue.folderId + ' · ' + issue.reason}</small>
            </details>
          </li>
        ))}
      </ul>
    </details>
  ) : null
}
export function useFavoriteFolders(
  accountId: string | null,
  revision: number,
  onError: (message: string) => void
) {
  const [result, setResult] = useState<{
    accountId: string
    folders: FavoriteFolder[]
  } | null>(null)
  useEffect(() => {
    if (!accountId) return
    let current = true
    void call(window.mylike.invoke('favoriteFolders', { accountId })).then(
      (folders) => {
        if (current) setResult({ accountId, folders })
      },
      (error) => {
        if (current) {
          setResult({ accountId, folders: [] })
          onError(error instanceof Error ? error.message : '读取收藏夹失败。')
        }
      }
    )
    return () => {
      current = false
    }
  }, [accountId, revision, onError])
  const refresh = async () => {
    if (!accountId) return []
    const folders = await call(window.mylike.invoke('favoriteFoldersRefresh', { accountId }))
    setResult({ accountId, folders })
    return folders
  }
  return result?.accountId === accountId
    ? { ...result, loaded: true, refresh }
    : { folders: [], loaded: false, refresh }
}
export function FavoritesPanel({
  accountId,
  task,
  busy,
  perform,
  folders,
  openClassification,
  foldersLoaded = true,
  folderId,
  setFolderId,
  compact = false,
  snapshot,
  error,
  notice
}: {
  snapshot: Snapshot | null
  accountId: string | null
  task: FavoritesTask | null
  busy: boolean
  perform: Perform
  start: () => void
  folders?: FavoriteFolder[]
  openClassification: (source: 'likes' | 'favorites') => void
  foldersLoaded?: boolean
  folderId?: string | null
  setFolderId?: (id: string | null) => void
  compact?: boolean
  updateTask?: FavoritesTask | null
  recovery?: readonly RecoveryState[]
  login?: () => void
  accessChecks?: readonly { accountId: string; operation: string; at: number }[]
  error: string
  notice?: (message: string) => void
}) {
  const latest = snapshot?.favoritesUpdate
  const progress =
    latest && (latest.status === 'running' || latest.updatedAt > (task?.updatedAt ?? 0)) ? latest : task
  const [manageLocalFolders, setManageLocalFolders] = useState(false)
  const [manageFolder, setManageFolder] = useState<{
    folder: FavoriteFolder
    action: 'edit' | 'delete'
  } | null>(null)
  const [folderVisits, setFolderVisits] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!accountId) {
      setFolderVisits({})
      return
    }
    try {
      setFolderVisits(readFavoriteFolderVisits(accountId))
    } catch (error) {
      setFolderVisits({})
      notice?.(`读取收藏夹访问记录失败：${error instanceof Error ? error.message : '本地存储不可用。'}`)
    }
  }, [accountId, notice])
  const sortedFolders = useMemo(
    () => sortFavoriteFoldersByVisit(folders ?? [], folderVisits),
    [folders, folderVisits]
  )
  const selectedFolder = folders?.find((folder) => folder.id === folderId)
  return (
    <section className={compact ? 'favorites-toolbar' : 'panel'} aria-label="收藏同步">
      {!compact && <h2>收藏与收藏夹</h2>}
      {setFolderId && (
        <Select
          label="收藏夹筛选"
          value={folderId ?? ''}
          popupMinWidth={300}
          onChange={(value) => setFolderId(value || null)}
          onSelect={(value) => {
            if (!value || !accountId) return
            try {
              setFolderVisits(
                recordFavoriteFolderVisit(
                  accountId,
                  value,
                  sortedFolders.find((folder) => folder.id === value)?.coverUrl
                )
              )
            } catch (error) {
              notice?.(
                `保存收藏夹访问记录失败：${error instanceof Error ? error.message : '本地存储不可用。'}`
              )
            }
          }}
          optionActions={(option) => {
            const folder = sortedFolders.find((entry) => entry.id === option.value)
            return folder ? (
              <>
                <button
                  type="button"
                  aria-label={`编辑 ${folder.title}`}
                  title="编辑收藏夹"
                  disabled={busy || !foldersLoaded}
                  onClick={() => setManageFolder({ folder, action: 'edit' })}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="danger-button"
                  aria-label={`删除 ${folder.title}`}
                  title="删除收藏夹"
                  disabled={busy || !foldersLoaded}
                  onClick={() => setManageFolder({ folder, action: 'delete' })}
                >
                  <Trash2 size={14} />
                </button>
              </>
            ) : null
          }}
          options={[
            { value: '', label: '全部收藏' },
            ...sortedFolders.map((folder) => ({
              value: folder.id,
              label: folder.title + ' · ' + folder.localCount,
              displayLabel: (
                <>
                  <span className="select-option-folder-title">{folder.title}</span>
                  <span
                    className="select-option-status"
                    role="img"
                    aria-label={folder.remoteId ? '云端有此收藏夹' : '云端没有此收藏夹'}
                  >
                    {folder.remoteId ? <Cloud size={14} /> : <CloudOff size={14} />}
                  </span>
                  <span className="select-option-folder-count">· {folder.localCount}</span>
                </>
              )
            }))
          ]}
        />
      )}
      {selectedFolder &&
        !selectedFolder.localOnly &&
        selectedFolder.localCount !== selectedFolder.remoteCount && (
          <span className="favorites-progress" role="note">
            {`本地 ${selectedFolder.localCount} 条 · 最近云端 ${selectedFolder.remoteCount} 条`}
          </span>
        )}
      {progress && (
        <span className="favorites-progress" role="status">
          {(progress.status === 'running'
            ? '进行中'
            : progress.status === 'completed'
              ? '已完成'
              : progress.status === 'partial'
                ? '部分完成'
                : '已停止') +
            ' · 本次新增 ' +
            progress.added +
            ' 条' +
            (progress.mode === 'update'
              ? ' · 更新顶部'
              : ' · 收藏夹 ' +
                progress.foldersDone +
                '/' +
                progress.foldersTotal +
                (progress.status === 'running' && progress.folderTitle ? ' · ' + progress.folderTitle : ''))}
        </span>
      )}
      <div className="panel-actions">
        <CollectionActions
          snapshot={snapshot}
          accountId={accountId}
          source="favorites"
          busy={busy}
          perform={perform}
          syncFolders
          syncToCloud={snapshot?.appPreferences.syncFavoritesToCloud ?? false}
          pendingWrites={snapshot?.favoriteWritePending ?? 0}
          notice={notice}
          folders={folders}
          onManageLocalFolders={() => setManageLocalFolders(true)}
          foldersLoaded={foldersLoaded}
          showCollectionControls={false}
        />
        <button
          disabled={!accountId || busy || !foldersLoaded}
          onClick={() => openClassification('favorites')}
          title={foldersLoaded ? '先核实抖音收藏夹，再选择分类目标' : '正在读取收藏夹'}
        >
          <Sparkles size={14} />
          AI 自动分类
        </button>
      </div>
      <FavoriteIssues task={task} />
      {manageLocalFolders && accountId && (
        <LocalFoldersDialog
          accountId={accountId}
          folders={folders ?? []}
          busy={busy}
          error={error}
          perform={perform}
          close={() => setManageLocalFolders(false)}
          notice={(message) => notice?.(message)}
        />
      )}
      {manageFolder && accountId && (
        <FavoriteFolderManagementDialog
          key={`${manageFolder.folder.id}:${manageFolder.action}`}
          accountId={accountId}
          folder={manageFolder.folder}
          initialAction={manageFolder.action}
          busy={busy}
          error={error}
          perform={perform}
          close={() => setManageFolder(null)}
          notice={(message) => notice?.(message)}
        />
      )}
    </section>
  )
}
