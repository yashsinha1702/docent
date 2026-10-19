# Decisions

Dated. Each overrides the plan where they disagree.

## 2026-10-18

- **Name:** Docent. Repository `yashsinha1702/docent`; npm package `docent-ide` (the bare name is taken); product name "Docent".
- **Shape:** an Electron desktop app, **Windows first, macOS too**, both built in CI. Unsigned at v0.1 (SmartScreen / Gatekeeper warnings are accepted until there is traction). The remote "local server + browser" mode from the plan is deferred, but the server package stays transport-agnostic so it can come back.
- **Scope:** lean v0.1 (plan §5 MUST minus replay file-state and the sessions Wall, which move to v0.2).
- **Stack:** Electron 44, electron-vite 6, electron-builder 26; React 19 + zustand 5; CodeMirror 6; @xterm/xterm 6 + node-pty 1.1; TypeScript 5.9 (`noEmit`); `node --test` for pure packages. Node 22 for development.
- **Pairwatch:** git submodule at `vendor/pairwatch`, pinned to a commit; bundled into the app as the plugin directory passed to `claude --plugin-dir`. The mod stays a complete standalone Claude Code plugin; every change to it is a PR on its own repository.
- **Licence:** MIT.
