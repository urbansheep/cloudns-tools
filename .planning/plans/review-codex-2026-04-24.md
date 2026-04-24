# Codex Implementation Review: VPS Direct Transport

Date: 2026-04-24
Reviewer: Claude Sonnet 4.6
Plan reviewed: `2026-04-24-vps-direct-implementation.md`

## Rating: 9 / 10

## What Was Delivered

All 7 tasks from the plan are complete. 68 tests, all passing. No regressions.

- `src/transport/cloudns-transport-core.js` — shared base class, URL building, request body construction, response parsing, error hierarchy
- `src/transport/direct-cloudns.js` — local `curl` transport using injected `spawnImpl`
- `src/transport/resolve-transport.js` — deterministic resolver with CLI/env/TTY-prompt precedence
- `src/options.js` — `--transport`/`-t` and full short-flag alias table
- `src/config.js` — transport-aware required-key validation, interactive `.env` bootstrap, transport persistence
- `src/cli.js` — wired to `createTransport()` factory, `TransportResolutionError` mapped to exit 2
- `README.md`, `docs/guide.md` — both updated with transport selection rules

---

## Revision: 2026-04-24 (post-review fixes)

Complaints 1–4 and 6 from the initial review were addressed. The later follow-up issue about CLI transport-error handling was also fixed. Updated assessment below.

### Fixed

**#1 — `SshTransportError` naming lie: FIXED**

`cloudns-transport-core.js` now has a proper hierarchy:
```
TransportError
  ├── SshTransportError
  └── DirectTransportError
```
`direct-cloudns.js` now throws `DirectTransportError`. Clean.

**#2 — `direct-transport.test.js` wrong import source: FIXED**

Test now imports error classes directly from `cloudns-transport-core.js`. Correct coupling.

**#3 — Direct transport via `sh -c`: FIXED**

`direct-cloudns.js` now spawns `curl` as the process directly with an args array. Shell layer and `quoteForPosixShell` are gone from the direct path.

**#4 — `stdin` undefined check asymmetry: FIXED**

Direct transport now has the same guard as SSH.

**#6 — Dead imports in `ssh-cloudns.js`: FIXED**

`parseCloudnsResponse` and `parseRawCloudnsResponse` are no longer in the import list.

**Follow-up — `cli.js` transport error handling after hierarchy split: FIXED**

`cli.js` now catches `TransportError` rather than only `SshTransportError`, and preserves specific messages through `describeTransportError()`:

- `SSH transport failed`
- `Direct transport failed`

CLI integration coverage now exists for direct-mode subprocess failures in both:

- `test/auth-check.test.js`
- `test/domain-management.test.js`

This closes the regression where direct-mode `curl` failures fell through to generic `runtime error`.

**#5 — Ctrl+C during secret input persists empty credential: FIXED**

`readSecret()` in `src/config.js` now rejects with `ConfigPromptAbortError("interactive setup canceled")` on `Ctrl+C` instead of resolving `""`.

Config-flow coverage exists in `test/config.test.js` to verify that canceled prompting aborts cleanly and does not persist a blank secret into `.env`.

---

## Remaining Issues

No correctness bugs remain from the review items above.

---

## What Went Well

**Architecture**: The base class / template method pattern (`BaseCloudnsTransport.executeRequest`) is the right cut. SSH and direct transports differ only in subprocess invocation; everything else is shared.

**Testability**: `spawnImpl`/`promptImpl`/`promptValueImpl` injection makes all paths testable without real network or TTY. Subprocess-based CLI integration tests cover the real binary with fake `ssh` and `curl` scripts.

**Design doc compliance**: Every resolver rule is tested — CLI/env conflict, agreement, env-only, CLI-only, TTY prompt, non-interactive failure. Config validation for both transport modes is tested.

**`.env` persistence**: Prompted transport is written back to `.env` on first interactive run. Good UX detail.

---

## Known Testing Gap (flagged by Codex)

Secret input masking (`readSecret` in `config.js`) still has no subprocess-level TTY test. Existing `config.test.js` coverage verifies the abort/no-persist flow and the wizard behavior through injected prompt behavior, but it does not drive raw-mode keystrokes through a PTY. Reasonable deferral — PTY tests require `node-pty` or platform-specific helpers.

---

## Summary

The revision improved the score. The error hierarchy is now correct, direct transport spawns curl cleanly, CLI transport failures are mapped correctly for both SSH and direct mode, and the Ctrl+C secret-input edge case now aborts cleanly instead of persisting an empty credential. The main remaining gap is the lack of a true PTY-level test for raw secret input handling.
