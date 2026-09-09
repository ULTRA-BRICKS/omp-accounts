# omp-accounts

Multi-OAuth-account management for [Oh My Pi](https://github.com/can1357/oh-my-pi): several OAuth accounts of the same provider with listing, pinning, quota-aware rotation, and per-model quota ceilings.

**CLI-first workflow:** use `/accounts` subcommands for everything. `accounts.config.json` is storage only — you rarely edit it by hand.

## What it does

- `/accounts list` — current provider expanded; other logged-in providers summarized
- `/accounts list all` — every provider with stored OAuth accounts
- `/accounts set` / `unset` — pin one account to the session, or hand control back to omp
- `/accounts rotation smart` — each turn, pin the account with the most remaining quota (10% hysteresis margin)
- `/accounts rotation default` — built-in omp quota-aware rotation (no extension pinning)
- `/accounts ceiling set|unset` — per-model quota ceilings with automatic fallback model switching
- Account-switch notifications when omp's native rotation changes the account underneath you

Requires **omp >= 18.1.15**.

## Installation

```sh
omp plugin install github:alex-mextner/omp-accounts
omp plugin upgrade omp-accounts   # after releases
```

Restart omp after installing (extension modules load at session start).

Development checkout:

```sh
omp plugin link /path/to/omp-accounts
```

## Commands

```
/accounts                          same as /accounts list
/accounts list [provider|all]      accounts with (active) marker and quota
/accounts set <n|email|accountId>  pin an account to this session
/accounts unset                    release the pin; built-in omp rotation resumes
/accounts rotation default|smart|status   rotation policy (persisted)
/accounts ceiling                  show ceilings + live quota status
/accounts ceiling set <model> <percent> [fallback]
/accounts ceiling unset <model>
/accounts login [provider]         pre-fills /login in the editor
/accounts logout [n|email|accountId] remove a stored OAuth account
/accounts help
```

Deprecated aliases: `rotation on` → `smart`, `rotation off` → `default` (warning shown).

### Rotation policies

**smart** (default on fresh install) — extension pins max-remaining account each turn:

```
Turn1: A(80%) → pin A
Turn2: B(90%) → stay A  (within 10% margin)
Turn3: B(95%) → pin B
```

**default** — omp's built-in ranker handles rotation; extension does not pin.

### Ceilings

```
/accounts ceiling set claude-opus-4-6 90 anthropic/claude-sonnet-4-6
```

When the active account passes 90% used on that model, omp switches to the fallback automatically.

## Tab completion

- Subcommands with use-case descriptions and ghost-hints
- `/accounts rotation ` → `default`, `smart`, `status`
- `/accounts list ` → logged-in providers + `all`
- `/accounts ceiling set ` → models, then percent presets 80/85/90/95
- Workaround for omp TUI trailing-space autocomplete gap (see `index.ts` comment citing `packages/tui/src/components/editor.ts`)

## Configuration

File: `<agent dir>/accounts.config.json` (`$PI_CODING_AGENT_DIR` or `~/.omp/agent`).

- **Fresh install** (no file): `rotationPolicy` defaults to **smart**
- **Upgrade** (file exists): existing behavior preserved (`rotation: true` → smart, `rotation: false` → default)

```json
{
  "rotationPolicy": "smart",
  "reserveFraction": 0.1,
  "rotationMargin": 0.1,
  "models": {
    "claude-opus-4-6": { "maxUsedFraction": 0.9, "fallback": "anthropic/claude-sonnet-4-6" }
  }
}
```

Prefer `/accounts rotation` and `/accounts ceiling set` over hand-editing the file.

## Identity labels

Best-effort readable labels: `email` → meaningful `orgName` → `accountId` → credential id.

Providers like **kimi-code** often omit `email` in `AuthStorage.listOAuthAccounts` / JWT claims — the extension shows whatever the omp API surfaces (`accountId`, etc.). See `packages/ai/src/auth-storage.ts` (`OAuthAccountSummary`).

## License

MIT
