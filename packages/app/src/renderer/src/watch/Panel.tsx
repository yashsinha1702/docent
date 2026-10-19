import { useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'

import type { Snapshot } from '../../../../../server/src/pairwatch/types'
import type { WatchHostStatus } from '../../../shared/ipc'
import { useStore } from '../store'
import { Boundary } from './Boundary'
import { Controls } from './Controls'
import { Stage } from './Stage'
import { chooseSession, pickerSessions } from './choose.ts'
import { useWatchFeed } from './feed.ts'
import { asText, levelOf, narrationLabel, narratorName, sessionLabel, staleText, stationColor } from './format.ts'
import { renderMarkdown } from './markdown.ts'
import { useWatchStore } from './store.ts'
import { useNow } from './useNow.ts'
import './watch.css'

/** The README's check for why a mod did not load, run after a `claude --debug` session. */
const DEBUG_GREP = 'grep "hooks modules" "$(ls -t ~/.claude/debug/*.txt | head -n 1)"'

function hostText(host: WatchHostStatus | undefined, error: string | undefined): string {
  if (error !== undefined) return 'status unavailable'
  if (host === undefined) return 'checking…'
  if (host.mode === 'host') return `hosting the viewer on :${host.port}`
  if (host.mode === 'bridge') return `following the viewer on :${host.port}`
  return 'not running'
}

/** Why the mod may not load in the terminal at all: the README's two known causes and its grep. */
function Diagnostic() {
  return (
    <>
      <ul>
        <li>
          <strong>Workspace trust.</strong> Claude Code loads no mod until this folder is trusted: accept the trust prompt in the terminal.
        </li>
        <li>
          <strong>The rollout flag.</strong> Some builds still check a server-side flag before they run an installed mod’s hooks; <code>/pairwatch</code> is then an unknown command.
        </li>
      </ul>
      <p>
        To tell them apart, start <code>claude --debug</code>, try <code>/pairwatch</code>, quit, then grep the newest debug log:
      </p>
      <code className="watch-cmd">{DEBUG_GREP}</code>
      <p className="muted">“not loaded until workspace trust is accepted” means trust the folder first; “rollout flag (…) is off” means this build does not run installed mods for you yet.</p>
    </>
  )
}

function NotRunning({ host }: { host: WatchHostStatus }) {
  // port 0 is main's stand-in when the host never started, so no port is named then
  const where = host.port > 0 ? `No viewer answers on port ${host.port}` : 'No Pairwatch viewer is reachable'
  return (
    <div className="watch-card watch-diag">
      <strong>Pairwatch is not running</strong>
      {host.note !== undefined && host.note !== '' && <p className="muted">{host.note}</p>}
      <p>
        {where}: Docent is not hosting one and found none to follow, so the mod has nowhere to write and nothing arrives here. If <code>/pairwatch</code> is also unknown in the terminal,
        the mod itself did not load:
      </p>
      <Diagnostic />
    </div>
  )
}

function Waiting({ awaiting }: { awaiting: boolean }) {
  return (
    <div className="watch-card watch-waiting">
      <strong>{awaiting ? 'Waiting for Pairwatch in this session…' : 'No Pairwatch session yet'}</strong>
      <p className="muted">
        The mod writes its first snapshot once this folder is trusted in Claude Code and the first prompt is sent. <code>/pairwatch status</code> in the terminal shows what it sees.
      </p>
      <details className="watch-diag">
        <summary className="muted">Nothing arriving? Check that the mod loads</summary>
        <Diagnostic />
      </details>
    </div>
  )
}

/** A snapshot, top to bottom: the stage, the now-line, the Why? answer, the card, goal and recent, the note. */
function Live({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  // the mod's Markdown becomes HTML through the renderer above; `note` is plain text and stays text
  const html = useMemo(
    () => ({
      head: renderMarkdown(snapshot.head),
      ask: renderMarkdown(snapshot.ask),
      lesson: renderMarkdown(snapshot.lesson),
      context: renderMarkdown(snapshot.goal) + renderMarkdown(snapshot.recent),
    }),
    [snapshot],
  )
  const svg = asText(snapshot.svg)
  const note = asText(snapshot.note)
  const stale = snapshot.ended === true ? undefined : staleText(snapshot.at, now)
  return (
    <>
      {svg !== '' && <Stage svg={svg} alt={asText(snapshot.alt)} />}
      <div className="watch-card watch-now" dangerouslySetInnerHTML={{ __html: html.head }} />
      {html.ask !== '' && <div className={`watch-card watch-ask${snapshot.isAsking === true ? ' asking' : ''}`} dangerouslySetInnerHTML={{ __html: html.ask }} />}
      {html.lesson !== '' && <div className="watch-card watch-lesson" dangerouslySetInnerHTML={{ __html: html.lesson }} />}
      {html.context !== '' && <div className="watch-context muted" dangerouslySetInnerHTML={{ __html: html.context }} />}
      {note !== '' && <div className="watch-note muted">{note}</div>}
      {stale !== undefined && <div className="watch-stale muted">{stale}</div>}
    </>
  )
}

const couldNotDraw = (message: string) => (
  <div className="watch-card watch-diag">
    <strong>This snapshot could not be drawn</strong>
    <p className="muted">{message}</p>
  </div>
)

function Footer({ snapshot }: { snapshot: Snapshot }) {
  const level = levelOf(snapshot.level)
  return <div className="watch-footer muted">{`${narratorName(snapshot.narrator)} · ${narrationLabel(snapshot.narrationSource)} · level ${level.value} (${level.name})`}</div>
}

export function WatchPanel() {
  useWatchFeed()
  const sessions = useWatchStore(s => s.sessions)
  const host = useWatchStore(s => s.host)
  const hostError = useWatchStore(s => s.hostError)
  const listError = useWatchStore(s => s.listError)
  const picked = useWatchStore(s => s.picked)
  const pick = useWatchStore(s => s.pick)
  const terminal = useStore(s => s.session)
  const panel = useRef<HTMLDivElement>(null)
  const choice = useMemo(() => chooseSession(sessions, terminal, picked), [sessions, terminal, picked])
  const list = useMemo(() => pickerSessions(sessions, choice.sid), [sessions, choice.sid])
  const snapshot = choice.session?.snapshot
  const now = useNow(15_000, snapshot !== undefined && snapshot.ended !== true)
  const down = host?.mode === 'down'
  const pickerValue = picked !== undefined && sessions.has(picked) ? picked : ''
  // a choice is offered once there is a session other than the one on show
  const showPicker = pickerValue !== '' || list.some(s => s.sid !== choice.sid)
  const style = { '--st': stationColor(snapshot?.station) } as CSSProperties

  return (
    <div ref={panel} className="watch-inner watch-panel" style={style}>
      <div className="watch-head">
        <span className="watch-title">Watch</span>
        <span className="watch-status" title={hostError ?? host?.note}>
          {hostText(host, hostError)}
        </span>
        {snapshot?.ended === true && <span className="watch-badge">ended</span>}
      </div>
      {listError !== undefined && (
        <div className="watch-problem muted" title={listError}>
          the session list could not be read; new snapshots still arrive
        </div>
      )}
      {showPicker && (
        <select
          className="watch-picker"
          value={pickerValue}
          title="Session"
          onChange={e => {
            pick(e.target.value === '' ? undefined : e.target.value)
            e.target.blur() // the keys w, t, k and p work again
          }}
        >
          <option value="">{terminal !== undefined ? 'This terminal’s session' : 'Newest session'}</option>
          {list.map(s => (
            <option key={s.sid} value={s.sid}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
      )}
      {host?.mode === 'down' && <NotRunning host={host} />}
      {snapshot !== undefined ? (
        <Boundary resetOn={snapshot} fallback={couldNotDraw}>
          <Live snapshot={snapshot} now={now} />
        </Boundary>
      ) : (
        !down && <Waiting awaiting={choice.awaiting} />
      )}
      <Controls sid={choice.sid} snapshot={snapshot} canSend={!down} panel={panel} />
      {snapshot !== undefined && <Footer snapshot={snapshot} />}
    </div>
  )
}
