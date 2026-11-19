import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

type Props = {
  enabled: boolean
  thresholdMinutes: number
  onEnabledChange: (enabled: boolean) => void
  onThresholdChange: (minutes: number) => void
}

export function VideoDurationFilter({
  enabled,
  thresholdMinutes,
  onEnabledChange,
  onThresholdChange
}: Props) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(String(thresholdMinutes))
  const parsed = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_440

  useEffect(() => setDraft(String(thresholdMinutes)), [thresholdMinutes])

  useLayoutEffect(() => {
    const node = popup.current
    if (!open || !node) return
    node.showPopover()
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect()
      const width = Math.min(Math.max(rect.width, 286), innerWidth - 16)
      node.style.width = `${width}px`
      const height = node.offsetHeight
      const top =
        rect.bottom + height + 6 <= innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)
      Object.assign(node.style, {
        left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`,
        top: `${top}px`
      })
    }
    position()
    const outside = (event: Event) => {
      if (!node.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        setOpen(false)
    }
    const reposition = (event: Event) => {
      if (!node.contains(event.target as Node)) position()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape)
    document.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', position)
    return () => {
      node.hidePopover()
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', position)
    }
  }, [open])

  const commitDraft = () => {
    if (valid) onThresholdChange(parsed)
    else setDraft(String(thresholdMinutes))
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="select-trigger video-duration-trigger"
        aria-label={enabled ? `视频时长筛选：大于 ${thresholdMinutes} 分钟` : '视频时长筛选：未启用'}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        title={enabled ? `筛选大于 ${thresholdMinutes} 分钟的视频` : '不按视频时长筛选'}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{enabled ? `> ${thresholdMinutes} 分钟` : '视频时长'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          ref={popup}
          id={id}
          popover="manual"
          role="dialog"
          aria-label="视频时长筛选条件"
          className="select-popup video-duration-popup"
        >
          <div className="video-duration-row">
            <input
              className="video-duration-checkbox"
              type="checkbox"
              aria-label="启用视频时长筛选"
              checked={enabled}
              onChange={(event) => {
                commitDraft()
                onEnabledChange(event.currentTarget.checked)
              }}
            />
            <label htmlFor={`${id}-threshold`}>大于</label>
            <input
              id={`${id}-threshold`}
              className="video-duration-input"
              type="number"
              min="0"
              max="1440"
              step="any"
              aria-label="视频时长阈值（分钟）"
              aria-invalid={!valid}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitDraft()
                  if (valid) {
                    onEnabledChange(true)
                    setOpen(false)
                    trigger.current?.focus()
                  }
                }
              }}
            />
            <span>分钟的视频</span>
          </div>
          {!valid && <small className="video-duration-error">请输入 0 到 1440 分钟之间的有效时长。</small>}
        </div>
      )}
    </>
  )
}
