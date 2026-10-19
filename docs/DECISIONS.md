# Decisions

Dated. Each overrides the plan where they disagree.

## 2026-10-18

- **Name:** Docent. Repository `yashsinha1702/docent`; npm package `docent-ide` (the bare name is taken); product name "Docent".
- **Shape:** an Electron desktop app, **Windows first, macOS too**, both built in CI. Unsigned at v0.1 (SmartScreen / Gatekeeper warnings are accepted until there is traction). The remote "local server + browser" mode from the plan is deferred, but the server package stays transport-agnostic so it can come back.
- **Scope:** lean v0.1 (plan §5 MUST minus replay file-state and the sessions Wall, which move to v0.2).
- **Stack:** Electron 44, electron-vite 6, electron-builder 26; React 19 + zustand 5; CodeMirror 6; @xterm/xterm 6 + node-pty 1.1; TypeScript 5.9 (`noEmit`); `node --test` for pure packages. Node 22 for development.
- **Pairwatch:** git submodule at `vendor/pairwatch`, pinned to a commit; bundled into the app as the plugin directory passed to `claude --plugin-dir`. The mod stays a complete standalone Claude Code plugin; every change to it is a PR on its own repository.
- **Licence:** MIT.

## 2026-10-19

- **No `electron-builder install-app-deps` postinstall.** It recursed under npm workspaces (765 nested installs). node-pty 1.1.0 ships N-API prebuilds that load unchanged inside Electron, so there is nothing to rebuild; `npmRebuild: false` at packaging time for the same reason.
- **Hand-rolled MCP over `ws` for the IDE protocol**, no `@modelcontextprotocol/sdk`: the CLI needs five methods (initialize, initialized, ping, tools/list, tools/call) and three notifications; a dependency would be larger than the code.
- **Pairwatch host port:** prefer 7979 (the mod's default) but never fight for it. A real viewer there → bridge mode; a foreign process (VS Code holds 7979 on the dev machine) → the next free port, passed to the bundled mod with `--settings {"pluginConfigs":{"pairwatch@inline":{"options":{"viewerPort":<port>}}}}`.
- **One IDE server per claude terminal**, started before the spawn so `CLAUDE_CODE_SSE_PORT` can carry its port (that variable alone makes the lock valid and skips the pid/ancestry check), deleted with its lock when the pty exits.
- **The renderer never sees the protocol.** Main relays `IdeRequest`s over IPC and answers the CLI from the renderer's `ide:reply`; the renderer reports its editors and selection, main debounces `selection_changed` (300 ms, like the VS Code extension).
- **Verification without a person:** `DOCENT_SMOKE` launches, probes the DOM, captures the window and quits; a pre-trusted scratch folder stands in for the user's workspace when the real `claude` must be started (never with a prompt).
