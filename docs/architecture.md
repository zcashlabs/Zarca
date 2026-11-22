# Zarca architecture and decisions

## Processes

| Process | Runs | Holds secrets? |
| --- | --- | --- |
| Bun main process (`src/bun`) | Wallet engine (zcash.js + WASM workers), vault, treasury store, RPC handlers, timers | Yes, only while a wallet is unlocked |
| Webview (`src/mainview`) | React UI | Never. It sends passwords once per unlock or authorization and receives no keys. |

The webview talks to Bun through one typed `invoke` request (`src/shared/api.ts`) plus push messages (session, sync, changed). Every handler re-validates its input. File paths come only from native dialogs. The webview has a strict CSP and navigation rules that allow only bundled pages.

## Storage layout

```
$XDG_DATA_HOME/zarca/
  app.json                  # settings + wallet picker (id, name, network). Non-secret.
  wallets/<id>/             # 0700
    vault.json              # scrypt params, wrapped data key, wrapped recovery phrase
    treasury.bin            # AES-256-GCM sealed SQLite snapshot (contacts, payments, schedules, ...)
    engine/                 # zcash.js wallet: wallet.db + journal, encrypted (zcashjs#31)
```

## Key hierarchy

```
password ──scrypt(N=2^17,r=8,p=1)──> KEK
KEK ──HKDF "wrap/data-key"──> unwraps data key (random 32 B)
KEK ──HKDF "wrap/seed"─────> unwraps recovery phrase   (only during a payment authorization)
data key ──HKDF "engine"───> zcash.js storage key
data key ──HKDF "treasury"─> treasury snapshot key
```

**Why scrypt:** it is memory-hard, built into Bun's `node:crypto` (no native addon) and fast enough (~0.3 s) to run on every unlock and every payment. Argon2id would need a WASM or native dependency in the main process.

**Why the phrase is wrapped separately:** an unlocked wallet can sync and record, but it cannot spend without the password. This makes per-payment authorization real rather than a UI prompt.

## Encryption at rest

- **Engine database:** encrypted by zcash.js (zcashlabs/zcashjs#31). The database is stored as authenticated 4 KiB blocks, and the rollback journal as an append-only log of authenticated frames, so crash safety is preserved.
- **Treasury:** in-memory `bun:sqlite`. Every committed write seals the serialized database and atomically replaces `treasury.bin` (write tmp, fsync, rename, fsync dir). No plaintext journal, WAL or temp file ever exists.
- **SQLCipher** was not used: it would need a native SQLite build inside both the WASM engine and Bun, and the spec rules it out.

## Payments

```
draft ──prepare──> review (zcash.js proposal, NEAR quote) ──authorize(password)──> persist intent + attempt
     ──> execute (sign with phrase, prove, broadcast) ──> pending ──reconcile──> completed | failed | unknown
```

- An attempt whose dispatch is uncertain becomes **unknown** and blocks retries until chain or provider evidence resolves it.
- Retry creates a new attempt. It is allowed only when every earlier attempt is known not to have paid.
- Restored records reference operations from a previous database, so they are settled only by chain evidence: a mined txid, or an expiry height passed without it.

## Cross-chain (NEAR Intents)

- Keyless 1Click API, EXACT_INPUT quotes, 1% slippage, a 20-minute deadline, and review expiry 5 minutes before the deadline.
- Each quote's refund address is a fresh diversified address of the wallet. Incoming funds to it are classified as a **refund**, never revenue.
- The payment completes only on provider `SUCCESS`. `REFUNDED` means not paid (retry allowed). An outage keeps the attempt pending.
- Mainnet only: NEAR Intents has no Zcash testnet route.

## Fiat valuation

- **CoinGecko public API** (no key): spot prices for 24 major currencies and 365 days of daily history.
- **Kraken public OHLC:** daily ZEC/USD and ZEC/EUR closes for up to ~720 days.
- Valuation evidence (currency, rate, source, timestamp) is recorded once per settled item and never overwritten. Changing the display currency leaves recorded evidence untouched; reports fall back to cached daily rates and count items without a rate.
- Testnet wallets have no fiat values.

## Recurrence

Schedules use timezone-local calendar dates. Occurrence identity is `(schedule, date)`, enforced by a UNIQUE constraint, so regeneration after restart, missed periods or a restore never duplicates. Occurrences are never back-filled before a schedule's creation. Missed ones stay separate overdue payments.
