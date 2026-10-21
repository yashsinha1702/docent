import { useEffect, useState } from 'react'

/** The clock, re-read every `every` ms while `enabled` (for "n min ago" lines). */
export function useNow(every: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), every)
    return () => window.clearInterval(timer)
  }, [every, enabled])
  return now
}

/** When `key` was first seen (ms since epoch), for as long as it stays the same; undefined without a key, and on the render that brings a new one. */
export function useSince(key: string | undefined): number | undefined {
  const [since, setSince] = useState<{ key: string; at: number }>()
  useEffect(() => {
    if (key !== undefined) setSince(s => (s?.key === key ? s : { key, at: Date.now() }))
  }, [key])
  return since !== undefined && since.key === key ? since.at : undefined
}
