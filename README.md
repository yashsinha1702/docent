# Docent

An IDE that explains what Claude Code is doing while it works, built around
[Pairwatch](https://github.com/yashsinha1702/pairwatch): a file tree, a
CodeMirror editor, a terminal running the real `claude` CLI, and a Watch panel
that shows Pairwatch's stage, narration and concept cards next to the code.

**Status: pre-alpha (v0.1 in progress).** Windows and macOS builds come from
the same Electron app; macOS is what gets tested first because that is the
development machine.

## How it fits together

```
Electron main process (packages/app/src/main)
├─ node-pty ─────────── claude --session-id <uuid> --plugin-dir <bundled pairwatch> --settings {viewerPort}
│                        env: CLAUDE_CODE_SSE_PORT=<ide port>, TERM_PROGRAM=docent
├─ IDE protocol server ─ ~/.claude/ide/<port>.lock + ws MCP server (openDiff, selection, @-mentions)
├─ Pairwatch host ────── answers the mod as its viewer (/health, /api/inbox, …) and watches
│                        ~/.claude/pairwatch/live/<sid>.json snapshots
├─ session feed ──────── tails the session's transcript and folds it with Pairwatch's own reducer
├─ status ───────────── answers the CLI's OSC 7501 probe; "needs you" / "done" notifications
├─ file watch ────────── the open tabs' files, so outside edits reload or raise a choice
├─ recap ────────────── one self-contained, redacted HTML page per session, on request
└─ renderer (React) ──── tree with file heat · editor with follow mode · diff tabs · terminal · Watch panel
```

What you get while Claude works:

- **Watch panel:** Pairwatch's stage, narration and concept cards when the mod runs; drawn from the transcript when it does not (yet), with a steps strip (click a step to see its lines), this turn's stats and tokens.
- **Follow mode** (on by default, `Mod+Alt+F`): the editor shows what Claude reads (a wash over the lines) and what it changes (marks on the edit), without stealing focus; touching the editor pauses it for 20 s.
- **File heat:** files Claude read or edited are tinted in the tree, fading over ten minutes.
- **Needs you:** a status chip on the terminal, and a notification when Claude waits for you or finishes while Docent is in the background.
- **Diffs:** Claude's proposed edits open as diff tabs to accept or reject; a file changed on disk while you have unsaved edits asks before anything is overwritten.
- **Recap:** export the session as one HTML page (no scripts, paths shortened, secrets masked) to share.

- `packages/core` re-exports Pairwatch's pure core modules (timeline, stage, concepts, …) from the `vendor/pairwatch` submodule, unchanged.
- `packages/server` holds everything that is not Electron-specific: the pty manager and OSC parser, the claude spawn plan, the path-jailed workspace, the IDE protocol server and the Pairwatch host.
- `packages/app` is the Electron app (electron-vite, React 19, CodeMirror 6, xterm 6).

## Requirements

- Node 22.18 or newer (the repo has an `.nvmrc`).
- Claude Code CLI 2.1.287 or newer on your PATH (tested with 2.1.304). The embedded terminal runs your own `claude` with your own login; Docent never calls the API itself.
- Pairwatch loads as a mod from the submodule; some Claude Code builds gate installed mods' hooks modules on a server-side rollout flag and on workspace trust (see `docs/spikes.md`).

## Development

```sh
git clone --recurse-submodules https://github.com/yashsinha1702/docent
cd docent
nvm use            # 22
npm install
npm run dev        # electron-vite dev: the app with hot reload
npm run check      # tsc for core, server and app
npm test           # node --test specs for core, server and app
npm run package    # electron-builder: dmg (mac) / nsis (windows) into packages/app/release
```

Useful switches:

- `DOCENT_WORKSPACE=/path/to/repo npm run dev` opens that folder (the default in development is this repo).
- `DOCENT_SMOKE=1` opens the window with a plain shell instead of claude, probes the DOM, and quits after 6 s; `DOCENT_SMOKE=claude` does the same with the real `claude` after 15 s. `DOCENT_SMOKE_SHOT=/tmp/shot.png` saves a capture of the window first. This is how builds are verified without a person watching.
- `node scripts/smoke-feed.mjs [shot.png]` (after `npm run build`) replays a made-up session into a temporary Claude config folder while the app runs, so the live feed, steps, heat and follow mode can be checked without running `claude`.
- Releases: see `docs/RELEASING.md` (CI builds unsigned installers for macOS, Windows and Linux from a `v*` tag).

## What it writes on your machine

| Where | What | Why |
| --- | --- | --- |
| `~/.claude/ide/<port>.lock` | one small JSON per claude terminal, deleted on exit | how the CLI finds the editor (the same file VS Code's extension writes) |
| `~/.claude/pairwatch/live/<sid>.json`, `viewer.token` | Pairwatch's own snapshots and key | written by the mod, read by Docent's Watch panel |
| a recap `.html` | only when you export one, where you choose | a shareable record of a session |
| nothing else | | no telemetry, no network beyond 127.0.0.1 |

It reads the transcript Claude Code keeps for the sessions it starts (`~/.claude/projects/<project>/<session>.jsonl` and its helpers' files), in place, to draw the steps; it never copies or uploads it.

## Not yet

Replay with file state, the sessions Wall, remote (SSH) workspaces, a native agent panel. Windows builds are made and type-checked in CI but not yet tried by hand. See `docs/PLAN.md` for the plan and `docs/DECISIONS.md` for the decisions so far.

## License

MIT
