import type { FormEvent } from 'react'
import { LockKeyhole, X } from 'lucide-react'
import type { FavoriteFolder } from '../../shared/contracts'
import { CoverImage } from './CoverImage'

/**
 * Folder picking is shared by the playback favorite dialog and the batch
 * "add to favorite folders" dialog. Both must show the same search field,
 * create form and rows; only their data source and save semantics differ.
 */
export function FavoriteFolderSearchField({
  value,
  onChange,
  onClose,
  disabled = false
}: {
  value: string
  onChange: (value: string) => void
  onClose: () => void
  disabled?: boolean
}) {
  return (
    <div className="favorite-search-field">
      <input
        type="search"
        aria-label="搜索收藏夹名称"
        placeholder="搜索收藏夹"
        value={value}
        autoFocus
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onChange('')
            onClose()
          }
        }}
      />
      {value && (
        <button type="button" aria-label="清空收藏夹搜索" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}

export function FavoriteFolderCreateForm({
  name,
  onNameChange,
  secret,
  onSecretChange,
  nameLabel,
  submitLabel,
  pendingLabel,
  pending = false,
  disabled = false,
  onSubmit,
  onCancel
}: {
  name: string
  onNameChange: (value: string) => void
  secret: boolean
  onSecretChange: (value: boolean) => void
  nameLabel: string
  submitLabel: string
  pendingLabel?: string
  pending?: boolean
  disabled?: boolean
  onSubmit: (event: FormEvent) => void
  onCancel: () => void
}) {
  const locked = pending || disabled
  return (
    <form className="favorite-create-form" onSubmit={onSubmit}>
      <span className="favorite-create-name">
        <input
          aria-label={nameLabel}
          placeholder="收藏夹名称"
          maxLength={30}
          value={name}
          disabled={locked}
          autoFocus
          onChange={(event) => onNameChange(event.target.value)}
        />
        <button
          type="button"
          className="favorite-cancel-create"
          aria-label="取消新建收藏夹"
          title="取消新建收藏夹"
          disabled={locked}
          onClick={onCancel}
        >
          <X size={16} />
        </button>
      </span>
      <div>
        <label>
          <input
            type="checkbox"
            checked={secret}
            disabled={locked}
            onChange={(event) => onSecretChange(event.target.checked)}
          />
          设为私密
        </label>
        <button type="submit" disabled={locked || !name.trim()}>
          {pending && pendingLabel ? pendingLabel : submitLabel}
        </button>
      </div>
    </form>
  )
}

export function FavoriteFolderRow({
  folder,
  coverUrl,
  badge,
  hint,
  checked,
  disabled = false,
  checkboxLabel,
  className,
  onToggle
}: {
  folder: FavoriteFolder
  coverUrl?: string | null
  badge?: string
  hint?: string
  checked: boolean
  disabled?: boolean
  checkboxLabel: string
  className?: string
  onToggle: (checked: boolean) => void
}) {
  return (
    <label className={`favorite-folder-row${className ? ` ${className}` : ''}`} title={hint}>
      <span className="favorite-folder-cover">
        <CoverImage url={coverUrl ?? folder.coverUrl} size={20} />
      </span>
      <span className="favorite-folder-name" title={folder.title}>
        <span>{folder.title}</span>
        {folder.private && <LockKeyhole size={12} aria-label="私密收藏夹" />}
        {badge && <span className="favorite-folder-badge">{badge}</span>}
        <small>{folder.localOnly ? `仅本机 · ${folder.localCount} 条` : `${folder.localCount} 条`}</small>
      </span>
      <input
        type="checkbox"
        aria-label={checkboxLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onToggle(event.target.checked)}
      />
    </label>
  )
}
