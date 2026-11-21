import { useEffect, useRef, type RefObject } from 'react'
import type { PlaybackPreferences } from '../../shared/contracts'
import type { ShortcutAction } from '../../shared/preferences'

export function usePlayerShortcuts(
  shortcuts: PlaybackPreferences['shortcuts'],
  actions: Record<ShortcutAction, () => void>,
  root: RefObject<HTMLElement | null>,
  back: () => void,
  leaveClean?: () => boolean
) {
  const current = useRef(actions)
  const exit = useRef(back)
  current.current = actions
  exit.current = back
  const leave = useRef(leaveClean)
  leave.current = leaveClean
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      // Text entry and dropdowns own the keyboard. Checkboxes and radios do not:
      // arrow keys do nothing there, and the favorite bar focuses a row's checkbox
      // as soon as it is clicked — treating that as "typing" killed every playback
      // shortcut until focus left the bar.
      const editing =
        !!target &&
        (target.isContentEditable ||
          ['TEXTAREA', 'SELECT'].includes(target.tagName) ||
          (target instanceof HTMLInputElement && !['checkbox', 'radio'].includes(target.type)))
      // Space / Enter activate the focused button or toggle its checkbox, so those
      // must stay native instead of firing the shortcut mapped to the same key.
      const activating =
        !!target &&
        ['Space', 'Enter'].includes(event.code) &&
        !!target.closest('button, summary, [type=checkbox], [type=radio]')
      if (
        event.defaultPrevented ||
        root.current?.closest('[inert]') ||
        // Non-modal panels (the persistent favorite bar) leave the player usable.
        document.querySelector('dialog[open]:modal') ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        editing ||
        activating ||
        (target && target.closest('[role=combobox], [role=listbox], [role=menu]'))
      )
        return
      if (event.code === 'Escape') {
        event.preventDefault()
        if (leave.current?.()) return
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
        else exit.current()
        return
      }
      const action =
        event.code === 'PageUp'
          ? 'previous'
          : event.code === 'PageDown'
            ? 'next'
            : (Object.keys(shortcuts) as ShortcutAction[]).find((id) => shortcuts[id] === event.code)
      if (action) {
        event.preventDefault()
        current.current[action]()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [shortcuts, root])
}
