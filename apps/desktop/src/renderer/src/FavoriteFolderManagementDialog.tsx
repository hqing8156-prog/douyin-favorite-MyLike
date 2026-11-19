import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Pencil, Trash2, X } from 'lucide-react'
import type { FavoriteFolder } from '../../shared/contracts'
import { ConfirmDialog } from './ConfirmDialog'
import { call, type Perform } from './api'
import './favorite-dialog.css'

export function FavoriteFolderManagementDialog({
  accountId,
  folder,
  initialAction,
  busy,
  error,
  perform,
  close,
  notice
}: {
  accountId: string
  folder: FavoriteFolder
  initialAction: 'edit' | 'delete'
  busy: boolean
  error: string
  perform: Perform
  close: () => void
  notice: (message: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(folder.title)
  const [confirmDelete, setConfirmDelete] = useState(initialAction === 'delete')
  const cloudLinked = !!folder.remoteId && !folder.localOnly

  // Only one modal stays open: the management panel steps aside while the
  // delete confirmation is shown, and comes back if the user cancels.
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (confirmDelete) {
      if (node.open) node.close()
    } else if (!node.open) node.showModal()
  }, [confirmDelete])
  useEffect(
    () => () => {
      if (dialog.current?.open) dialog.current.close()
    },
    []
  )

  const rename = async (event: FormEvent) => {
    event.preventDefault()
    const title = name.trim()
    if (!title || title === folder.title) return
    const command = folder.managedLocally ? 'favoriteFolderEditLocal' : 'favoriteFolderRenameCloud'
    const succeeded = await perform('改名收藏夹', async () => {
      await call(window.mylike.invoke(command, { accountId, folderId: folder.id, title }))
    })
    if (succeeded) {
      notice(`收藏夹已改名为“${title}”。${cloudLinked ? '云端名称已同步更新。' : '更改仅保存在本机。'}`)
      close()
    }
  }

  const remove = async () => {
    const command = cloudLinked ? 'favoriteFolderDeleteCloud' : 'favoriteFolderDeleteLocal'
    const succeeded = await perform('删除收藏夹', async () => {
      await call(window.mylike.invoke(command, { accountId, folderId: folder.id }))
    })
    if (!succeeded) return
    notice(
      cloudLinked
        ? `已删除云端收藏夹“${folder.title}”；其中作品仍保留在默认收藏列表中。`
        : `已删除本地收藏夹“${folder.title}”；作品仍保留在默认收藏列表中。`
    )
    close()
  }

  return (
    <>
      <dialog
        ref={dialog}
        className="favorite-dialog local-folders-dialog favorite-folder-management-dialog"
        aria-labelledby="folder-management-title"
        onCancel={(event) => {
          event.preventDefault()
          if (!busy) close()
        }}
      >
        <header className="favorite-dialog-heading">
          <h2 id="folder-management-title">管理收藏夹</h2>
          <button
            type="button"
            className="favorite-close"
            aria-label="关闭收藏夹管理"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <form className="favorite-create-form" onSubmit={(event) => void rename(event)}>
          <label htmlFor="managed-folder-name">收藏夹名称</label>
          <input
            id="managed-folder-name"
            aria-label="收藏夹名称"
            maxLength={30}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="local-folder-form-actions">
            <button type="submit" disabled={busy || !name.trim() || name.trim() === folder.title}>
              <Pencil size={14} />
              保存名称
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={14} />
              删除收藏夹
            </button>
          </div>
          <p className="local-folders-note">
            {cloudLinked
              ? '改名和删除会同步到抖音云端。删除只移除收藏夹分组及其中的关联，作品仍保留在默认收藏列表。'
              : '这是仅本地收藏夹；改名和删除只影响本机，作品仍保留在默认收藏列表。'}
          </p>
          {error && (
            <p className="favorite-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </dialog>
      {confirmDelete && (
        <ConfirmDialog
          title={cloudLinked ? '删除云端收藏夹' : '删除本地收藏夹'}
          busy={busy}
          confirmLabel={cloudLinked ? '确认删除云端收藏夹' : '确认删除本地收藏夹'}
          cancel={() => (initialAction === 'delete' ? close() : setConfirmDelete(false))}
          confirm={() => void remove()}
        >
          <p>
            确定删除“{folder.title}”及其 {folder.localCount} 条夹内关联吗？
            {cloudLinked
              ? '此操作会删除抖音云端收藏夹；作品仍保留在默认收藏列表。'
              : '此操作仅删除本机收藏夹；作品仍保留在默认收藏列表。'}
          </p>
          {error && (
            <p className="task-error" role="alert">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}
