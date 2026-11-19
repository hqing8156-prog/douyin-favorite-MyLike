import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { FolderHeart, LockKeyhole, PlusCircle, Search, X } from 'lucide-react'
import type { FavoriteFolder } from '../../shared/contracts'
import { call } from './api'
import {
  readFavoriteFolderVisits,
  recordFavoriteFolderVisit,
  sortFavoriteFoldersByVisit
} from './favorite-folder-recency'
import './favorite-dialog.css'

export function MoveToFolderDialog({
  accountId,
  workIds,
  folders,
  currentFolderId,
  addOnly = false,
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
  addOnly?: boolean
  workCount: number
  cloudSync: boolean
  busy: boolean
  error: string
  cancel: () => void
  confirm: (addFolderIds: string[], removeFolderIds: string[]) => Promise<unknown>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [existingCounts, setExistingCounts] = useState<Record<string, number> | null>(null)
  const [membershipError, setMembershipError] = useState('')
  const [visitError, setVisitError] = useState('')
  const [folderVisits, setFolderVisits] = useState<Record<string, number>>({})
  const [folderSearch, setFolderSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [privateFolder, setPrivateFolder] = useState(true)
  const [createError, setCreateError] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createdFolders, setCreatedFolders] = useState<FavoriteFolder[]>([])
  const targets = useMemo(
    () =>
      [
        ...createdFolders,
        ...folders.filter((folder) => !createdFolders.some((created) => created.id === folder.id))
      ].filter((folder) => addOnly || folder.id !== currentFolderId),
    [folders, currentFolderId, addOnly, createdFolders]
  )
  const sortedTargets = useMemo(
    () => sortFavoriteFoldersByVisit(targets, folderVisits),
    [targets, folderVisits]
  )
  const normalizedSearch = folderSearch.trim().toLocaleLowerCase()
  const filteredTargets = normalizedSearch
    ? sortedTargets.filter((folder) => folder.title.toLocaleLowerCase().includes(normalizedSearch))
    : sortedTargets
  const moving = busy || submitting || creatingFolder

  useEffect(() => {
    try {
      setFolderVisits(readFavoriteFolderVisits(accountId))
    } catch (error) {
      setVisitError(`读取收藏夹访问记录失败：${error instanceof Error ? error.message : '本地存储不可用。'}`)
    }
  }, [accountId])

  useEffect(() => {
    let current = true
    void call(window.mylike.invoke('favoriteFolderMemberships', { accountId, workIds })).then(
      (rows) => {
        if (current) {
          const counts = Object.fromEntries(rows.map((row) => [row.folderId, row.count]))
          setExistingCounts(counts)
          if (!addOnly)
            setSelectedIds(
              targets.filter((folder) => (counts[folder.id] ?? 0) > 0).map((folder) => folder.id)
            )
        }
      },
      (error: unknown) => {
        if (current)
          setMembershipError(
            error instanceof Error ? error.message : '读取收藏夹中的作品状态失败，请关闭后重试。'
          )
      }
    )
    return () => {
      current = false
    }
  }, [accountId, workIds, targets, addOnly])

  const submit = async () => {
    if (!existingCounts || membershipError || moving) return
    const addFolderIds = targets
      .filter((folder) => selectedIds.includes(folder.id) && (existingCounts[folder.id] ?? 0) < workCount)
      .map((folder) => folder.id)
    const removeFolderIds = addOnly
      ? []
      : targets
          .filter((folder) => !selectedIds.includes(folder.id) && (existingCounts[folder.id] ?? 0) > 0)
          .map((folder) => folder.id)
    setSubmitting(true)
    try {
      await confirm(addFolderIds, removeFolderIds)
    } finally {
      setSubmitting(false)
    }
  }

  const createFolder = async (event: FormEvent) => {
    event.preventDefault()
    const title = folderName.trim()
    if (!title || moving) return
    setCreatingFolder(true)
    setCreateError('')
    try {
      const folder = await call(
        window.mylike.invoke('favoriteFolderCreateLocal', {
          accountId,
          title,
          private: privateFolder
        })
      )
      setCreatedFolders((current) => [folder, ...current])
      setSelectedIds((ids) => [...new Set([...ids, folder.id])])
      setFolderName('')
      setFolderSearch('')
      setCreating(false)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '新建本地收藏夹失败。')
    } finally {
      setCreatingFolder(false)
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
      className={`favorite-dialog favorite-move-dialog${addOnly ? ' favorite-add-dialog' : ''}`}
      aria-labelledby="move-folder-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!moving) cancel()
      }}
    >
      <header className="favorite-dialog-heading">
        <h2 id="move-folder-title">{addOnly ? '添加到收藏夹' : '移动到其他收藏夹'}</h2>
        {addOnly && (
          <>
            <button
              type="button"
              className="favorite-search-trigger"
              aria-label={searchOpen ? '关闭收藏夹搜索' : '搜索收藏夹'}
              aria-pressed={searchOpen}
              disabled={moving}
              onClick={() => {
                if (searchOpen) setFolderSearch('')
                setSearchOpen(!searchOpen)
              }}
            >
              <Search size={16} />
            </button>
            <button
              type="button"
              className="favorite-create-trigger"
              disabled={moving}
              onClick={() => {
                setCreating((value) => !value)
                setCreateError('')
              }}
            >
              <PlusCircle size={16} />
              新建
            </button>
          </>
        )}
        <button
          type="button"
          className="favorite-close"
          aria-label={addOnly ? '关闭添加到收藏夹' : '关闭移动到其他收藏夹'}
          disabled={moving}
          onClick={cancel}
        >
          <X size={18} />
        </button>
      </header>
      <p className="favorite-writeback-note">
        {addOnly
          ? '勾选要加入的收藏夹；已存在的作品会保留，不会重复添加。'
          : '勾选要保留或加入的其他收藏夹；取消已勾选项会将作品从该收藏夹移除。提交后作品会从当前收藏夹移出，但仍保留在默认收藏中，也不会取消抖音收藏。'}
        {cloudSync
          ? addOnly
            ? '云端写回已开启：会直接加入云端收藏夹。'
            : '云端写回已开启：会先加入所选收藏夹，再移除取消勾选的收藏夹。'
          : '云端写回已关闭，本次调整只记录在本机，抖音云端收藏夹不变。'}
      </p>
      {searchOpen && addOnly && (
        <div className="favorite-search-field">
          <input
            type="search"
            aria-label="搜索收藏夹名称"
            placeholder="搜索收藏夹"
            value={folderSearch}
            autoFocus
            onChange={(event) => setFolderSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setFolderSearch('')
                setSearchOpen(false)
              }
            }}
          />
          {folderSearch && (
            <button type="button" aria-label="清空收藏夹搜索" onClick={() => setFolderSearch('')}>
              <X size={14} />
            </button>
          )}
        </div>
      )}
      {creating && addOnly && (
        <form
          className="favorite-create-form favorite-move-create-form"
          onSubmit={(event) => void createFolder(event)}
        >
          <label htmlFor="move-folder-name">新收藏夹名称</label>
          <input
            id="move-folder-name"
            aria-label="新收藏夹名称"
            placeholder="收藏夹名称"
            maxLength={30}
            value={folderName}
            disabled={moving}
            autoFocus
            onChange={(event) => setFolderName(event.target.value)}
          />
          <div>
            <label>
              <input
                type="checkbox"
                checked={privateFolder}
                disabled={moving}
                onChange={(event) => setPrivateFolder(event.target.checked)}
              />
              设为私密
            </label>
            <button type="submit" disabled={moving || !folderName.trim()}>
              {creatingFolder ? '正在创建…' : '创建并添加'}
            </button>
          </div>
        </form>
      )}
      <div
        className="favorite-folder-list"
        aria-label={addOnly ? '可添加的收藏夹' : '其他收藏夹'}
        aria-busy={moving || existingCounts === null}
      >
        {filteredTargets.length ? (
          filteredTargets.map((folder) => {
            const existing = existingCounts?.[folder.id] ?? 0
            const existingLabel =
              workCount === 1
                ? '已存在'
                : existing >= workCount
                  ? `已含全部 ${existing} 条`
                  : `已含 ${existing}/${workCount} 条`
            return (
              <label
                className="favorite-folder-row favorite-writeback-row"
                key={folder.id}
                title={existing ? '所选作品已在该收藏夹中的数量；取消勾选可移除' : undefined}
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
                  {existing > 0 && workCount > 1 && (
                    <span className="favorite-folder-badge">{existingLabel}</span>
                  )}
                  <small>
                    {folder.localOnly ? `仅本机 · ${folder.localCount} 条` : `${folder.localCount} 条`}
                  </small>
                </span>
                <input
                  type="checkbox"
                  aria-label={
                    addOnly
                      ? existing >= workCount
                        ? `已含全部 ${folder.title}`
                        : `加入 ${folder.title}`
                      : `${existing > 0 ? '从' : '加入'} ${folder.title}`
                  }
                  checked={selectedIds.includes(folder.id)}
                  disabled={
                    moving ||
                    existingCounts === null ||
                    !!membershipError ||
                    (addOnly && (existingCounts[folder.id] ?? 0) >= workCount)
                  }
                  onChange={(event) => {
                    try {
                      setFolderVisits(recordFavoriteFolderVisit(accountId, folder.id))
                      setVisitError('')
                    } catch (error) {
                      setVisitError(
                        `保存收藏夹访问记录失败：${error instanceof Error ? error.message : '本地存储不可用。'}`
                      )
                    }
                    setSelectedIds((ids) =>
                      event.target.checked
                        ? [...new Set([...ids, folder.id])]
                        : ids.filter((id) => id !== folder.id)
                    )
                  }}
                />
              </label>
            )
          })
        ) : normalizedSearch ? (
          <p className="favorite-search-empty" role="status">
            没有找到匹配的收藏夹。
          </p>
        ) : (
          <p className="favorite-writeback-empty">
            {addOnly ? '还没有收藏夹，请先创建或同步收藏夹。' : '还没有其他收藏夹，可先新建收藏夹后再移动。'}
          </p>
        )}
      </div>
      {createError && (
        <div className="favorite-error" role="alert">
          {createError}
        </div>
      )}
      {membershipError && (
        <div className="favorite-error" role="alert">
          无法读取收藏夹中的作品状态，未执行更改：{membershipError}
        </div>
      )}
      {visitError && (
        <div className="favorite-error" role="alert">
          {visitError}
        </div>
      )}
      {error && (
        <div className="favorite-error" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="favorite-save"
        disabled={
          moving ||
          existingCounts === null ||
          !!membershipError ||
          (addOnly
            ? !targets.some(
                (folder) => selectedIds.includes(folder.id) && (existingCounts[folder.id] ?? 0) < workCount
              )
            : false)
        }
        onClick={() => void submit()}
      >
        {moving
          ? addOnly
            ? '正在添加…'
            : '正在更新…'
          : addOnly
            ? `添加 ${workCount} 条作品`
            : `更新 ${workCount} 条作品的收藏夹`}
      </button>
    </dialog>
  )
}
