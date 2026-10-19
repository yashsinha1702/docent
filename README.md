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
└─ renderer (React) ──── tree · editor · diff tabs · xterm terminal · Watch panel
```

- `packages/core` re-exports Pairwatch's pure core modules (timeline, stage, concepts, …) from the `vendor/pairwatch` submodule, unchanged.
- `packages/server` holds everything that is not Electron-specific: the pty manager and OSC parser, the claude spawn plan, the path-jailed workspace, the IDE protocol server and the Pairwatch host.
- `packages/app` is the Electron app (electron-vite, React 19, CodeMirror 6, xterm 6).

## Requirements

- Node 22.18 or newer (the repo has an `.nvmrc`).
- Claude Code CLI 2.1.287 or newer on your PATH (tested with 2.1.302). The embedded terminal runs your own `claude` with your own login; Docent never calls the API itself.
- Pairwatch loads as a mod from the submodule; some Claude Code builds gate installed mods' hooks modules on a server-side rollout flag and on workspace trust (see `docs/spikes.md`).

## Development

```sh
git clone --recurse-submodules https://github.com/yashsinha1702/docent
cd docent
nvm use            # 22
npm install
npm run dev        # electron-vite dev: the app with hot reload
npm run check      # tsc for core, server and app
npm test           # node --test specs for core and server
npm run package    # electron-builder: dmg (mac) / nsis (windows) into packages/app/release
```

Useful switches:

- `DOCENT_WORKSPACE=/path/to/repo npm run dev` opens that folder (the default in development is this repo).
- `DOCENT_SMOKE=1` opens the window with a plain shell instead of claude, probes the DOM, and quits after 6 s; `DOCENT_SMOKE=claude` does the same with the real `claude` after 15 s. `DOCENT_SMOKE_SHOT=/tmp/shot.png` saves a capture of the window first. This is how builds are verified without a person watching.

## What it writes on your machine

| Where | What | Why |
| --- | --- | --- |
| `~/.claude/ide/<port>.lock` | one small JSON per claude terminal, deleted on exit | how the CLI finds the editor (the same file VS Code's extension writes) |
| `~/.claude/pairwatch/live/<sid>.json`, `viewer.token` | Pairwatch's own snapshots and key | written by the mod, read by Docent's Watch panel |
| nothing else | | no telemetry, no network beyond 127.0.0.1 |

## Not yet

Replay with file state, the sessions Wall, remote (SSH) workspaces, a native agent panel. See `docs/PLAN.md` for the plan and `docs/DECISIONS.md` for the decisions so far.

## License

MIT
