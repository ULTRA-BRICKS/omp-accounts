# omp-accounts

Multi-OAuth-account management for [Oh My Pi](https://github.com/can1357/oh-my-pi): several OAuth accounts of the same provider (e.g. several Anthropic accounts) with listing, pinning, quota-aware rotation, and per-model quota ceilings.

## What it does

- `/accounts list` — accounts of the current provider with live quota and an `(active)` marker
- `/accounts set` / `unset` — pin one account to the session, or hand control back to native rotation
- `/accounts rotation on` — every turn, pin the account with the most remaining quota, with a hysteresis margin so near-ties don't flap the Anthropic prompt cache
- Account-switch notifications when omp's native rotation changes the account underneath you
- Per-model quota ceilings with automatic fallback to a reserve model

Requires **omp >= 18.1.15** (built against `AuthStorage.listOAuthAccounts`, `pinSessionOAuthAccount`, `releaseSessionCredentialForReselection`, `getModelUsageHealth`, `getOAuthAccountIdentity`, `removeCredential`).

## Installation

```sh
omp plugin install github:alex-mextner/omp-accounts
```

Restart omp after installing (extension modules are loaded at session start).

For development from a local checkout instead:

```sh
omp plugin link /path/to/omp-accounts
```

## Commands

```
/accounts                          same as /accounts list
/accounts list [provider]          accounts of the current provider (or the given one),
                                   with (active) marker and quota when available
/accounts set <n|email|accountId>  pin an account to this session
/accounts unset                    release the pin; native rotation resumes
/accounts auto                     alias for unset
/accounts rotation on|off|status   max-remaining-quota rotation policy (persisted)
/accounts login [provider]         starts the OAuth flow: pre-fills /login in the editor
/accounts logout [n|email|accountId]  remove a stored OAuth account (asks first)
/accounts ceiling                  show per-model quota ceiling rules
/accounts help
```

Example `list` output (emails here are fictional):

```
OAuth accounts for anthropic:
1. alice@example.com (active) — 41% remaining, resets 15:00
2. bob@example.com — 87% remaining
3. carol@example.com (Example Org) — 92% remaining
4. dave@example.com — 12% remaining, resets 18:30

Pin one with /accounts set <number|email|account id>.
```

## Configuration

Config lives in `<agent dir>/accounts.config.json` — the agent dir is
`$PI_CODING_AGENT_DIR` or `~/.omp/agent` by default. The file is optional;
without it the defaults apply (`rotation` off, 10% reserve, 10% hysteresis
margin, no ceilings). `/accounts rotation on|off` creates and rewrites this
file for you; `/accounts rotation status` shows the resolved path.

```json
{
  "rotation": false,
  "reserveFraction": 0.1,
  "rotationMargin": 0.1,
  "models": {
    "claude-opus-4-6": { "maxUsedFraction": 0.9, "fallback": "anthropic/claude-sonnet-4-6" },
    "gpt-5.6": 0.85
  }
}
```

Edit the file and `/reload` (or restart) to apply. For legacy drop-in installs
under `~/.omp/agent/extensions/accounts/`, a config file next to `index.ts`
is still honored when no agent-dir config exists.

## Rotation policy (`rotation on`)

On every `turn_start` the extension calls `getModelUsageHealth` for the current
model's provider and pins the OAuth account with the highest `remainingFraction`
(skipping `depleted` accounts). A re-pin happens only when the best account beats
the active one by more than `rotationMargin` (default 10%, see "Warm-window
interaction" below); a depleted active account always rotates. The toggle persists
across restarts in `accounts.config.json`.

This differs from omp's native rotation: the native ranker is usage-aware but
optimizes for required drain, not for maximizing remaining quota. `/accounts unset`
or `rotation off` hands control back to the native ranker.

### Warm-window interaction (Anthropic prompt cache)

Anthropic stickiness has a 1-hour warm window (`ANTHROPIC_SESSION_STICKY_CACHE_WARM_MS`
in auth-storage.ts): while the session's sticky credential is warm, omp skips ranking
and reuses it to preserve the conversation-prefix prompt cache. Each pin to a
*different* account stamps `lastUsedAtMs = now`, marking that account warm — so an
A→B→A oscillation would cold-start the prompt cache on every hop.

Rotation mitigates this by default with a hysteresis margin (`rotationMargin`,
default `0.10`): the extension re-pins only when the best account's
`remainingFraction` beats the active one's by **more than the margin**. Near-ties
and slow quota drift therefore keep the session on the warm account instead of
flapping. Two overrides:

- **Depleted active account** (`state: "depleted"` from `getModelUsageHealth`)
  always rotates, margin or not — a session is never stranded on a dead account.
- **No active account yet** (first turn) pins the best account unconditionally.

The re-pin notification shows both fractions and the margin so the decision is
explainable, e.g.:

```
Rotation (turn_start, margin-exceeded): pinned bob@example.com — 87% vs active 41% remaining (margin 10%)
```

Set `"rotationMargin": 0` to restore pin-on-any-difference behavior, or raise it
(e.g. `0.25`) to rotate only on large quota gaps.

## Account-switch notifications

On each `turn_start` the extension compares the session's active account
(`getOAuthAccountIdentity`) with the last one it saw. When it changed without
this extension doing the pin (i.e. native auto-rotation kicked in after a
rate-limit), you get:

```
Account switched: alice@example.com → bob@example.com (auto-rotation)
```

## Per-model ceilings

- `models` keys: a bare model id or `provider/model-id`.
- Value: either an object with `maxUsedFraction` (default 0.9) and `fallback`,
  or a bare number meaning just the threshold.
- On `turn_start`, if the session's selected account has used more than
  `maxUsedFraction` of the current model's quota, the extension switches to the
  `fallback` model via `pi.setModel` and notifies you.
- This complements the global `retry.usageReservePct` reserve (which applies to
  all models); ceilings let you protect one expensive model specifically.

## Notes and limitations

- **Login cannot be started programmatically** — omp 18.1.15's Extension API
  has no OAuth-login entry point; the flow is TUI-only (built-in `/login` opens
  the provider selector). `/accounts login` therefore pre-fills `/login
  [provider]` into the editor so you only press Enter. In headless (`-p`) mode
  it prints a hint instead.
- **Logout is real**: `/accounts logout <selector>` removes the stored
  credential via `AuthStorage.removeCredential` (with a confirmation dialog in
  interactive mode). The built-in `/logout` provider-wide selector remains
  available too.
- `/accounts set` refuses to pin while the session is streaming (same guard as
  the built-in `/session pin`). The rotation policy pins on `turn_start`, which
  is safe mid-stream.
- In non-interactive modes (`omp -p`, RPC) there is no UI; all output goes to
  stderr prefixed with `[accounts]`.
- There are no native `account_rotated`/`quota_updated` events in 18.1.15, so
  switch detection is poll-based on `turn_start` rather than push-based.

## License

MIT
