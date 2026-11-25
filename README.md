# Zarca

A desktop treasury workspace for organizations that run on Zcash: local wallets, reviewed payments, recurring schedules, cross-chain payouts through NEAR Intents, and bookkeeping for treasury activity.

Built with [Electrobun](https://electrobun.dev), React, TypeScript and [zcash.js](https://github.com/zcashlabs/zcashjs).

> Status: under active development. Linux is the current platform target; see the [roadmap](https://github.com/zcashlabs/Zarca/issues/1).

## Development

Requirements: Linux x86_64, [Bun](https://bun.sh) 1.4+, Node 22+ and the Rust toolchain (for the first zcash.js build), plus WebKitGTK 4.1.

```sh
npx electrobun@2.0.7 prepare      # installs Hutch and projects the Electrobun devkit
hutch install
hutch run dev                     # build the view and launch the app
bun test tests/unit               # unit tests
```

Data lives in `$XDG_DATA_HOME/zarca` (default `~/.local/share/zarca`); set `ZARCA_DATA_DIR` to use another directory.

### macOS (local builds)

Without an Apple Developer ID, `bash scripts/build-macos-local.sh [--install]` builds Zarca.app and seals it with an ad hoc signature, the hardened runtime and the entitlements Bun's JIT and the WASM engine need. It runs on the Mac that built it. It isn't notarized, so copies downloaded on other Macs are blocked by Gatekeeper (#6).

### Headless runs

`scripts/dev-headless.sh` starts the app on an Xvfb display with an isolated data directory and a development-only automation socket (dev channel only, never in release builds). `scripts/ui.sh shot out.png` captures the screen and `scripts/ui-run.sh script.js` drives the UI.

## Security model

- Each wallet has its own password, vault and encrypted stores. Only non-secret picker data (wallet names and network) lives outside them.
- The vault wraps a random data key and, separately, the recovery phrase under an scrypt-derived key. Unlocking yields only the data key. Each payment authorization re-derives the key from the password to open the phrase, which is wiped right after signing.
- The zcash.js wallet database and its rollback journal are encrypted with AES-256-GCM (zcashlabs/zcashjs#31). Treasury records are an encrypted SQLite snapshot replaced atomically. No plaintext journal or temp file reaches the disk.
- Locking, switching wallets, inactivity and sleep stop sync, close both stores and wipe keys from memory.
