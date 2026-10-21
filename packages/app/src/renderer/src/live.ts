// The terminal session's live model, kept in the store for the Watch panel, follow mode and file heat.
import { useStore } from './store'

/** Subscribes once (App mounts it); returns the unsubscribe. */
export function startLiveFeed(): () => void {
  return window.docent.session.onEvent(e => {
    const s = useStore.getState()
    if (e.type === 'update' && e.live.ptyId === s.session?.ptyId) s.setLive(e.live)
  })
}
