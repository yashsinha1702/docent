import { useCallback, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'

import { timeline } from '@docent/core'
import type { Level } from '@docent/core'

import type { Snapshot } from '../../../../../server/src/pairwatch/types'
import type { WatchHostStatus } from '../../../shared/ipc'
import { useStore } from '../store'
import { Boundary } from './Boundary'
import { Controls } from './Controls'
import type { LocalControls } from './Controls'
import { FromTranscript } from './FromTranscript'
import { Stage } from './Stage'
import { Steps } from './Steps'
import { ThisTurn } from './ThisTurn'
import { choosePanelView, pickerSessions, transcriptSource } from './choose.ts'
import type { TranscriptSource } from './choose.ts'
import { anotherCard } from './transcript.ts'
import { useWatchFeed } from './feed.ts'
import { asText, levelOf, narrationLabel, narratorName, sessionLabel, staleText, stationColor } from './format.ts'
import { renderMarkdown } from './markdown.ts'
import { useWatchStore } from './store.ts'
import { useNow, useSince } from './useNow.ts'
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

/**
 * Says where the panel's picture comes from when it is not the mod's: the transcript while the mod's first
 * snapshot is awaited (the live model often lands first), else because the mod is not running, and why.
 */
function FromTranscriptNote({ host, source }: { host?: WatchHostStatus; source: TranscriptSource }) {
  if (source === 'waiting') {
    return (
      <div className="watch-source">
        <div>
          <strong>From the transcript:</strong> waiting for the Pairwatch mod; drawn from the transcript meanwhile.
        </div>
        <p className="muted">The mod writes its first snapshot soon after the first prompt. Until it arrives, the stage, the narration and the card are drawn here from Claude Code’s transcript, with rules narration in place of Haiku’s.</p>
        <details className="watch-diag">
          <summary className="muted">Nothing arriving? Check that the mod loads</summary>
          <Diagnostic />
        </details>
      </div>
    )
  }
  const why =
    host?.mode === 'down'
      ? host.port > 0
        ? `No Pairwatch viewer answers on port ${host.port}, so the mod has nowhere to write.`
        : 'No Pairwatch viewer is reachable, so the mod has nowhere to write.'
      : 'No snapshot from the mod has arrived for this session.'
  return (
    <div className="watch-source">
      <div>
        <strong>From the transcript:</strong> the Pairwatch mod is not running in this session.
      </div>
      <p className="muted">{why} The stage, the narration and the card are drawn here from Claude Code’s transcript, with rules narration in place of Haiku’s.</p>
      {host?.mode === 'down' && host.note !== undefined && host.note !== '' && <p className="muted">{host.note}</p>}
      <details className="watch-diag">
        <summary className="muted">Why is the mod not running? Check that it loads</summary>
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

const cannotDraw = (what: string) => (message: string) => (
  <div className="watch-card watch-diag">
    <strong>{what} could not be drawn</strong>
    <p className="muted">{message}</p>
  </div>
)
const couldNotDraw = cannotDraw('This snapshot')
const couldNotDrawLive = cannotDraw('The transcript view')
const couldNotDrawSteps = cannotDraw('The steps')
const couldNotDrawTurn = cannotDraw('This turn')

function Footer({ snapshot }: { snapshot: Snapshot }) {
  const level = levelOf(snapshot.level)
  return <div className="watch-footer muted">{`${narratorName(snapshot.narrator)} · ${narrationLabel(snapshot.narrationSource)} · level ${level.value} (${level.name})`}</div>
}

function LocalFooter({ level }: { level: Level }) {
  const l = levelOf(level)
  return <div className="watch-footer muted">{`from the transcript · rules narration · level ${l.value} (${l.name})`}</div>
}

export function WatchPanel() {
  useWatchFeed()
  const sessions = useWatchStore(s => s.sessions)
  const host = useWatchStore(s => s.host)
  const hostError = useWatchStore(s => s.hostError)
  const listError = useWatchStore(s => s.listError)
  const picked = useWatchStore(s => s.picked)
  const pick = useWatchStore(s => s.pick)
  const level = useWatchStore(s => s.level)
  const setLevel = useWatchStore(s => s.setLevel)
  const terminal = useStore(s => s.session)
  const live = useStore(s => s.live)
  const root = useStore(s => s.workspace?.root)
  const panel = useRef<HTMLDivElement>(null)
  const view = useMemo(() => choosePanelView(sessions, terminal, picked, live), [sessions, terminal, picked, live])
  const list = useMemo(() => pickerSessions(sessions, view.sid), [sessions, view.sid])
  const snapshot = view.kind === 'snapshot' ? view.session.snapshot : undefined
  /** the live model under the stage: the steps strip and the stats */
  const below = view.kind === 'none' ? undefined : view.live
  const isRunning = below?.model.turn?.isRunning === true
  const tick = useNow(isRunning ? 5_000 : 15_000, (snapshot !== undefined && snapshot.ended !== true) || below !== undefined)
  // an update is never drawn as older than it is, whatever the last tick said
  const now = Math.max(tick, below?.at ?? 0)
  const down = host?.mode === 'down'
  const pickerValue = picked !== undefined && sessions.has(picked) ? picked : ''
  // a choice is offered once there is a session other than the one on show
  const showPicker = pickerValue !== '' || list.some(s => s.sid !== view.sid)
  const station = snapshot !== undefined ? snapshot.station : view.kind === 'live' ? timeline.currentActivity(view.live.model)?.station : undefined
  const style = { '--st': stationColor(station) } as CSSProperties
  const ended = snapshot?.ended === true || (view.kind === 'live' && terminal?.ended === true)
  // how long the panel has drawn this session from the transcript without a snapshot arriving
  const drawingSince = useSince(view.kind === 'live' ? view.sid : undefined)
  const source = transcriptSource(host, ended, drawingSince === undefined ? undefined : now - drawingSince)

  const fromLive = view.kind === 'live' ? view.live : undefined
  const anotherTip = useCallback(() => {
    if (fromLive === undefined) return
    const st = useWatchStore.getState()
    const card = st.card?.sid === fromLive.sid ? st.card : { sid: fromLive.sid }
    const at = Date.now()
    const next = anotherCard(card, fromLive.model, { level: st.level, seen: st.seen, recent: st.recent, now: at })
    if (next !== undefined) st.putCard(next, at)
  }, [fromLive])
  const local = useMemo<LocalControls | undefined>(() => (fromLive === undefined ? undefined : { level, setLevel, anotherTip }), [fromLive, level, setLevel, anotherTip])

  return (
    <div ref={panel} className="watch-inner watch-panel" style={style}>
      <div className="watch-head">
        <span className="watch-title">Watch</span>
        <span className="watch-status" title={hostError ?? host?.note}>
          {hostText(host, hostError)}
        </span>
        {ended && <span className="watch-badge">ended</span>}
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
      {view.kind === 'live' ? <FromTranscriptNote host={host} source={source} /> : down && host !== undefined && <NotRunning host={host} />}
      {view.kind === 'snapshot' ? (
        <Boundary resetOn={view.session.snapshot} fallback={couldNotDraw}>
          <Live snapshot={view.session.snapshot} now={now} />
        </Boundary>
      ) : view.kind === 'live' ? (
        <Boundary resetOn={view.live} fallback={couldNotDrawLive}>
          <FromTranscript live={view.live} root={root} now={now} />
        </Boundary>
      ) : (
        !down && <Waiting awaiting={view.awaiting} />
      )}
      <Controls sid={view.sid} snapshot={snapshot} canSend={!down} panel={panel} local={local} />
      {below !== undefined && (
        // apart, so that one that cannot be drawn leaves the other
        <>
          <Boundary resetOn={below} fallback={couldNotDrawSteps}>
            <Steps live={below} root={root} now={now} />
          </Boundary>
          <Boundary resetOn={below} fallback={couldNotDrawTurn}>
            <ThisTurn live={below} now={now} />
          </Boundary>
        </>
      )}
      {snapshot !== undefined ? <Footer snapshot={snapshot} /> : view.kind === 'live' && <LocalFooter level={level} />}
    </div>
  )
}
