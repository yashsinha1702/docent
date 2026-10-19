// The buttons' rules: which keys stand for them, when a key press may fire, and which are enabled.
import type { Snapshot } from '../../../../../server/src/pairwatch/types'
import type { WatchAction } from '../../../shared/ipc'

export const KEY_ACTIONS: Readonly<Record<string, WatchAction>> = { w: 'why', t: 'tip', k: 'known', p: 'pause' }

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean; isComposing: boolean }

/** The action a bare key press stands for (w t k p); modified, held or composing keys never count. */
export function shortcutAction(e: KeyLike): WatchAction | undefined {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing) return undefined
  return KEY_ACTIONS[e.key]
}

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Shortcuts fire with nothing focused (the body) or with the focus inside the panel, never where typing goes. */
export function mayUseShortcut(active: Element | null, body: Element | null, panel: Element | null): boolean {
  if (active === null || active === body) return true
  if (panel === null || !panel.contains(active)) return false
  const editable = 'isContentEditable' in active && active.isContentEditable === true
  return !TYPING.has(active.tagName) && !editable
}

export type ActionFlags = Readonly<Record<WatchAction, boolean>>

/** Which buttons work: none without a session to send to or once it ended; Why? not while asking; I know this only with a card. */
export function enabledActions(snapshot: Snapshot | undefined, canSend: boolean): ActionFlags {
  const live = canSend && snapshot !== undefined && snapshot.ended !== true ? snapshot : undefined
  return {
    why: live !== undefined && live.isAsking !== true,
    tip: live !== undefined,
    known: live !== undefined && live.hasLesson === true,
    pause: live !== undefined,
    level: live !== undefined,
  }
}
