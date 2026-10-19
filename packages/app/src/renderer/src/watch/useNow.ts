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
