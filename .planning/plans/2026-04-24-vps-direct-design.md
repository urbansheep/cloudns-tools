# VPS Direct Transport Design

Date: 2026-04-24
Status: approved

## Goal

Allow agents to run `cloudns-tools` directly on the whitelisted VPS without SSH, while preserving the existing SSH transport for off-box execution.

## Constraints

- Non-interactive runs must never block on prompts.
- Transport selection must be explicit and deterministic for automation.
- Conflicting transport selectors from CLI and env are configuration errors.
- Existing SSH-based behavior must remain supported.
- Short flags should be supported alongside long flags where reasonable, including `-t` for `--transport`.

## Selected Approach

Add a transport resolver layer that accepts transport selection from:

1. CLI flag: `--transport <ssh|direct>` or `-t <ssh|direct>`
2. Environment variable: `CLOUDNS_TRANSPORT=ssh|direct`
3. Interactive fallback prompt only when no transport is configured and the process is attached to a TTY

Resolution rules:

- CLI only: use CLI transport
- env only: use env transport
- both present and equal: use that transport
- both present and different: fail with exit code `2`
- neither present and TTY available: prompt user to choose `ssh` or `direct`
- neither present and not interactive: fail with exit code `2`

## Architecture

### Transport interface

Keep `CloudnsClient` transport-agnostic. A transport only needs to expose:

- `listZones()`
- `request(path, params, options)`

### Implementations

- `SshCloudnsTransport`: existing behavior, still shells out to remote `curl` over SSH
- `DirectCloudnsTransport`: new behavior, shells out to local `curl`

Both transports should share:

- request body construction
- ClouDNS response parsing
- HTTP status marker handling
- auth/api error normalization

Only command execution should differ between SSH and direct modes.

### Config loading

Replace the single global required-config list with transport-aware validation:

- Common required keys:
  - `CLOUDNS_AUTH_ID`
  - `CLOUDNS_AUTH_PASSWORD`
- SSH-only required keys:
  - `VPS_HOST`
  - `VPS_USER`
  - `VPS_SSH_KEY`
- Direct mode requires no `VPS_*` keys

## CLI UX

### Transport flags

Add:

- `--transport`
- `-t`

Also add short aliases for existing flags where practical, to make agent invocation shorter and more uniform. Initial target set:

- `-t` => `--transport`
- `-f` => `--format`
- `-n` => `--dry-run`
- `-y` => `--confirm`
- `-v` => `--verbose`
- `-T` => `--type`
- `-N` => `--name`
- `-V` => `--value`
- `-i` => `--id` or `--input` is ambiguous, so do not reuse without resolving the conflict
- `-o` => `--output`

Because `--id` and `--input` both naturally want `-i`, short flags should only be added where they are unambiguous. It is better to omit a short alias than create conflicting meaning.

### Prompt behavior

Prompt only when:

- no transport is configured, and
- `stdin.isTTY` and `stdout.isTTY` are both true

Prompt text should keep the choice narrow and explicit, for example:

- `Select transport: [1] ssh via VPS [2] direct on this machine`

Invalid or empty input should fail with a configuration error rather than looping indefinitely.

## Testing Strategy

Use TDD and extend the current subprocess-heavy style.

### Parser tests

- `--transport direct`
- `-t direct`
- existing long flags still parse
- selected short flags parse correctly
- conflicting or invalid transport values fail

### Resolver/config tests

- env selects `direct`
- env selects `ssh`
- CLI selects `direct`
- CLI selects `ssh`
- CLI/env agree
- CLI/env disagree
- no selector + TTY prompt chooses `direct`
- no selector + TTY prompt chooses `ssh`
- no selector + non-interactive exits `2`
- SSH config missing `VPS_*` exits `2`
- direct config succeeds without `VPS_*`

### Transport tests

Mirror current auth-check transport coverage for direct mode:

- success
- auth rejection
- API failure
- invalid HTTP marker
- local command failure

## Documentation Changes

Update:

- `README.md`
- `docs/guide.md`

Document:

- both transport modes
- new `CLOUDNS_TRANSPORT` env variable
- `--transport` / `-t`
- non-interactive requirement for agents to set transport explicitly

## Non-Goals

- Persisting an interactive choice back into `.env`
- Auto-inferring transport from partial `VPS_*` presence
- Implicitly trying direct mode in non-interactive runs
