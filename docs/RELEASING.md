# Releasing Docent

Docent ships as **unsigned** installers for now (docs/DECISIONS.md, 2026-10-18): a macOS dmg (Apple silicon and Intel), a Windows NSIS installer (x64) and a Linux AppImage (x64). Nothing is signed, notarized or published automatically. Packaging is configured in `packages/app/electron-builder.yml`.

## Build locally

Once per clone:

```sh
nvm use 22                                   # nothing here runs on Node 18
git submodule update --init --recursive      # vendor/pairwatch, bundled into the app
npm ci
```

Every build:

```sh
npm run build                                # electron-vite: packages/app/out (main, preload, renderer)
cd packages/app
npx electron-builder --mac --arm64 --dir --publish never   # release/mac-arm64/Docent.app, no installer, a few seconds
```

Smoke-test the packaged app before building installers. It opens the window with a plain shell instead of `claude`, saves a screenshot and quits by itself:

```sh
DOCENT_SMOKE=1 DOCENT_SMOKE_SHOT=/tmp/docent.png release/mac-arm64/Docent.app/Contents/MacOS/Docent
```

The log should contain:

- `smoke pty exit 0: "SMOKE_PTY_OK"`: node-pty loads from `app.asar.unpacked`, and its `spawn-helper` is still executable;
- `smoke: renderer loaded`;
- a first line whose `pairwatch:` path ends in `Docent.app/Contents/Resources/pairwatch`: the bundled Pairwatch plugin.

Installers. Build each one on its own platform, as CI does. Run these in `packages/app` after `npm run build`:

| Platform | Command | Output in `packages/app/release/` |
| --- | --- | --- |
| macOS | `npx electron-builder --mac dmg --arm64 --x64 --publish never` | `Docent-<version>-mac-arm64.dmg`, `Docent-<version>-mac-x64.dmg` |
| Windows | `npx electron-builder --win nsis --x64 --publish never` | `Docent-Setup-<version>-x64.exe` |
| Linux | `npx electron-builder --linux AppImage --x64 --publish never` | `Docent-<version>-linux-x86_64.AppImage` |

For reference, the arm64 dmg of 0.0.1 is about 136 MB. `release/` is git-ignored, and electron-builder downloads its own Electron build for each target architecture.

A Windows package can be checked from a Mac without an installer: `npx electron-builder --win dir --x64 --publish never` gives `release/win-unpacked/Docent.exe`. For Windows targets, electron-builder logs `signing with signtool.exe` for every executable even when no certificate is set. Without one it skips the signing itself, so the output is unsigned.

The app icon is `packages/app/build/icon.svg`. After changing it, render `build/icon.png` again (electron-builder derives `icon.icns` and `icon.ico` from the PNG):

```sh
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/make-icon.mjs   # run from the repository root
```

## Cut a release

1. Set the version in `packages/app/package.json`. It names the installers and is what the app reports. Keep the root `package.json` in step.
2. Commit, then tag and push the tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) first checks that the tag is `v` plus that version. Then it builds the three platforms in parallel and uploads the installers as the workflow artifacts `docent-mac`, `docent-windows` and `docent-linux`. To build without tagging, start it from the Actions tab (`gh workflow run release.yml`).
4. Download the artifacts (`gh run download <run id>`), install each one and smoke-test it. Then publish them by hand, with checksums so people can verify what they got:

   ```sh
   shasum -a 256 Docent-* > SHA256SUMS
   gh release create v0.1.0 --title "Docent 0.1.0" --notes-file NOTES.md Docent-* SHA256SUMS
   ```

The **CI** workflow (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check`, `npm test` and `npm run build` on Linux, macOS and Windows for every push and pull request. A release should start from a commit where it is green.

## What unsigned means for the people installing it

The operating systems cannot tell who built these installers, so they warn. Tell users what to expect in the release notes and the README, and only ever from the project's own release page.

**macOS (Gatekeeper).** The first launch is blocked:

- *"Docent cannot be opened because Apple cannot check it for malicious software"* (wording varies by version). On macOS 14 and earlier: Control-click (right-click) `Docent.app` in Applications, choose **Open**, then **Open** again. On macOS 15 and later, Control-click no longer bypasses the check. Try to open the app once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- *"Docent is damaged and can't be opened"*. macOS can say this about an app that carries no valid signature at all, which is what `mac.identity: null` produces on Apple silicon. The app is not damaged; the download is quarantined. Clear the quarantine flag once:

  ```sh
  xattr -dr com.apple.quarantine /Applications/Docent.app
  ```

**Windows (SmartScreen).** *"Windows protected your PC"*: click **More info**, then **Run anyway**. Browsers may also flag the download as uncommon; keep it.

**Linux.** No signature is checked: `chmod +x Docent-*.AppImage` and run it. If it does not start, the usual causes are a missing FUSE 2 library (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04) and Ubuntu's restriction on unprivileged user namespaces, which stops Electron's sandbox. Both are properties of the system, not of Docent's build.

## What signing would need later

**macOS: Developer ID and notarization.**

- An Apple Developer Program membership ($99 a year) and a *Developer ID Application* certificate.
- Store it in CI as a base64 `.p12` in `CSC_LINK`, with its password in `CSC_KEY_PASSWORD`.
- In `electron-builder.yml`, remove `mac.identity: null`, keep `hardenedRuntime` on (the default) and add the entitlements Electron apps usually need under the hardened runtime: `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`. Add `disable-library-validation` only if a native module ends up signed by a different team.
- For notarization, set `mac.notarize: true` and give the job an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). The alternative is `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
- Remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` from `release.yml`.
- electron-builder signs the native files in `app.asar.unpacked` (node-pty's `pty.node` and `spawn-helper`) along with the app.
- A free step before all that is ad-hoc signing (`mac.identity: "-"`). It gives the bundle a valid signature without a certificate, so the "damaged" message should give way to the ordinary unverified-developer prompt. Users still see a warning.

**Windows: Authenticode.**

- A code-signing certificate whose key lives in a hardware token or a cloud HSM, as certificate authorities now require; Azure Trusted Signing is one hosted option.
- electron-builder's `win.signtoolOptions`, or `win.azureSignOptions` for Azure Trusted Signing, plus the matching CI secrets.
- SmartScreen warnings fade as a signed installer builds up download reputation.

**Linux.** Nothing is required. The `SHA256SUMS` above is the usual assurance; a detached GPG signature of it is the next step if anyone asks.
