import { useEffect, useRef, useState } from 'react'
import { FolderHeart, LockKeyhole, X } from 'lucide-react'
import type { FavoriteFolder } from '../../shared/contracts'
import { call } from './api'
import './favorite-dialog.css'

export function MoveToFolderDialog({
  accountId,
  workIds,
  folders,
  currentFolderId,
  workCount,
  cloudSync,
  busy,
  error,
  cancel,
  confirm
}: {
  accountId: string
  workIds: string[]
  folders: FavoriteFolder[]
  currentFolderId: string
  workCount: number
  cloudSync: boolean
  busy: boolean
  error: string
  cancel: () => void
  confirm: (folderId: string) => Promise<unknown>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [existingCounts, setExistingCounts] = useState<Record<string, number>>({})
  const targets = folders.filter((folder) => folder.id !== currentFolderId)
  const selected = targets.some((folder) => folder.id === targetId) ? targetId : null
  const moving = busy || submitting

  useEffect(() => {
    let current = true
    void call(window.mylike.invoke('favoriteFolderMemberships', { accountId, workIds })).then(
      (rows) => {
        if (current) setExistingCounts(Object.fromEntries(rows.map((row) => [row.folderId, row.count])))
      },
      // The markers are informational; a failed lookup must not block the move.
      () => {}
    )
    return () => {
      current = false
    }
  }, [accountId, workIds])

  const submit = async () => {
    if (!selected || moving) return
    setSubmitting(true)
    try {
      await confirm(selected)
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    dialog.current?.showModal()
    return () => {
      if (dialog.current?.open) dialog.current.close()
    }
  }, [])

  return (
    <dialog
      ref={dialog}
      className="favorite-dialog favorite-move-dialog"
      aria-labelledby="move-folder-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!moving) cancel()
      }}
    >
      <header className="favorite-dialog-heading">
        <h2 id="move-folder-title">移动到其他收藏夹</h2>
        <button
          type="button"
          className="favorite-close"
          aria-label="关闭移动到其他收藏夹"
          disabled={moving}
          onClick={cancel}
        >
          <X size={18} />
        </button>
      </header>
      <p className="favorite-writeback-note">
        将把所选的 {workCount}{' '}
        条作品从当前收藏夹移出，再加入目标收藏夹；作品仍保留在默认收藏中，也不会取消抖音收藏。
        {cloudSync
          ? '云端写回已开启：会先在目标收藏夹添加，再从原收藏夹移出。'
          : '云端写回已关闭，本次移动只记录在本机，抖音云端收藏夹不变。'}
      </p>
      <div className="favorite-folder-list" aria-label="目标收藏夹" aria-busy={moving}>
        {targets.length ? (
          targets.map((folder) => {
            const existing = existingCounts[folder.id] ?? 0
            return (
              <label
                className="favorite-folder-row favorite-writeback-row"
                key={folder.id}
                title={existing ? '所选作品已在该收藏夹中的数量' : undefined}
              >
                <span className="favorite-folder-cover">
                  {folder.coverUrl ? (
                    <img src={folder.coverUrl} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <FolderHeart size={20} />
                  )}
                </span>
                <span className="favorite-folder-name">
                  <span>{folder.title}</span>
                  {folder.private && <LockKeyhole size={12} aria-label="私密收藏夹" />}
                  {existing > 0 && (
                    <span className="favorite-folder-badge">
                      {workCount === 1
                        ? '已存在'
                        : existing === workCount
                          ? `已含全部 ${existing} 条`
                          : `已含 ${existing}/${workCount} 条`}
                    </span>
                  )}
                  <small>
                    {folder.localOnly ? `仅本机 · ${folder.localCount} 条` : `${folder.localCount} 条`}
                  </small>
                </span>
                <input
                  type="radio"
                  name="move-target-folder"
                  aria-label={`移动到 ${folder.title}`}
                  checked={selected === folder.id}
                  disabled={moving}
                  onChange={() => setTargetId(folder.id)}
                />
              </label>
            )
          })
        ) : (
          <p className="favorite-writeback-empty">还没有其他收藏夹，可先新建收藏夹后再移动。</p>
        )}
      </div>
      {error && (
        <div className="favorite-error" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="favorite-save"
        disabled={moving || !selected}
        onClick={() => void submit()}
      >
        {moving ? '正在移动…' : `移动 ${workCount} 条到所选收藏夹`}
      </button>
    </dialog>
  )
}
