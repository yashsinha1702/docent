# Docent: MVP plan (v0.1)

Working name **Docent** (decision D1). This file is written to be dropped into the new repository as `docs/PLAN.md`.

Ground truth: the three research reports (`01-pairwatch-internals.md`, `02-claude-code-integration.md`, `03-landscape.md`), the four designs and the two judge reports in `_ide-design/`. The winner is `design-differentiation.md` (Docent); this plan is that design with the judges' grafts applied: Understudy's integration discipline (the mod stays the single source of truth for narration and learning state), Glassbox's two-week shell, security rules and tests, and Switchyard's cost meter, status merge and resume button. Line numbers cite `/Users/yashsinha/Desktop/github/pairwatch/pairwatch/...` (`register.tsx` = `hooks/register.tsx`, `server.mjs` = `viewer/server.mjs`) as read on 2026-10-18. "unknown" means not verified; every unknown the plan depends on is in the assumptions register (§8).

Facts checked while writing this plan (read-only, no model calls): Claude Code is `2.1.302`; its `--help` lists `--session-id <uuid>`, `--fork-session`, `--ide`, `--include-partial-messages` and `--plugin-dir <path>` ("for this session only"). The newest local transcript (`~/.claude/projects/-Users-yashsinha/<sid>.jsonl`) has 11 `"offset":`, 13 `"limit":`, 13 `"old_string":`, 9 `file-history-delta` and 311 `usage` occurrences. `~/.claude/file-history/<sid>/` holds files named `<hash>@v<n>` that `file` reports as plain ASCII text; one delta row carries `"backupFileName": null` with `version: 1`, so the mapping is not one-to-one. `~/.claude/plugins/store/` is empty on this machine (Pairwatch is not installed here). `~/.claude/projects/` directory names encode the cwd with `/` replaced by `-` (`-Users-yashsinha`, `-Users-yashsinha-Desktop-learning`).

---

## 1. Name shortlist and one-liner

None of these is checked against npm, GitHub or a trademark register (unknown). Day-0 check: `npm view <name> version --registry https://registry.npmjs.org/` and `gh repo view yashsinha1702/<name>`. If the bare npm name is taken, use `<name>-ide`. Avoid "pairwatch" itself so the mod keeps its identity as a plugin.

| Name | Vibe |
| --- | --- |
| **Docent** (recommended) | The museum guide who explains the exhibit while you look at it. `npx docent`, `docent replay`, `docent ssh gpu`. |
| **Understudy** | You learn the part by watching the lead perform it, every night. |
| **Kibitz** | The commentator at the chessboard who explains every move as it is played. |
| **Glassbox** | The opposite of a black-box agent: you see through it while it works. |
| **Footnote** | Every step the agent takes gets a footnote: what, why, and the idea behind it. |

**One-liner:** *Docent is an open IDE that narrates your coding agent: watch it work in the editor, scrub any session back, and share a redacted recap. It runs the real Claude Code CLI with Pairwatch built in, on your laptop or on a remote box through one SSH tunnel.*

---

## 2. Thesis, target user, scenario, demo

### Thesis

Every shipping product (Cursor, Windsurf/Devin, Zed, VS Code Copilot, Claude Code's extension and Desktop app, Theia AI, Cline, Conductor, Warp Oz) shows the same raw surfaces: tool rows, a diff pane, checkpoints, a sessions list with status words, lately subagent trees. None shows *why* a step happens or teaches the person watching (03 §1-2). A plugin cannot own the editor; an IDE can. Docent's two wedges are the two items of that gap that no product has:

1. **Follow mode: the editor is the stage.** While Claude works, the editor opens the file being read and washes the exact lines; the hunk Claude is about to make arrives with the step's one-line "why" and the concept card in the review bar; the file tree warms with read/edit heat.
2. **Replay and the recap: a session is a document.** Any Claude Code session, live or past, local or on the GPU box, can be scrubbed step by step with the narration, the card and the file as it was; one click exports a single redacted, offline HTML recap. Zero model calls, so it demos from day one and gives the repo an artifact strangers can click.

Both wedges are one pipeline: `events -> core/timeline.reduce -> SessionModel -> editor decorations | frames`. Live and replay differ only in where events come from. The pipeline is already proven by `dev/eval-corpus.ts` and `dev/spec/integration.spec.ts` `play()` (lines 52-70: 400 ms batches through `reduce` then `settleHop`).

Pairwatch is the engine, not an overlay: Haiku narration, the Why? fork, lesson choice and the learning state come from the mod on the user's own auth; Docent never holds a model key and never re-implements lesson selection or learning persistence (judge grafts G1, G2).

Position (03 §2): the first open IDE whose primary surface is an explanation of the agent. Do not compete with Anthropic's Desktop app on session plumbing (no worktree-per-session, no PR lane, no permission queue in v0.x).

### Target user

An engineer who runs Claude Code several times a day, often on a remote machine, who wants to (a) understand what happened without reading a transcript, (b) learn the idioms the agent uses, and (c) show a session to someone else. User #1 is the owner (laptop + GPU server). Secondary: students and early-career engineers who feel the "the tests pass and I cannot explain why" gap; people evaluating agents who want a legible demo; hiring managers reading the repo.

### The 10-step MVP scenario (local laptop, a TypeScript repo)

1. `cd ~/work/api && npx docent` prints `http://127.0.0.1:4747/?key=...` and opens it in under 10 s. Layout: file tree (left), editor (centre), terminal (bottom) already running `claude` (spawned by Docent with `--session-id <uuid>`, the IDE env, and `--plugin-dir` for the bundled Pairwatch unless the user has it installed), the **Watch** panel (right). The `claude` status line shows the IDE as connected (our lock file + ws MCP server + `CLAUDE_CODE_SSE_PORT`, 02 §1.7). The Watch panel says "Pairwatch live" or, honestly, "Pairwatch is not running in this session" with the README's `claude --debug` grep (README 31-39).
2. The user types in the terminal: `add retries with backoff to fetchJson in src/http.ts and cover it in tests`. Shift+Enter inserts a newline (we send CSI-u `\x1b[13;2u`, 02 §4.3). The goal line appears in the Watch panel.
3. Claude reads `src/http.ts`. The stage hops to **Read**, the narration reads "Reading src/http.ts to see how fetchJson handles errors before changing it" (Haiku, from the mod, because Docent counts as a watcher), the card **Read before edit** appears. The editor opens `src/http.ts` and washes lines 12-48 (`Read.input.offset/limit` from the transcript tail). The tree shows a warm dot beside `src/http.ts`.
4. Claude greps for callers. Stage hops to **Search**; the Steps strip under the stage gains `Grep fetchJson( · 6 matches`; clicking a match opens that file at the line. The editor stays put.
5. Claude edits. The CLI calls our `openDiff`; Docent opens a diff tab (`@codemirror/merge`) titled with the current narration's why ("Adds a bounded retry loop so transient 5xx responses are retried") with the card **Exponential backoff** pinned beside the hunk. Accept returns `FILE_SAVED`; the editor shows the saved file.
6. Claude runs `npm test`. The stage types the command; after 15 s the card deepens (depth 1, `lessons.ts depthFor`), after 35 s again. The user presses **Why?** (key `w`); the answer, from the mod's `$.model.fork` (register.tsx:1612), arrives in the Ask block.
7. The turn ends. The **This turn** strip reads `7 steps · 2 files · 1 command · 0 errors · 1m 40s · 38k in / 2.1k out tokens`. Clicking any step re-opens its file and range.
8. The user drags the **scrubber** back to step 5. The editor shows `src/http.ts` as it was before the edit (from `~/.claude/file-history/<sid>/` when the backup exists, else reverse-applied from `old_string/new_string` with an "approximate" badge), the diff view shows that hunk, narration and card are the ones from that moment. Space plays forward at 4x.
9. The user clicks **Recap**. Docent writes `docent-recap-<sid>.html` (one file, secrets masked by `core/redact.ts`, no server needed). Opened in any browser it shows the narrated timeline, hunks, concepts met, files changed, cost, with the same scrubber.
10. Next morning, on the GPU box: `ssh -L 4747:127.0.0.1:4747 gpu 'npx docent --no-open'` and the same page in the laptop browser lists last night's remote sessions on the **Wall**, each with one sentence and a status; **Resume** spawns `claude --resume <sid>` in its cwd; steps 7-9 work unchanged.

Demo discipline: at the week-2 alpha, Glassbox's rule applies (the IDE connects, the panel wakes, `openDiff` opens, Accept writes: if any fails, the alpha is not done). At v0.1, Docent's rule applies: if step 3 (live wash), step 8 (scrub) or step 9 (recap) is not smooth on the laptop *and* over SSH, v0.1 is not done. Steps 5 and 6 touch a private protocol and quota-costing paths and are allowed to be rough.

### The 90-second demo script (the README GIF and the Show HN video)

| Time | Shot | Narration (captions) |
| --- | --- | --- |
| 0-12 s | Terminal: `npx docent` → browser opens; the embedded `claude` status line shows "IDE: Docent" | "One command. The real Claude Code, in a real terminal, with an IDE around it." |
| 12-35 s | Type the prompt; the editor jumps to `src/http.ts`, lines wash blue; the stage hops to Read; the narration and the card appear | "Docent narrates every step and shows you the exact lines Claude is reading." |
| 35-55 s | `openDiff` tab opens with the why in the title bar and the card pinned beside the hunk; click Accept | "Every edit arrives with the reason and the idea behind it." |
| 55-75 s | Drag the scrubber back; the hunk vanishes, the file reverts, narration changes; press space to play forward | "Scrub any session back, live or from last week, on your laptop or your GPU box." |
| 75-90 s | Click Recap; open the HTML in a fresh browser window; scrub it there | "Export a redacted recap that works offline. Share it in a PR." |

Second act insurance: 55-90 s can be recorded from an existing transcript under `~/.claude/projects` with zero model calls, so a flaky live session cannot kill the video (judge-product §2).

---

## 3. Stack and base

**Base: (c) browser UI served by a local Node server** (03 §3 ranking; all four designs and both judges agree). Why, for this owner and machine: no Rust (rules out Tauri), no Electron download or node-pty ABI rebuilds (~1 GB per target; ~16 GB free), no VS Code/Theia multi-GB builds; TypeScript/React is the day job; the server runs *where `claude` runs*, so the remote GPU box is the same product behind one `ssh -L` (Pairwatch's own README 80-83 pattern, code-server's shape). An Electron shell can wrap the same page later (03 §3a).

**Editor: CodeMirror 6** (03 §3f). The editor's jobs are decorations ("the lines Claude just read"), a review bar with a card pinned to a hunk, and diffs (`@codemirror/merge`). LSP is a non-goal for v0.x. The editor sits behind one interface (`packages/web/src/editor/api.ts`) so Monaco remains possible.

**Node:** develop on **Node 22** (`nvm install 22`; needed anyway for `pairwatch/dev/check.sh`, whose `dev/package.json` pins `engines.node >= 22.18`, and Node ≥ 22.18 runs `hooks/core/*.ts` directly through type stripping: the judge confirmed `hooks/core` has no TS-only runtime syntax). Publish an esbuild bundle so the **runtime floor for users is Node 20** (the GPU box's Node version is unknown). Node 18 is EOL; not targeted. `tsc` is used with `noEmit` only: TypeScript 5.6 cannot emit from `.ts`-extension imports (judge-engineer §5), so all emit goes through esbuild (server, recap) and Vite (web).

**Tests:** `node --test` on Node 22 (the same convention as `pairwatch/dev/spec/*.spec.ts`; one habit for both repos). No vitest.

**Packages** (versions I am confident existed before June 2026; the owner's npm points at a work Nexus that did not answer, so pin each after `npm view <pkg> version --registry https://registry.npmjs.org/` on day 0; assumption A16):

| Area | Package | Version | Note |
| --- | --- | --- | --- |
| PTY | `node-pty` | 1.0.0 | native addon; builds with node-gyp (python3 + Xcode CLT present here; `build-essential` + python3 needed on the GPU box). No prebuilt binary assumed (judge-engineer §0) |
| Terminal | `@xterm/xterm` | 5.5.0 | |
| | `@xterm/addon-fit` | 0.10.0 | |
| | `@xterm/addon-web-links` | 0.11.0 | |
| | `@xterm/addon-unicode11` | 0.8.0 | box drawing, wide glyphs |
| | `@xterm/addon-clipboard` | 0.1.0 | OSC 52 |
| | `@xterm/addon-webgl` | 0.18.0 | optional, off by default (02 §4.3 GPU glitches); canvas/DOM renderer is the default |
| WebSocket | `ws` | 8.18.0 | app channel and the IDE-protocol server |
| Editor | `codemirror` | 6.0.1 | meta-package |
| | `@codemirror/state` / `@codemirror/view` | 6.4.1 / 6.34.1 | |
| | `@codemirror/merge` | 6.7.4 | diff tab, replay hunks |
| | `@codemirror/language-data` | 6.5.1 | lazy language packs |
| | `@codemirror/lang-javascript`, `@codemirror/lang-python` | 6.2.2, 6.1.6 | eager for the two common cases |
| UI | `react`, `react-dom` | 18.3.1 | |
| | `zustand` | 4.5.5 | one store |
| Build | `vite`, `@vitejs/plugin-react` | 5.4.11, 4.3.4 | web + recap bundles |
| | `esbuild` | 0.24.0 | server bundle |
| | `typescript` | 5.6.3 | matches `pairwatch/dev/package.json`; `noEmit` |
| Server | `chokidar` | 3.6.0 | `~/.claude/projects/**`, `~/.claude/pairwatch/live/`, workspace |
| | `diff` | 7.0.0 | unified diffs for the recap and untracked files |
| | `commander` | 12.1.0 | CLI |
| | `open` | 10.1.0 | open the browser |
| Dev only | `playwright` | 1.48.0 | GIF/screenshots; **not** in the default install (disk) |

Deliberately not used in MVP: `@modelcontextprotocol/sdk` (the IDE side is five JSON-RPC methods; hand-roll ~150 lines over `ws`, answer unknown methods with `-32601`; add the SDK later only if schema drift bites), `@anthropic-ai/claude-agent-sdk` (phase 2; version unknown), `ssh2` (use the system `ssh`), Monaco, Tailwind, Electron.

**Licensing:** everything above is MIT; Pairwatch is MIT; Docent is MIT (D3). Claude Code is proprietary and is spawned from the user's own install; Docent ships none of its bytes. No marketplace or Open VSX is involved because there is no extension host.

**Repo layout** (npm workspaces; npm 8 supports them). Pairwatch lives as a **git submodule pinned to a tag**, read-only in this repo; mod changes are PRs to `yashsinha1702/pairwatch`, then the submodule is bumped. Not an npm dependency yet (`@pairwatch/core` does not exist; it is a v2 mod change), not a vendored copy with a sync script (drift). The published npm package carries a build-time copy of `vendor/pairwatch/pairwatch` (the plugin directory with `.claude-plugin/plugin.json`) at `dist/pairwatch/` so `npx docent` can pass `--plugin-dir` when the user has not installed the mod. The mod keeps working standalone (pane + page) regardless of Docent.

```
docent/
  .npmrc                       registry=https://registry.npmjs.org/   (first commit; the owner's npm points at a work Nexus)
  .nvmrc                       22
  package.json                 workspaces: packages/*; scripts: dev | build | check | test | release
  tsconfig.base.json           es2023, module esnext, moduleResolution bundler, strict, noUncheckedIndexedAccess,
                               allowImportingTsExtensions, noEmit   (matches pairwatch/dev/check.sh:176-181)
  vendor/pairwatch/            git submodule -> github.com/yashsinha1702/pairwatch, pinned to a tag (read-only here)
  packages/core/               shim: index.ts re-exports vendor/pairwatch/pairwatch/hooks/core/*.ts;
                               claude-code-shim.d.ts declares the ambient 'claude-code' module so types/index.d.ts:247-257 compiles
  packages/server/src/
    cli.ts                     docent [dir] | --port 4747 | --no-open | replay <sid|file> | recap <sid> [--out] | ssh <host> (SHOULD)
    http.ts                    static SPA, /api/*, token + Host/Origin checks (copied from server.mjs:499-501), 127.0.0.1 only
    rt.ts                      one ws per page: terminal bytes, state events, editor commands; Origin checked on upgrade
    pty/manager.ts             node-pty sessions; env builder (CLAUDE_CODE_SSE_PORT, TERM_PROGRAM=docent, COLORTERM, PAIRWATCH_HOST);
                               chunked drain-aware writes; graceful close (Ctrl-C, Ctrl-D, SIGTERM after 5 s)
    pty/osc.ts                 OSC 0/2 title, 7501 program status, 9/777 notifications, bell -> status events
    ide/lock.ts                ~/.claude/ide/<port>.lock (0600 in 0700 dir), honours CLAUDE_CONFIG_DIR; deleted on exit
    ide/mcp.ts                 JSON-RPC 2.0 over ws: initialize, tools/list, tools/call, ping, notifications/initialized; -32601 otherwise
    ide/tools.ts               the 12 tools; openDiff awaits a promise the page resolves; getDiagnostics -> []; executeCode -> error
    ide/session.ts             one lock + one ws server + one CLAUDE_CODE_SSE_PORT per pty (several sessions connected at once)
    pairwatch/host.ts          viewer-compatible 7979 server (host mode): /health, /api/sessions, /api/state, /api/events, /api/action,
                               /api/inbox (watching = pages showing sid), /api/quit (stops this listener only), serves pairwatch's index.html
    pairwatch/bridge.ts        bridge mode when a healthy viewer already answers /health: one SSE /api/events?sid= per on-screen sid, /api/action proxy
    pairwatch/snapshots.ts     parse live/<sid>.json (tolerate half-written files), overlay events to pages; v2 fields when present
    sessions/transcripts.ts    locate ~/.claude/projects/*/<sid>.jsonl (+ <sid>/subagents/agent-*.jsonl) by glob, tail by byte offset, half-line safe
    sessions/live.ts           rows -> core/replay.ts (RawEvent[]) -> reduce + settleHop on a 400 ms timer -> SessionModel per sid (diffed by rev);
                               rulesNarration; inputs side-map (Read offset/limit, Edit old/new) keyed by tool_use id
    sessions/cost.ts           message.usage + message.model per assistant row; config/prices.json (hand-filled; tokens only when unknown)
    sessions/status.ts         merge OSC 7501 + snapshot station==='ask' + transcript -> starting|working|needs-you|idle|done|gone
    replay/frames.ts           events -> keyframes every N events; seek = nearest keyframe + re-reduce; per-frame narration (rules) + lesson id
    replay/fileState.ts        text of a path at frame N: file-history backups (file-history-delta rows) -> Read results -> reverse-apply fallback
    recap/export.ts            single HTML: inlined redacted RawEvent[] + inputs side-map + the recap bundle; redactSecrets over every string
    workspace/fs.ts            tree, read, write, watch; realpath jail under the workspace root
  packages/web/src/
    main.tsx, App.tsx, store.ts (zustand), rt.ts (ws client, reconnect)
    editor/{api.ts, Editor.tsx, follow.ts, DiffTab.tsx, reviewBar.tsx}
    terminal/Terminal.tsx      xterm + addons; Shift+Enter CSI-u; macOptionIsMeta; bracketed paste; Shift-drag selection
    watch/{Panel.tsx, Stage.tsx, Narration.tsx, Card.tsx, Steps.tsx, ThisTurn.tsx, Scrubber.tsx, Ask.tsx}
    tree/{Tree.tsx, heat.ts}
    wall/Wall.tsx
    md.ts                      port of viewer/index.html:126-167 mini-Markdown (same subset the mod writes)
  packages/recap/src/          read-only bundle (Scrubber + Stage + Narration + Steps + hunks) built as an IIFE and inlined into the recap
  config/prices.json           model id -> {input, cacheWrite, cacheRead, output} per MTok; hand-filled; empty by default
  test/                        node --test specs; test/corpus/ = 3 of the owner's transcripts, redacted and reviewed before commit
  docs/PLAN.md (this file), docs/spikes.md (every spike result, kept as portfolio material), docs/privacy.md
  .github/workflows/check.yml  Node 20 + 22: tsc --noEmit, node --test, build, handshake smoke (claude --version only when present)
```

**Commands:**

```sh
nvm install 22 && nvm use 22
git clone --recurse-submodules git@github.com:yashsinha1702/docent && cd docent
npm install                        # node-pty compiles (python3 + Xcode CLT / build-essential)
npm run dev                        # node --watch packages/server/src/cli.ts (Node 22 type stripping) + vite dev server, page on :4747
npm run check                      # tsc --noEmit (server, web, core shim) && node --test test/*.spec.ts
npm run build                      # esbuild -> packages/server/dist/{cli.js,server.mjs}; vite -> dist/web, dist/recap; copy vendor/pairwatch/pairwatch -> dist/pairwatch
node packages/server/dist/cli.js   # == npx docent after `npm publish --provenance` from GitHub Actions
```

---

## 4. Architecture

### Processes (identical on the laptop and on the GPU box; the browser is wherever the person is)

```
browser (React SPA)  ──ws /rt?key=… (Origin checked)──┐
                                                       ▼
                  docent server  (Node, 127.0.0.1:4747, token in ~/.docent/<port>.token 0600)
                    ├─ http.ts / rt.ts      SPA, /api/{tree,file,sessions,frames,recap}, state + terminal channels
                    ├─ pty/manager.ts ── node-pty ── claude --session-id <uuid> [--plugin-dir dist/pairwatch]   (one per terminal tab)
                    │                                 env: CLAUDE_CODE_SSE_PORT=<p_i> TERM_PROGRAM=docent COLORTERM=truecolor
                    │                                      TERM=xterm-256color PAIRWATCH_HOST=docent
                    │                                 inside: pairwatch mod hooks (unchanged) ── $.fs.write ~/.claude/pairwatch/live/<sid>.json
                    │                                                                         └─ GET /api/inbox, /health on :7979
                    ├─ ide/session.ts      per pty: ~/.claude/ide/<p_i>.lock + ws MCP server :<p_i>   ◄── that claude connects, sends ide_connected
                    ├─ pairwatch/host.ts   binds :7979 when nothing healthy answers /health (host mode); else bridge.ts holds SSE as a watcher
                    ├─ sessions/*          chokidar on ~/.claude/projects/**/<sid>.jsonl ─► core/replay.ts ─► core.reduce ─► SessionModel + cost + status
                    ├─ pairwatch/snapshots chokidar on live/*.json ─► overlay {head, lesson, ask, svg, station, flags, recentPaths | v2: model, narration, lesson, stage}
                    └─ replay/, recap/     frames from the same events; recap = redacted events + recap bundle in one HTML
```

Only one Docent process per host. The IDE-protocol server is a separate `http.Server` + `ws.Server` per pty because the port *is* the lock-file name and the CLI keeps one client per server (02 §1.3); several embedded sessions are therefore IDE-connected at once (Switchyard §5; assumption A15).

### Data flow (one session)

1. **Spawn.** `pty/manager.ts` mints a uuid, creates the per-session IDE server + lock (`pid: process.pid`, `workspaceFolders: [root]`, `ideName: "Docent"`, `transport: "ws"`, `runningInWindows: false`, `authToken`), then spawns `claude --session-id <uuid>` with the env above. `CLAUDE_CODE_SSE_PORT` alone makes the lock valid and skips the pid/ancestry check (02 §1.6); spawning from our process tree makes the ancestry check pass anyway. `--plugin-dir dist/pairwatch` is added only when `~/.claude/plugins/installed_plugins.json` has no pairwatch entry (two copies: behaviour unknown, avoided). Terminal bytes stream to the page; `pty/osc.ts` parses OSC 0/2/7501/9/777 and the bell for status.
2. **IDE protocol.** The CLI connects to `ws://127.0.0.1:<p_i>` with `X-Claude-Code-Ide-Authorization`; `ide/mcp.ts` answers `initialize`, `tools/list`, `tools/call`, `ping`. `openDiff` posts `{id, oldPath, newPath, newContents, tabName}` to the page and awaits `diffResult {id, accepted}` → `FILE_SAVED` / `DIFF_REJECTED` (exact result shape: A4). The page pushes `selection_changed` (300 ms debounce, 0-based lines) and `at_mentioned` (Alt+K). `getDiagnostics` returns `[]`; `executeCode` returns an error string.
3. **Live model.** `sessions/transcripts.ts` finds `~/.claude/projects/*/<uuid>.jsonl` by glob (never by computing the encoded cwd) and tails it from the current byte offset. `core/replay.ts` (mod change P4; until merged, a Docent-local copy with the same tests) turns rows into `RawEvent`s per the 01 §4 table: string-content `user` rows → `prompt`; `assistant` `thinking`/`text` blocks → `think`/`say` (+ `stream` at the row timestamp); `tool_use` → `tool-start`; `tool_result` → `tool-end`; `Agent` calls + `<sid>/subagents/agent-*.jsonl` → `agent-start/stop`; `turn-start`/`turn-end` inferred; rows of type `attachment`, `api-request*`, `queue-operation`, `mode`, `permission-mode`, `file-history-snapshot`, `file-history-delta` skipped (but the last is kept aside for replay). Batches go through `reduce(model, batch, {level, cwd, now})` then `settleHop` on a 400 ms timer, mirroring `register.tsx tick()`. `rulesNarration` runs here (pure). The `tool_use.input` of each Read/Edit/Write/MultiEdit is kept in a side map keyed by `tool_use_id` because `Step.scene` carries no numeric ranges (`types/index.d.ts:98`). `sessions/cost.ts` sums `message.usage` by `message.model`. The page receives `state {sid, rev, model, narration, cost, status}` only when `rev` or status changed.
4. **Mod overlay.** In **host mode** Docent is the viewer the mod expects: it answers `/health` with `{ok:true, app:'pairwatch', version:3, clients}` (`register.tsx:1147-1162` checks `app` and numeric `version >= 3`), keeps `~/.claude/pairwatch/viewer.token` semantics (0600, base64url 32; `server.mjs:155-175`), answers `/api/inbox?sid=` with the queued presses and `watching = <pages currently showing sid>` so `isWatched()` (`register.tsx:896-898`) is true and Haiku narration runs, serves pairwatch's own `index.html` at `/` so the `/pairwatch` link keeps working, and implements `/api/quit` as "stop the 7979 listener only". In **bridge mode** (a healthy viewer already answers) Docent holds one SSE `GET /api/events?sid=&key=` per on-screen session, which the real server counts in `watchingOf()` (`server.mjs:317-321`), and proxies presses to `POST /api/action`. Either way `pairwatch/snapshots.ts` parses `live/<sid>.json` (skipping half-written files like `server.mjs:238-248`) and the page receives `overlay {head, lesson, ask, svg, station, status, isPaused, isAsking, level, narrationSource, recentPaths?}`; when the file says `v: 2`, `model` from the mod replaces the transcript model (engine timestamps, `#permission` steps) and `lesson {conceptId, depth}` is rendered from `getConcept`. Presses `why|tip|known|pause|level` go to the inbox (host) or `/api/action` (bridge).
5. **Watch panel.** Prefers the mod's `head` (Haiku) when its `at` is within 10 s, else its own rules narration; the card is the mod's `lesson` Markdown; when the mod is absent the panel shows the current step's first concept via `getConcept` + `lessonMarkdown` **stateless** (no seen/known file of its own: there is exactly one learning state, the mod's `$.store`), with Why? / I know this disabled and a tooltip saying why. Steps strip, This-turn stats and cost come from the model.
6. **Follow mode** (`editor/follow.ts`): the current step's `scene.kind === 'read'` opens `files[0]` and decorates the range from the side map (default: whole file, faded after `FRESH_MS`); `kind === 'edit'` opens the diff tab with the full `old_string/new_string`; `kind === 'search'` only fills the Steps strip. Manual navigation pauses following for 20 s; one key toggles it. `tree/heat.ts` tints rows from `model.files[] {path, reads, edits, last}`.
7. **Replay** (`replay/frames.ts`): all events of a session sorted by timestamp → 400 ms batches (`play()` cadence) → keyframes every N events (`{at, model}`); a seek re-reduces from the nearest keyframe (≤ N events; budget A13), then `stageInput` + `renderStage` for the frame on screen, rules narration, lesson id from `lessonCandidates` logic without seen/known state. `replay/fileState.ts` gives a path's text at frame N: (1) the `file-history-delta` row with the latest `messageId` at or before the frame, mapped to `~/.claude/file-history/<sid>/<backupFileName>`; (2) the last successful `Read` of that path with full text in `toolUseResult.file.content`; (3) reverse-apply `old_string/new_string` from the working copy, badged "approximate" when an `old_string` does not match (A12).
8. **Recap** (`recap/export.ts`): `redactSecrets` over every string of the `RawEvent[]` and the side map, inlined as `<script type="application/json">`, plus the `packages/recap` IIFE (which runs `reduce`/`renderStage` in the browser), plus inline CSS. One file; no frames precomputed (judge G18). Size cap: if the inlined JSON exceeds 5 MB, keep the last N turns and say so in the header.
9. **Wall** (`wall/Wall.tsx`, `/api/sessions`): union of `live/*.json` (sid, cwd, goalText, head's first sentence, station, ended, at) and `~/.claude/projects/*/*.jsonl` (sid, cwd from the first row, mtime, cost). Live sessions open the session view; ended ones open replay; **Resume** spawns `claude --resume <sid>` in that cwd with the Docent env.

### Claude Code integration route and fallbacks

**Route A for MVP** (02 §5 "C, phased A then B"): the unmodified interactive CLI in our pty plus our implementation of the IDE protocol plus the transcript tail, with the mod overlaid by `sid`. Everything the CLI does (slash commands, plan mode, permissions, `/pairwatch`) works on day one and cannot drift from the CLI.

| If this fails | Docent still does | What changes |
| --- | --- | --- |
| IDE handshake (A3) | terminal, panel, follow, replay, recap | diffs stay in the terminal; no selection context; `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=1` as a documented workaround |
| Mod does not load (rollout flag or workspace trust; A8) | steps, follow, heat, replay, recap, cost, status from the transcript | panel shows "Pairwatch is not running in this session" with the README grep; rules narration; stateless cards; Why? / known disabled |
| Transcript not appended during a turn (A6) | panel from the snapshot; replay/recap after the turn | follow mode degrades to station level from the snapshot until mod change P1 (snapshot v2 `model`) lands, which then becomes the live source |
| `--session-id` not honoured interactively (A5) | everything | locate the transcript by newest file under the cwd's project dir and by the snapshot `sid` |
| A healthy viewer already owns 7979 (A9/A10) | everything | bridge mode; an unhealthy or old server is replaced by the mod itself via `/api/quit` (`register.tsx:1147-1162`); Docent never kills a server it did not start |
| `openDiff` result shape wrong (A4) | everything | answer `DIFF_REJECTED` so the CLI falls back to its terminal diff; the watcher still shows the change in the editor |

**Phase 2, Route B** (`claude -p --output-format stream-json --input-format stream-json --include-partial-messages --plugin-dir ...`) only where it buys something concrete: a permission broker (`canUseTool`) so the `ask` station exists in headless runs; scoped "explain this hunk" through `claude -p --resume <sid> --fork-session` (flag present in 2.1.302 `--help`); `result.total_cost_usd` cross-check. Not a chat UI; the terminal remains the chat. `ui_surface_v1` attachment is an experiment behind a flag (02 §2.5: `@internal`). The sanctioned v2 live source is the mod's **event push** (mod change V1), not the private UI protocol. ACP (`@zed-industries/claude-agent-acp`) later, for Codex/Gemini with rules narration.

**Stability:** pin "tested with Claude Code 2.1.302, CLI ≥ 2.1.287 required"; CI smoke spawns `claude --version` and, where a CLI is present, a lock + ws handshake with `claude --ide` and no prompt; every reader stays tolerant (`normalize` in `timeline.ts:168-206` already is).

**Security (R8, Glassbox):** token in `~/.docent/<port>.token` (0600) and in the URL as `?key=`; Host must be localhost/127.0.0.1/[::1] and Origin, when sent, too (copied from `server.mjs:499-501`), also on the `/rt` WebSocket upgrade (WebSockets ignore CORS; judge-engineer §2 learning (3)); realpath path jail under the workspace root; 127.0.0.1 only; no `--host` flag in v0.x; the IDE-protocol server closes unauthenticated upgrades with 1008; lock files 0600 in a 0700 dir; README says "treat the URL like a shell". No telemetry.

---

## 5. MVP scope (v0.1)

Sizes in evenings (one evening ≈ 3 h; a weekend day counts as two): S ≤ 1, M = 2-4, L = 5-8. Budget: 6 weeks ≈ 54 evenings at the owner's pace (assumption A25). MUST below sums to ~40 evenings plus ~5 pure spike evenings, which leaves ~15% slack; the cut order in §7 keeps the release date fixed.

### MUST

| # | Feature | Size | Lives in |
| --- | --- | --- | --- |
| M1 | `npx docent [dir]`: free port (default 4747), token file, static SPA, `/rt` ws, `--no-open`, `--port`; graceful shutdown (kill ptys, delete locks, stop 7979 listener) | S (1.5) | server/cli.ts, http.ts, rt.ts |
| M2 | Workspace tree (lazy, ignores `.git`/`node_modules`), read/write, modified badge from the watcher, realpath jail | S (1) | server/workspace/fs.ts, web/tree |
| M3 | Editor: CodeMirror 6 tabs, `language-data`, save, external-change reload prompt, decoration API (`wash(from,to)`, `pin(widget)`), selection events | M (2) | web/editor |
| M4 | Terminal: node-pty + xterm, fit/resize debounce, Shift+Enter CSI-u, `macOptionIsMeta`, bracketed paste in chunks with drain, OSC 52, Shift-drag selection, canvas renderer default, OSC 0/2/7501 parse, tab badge | **L (6)** | server/pty/*, web/terminal |
| M5 | Spawn `claude` with `--session-id`, the IDE env, `--plugin-dir dist/pairwatch` unless installed, `PAIRWATCH_HOST=docent`; graceful close; "new terminal (shell)" tab | S (1) | server/pty/manager.ts |
| M6 | IDE protocol per session: lock file, ws MCP (`initialize`, `tools/list`, `tools/call`, `ping`), 11 cheap tools, `selection_changed` (300 ms), `at_mentioned` (Alt+K) | M (3) | server/ide/* |
| M7 | `openDiff` diff tab: `@codemirror/merge`, Accept writes and answers `FILE_SAVED`, Reject answers `DIFF_REJECTED`, `closeAllDiffTabs`/`close_tab`; review bar titled with the current narration's why and the card pinned beside the hunk ("what you are approving", judge-product G5) | M (2.5) | server/ide/tools.ts, web/editor/DiffTab.tsx, reviewBar.tsx |
| M8 | Pairwatch host mode (viewer-compatible 7979: `/health`, `/api/sessions`, `/api/state`, `/api/events`, `/api/action`, `/api/inbox` with `watching`, `/api/quit`, token file, Host/Origin, serves `index.html`) + bridge mode (SSE per on-screen sid, action proxy) + snapshot parsing | M (3) | server/pairwatch/* |
| M9 | Watch panel: stage `svg`, `head`, `lesson`, `ask`, `goal`, `recent` via the mini-Markdown port; Why? / Another tip / I know this / Pause / Level; keys w t k p; "ended"; the honest "not running" diagnostic with the README grep; stateless card fallback | M (2) | web/watch/* |
| M10 | Transcript locate + tail; `core/replay.ts` rows → `RawEvent[]` (contributed to the pairwatch repo, P4; local copy until merged); live `reduce` + `settleHop`; rules narration; inputs side map; Steps strip; This-turn stats; cost meter from `message.usage` with `config/prices.json` | M (4) | server/sessions/*, web/watch/Steps.tsx, ThisTurn.tsx |
| M11 | Follow mode: Read wash, Edit hunk in the diff view, click a step / a `recentPaths` entry / a `data-path` element → open file at range; 20 s manual-navigation pause; toggle key | M (3) | web/editor/follow.ts |
| M12 | Explorer heat from `model.files` (reads blue, edits amber, tooltip with counts and age) | S (1) | web/tree/heat.ts |
| M13 | Replay: keyframed frames builder, scrubber (drag, `[` `]`, space, 1-8x), editor and diff following, stage/narration/card per frame; file state via file-history → Read results → reverse-apply with the "approximate" badge; `docent replay <sid|file>` | **L (7)** | server/replay/*, web/watch/Scrubber.tsx |
| M14 | Recap export: one redacted HTML with the recap bundle (same Replay component), timeline, concepts met, files changed, cost; `docent recap <sid>`; download button | M (2) | server/recap/export.ts, packages/recap |
| M15 | Wall: live + last 7 days, one sentence + status + cost per card, click to open or replay, Resume (`claude --resume <sid>`) | M (2) | web/wall, server /api/sessions |
| M16 | Needs-you: snapshot `station === 'ask'` or OSC 7501 waiting → tab badge, Wall pulse, chime (full six-state merge is S1) | S (1) | server/sessions/status.ts |
| M17 | README (20 s GIF of demo beats 2-5, how-it-works diagram, privacy table as explicit as Pairwatch's README 118-129, requirements block: CLI ≥ 2.1.287 tested with 2.1.302, rollout-flag caveat, Node ≥ 20, macOS/Linux; "what it does not do"; "treat the URL like a shell"; the `/pairwatch close` vs close-pane note); MIT; CONTRIBUTING; CI (tsc, `node --test`, build, handshake smoke) on Node 20 + 22; `npm publish --provenance`; tagged `v0.1.0` | M (3) | repo root |
| M18 | Tests: fake MCP client over ws (`initialize`, `tools/list`, `openDiff` round trip), lock-file test, path-jail test, half-written-snapshot test, `core/replay.ts` + `reduce` over the 3 corpus transcripts, cost sums, status merge with a scripted OSC stream, fileState on corpus | M (3) | test/*.spec.ts |

### SHOULD (v0.1 if slack allows, else v0.2)

| # | Feature | Size |
| --- | --- | --- |
| S1 | Full status merge (OSC 7501 + station + transcript rows) into `starting | working | needs-you | idle | done | gone`, optional browser `Notification` | M |
| S2 | `docent ssh <host>`: runs `ssh -t -L 4747:127.0.0.1:4747 <host> 'npx docent --no-open'` and opens the page | S |
| S3 | Snapshot v2 consumption (`model`, `narration`, `lesson {conceptId, depth}`, `stage`, `fresh`) when the mod ships it: mod's model preferred, Docent renders the stage itself in replay | S |
| S4 | Live turn recap at `#done` (concepts met with I-know-this via `/api/action known`, files changed with diff links, stats, one narrated line) built from the same component the exported recap uses | M |
| S5 | Journal page read from the mod's learning data (store file names unknown here: A-spike; v2 `learning.json` makes it stable) | S |
| S6 | Multiple `claude` terminals (one IDE server each), "new session" button | S |
| S7 | Layout persistence in `localStorage`; light theme (stage SVG is dark-only, so dark default) | S |
| S8 | Sub-agent lanes in the Steps strip from `model.agents` | S |

### COULD

| # | Feature | Size |
| --- | --- | --- |
| C1 | Iframe of the real Pairwatch page (`http://127.0.0.1:7979/?key=`) as an alternate panel view (CSP has no `frame-ancestors`, `server.mjs:465-486`); the day-3 fallback | S |
| C2 | Terminal time-marks: pty byte offsets per second so scrubbing scrolls the terminal to that moment | M |
| C3 | Docent-side Haiku narration when the mod is absent (`claude -p --model haiku` with `NARRATOR_SYSTEM` + `buildNarrationPrompt`, same gating as `register.tsx:901-926`) | M |
| C4 | Docker image (`node:22-slim` + the user's `claude`) for the GPU-box audience | S |
| C5 | Git status column in the tree | S |

### NON-goals for v0.x (written into the README)

No LSP, no debugger, no extension host or marketplace, no Windows, no Electron until stars justify $99/yr of signing, no worktree-per-session, no PR lane, no permission answering by writing `\r`/`\x1b` into the pty, no re-implemented chat UI, no `--host 0.0.0.0`, no Docent-owned model key (narration stays on the mod's `$.model.complete` on the user's auth), no second learning state, no telemetry.

---

## 6. Pairwatch advancement

Rule: every change keeps the mod a complete standalone Claude Code plugin (pane + page), `dev/check.sh` stays green, every snapshot change is additive so `viewer/index.html` keeps working untouched, each change is its own PR on `yashsinha1702/pairwatch`, and Docent never *requires* a mod version (transcript path); it only gets better with one.

### MVP changes (small, additive; opened in weeks 2-4, in this order)

| # | Change | Where | Size |
| --- | --- | --- | --- |
| P1 | **Snapshot `v: 2`** (01 §3): add `model: SessionModel`, `narration`, `lesson: {conceptId, depth, concept}`, `ask` (raw), `prefs`, `stage: StageInput`, `fresh`, keep every v1 field; guard `JSON.stringify(model).length < 200_000` else write v1 fields plus `modelOmitted: true`; make `Snapshot` (`register.tsx:311`, today `{sid} & Record<string, unknown>`) concrete in `types/index.d.ts`; shape assertion in `dev/spec/viewer.spec.ts`; README Privacy row (the file now holds the session's step history). The judge calls this "the right first mod PR". | `writeSnapshot` register.tsx:1290-1332; `viewOf` 1722-1744 already has `stage`/`fresh`; `getConcept` imported at 58 | half a day |
| P2 | **`PAIRWATCH_HOST` env hint**: when `$.env.get('PAIRWATCH_HOST')` is set, do not auto-open the terminal pane (the host draws the stage); keep status-line updates and snapshots. README note: `/pairwatch close` stops snapshots (`isOff`, `register.tsx:1137-1140`) while closing the pane only resets flags (`ui.close` → `markClosed` 1419-1424). | `session.start` 1832-1869; the `autoOpen` check at `prompt.submit` 1893 | 3 lines |
| P3 | **`recentPaths: string[]`** in the snapshot: full `target` paths of the same last-4 main-lane steps `recent` is built from (`text.ts:245` `recentOf` gives basenames only), so click-to-open is unambiguous before P1 is consumed. | `writeSnapshot` | ~6 lines |
| P4 | **`core/replay.ts`** (pure): transcript rows → `RawEvent[]`, lifted from `dev/eval-corpus.ts` (`plain`, `argsOf`, `previewOf`, dedupe by `uuid`, `cwd`/`timestamp` tracking, ~65-108) and extended per 01 §4 (prompts, thinking/text blocks, agent files, inferred turn boundaries, skipped row types). Spec against two redacted fixtures; `eval-corpus.ts` may import it. Serves the mod's own roadmap line "Replays of past sessions on the page" (README 175). | new file + `dev/spec/replay.spec.ts` | ~250 lines |
| P5 | **`data-step` / `data-path` / `data-station` attributes** in the SVG so the stage is clickable in any host without parsing text: `data-path` via `sheetTab` (`scenes/work.ts:162`; call sites 653 read, 851 edit), `data-step` on each scene group, `data-station` on rail stops (`stage.ts:86-97`). Attributes only; one assertion in `dev/spec/stage.spec.ts`; stays inside the 60,000-char budget. | scenes/work.ts, stage.ts | ~10 lines |
| P6 | **`toolUseId` on `#permission` steps**: `SceneData.ask` (`types/index.d.ts:104`) gains `toolUseId?` so the diff tab can say "waiting for your OK on Edit src/x.ts". | `timeline.ts onPermission` 1052-1079, types | S |
| P7 | **`/health` `host` field** reader: when `/health` returns `host` (and a `link`), `/pairwatch` prints the host's page link instead of the viewer's. Optional. | `runCommand` register.tsx:1532-1588 | S |

### v2 changes (after v0.1)

| # | Change | Why |
| --- | --- | --- |
| V1 | **Event push to a host**: when `/health` advertises `accepts: ['events']`, `tick()` (`register.tsx:731-763`) POSTs the folded batch of redacted, bounded `RawEvent`s with a `rev` to `POST /api/events?sid=` via `$.http.fetch`, once per tick; the host detects gaps by `rev` and falls back to the snapshot. | engine timestamps and `permission` events, which transcripts lack (01 §6), without the private `ui_surface_v1` |
| V2 | **Scene ranges**: Read `offset/limit` → `scene.read.files[].from/to`; Edit first changed line where computable (`explain.ts explainBy` 732-774; `types/index.d.ts:98-100`). | follow mode from the model alone; the stage can say "lines 40-80" |
| V3 | **Scoped Why?**: inbox `{action:'why', value:'<stepId>' | 'path:from-to'}`; raise the `value` limit 40 → 200 (`server.mjs:426-432`); extend `whyForkPrompt` (`narrate.ts:306`); keep the 20 s cooldown (`WHY_COOLDOWN_MS` register.tsx:114). | "explain this hunk" from the editor gutter |
| V4 | **Learning as data**: the mod writes `~/.claude/pairwatch/learning.json` (`journal[] {conceptId, at, cwd, sid, stepId}`, `known[]`, `seen`) with its 15 s learning save; a `GET /api/learning` route on `server.mjs`. | one learning state, readable by the IDE's journal page and the recap |
| V5 | **Lesson anchors** `{path, range}` in `LessonState` from the activity's first step. | pin the card to code anywhere |
| V6 | **Agent lanes on the stage** (roadmap README 176): `stage.ts` lane strip from `model.agents`; `sceneDelegate` fan-out with a merge point. | lanes in pane, page and IDE at once |
| V7 | **Quiz during long waits** (roadmap README 174): pure `core/quiz.ts`; after 20 s on a step, three next stations from `trail(model)` + `RAIL`; inbox action `quiz`; graded on the next `tool-start`; result into the journal. | rendered as `Select` in the pane, buttons in Docent |
| V8 | **`@pairwatch/core` package**: `dev/build-core.sh` (esbuild with `.ts` extension rewriting; `.d.ts` from `types/index.d.ts` minus the `declare module 'claude-code'` tail, 247-257), gated on a test that the engine still accepts the augmentation from a second file (unknown). | Docent moves from submodule to npm dependency |
| V9 | **`recap` inbox action**: one `$.model.complete` call summarising the turn on the user's auth, shared with the 600-call cap. | a narrated summary line without a Docent key |
| V10 | **`ui_surface_v1` attach** behind `--experimental-surface` (private; payloads unknown). | the mod's Pane tree with `Svg` drawn natively |
| V11 | **Per-project glossary** (roadmap README 177): bounded Haiku pass over file names, exported symbols and README headings, cached in `$.store` per repo, used by `buildNarrationPrompt`. | cards say "the `OrderSaga`", not "a saga" |

### IDE-native affordances (what Docent does with the data)

| Affordance | v0.1 source | v2 source |
| --- | --- | --- |
| Click a path in the stage, narration, Steps strip or recap → open the file at the range | `recentPaths` (P3), `data-path` (P5), side map | `scene.read.files[].from/to` (V2) |
| Lines being read washed in the editor | transcript `Read.input.offset/limit` | V2 ranges from the model |
| Diff scene → real diff with why + card in the review bar | `openDiff` (live), `Edit.input.old_string/new_string` (replay) | same, plus `scene.edit.line` |
| File heat in the explorer | `model.files` from the transcript model | `model.files` from snapshot v2 / event push |
| Permission diff named by its approval | `openDiff` + current `head` | `toolUseId` on the `#permission` step (P6) |
| Needs-you cue | `station === 'ask'`, OSC 7501 | `canUseTool` in route B; V1 permission events |
| Replay scrubber, deep links `?sid=&at=` | `core/replay.ts` + `reduce`, file-history | same |
| Wall sentence | `head`'s first line; `goalText` | `narration.now` raw (P1) |
| Why? / Another tip / I know this from the panel and the gutter | the mod's inbox | V3 scoped Why? |
| Concept journal | mod store (S5; names unknown) | `learning.json` (V4) |

---

## 7. Week-by-week plan to v0.1 (6 weeks)

Quota rule: every spike is free except day 4, which spends two short turns in a throwaway repo, at the owner's chosen time. All results go to `docs/spikes.md`.

**Week 1: retire the biggest risks, start the shell.**
- Day 0 (evening): repo on GitHub (`yashsinha1702/docent`, public, MIT), `.npmrc` registry pin as the first commit, `.nvmrc` 22, workspaces, submodule at `vendor/pairwatch`, `packages/core` shim; `npm view` every pinned version (A16); `node --test` a 20-line spec importing `reduce`, `emptyModel`, `renderStage` from the submodule with the shim, and a Vite page calling `renderStage(emptyModel)` (A11); `du -sh node_modules` (A20).
- Day 1: node-pty + xterm soak: spawn `claude` in the pty, `/help`, `/config`, scroll, resize twice, paste 5 KB, Shift+Enter, Option+Enter, `/tui fullscreen`; **ten minutes of real TUI use** before building on it; decide canvas vs DOM; quit with Ctrl+C, no prompt (A1, A2).
- Day 2: IDE handshake: `ide/lock.ts` + `ide/mcp.ts` with `initialize`/`tools/list` and stub tools; `claude --ide` in our pty with `CLAUDE_CODE_SSE_PORT`; expect `ide_connected` on our socket and `/ide` listing "Docent"; **two sessions with two locks at once**; note how an unknown `ideName` is displayed (A3, A15). No prompt.
- Day 3: Pairwatch host mode stub on 7979; `claude --debug --plugin-dir vendor/pairwatch/pairwatch`, `/pairwatch status`, quit; confirm a `live/<sid>.json` appears, `watching ≥ 1`, the rollout-flag grep (`grep "hooks modules" "$(ls -t ~/.claude/debug/*.txt | head -n 1)"`), `--session-id` == transcript file name == snapshot `sid` (A5, A8, A9); `ls ~/.claude/plugins/store | grep pairwatch` (S5); capture raw pty bytes while idling and quitting and grep `\x1b]7501`, `\x1b]9;`, `\x1b]777` (A14).
- Day 4 (the one quota session): `say hi`, then one small Edit with `--permission-mode default`: capture the exact `openDiff` `tools/call` params and what the CLI accepts as a result (A4); `tail -F` the JSONL for append latency and confirm `Read.input.offset/limit` arrive mid-turn (A6, A7); confirm `narrationSource: 'model'` in the snapshot while Docent is the only watcher (A9); map that session's `file-history-delta` rows to backups (A12).
- Day 5: `core/replay.ts` draft + `reduce` over three local transcripts in a spec; first keyframes; measure re-reduce time on the longest local transcript (A13); check file-history mapping on three local sessions, including `backupFileName: null` rows (A12).
- Weekend: M1 server skeleton, M4 terminal (first pass), M6 protocol, M8 host/bridge mode.
- Gate: `docs/spikes.md` has A1-A15 answered; a page shows xterm running `claude` with "IDE: Docent" in its status line and a `live/*.json` snapshot arriving.

**Week 2: the shell (Glassbox M1-M11 as Docent's internal milestone).**
- M2 tree, M3 editor, M5 spawn, M7 `openDiff` with the review bar, M9 Watch panel from the v1 snapshot (C1 iframe as the stopgap if M9 slips), M16 needs-you, M18 tests part 1 (fake MCP client, lock, path jail, half-written snapshot), CI on Node 20 + 22.
- Open mod PR P2 (`PAIRWATCH_HOST`) and P3 (`recentPaths`); P5 (`data-*`) if time.
- Gate: the Glassbox rule (connect, panel wakes, `openDiff` opens, Accept writes) passes on the laptop. Tag **`v0.1.0-alpha.1`** as a GitHub pre-release and publish to npm under the `next` dist-tag (an early tagged release is worth more to the portfolio than a bigger first one, judge-product G9).

**Week 3: the live pipeline and follow mode (wedge 1).**
- M10 transcript tail + `core/replay.ts` (open mod PR P4 with specs) + live `reduce` + Steps strip + This-turn + cost; M11 follow mode; M12 heat; M18 part 2 (replay + cost specs on the corpus).
- Open mod PR P1 (snapshot v2) and P6 (`toolUseId`); S3 consumption lands when P1 merges.
- Gate: scenario steps 3, 4 and 7 on a real session; follow mode wash within one second of the tool call.

**Week 4: replay (wedge 2a).**
- M13 frames builder with keyframes, scrubber UI, editor/diff following, `fileState` (file-history → Read results → reverse-apply with the badge), `docent replay`.
- Mid-week checkpoint against the cut order below.
- Gate: scrub any of the 22 local transcripts; a seek stays within the frame budget (A13); "approximate" badge counts recorded per transcript.

**Week 5: recap, Wall, remote (wedge 2b).**
- M14 recap export with the `packages/recap` bundle (same component as the scrubber); M15 Wall + Resume; S2 `docent ssh` if slack; remote verified on the GPU box with `ssh -L` (keystroke echo acceptable; lock and snapshots on the remote host) (A1 on Linux, A19).
- Terminal second soak after a week of daily use; fix what the owner tripped on.
- Gate: Docent's rule (steps 3, 8, 9 smooth, laptop and SSH).

**Week 6: release.**
- M17: README with the 20 s GIF (beats 2-5 of the demo script; recorded with Playwright from a separate folder), how-it-works diagram, privacy table, requirements, non-goals, `/pairwatch close` note; CONTRIBUTING; CI green; `npm publish --provenance` from GitHub Actions; tag **`v0.1.0`**; GitHub Release with changelog; bump the submodule to the pairwatch tag that includes whichever of P1-P6 merged; Show HN draft titled around the recap (the artifact people can click).

**Cut order if week 4 slips** (never cut the terminal, the IDE protocol, the panel, or the tests): (1) M13 file state → replay shows the hunk at each step but not the whole file as it was; (2) M14 scrubber in the recap → static recap (timeline, concepts, files, cost); (3) M15 Wall → a session picker only, Resume dropped; (4) M12 heat. Everything cut moves to v0.2 (weeks 7-10). Judges' sizing note, repeated honestly: the full MUST + SHOULD set is an 8-10 week project; v0.1 is MUST only, with the cut order above keeping the date fixed.

---

## 8. Assumptions register

Each is attacked by the day-1..5 spikes or a test; "Fallback" says what the plan does if the claim is false.

| Id | Claim the plan depends on | How to validate cheaply | Fallback |
| --- | --- | --- | --- |
| A1 | `node-pty` 1.0.0 builds with node-gyp on this Mac (Node 22, npm 8, python3, Xcode CLT) and on the GPU box; no prebuilt binary assumed | `npm i node-pty --registry https://registry.npmjs.org/` in a scratch dir on both machines; spawn `zsh`, echo, read back | pin the Node version that builds; document `build-essential` + python3; worst case Node 18.12 |
| A2 | xterm.js renders the Claude TUI acceptably: Shift+Enter CSI-u honoured, Option as Meta, ≥ 5 KB paste without a freeze (chunked, drain-aware writes), synchronized output, no garbling with the canvas renderer | day-1 ten-minute soak; paste test; `/tui fullscreen` and classic | `CLAUDE_CODE_NO_FLICKER=1` default; DOM renderer; "copy mode" toggle for selection |
| A3 | The 2.1.302 CLI accepts our lock + ws MCP server with `CLAUDE_CODE_SSE_PORT` in the env, with an `ideName` outside its known-names table, and shows the IDE as connected (02 §1.6-1.7; not executed there) | day-2 handshake with `claude --ide`, no prompt: expect `ide_connected` and `/ide` listing ours | `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=1`; if no connection at all, selection is pasted as text and diffs stay in the terminal |
| A4 | `openDiff` returns `FILE_SAVED` / `DIFF_REJECTED` as text content and the CLI accepts `{content:[{type:'text', text:'FILE_SAVED'}]}`; the edited-content path is unknown | day-4 single Edit; log the `tools/call` params and the CLI's reaction to both answers | always answer `DIFF_REJECTED` so the CLI falls back to its terminal diff |
| A5 | Interactive `claude` honours `--session-id <uuid>` (listed in `--help`, not marked print-only) and the transcript file name and the snapshot `sid` (`$.session.id()`) both equal it | day-3: spawn with a uuid, `/pairwatch`, quit; `ls ~/.claude/projects/*/` and `~/.claude/pairwatch/live/` | locate by newest `.jsonl` under the cwd's project dir and by the snapshot `sid` |
| A6 | The transcript JSONL is appended per message during a turn (`tool_use` rows appear while the tool runs), not only at turn end; hook payloads expose `transcript_path` mid-turn (judge-engineer §0, "I believe yes") | day-4 `tail -F` of the newest JSONL against the terminal; chokidar timestamps | follow mode at station level from the snapshot; P1 (`model` in snapshot v2) becomes the live source and MUST |
| A7 | `Read.input` carries `offset`/`limit` when partial and `Edit.input` carries `old_string`/`new_string` (counts of 11/13/13 in the newest local transcript) | spec over `test/corpus` | ranges default to the whole file; hunks from `openDiff` payloads only |
| A8 | The installed-mods rollout flag is on for the owner's account and a `--plugin-dir` mod loads in an interactive session (02 §2.5: whether `--plugin-dir` counts as "installed" is unknown; `--help` says "for this session only") | day-3 `claude --debug` + the README grep; `/pairwatch` answers | the transcript path carries the product; the panel shows the diagnostic; the demo is recorded on a machine where it loads |
| A9 | Host mode: the mod accepts our `/health` `{ok:true, app:'pairwatch', version:3, clients}` (`register.tsx:1147-1162`), writes snapshots, and reads `watching` from our `/api/inbox` body (`register.tsx:1396`) so `isWatched()` (896-898) is true and `narrationSource` becomes `'model'` | day-3 snapshot appears and `/pairwatch status` shows the viewer; day-4 `narrationSource: 'model'` in a snapshot | match `server.mjs:507-509` byte for byte; else bridge mode with the real viewer |
| A10 | Bridge mode: our Node SSE client on `/api/events?sid=&key=` counts in `watchingOf()` (`server.mjs:317-321`) and passes the Host/Origin rules (499-501) | `curl -N -H "x-pairwatch-key: $(cat ~/.claude/pairwatch/viewer.token)" "http://127.0.0.1:7979/api/events?sid=<sid>"` then `/api/inbox` shows `watching ≥ 1` | host mode (bind 7979 ourselves before `claude` starts) |
| A11 | `hooks/core/*.ts` import under Node 22 type stripping and under Vite with a `claude-code` ambient shim and zero edits to the pairwatch repo (no TS-only runtime syntax: judge-engineer §0) | day-0 spec + Vite page | esbuild-prebundle the core into `packages/core/dist` |
| A12 | `~/.claude/file-history/<sid>/<hash>@v<n>` are full plain-text copies keyed by `file-history-delta` rows (`trackingPath`, `backup.backupFileName`, `version`, `messageId`); some rows have `backupFileName: null` (seen) | day-5 mapping over three local sessions: count exact / missing; diff a backup against the Read result of the same version | Read results (`toolUseResult.file.content`), then reverse-apply with the "approximate" badge |
| A13 | Keyframes every N events keep a seek inside one animation frame (16 ms) on the laptop for the longest local transcript; per-event `reduce` cost unknown | day-5 benchmark with `performance.now()` | lower N (50 → 25 → 10); precompute all frames for sessions under 2,000 events |
| A14 | OSC 7501 / 9 / 777 payload formats are stable enough to parse for status (formats unknown) | day-3 raw pty capture while idling at the prompt and quitting | status from snapshot `station` + transcript only; needs-you from `station === 'ask'` |
| A15 | Two concurrent lock files + ws servers work and each `claude` connects to the one in its own `CLAUDE_CODE_SSE_PORT` (02 §1.6: exactly one valid lock with that port is chosen without a picker) | day-2 two sessions at once | one session at a time; document the CLI's one-client rule |
| A16 | Every pinned package version exists on npm (registry unreachable from the sandbox; versions are from memory) | day-0 `npm view <pkg> version --registry https://registry.npmjs.org/` for each | pin whatever `npm view` returns in the same major |
| A17 | `--fork-session` exists in 2.1.302 (confirmed in `--help`) and works with `-p --resume <sid>` for a scoped Why? without polluting the session (v2 only) | v2 spike, one short turn | scoped Why? through the mod's inbox (V3) only |
| A18 | A redacted `RawEvent[]` for a whole session plus the recap bundle fits in a few MB (`plain` bounds args to 4,000 chars and previews to 1,500; `redact.ts`) | measure on the three corpus transcripts and the largest local one | cap at the last N turns; say so in the recap header |
| A19 | The esbuild server bundle runs on Node 20 (no Node 22-only APIs; node-pty built for the running Node) | CI matrix on 20 and 22; a Node 20 run on the GPU box | raise the floor to 22 in `engines` and say so |
| A20 | `node_modules` for the whole workspace stays under 600 MB and no step needs Electron, Playwright or Chromium by default | `du -sh node_modules` on day 0 | drop optional addons; Playwright in a separate folder as pairwatch's README does |
| A21 | Snapshot writes are non-atomic (`$.fs.write`), so a reader may see a half-written file (`server.mjs:238-248` skips it) | the half-written-snapshot test | retry on the next change event |
| A22 | Transcript `assistant` rows carry `message.usage` (input, cache creation, cache read, output, thinking) and `message.model` (verified by two judges and 311 `usage` occurrences locally); prices are not known to the plan | cost spec on the corpus; dollars only when the model id is in `config/prices.json` | tokens only |
| A23 | `~/.claude/projects/*/<sid>.jsonl` can always be located by globbing on `<sid>` rather than by re-deriving the encoded cwd (`/` → `-` observed; other characters unknown) | spec against the local projects dir | also scan `<project>/<sid>/subagents/agent-*.jsonl` by the parent `Agent` tool_use id |
| A24 | The pairwatch `index.html` served from host mode works unchanged against Docent's viewer-compatible routes (same `/api/*`, same key semantics) | open `http://127.0.0.1:7979/?key=` in host mode; press Why? | serve a one-line note pointing at the Docent page |
| A25 | The owner has ~8-9 evening-slots per week for six weeks and the MUST list is ~45 slots including spikes (judges: every design under-estimates by 30-60%) | weekly checkpoint against the cut order | apply the cut order; the date holds, the scope moves |
| A26 | Origin checking on the `/rt` and IDE-protocol upgrades blocks a cross-site page from driving the pty; the token in the URL is not leaked by the SPA (no third-party requests) | test from a page on another origin; grep the bundle for external URLs | tighten: require the key as a header set by the SPA after load |
| A27 | When `~/.claude/plugins/installed_plugins.json` lists pairwatch, skipping `--plugin-dir` avoids two mod copies (behaviour of two copies unknown) | day-3 check of the file; day-4 session with the installed copy if present | document "either installed or bundled, not both" |

---

## 9. Decisions the owner must make (recommended defaults)

| # | Decision | Recommended default |
| --- | --- | --- |
| D1 | **Name** (by day 0, because the npm `next` publish is in week 2) | **Docent**; if `npm view docent` says taken, `docent-ide`; else Kibitz. Check npm, GitHub and a quick trademark search first. |
| D2 | **Stack confirmation** | (c) browser UI + local Node server; CodeMirror 6; node-pty + xterm.js; React 18 + zustand; Vite + esbuild; TypeScript 5.6.3 `noEmit`; Node 22 dev / Node 20 runtime; `node --test`. No Electron, no Tauri, no Theia in v0.x. |
| D3 | **Licence** | MIT (matches Pairwatch; every dependency is MIT). |
| D4 | **Where the repo and package live** | `github.com/yashsinha1702/docent` (personal account, public from day 0, so the commit history is portfolio); Pairwatch as a submodule pinned to a tag; npm package under the owner's account, published with `--provenance` from GitHub Actions; no org, no monorepo with Pairwatch (the mod keeps its own repo and identity). |
| D5 | **Quota and timing of the one model-spending spike** (day 4: two short turns) | Do it in week 1 so A4 and A6 are known before the shell is finished; batch into one session; use a throwaway repo. |
| D6 | **Scope guard** | Approve the cut order in §7 now, so a slipping week 4 is a scope decision already taken rather than a date slip; v0.1 ships MUST only. |

---

## 10. Post-MVP roadmap (v0.2 onwards), ranked by impact / effort

| Rank | Feature | Impact | Effort | Why this rank |
| --- | --- | --- | --- | --- |
| 1 | **Live turn recap at `#done`** with I-know-this toggles via `/api/action known`, files changed with diff links, stats, one narrated line (same component as the export; S4) | high | M | the moment of learning is the end of the turn; reuses the recap bundle |
| 2 | **Snapshot v2 / event push consumption** (P1, V1): live model from the engine with `permission` steps and engine timestamps; Docent renders the stage itself | high | M (mod M + IDE S) | makes the mod the live engine and removes the transcript-latency dependency |
| 3 | **Concept journal across sessions and projects** from `learning.json` (V4), each entry linking to its replay moment; a 60 s recall quiz on due concepts | high | S-M | first-class learning artifact; a small FSRS-style scheduler is a data-science talking point |
| 4 | **Explain this hunk / scoped Why?** (V3): select lines → Why? about exactly those, answered in first person by the session's own model | high | M | the gutter becomes a question box; costs one fork per press as today |
| 5 | **Experiment ledger** for the ML audience: when a Bash step runs `python train.py`, `torchrun`, `accelerate launch`, parse the output tail for `loss=`, `acc=`, `epoch` and attach a sparkline to the step and the recap (`core/metrics.ts`, pure, specced on the owner's transcripts) | high for the owner and DS readers | M | the remote-GPU story is the owner's own use case; zero model calls |
| 6 | **Sub-agent lanes** in the Steps strip (S8) and on the stage (V6) | medium | S + M | data already in `model.agents`; roadmap item for the mod |
| 7 | **Quiz during long waits** (V7): "what will Claude do next?" with three stations, graded on the next event; default off, one per turn | medium | M | roadmap item; pure rules; the risk is annoyance, hence the defaults |
| 8 | **Sessions Wall across machines**: `docent ssh gpu` registers the remote as a peer; local and remote cards with a sentence each and needs-you cues; "since you looked" counts | medium | M | the Wall exists; add an `/api/peer` relay |
| 9 | **Per-project glossary** (V11): narration uses the repo's own names | medium | M-L | bounded Haiku pass + cache; roadmap item |
| 10 | **ACP mode** (`@zed-industries/claude-agent-acp` and the Codex/Gemini adapters) with rules narration | medium-high reach, lower depth | L | positions Docent as agent-agnostic; doubles the event-mapping surface, so only after stars justify it |
| 11 | **Electron shell** around the same page + macOS signing ($99/yr) | adoption | M + money | only once issues and stars show people want a double-clickable app |
| 12 | **Docker image** for the GPU-box audience; **terminal time-marks** (C2); **Docent-side Haiku fallback** (C3) | low-medium | S / M / M | cheap once the pipeline exists |
