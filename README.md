# Docent

**An open IDE that narrates your coding agent.**

Docent runs the real Claude Code CLI in a real terminal, with an editor around it and [Pairwatch](https://github.com/yashsinha1702/pairwatch) built in: while Claude works you see what it is doing, why, and the idea behind each step. Scrub any session back and share a redacted recap.

> Status: pre-alpha. Nothing to install yet. The plan is in [docs/PLAN.md](docs/PLAN.md), the decisions in [docs/DECISIONS.md](docs/DECISIONS.md), and every experiment so far in [docs/spikes.md](docs/spikes.md).

## Development

Requirements: Node 22 (`nvm use`), a `claude` CLI (2.1.287 or newer), Xcode Command Line Tools or build tools for `node-pty`.

```sh
git clone --recurse-submodules https://github.com/yashsinha1702/docent && cd docent
npm install          # installs the workspace, rebuilds node-pty for Electron
npm run dev          # Electron with hot reload
npm run check        # type-check every package
npm test             # node --test specs
npm run build        # production bundles into packages/app/out
```

Pairwatch lives in `vendor/pairwatch` as a git submodule, pinned, and is bundled with the app so `claude` starts with it loaded. Changes to Pairwatch are pull requests to its own repository.

## License

[MIT](LICENSE)
