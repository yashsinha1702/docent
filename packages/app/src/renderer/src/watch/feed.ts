import { useEffect } from 'react'

import { useWatchStore } from './store.ts'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Mirrors the main process's Pairwatch relay into the watch store for as long as the panel is mounted. */
export function useWatchFeed(): void {
  useEffect(() => {
    const { upsert, remove, load, setHost, setHostError, setListError } = useWatchStore.getState()
    const api = window.docent.watch
    let alive = true
    // subscribed before the first fetches, so nothing that happens meanwhile is missed
    const off = api.onEvent(e => {
      if (!alive) return
      if (e.type === 'snapshot') upsert({ sid: e.sid, snapshot: e.snapshot, updatedAt: e.updatedAt })
      else if (e.type === 'removed') remove(e.sid)
      else if (e.type === 'host') setHost(e.status)
    })
    // each answer has its own home: a list that cannot be read says nothing about the viewer's status
    api.host().then(status => alive && setHost(status), (err: unknown) => alive && setHostError(message(err)))
    api.sessions().then(list => alive && load(list), (err: unknown) => alive && setListError(message(err)))
    return () => {
      alive = false
      off()
    }
  }, [])
}
