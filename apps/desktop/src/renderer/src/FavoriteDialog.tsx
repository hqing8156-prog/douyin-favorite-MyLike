import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, PlusCircle, Search, Star, X } from 'lucide-react'
import type { FavoriteEditor, PlaybackScope } from '../../shared/contracts'
import { call, CommandError } from './api'
import { favoriteWriteMessage } from './favorite-feedback'
import {
  readFavoriteFolderCovers,
  readFavoriteFolderVisits,
  recordFavoriteFolderVisits,
  sortFavoriteFoldersForSelection
} from './favorite-folder-recency'
import {
  FavoriteFolderCreateForm,
  FavoriteFolderRow,
  FavoriteFolderSearchField
} from './FavoriteFolderPicker'
import './favorite-dialog.css'

export function FavoriteDialog({
  scope,
  close,
  login,
  cloudSync,
  saved,
  keepOpen = false,
  uncollect
}: {
  scope: PlaybackScope & { workId: string }
  close: () => void
  login: () => void
  cloudSync: boolean
  saved: () => void
  /** Persisted mode: non-modal, reloads after saving instead of closing the bar. */
  keepOpen?: boolean
  /** Unchecking the default list and saving asks for the normal uncollect flow. */
  uncollect: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false),
    pending = useRef(false),
    sequence = useRef(0)
  const [editor, setEditor] = useState<FavoriteEditor | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  // The default list mirrors the work's own collected state: it starts
  // unchecked for works that are not favorited yet.
  const [defaultSelected, setDefaultSelected] = useState(false)
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false)
  const [error, setError] = useState(''),
    [visitError, setVisitError] = useState(''),
    [needsReload, setNeedsReload] = useState(false)
  const [saveComplete, setSaveComplete] = useState(false)
  const [folderVisits, setFolderVisits] = useState<Record<string, number>>({})
  const [folderCovers, setFolderCovers] = useState<Record<string, string>>({})
  const [searchOpen, setSearchOpen] = useState(false),
    [folderSearch, setFolderSearch] = useState('')
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [secret, setSecret] = useState(true)
  // Membership and visit recency share one ordering with the batch add dialog:
  // folders already holding the work come first, then most recently used.
  const existingCounts = useMemo(
    () => (editor ? Object.fromEntries(editor.folderIds.map((id) => [id, 1])) : null),
    [editor]
  )
  const sortedFolders = useMemo(
    () => sortFavoriteFoldersForSelection(editor?.folders ?? [], folderVisits, existingCounts),
    [editor?.folders, folderVisits, existingCounts]
  )
  const normalizedSearch = folderSearch.trim().toLocaleLowerCase()
  const filteredFolders = normalizedSearch
    ? sortedFolders.filter((folder) => folder.title.toLocaleLowerCase().includes(normalizedSearch))
    : sortedFolders
  const showDefaultFolder = !normalizedSearch || '默认收藏列表'.toLocaleLowerCase().includes(normalizedSearch)

  const reload = async (refreshFolders = false) => {
    if (pending.current) return
    const seq = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const next = await call(
        window.mylike.invoke('favoriteEditor', refreshFolders ? { ...scope, refresh: true } : scope)
      )
      if (!mounted.current || seq !== sequence.current) return
      setEditor(next)
      setSelected(next.folderIds)
      setDefaultSelected(next.collected)
      setNeedsReload(false)
      setCreating(false)
    } catch (error) {
      if (mounted.current && seq === sequence.current) {
        setError(error instanceof Error ? error.message : '收藏夹读取失败，请重试。')
        setNeedsReload(true)
      }
    } finally {
      if (mounted.current && seq === sequence.current) setLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    // The persisted bar is non-modal so the player stays usable underneath:
    // controls and the queue list keep receiving clicks and wheel input.
    if (keepOpen) dialog.current?.show()
    else dialog.current?.showModal()
    try {
      setFolderVisits(readFavoriteFolderVisits(scope.accountId))
      setFolderCovers(readFavoriteFolderCovers(scope.accountId))
    } catch (error) {
      setVisitError(`读取收藏夹访问记录失败：${error instanceof Error ? error.message : '本地存储不可用。'}`)
    }
    void reload()
    return () => {
      mounted.current = false
      sequence.current++
    }
  }, [])
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!keepOpen) return
    // Non-modal dialogs get no cancel event, so Esc is handled in the capture
    // phase: it closes the bar before the player's Esc shortcut can exit.
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Text entries keep Esc for themselves (clearing search); a checkbox or radio
      // is not editing text, so Esc closes the bar instead of exiting playback.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          'textarea, select, [contenteditable], input:not([type=checkbox]):not([type=radio])'
        )
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!pending.current) closeRef.current()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [keepOpen])
  const save = async () => {
    if (!editor || loading || needsReload || pending.current || saveComplete) return
    // Unchecking the default list asks to uncollect the work: hand off to the
    // regular uncollect confirmation instead of saving folder changes. The
    // persisted bar stays open so the confirm (and its result) is not lost.
    if (editor.collected && !defaultSelected) {
      if (!keepOpen) close()
      uncollect()
      return
    }
    pending.current = true
    setBusy(true)
    setError('')
    let savedOk = false
    try {
      const existing = new Set(editor.folderIds)
      const addedFolderIds = selected.filter((id) => !existing.has(id))
      await call(
        window.mylike.invoke('favoriteSave', {
          accountId: scope.accountId,
          token: editor.token,
          folderIds: addedFolderIds,
          removeFolderIds: editor.folderIds.filter((id) => !selected.includes(id))
        })
      )
      if (mounted.current) {
        let visitsSaved = true
        try {
          if (addedFolderIds.length) {
            recordFavoriteFolderVisits(scope.accountId, addedFolderIds)
            setVisitError('')
          }
        } catch (error) {
          visitsSaved = false
          setVisitError(
            `收藏已保存，但记录收藏夹访问顺序失败：${error instanceof Error ? error.message : '本地存储不可用。'}`
          )
        }
        saved()
        savedOk = true
        if (!keepOpen) {
          if (visitsSaved) close()
          else setSaveComplete(true)
        }
      }
    } catch (error) {
      if (mounted.current) {
        setError(favoriteWriteMessage(error, 'save'))
        setNeedsReload(true)
      }
    } finally {
      pending.current = false
      if (mounted.current) {
        setBusy(false)
        // The persistent bar stays open and shows the saved memberships.
        if (keepOpen && savedOk) void reload()
      }
    }
  }
  const create = async () => {
    if (!editor || !name.trim() || pending.current || needsReload) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const folder = await call(
        window.mylike.invoke('favoriteCreateFolder', {
          accountId: scope.accountId,
          token: editor.token,
          name: name.trim(),
          private: secret
        })
      )
      if (!mounted.current) return
      setEditor({ ...editor, folders: [folder, ...editor.folders] })
      setSelected((ids) => [...new Set([...ids, folder.id])])
      setName('')
      setCreating(false)
    } catch (error) {
      if (mounted.current) {
        setError(favoriteWriteMessage(error, 'create'))
        if (!(error instanceof CommandError && error.code === 'FOLDER_EXISTS')) setNeedsReload(true)
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="favorite-dialog"
      aria-labelledby="favorite-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!pending.current) close()
      }}
      onClick={(event) => {
        // A native modal dialog reports backdrop clicks with the dialog itself as the
        // target, so require the pointer to be outside its rendered box. This keeps
        // clicks in the panel's own padding from closing it.
        const element = dialog.current
        if (!element || pending.current || event.target !== event.currentTarget) return
        const rect = element.getBoundingClientRect()
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close()
      }}
    >
      <header className="favorite-dialog-heading">
        <h2 id="favorite-dialog-title">选择收藏夹</h2>
        <button
          type="button"
          className="favorite-search-trigger"
          aria-label={searchOpen ? '关闭收藏夹搜索' : '搜索收藏夹'}
          aria-pressed={searchOpen}
          disabled={loading || busy || needsReload}
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
          disabled={loading || busy || needsReload}
          onClick={() => {
            setCreating(!creating)
            setError('')
          }}
        >
          <PlusCircle size={16} />
          新建
        </button>
        <button
          type="button"
          className="favorite-close"
          aria-label="关闭收藏夹选择"
          disabled={busy}
          onClick={close}
          autoFocus={!keepOpen}
        >
          <X size={18} />
        </button>
      </header>
      {searchOpen && (
        <FavoriteFolderSearchField
          value={folderSearch}
          onChange={setFolderSearch}
          onClose={() => setSearchOpen(false)}
          disabled={loading || busy || needsReload}
        />
      )}
      {creating && (
        <FavoriteFolderCreateForm
          name={name}
          onNameChange={setName}
          secret={secret}
          onSecretChange={setSecret}
          nameLabel="收藏夹名称"
          submitLabel="创建"
          pending={busy}
          disabled={loading || needsReload}
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
          onCancel={() => {
            setCreating(false)
            setName('')
            setError('')
          }}
        />
      )}
      <p className="favorite-local-note" role="note">
        {!cloudSync &&
          '云端写回已关闭，新加入的收藏夹只会记录在本机；取消已存在项仍会从抖音收藏夹移除。可在设置中开启“允许同步本地收藏夹到抖音”，再到收藏夹页写回云端。'}
        收藏夹列表使用本机已同步的数据；开启云端写回时，保存会实时核验云端状态。若刚在抖音新增收藏夹，请先同步收藏夹。
      </p>
      {loading ? (
        <div className="favorite-loading" role="status">
          <LoaderCircle size={22} className="spin" />
          正在读取收藏夹…
        </div>
      ) : (
        editor && (
          <div className="favorite-folder-list" aria-label="可选收藏夹" aria-busy={busy}>
            {showDefaultFolder && (
              <label
                className="favorite-folder-row favorite-default"
                title={
                  editor.collected
                    ? '取消勾选并保存会取消收藏该作品（同时移出所有收藏夹）'
                    : '勾选后保存会把作品加入默认收藏列表'
                }
              >
                <span className="favorite-folder-cover">
                  <Star size={24} fill="currentColor" />
                </span>
                <span className="favorite-folder-name">
                  默认收藏列表 <small>{editor.localCount}</small>
                </span>
                <input
                  type="checkbox"
                  aria-label="默认收藏列表"
                  checked={defaultSelected}
                  disabled={busy || needsReload}
                  onChange={(event) => setDefaultSelected(event.target.checked)}
                />
              </label>
            )}
            {filteredFolders.map((folder) => {
              const alreadyAdded = editor.folderIds.includes(folder.id)
              return (
                <FavoriteFolderRow
                  key={folder.id}
                  folder={folder}
                  coverUrl={folderCovers[folder.id]}
                  badge={alreadyAdded ? '已存在' : undefined}
                  hint={alreadyAdded ? '该作品已在此收藏夹中' : undefined}
                  checkboxLabel={folder.title}
                  checked={selected.includes(folder.id)}
                  disabled={busy || needsReload}
                  onToggle={(checked) =>
                    setSelected((ids) =>
                      checked ? [...new Set([...ids, folder.id])] : ids.filter((id) => id !== folder.id)
                    )
                  }
                />
              )
            })}
            {normalizedSearch && !showDefaultFolder && filteredFolders.length === 0 && (
              <p className="favorite-search-empty" role="status">
                没有找到匹配的收藏夹。
              </p>
            )}
          </div>
        )
      )}
      {error && (
        <div className="favorite-error" role="alert">
          {error}
        </div>
      )}
      {visitError && (
        <div className="favorite-error" role="alert">
          {visitError}
        </div>
      )}
      {needsReload && !loading && (
        <div className="favorite-recovery">
          <button disabled={busy} onClick={() => void reload(true)}>
            重新读取
          </button>
          <button disabled={busy} onClick={login}>
            打开抖音登录 / 验证
          </button>
        </div>
      )}
      <button
        className="favorite-save"
        disabled={loading || busy || !editor || needsReload || creating || saveComplete}
        onClick={() => void save()}
      >
        {saveComplete ? (
          '已保存'
        ) : busy ? (
          <>
            <LoaderCircle size={17} className="spin" />
            正在保存…
          </>
        ) : (
          '保存'
        )}
      </button>
    </dialog>
  )
}
