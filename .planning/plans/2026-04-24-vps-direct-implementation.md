# VPS Direct Transport Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a direct ClouDNS transport for runs on the VPS, plus deterministic transport selection via CLI/env/TTY prompt and short flag support.

**Architecture:** Split transport execution from response parsing, add a direct local-`curl` transport beside the existing SSH transport, and add a transport resolver that chooses exactly one mode from CLI/env/prompt. Keep `CloudnsClient` unchanged at the abstraction boundary.

**Tech Stack:** Node.js 20, built-in `node:test`, subprocess-based CLI integration tests, local `curl` and `ssh`

---

### Task 1: Add parser coverage for transport and short flags

**Files:**
- Create: `test/options.test.js`
- Modify: `src/options.js`

**Step 1: Write the failing test**

Add parser tests for:

- `--transport direct`
- `-t ssh`
- `-f json`
- `-n`
- `-y`
- invalid `--transport ftp`
- unknown short flag

**Step 2: Run test to verify it fails**

Run: `node --test test/options.test.js`
Expected: FAIL because short flags and transport are not implemented.

**Step 3: Write minimal implementation**

Update `src/options.js` to:

- accept `transport` as a value flag
- validate transport values `ssh|direct`
- support a short-flag alias table
- reject unknown short flags
- keep existing long-flag behavior intact

**Step 4: Run test to verify it passes**

Run: `node --test test/options.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add test/options.test.js src/options.js
git commit -m "test: cover transport and short flag parsing"
```

### Task 2: Add transport resolution and config validation tests

**Files:**
- Create: `test/config.test.js`
- Modify: `src/config.js`
- Create: `src/transport/resolve-transport.js`

**Step 1: Write the failing test**

Add tests for:

- direct mode only requires auth keys
- ssh mode requires auth keys plus `VPS_*`
- env-only selection
- explicit selector conflict error
- no selector in non-interactive mode errors
- no selector in interactive mode prompts successfully using injected stdin/stdout/TTY metadata

**Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL because transport-aware config/resolution does not exist.

**Step 3: Write minimal implementation**

Refactor config loading into:

- dotenv parsing
- transport resolution
- transport-specific required-key validation

Resolver should accept injected streams for testability.

**Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add test/config.test.js src/config.js src/transport/resolve-transport.js
git commit -m "test: add transport resolution coverage"
```

### Task 3: Add shared transport execution/parsing layer and direct transport tests

**Files:**
- Create: `test/direct-transport.test.js`
- Modify: `src/transport/ssh-cloudns.js`
- Create: `src/transport/direct-cloudns.js`
- Create: `src/transport/cloudns-transport-core.js`

**Step 1: Write the failing test**

Add unit tests for `DirectCloudnsTransport` covering:

- successful `listZones`
- auth failure
- API failure
- invalid response marker
- local command failure

Use injected `spawnImpl` to avoid real `curl`.

**Step 2: Run test to verify it fails**

Run: `node --test test/direct-transport.test.js`
Expected: FAIL because the direct transport does not exist.

**Step 3: Write minimal implementation**

Extract shared helpers from the SSH transport:

- `buildUrl`
- `buildRequestBody`
- response split/parsing helpers
- common error classes

Implement `DirectCloudnsTransport` by spawning local `curl`.

**Step 4: Run test to verify it passes**

Run: `node --test test/direct-transport.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add test/direct-transport.test.js src/transport/cloudns-transport-core.js src/transport/direct-cloudns.js src/transport/ssh-cloudns.js
git commit -m "feat: add direct cloudns transport"
```

### Task 4: Wire transport selection into the CLI with auth-check coverage

**Files:**
- Modify: `test/auth-check.test.js`
- Modify: `src/cli.js`

**Step 1: Write the failing test**

Extend auth-check CLI tests for:

- direct mode via env
- direct mode via `-t direct`
- CLI/env transport conflict
- no transport configured in non-interactive mode

Keep existing SSH-path tests intact.

**Step 2: Run test to verify it fails**

Run: `node --test test/auth-check.test.js`
Expected: FAIL because CLI still hardwires SSH and globally requires `VPS_*`.

**Step 3: Write minimal implementation**

Update CLI bootstrap to:

- parse flags including transport
- resolve transport before client construction
- instantiate `DirectCloudnsTransport` or `SshCloudnsTransport`
- pass interactive streams to the resolver for prompt support

**Step 4: Run test to verify it passes**

Run: `node --test test/auth-check.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add test/auth-check.test.js src/cli.js
git commit -m "feat: select direct or ssh transport in cli"
```

### Task 5: Update end-to-end CLI tests for direct mode and short flags

**Files:**
- Modify: `test/domain-management.test.js`

**Step 1: Write the failing test**

Add CLI integration coverage for:

- `zone list -f json`
- `record add ... -T A -N www -V 192.0.2.2`
- direct mode command execution using fake local `curl`

Prefer focused tests over broad duplication.

**Step 2: Run test to verify it fails**

Run: `node --test test/domain-management.test.js`
Expected: FAIL because short flags and direct mode plumbing are incomplete.

**Step 3: Write minimal implementation**

Adjust any remaining CLI/test helpers so both transport modes can be exercised in subprocess tests.

**Step 4: Run test to verify it passes**

Run: `node --test test/domain-management.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add test/domain-management.test.js
git commit -m "test: cover direct mode and short cli flags"
```

### Task 6: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/guide.md`

**Step 1: Write the failing test**

Manual verification target:

- docs explain `CLOUDNS_TRANSPORT`
- docs explain `--transport` and `-t`
- docs explain interactive prompt vs non-interactive failure
- docs explain direct mode does not require `VPS_*`

**Step 2: Run test to verify it fails**

Run: `rg -n "CLOUDNS_TRANSPORT|--transport|-t|direct mode|non-interactive" README.md docs/guide.md`
Expected: missing references in current docs.

**Step 3: Write minimal implementation**

Update docs for both SSH and direct-on-VPS workflows.

**Step 4: Run test to verify it passes**

Run: `rg -n "CLOUDNS_TRANSPORT|--transport|-t|direct mode|non-interactive" README.md docs/guide.md`
Expected: matches in both docs.

**Step 5: Commit**

```bash
git add README.md docs/guide.md
git commit -m "docs: describe transport selection and direct mode"
```

### Task 7: Run full verification

**Files:**
- Modify: none

**Step 1: Run focused tests**

Run:

```bash
node --test test/options.test.js
node --test test/config.test.js
node --test test/direct-transport.test.js
node --test test/auth-check.test.js
node --test test/domain-management.test.js
```

Expected: all PASS

**Step 2: Run full suite**

Run:

```bash
npm test
```

Expected: PASS

**Step 3: Review diff**

Run:

```bash
git diff --stat
git diff -- src test README.md docs/guide.md .planning/plans
```

Expected: changes limited to transport selection, direct transport, tests, and docs

**Step 4: Commit**

```bash
git add src test README.md docs/guide.md .planning/plans
git commit -m "feat: support direct cloudns transport on vps"
```
