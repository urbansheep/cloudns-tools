# Agent Transparency Design

Date: 2026-04-29
Status: prepared for implementation planning

## Goal

Make CloudNS Tools transparent enough for unattended agents and cautious enough for human operators. The CLI should expose what it can do, what it intends to do, what it actually did, and why it refused to proceed.

This design prepares three feature tracks:

- `CAP1`: capabilities contract
- `API1`: structured command API
- `DISC1`: command and environment discovery

Transparency priorities are equal:

- `SAF1`: safety and approval traces
- `DISC1`: discoverability and machine-readable capability metadata
- `OBS1`: observability of transport, API, decisions, and outcomes

## Current State

The current CLI already has strong foundations:

- Stable command groups: `auth`, `zone`, `record`, `preset`, `backup`
- JSON output via `-f json`
- Dry-run support for write commands
- Confirmation gates for destructive operations
- Idempotent behavior for adds/removes where feasible
- Verbose diagnostics routed to `stderr`
- Explicit transport selection with `ssh` and `direct`
- Distinct exit codes: `0`, `1`, `2`, `3`

The current gaps are mostly contract gaps:

- JSON shapes vary by command.
- Help output is human-oriented and sparse.
- There is no machine-readable command index.
- There is no structured environment readiness report beyond `auth check`.
- Errors are strings, not stable error objects.
- Dry-run output does not always include enough context for agent review.
- Verbose output is useful for people, but not structured for logs or automation.

## Shared JSON Envelope

All agent-facing JSON output should eventually use the same envelope.

```json
{
  "ok": true,
  "command": "record.add",
  "status": "ok",
  "exitCode": 0,
  "dryRun": false,
  "transport": {
    "mode": "ssh",
    "selectedBy": "env",
    "endpoint": "ops@example-vps"
  },
  "target": {
    "zone": "example.com"
  },
  "changes": [],
  "data": {},
  "warnings": [],
  "errors": [],
  "observability": {
    "requestId": "optional-local-id",
    "steps": []
  },
  "nextActions": []
}
```

Envelope rules:

- `ok` is `true` only when the command achieved its intended non-error outcome.
- `command` uses stable dot notation: `zone.list`, `record.add`, `preset.diff`.
- `status` is a stable machine value, not display text.
- `exitCode` mirrors the process exit code.
- `transport` omits secrets and includes only safe metadata.
- `changes` is present for planned or completed mutations.
- `errors` is an array even when there is one error.
- Human output remains readable but should be rendered from the same internal result model.

## Status Values

Initial status vocabulary:

- `ok`: command succeeded and did useful work or returned data.
- `skipped`: command intentionally did no work due to idempotency.
- `planned`: command produced a dry-run or plan result.
- `blocked`: command refused to proceed due to safety rules.
- `usage_error`: invalid command, flags, arguments, or confirmation.
- `config_error`: missing or conflicting configuration.
- `auth_error`: credentials rejected or unavailable.
- `transport_error`: SSH or direct curl failed.
- `api_error`: ClouDNS API rejected or failed the request.
- `runtime_error`: unexpected local failure.

## Error Object

```json
{
  "code": "missing_required_flag",
  "message": "record add requires --value",
  "category": "usage",
  "retryable": false,
  "details": {
    "flag": "value"
  }
}
```

Error rules:

- `code` is stable and documented.
- `message` is human-readable and may evolve.
- `category` maps to exit-code semantics.
- `details` contains safe context only.
- Authentication secrets and raw upstream credential errors must not be emitted.

## Change Object

```json
{
  "action": "add",
  "resource": "record",
  "zone": "example.com",
  "record": {
    "type": "A",
    "name": "www",
    "value": "192.0.2.10",
    "ttl": 3600
  },
  "reason": "record missing",
  "safety": {
    "destructive": false,
    "requiresConfirm": false
  }
}
```

Supported initial actions:

- `add`
- `remove`
- `replace`
- `noop`

Supported initial resources:

- `zone`
- `record`
- `preset`
- `backup`

## CAP1: Capabilities Contract

### Purpose

Expose what this installed CLI can do without requiring agents to scrape README text or infer from failed commands.

### Command

```bash
cloudns capabilities -f json
cloudns capabilities --format json
```

Plain text may exist, but JSON is the primary contract.

### Output

```json
{
  "ok": true,
  "command": "capabilities",
  "status": "ok",
  "exitCode": 0,
  "data": {
    "name": "cloudns-tools",
    "version": "0.1.0",
    "schemaVersion": 1,
    "commands": [],
    "recordTypes": ["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SRV", "CAA"],
    "formats": ["text", "json", "bind"],
    "transports": ["ssh", "direct"],
    "exitCodes": {
      "0": "success",
      "1": "api, ssh, or runtime failure",
      "2": "config, auth, or usage failure",
      "3": "dry-run prevented a write"
    }
  },
  "warnings": [],
  "errors": []
}
```

### Command Metadata Shape

```json
{
  "name": "record.add",
  "argv": ["record", "add", "<zone>"],
  "description": "Add a DNS record if an equivalent record does not already exist.",
  "mutates": true,
  "idempotent": true,
  "supportsDryRun": true,
  "requiresConfirm": false,
  "requiredArgs": ["zone"],
  "requiredFlags": ["type", "value"],
  "optionalFlags": ["name", "ttl", "priority", "weight", "port", "caa-flag", "caa-type", "transport", "format", "dry-run", "verbose"],
  "outputs": ["text", "json"]
}
```

### SAF1 Requirements

- Every mutating command declares `mutates`.
- Destructive commands declare `requiresConfirm`.
- Idempotent commands declare `idempotent`.
- Dry-run support is explicit, not guessed.

### DISC1 Requirements

- Agents can list command groups and command-specific flags.
- Agents can list supported record types and output formats.
- Agents can list known templates if template loading is available.

### OBS1 Requirements

- Capabilities include the CLI version and schema version.
- Capabilities include transport modes and exit-code meanings.

## API1: Structured Command API

### Purpose

Provide a command surface where agents submit structured operations instead of shell-style arguments. This is not a replacement for the human CLI; it is a stable machine entrypoint.

### Command

```bash
cloudns api --input request.json
cloudns api --input - < request.json
```

Potential later alias:

```bash
cloudns exec --json request.json
```

### Request Shape

```json
{
  "schemaVersion": 1,
  "operation": "record.add",
  "options": {
    "transport": "ssh",
    "format": "json",
    "dryRun": true,
    "confirm": false
  },
  "target": {
    "zone": "example.com"
  },
  "record": {
    "type": "A",
    "name": "www",
    "value": "192.0.2.10",
    "ttl": 3600
  }
}
```

### Response Shape

The response uses the shared JSON envelope.

### Supported Initial Operations

- `auth.check`
- `zone.list`
- `zone.add`
- `zone.remove`
- `record.list`
- `record.add`
- `record.remove`
- `preset.diff`
- `preset.apply`
- `preset.remove`
- `backup.create`
- `backup.restore`
- `capabilities`
- `doctor`

### SAF1 Requirements

- Structured requests must still enforce confirmations.
- Destructive operations require `options.confirm: true`.
- Unknown operation names fail with stable error code `unknown_operation`.
- Unknown fields should initially warn, not fail, unless they create ambiguity.
- `dryRun` must be honored consistently.

### DISC1 Requirements

- `capabilities` describes valid API operations and request fields.
- API request schemas are versioned.
- Response errors point to invalid fields with JSON-pointer-like paths when feasible.

### OBS1 Requirements

- API responses include step-level observability when `options.verbose` is true.
- API responses include selected transport metadata.
- API responses include safe request metadata, never secrets.

## DISC1: Discovery And Readiness

### Purpose

Let agents discover both static capabilities and live environment readiness.

### Commands

```bash
cloudns capabilities -f json
cloudns doctor -f json
cloudns templates list -f json
cloudns help -f json
```

`cloudns templates list` can be deferred if the first implementation only exposes templates through `capabilities`.

### Doctor Checks

`doctor` is broader than `auth check`.

Initial checks:

- `.env` exists or can be created interactively.
- Transport is selected or non-interactive failure is explainable.
- Required auth keys are present.
- SSH-specific keys are present in SSH mode.
- SSH key path exists in SSH mode.
- Selected transport can execute a read-only API probe.
- JSON stdout remains clean when verbose mode is enabled.

Example:

```json
{
  "ok": false,
  "command": "doctor",
  "status": "config_error",
  "exitCode": 2,
  "checks": [
    {
      "id": "transport.selected",
      "status": "fail",
      "message": "transport must be set via --transport or CLOUDNS_TRANSPORT in non-interactive mode",
      "remediation": "Set CLOUDNS_TRANSPORT=ssh or pass --transport direct."
    }
  ],
  "errors": [
    {
      "code": "transport_required",
      "category": "config",
      "message": "transport must be set via --transport or CLOUDNS_TRANSPORT in non-interactive mode",
      "retryable": false
    }
  ]
}
```

### SAF1 Requirements

- `doctor` must not mutate CloudNS.
- `doctor` must not print secrets.
- `doctor` should distinguish missing config from rejected credentials.

### DISC1 Requirements

- Agents can discover missing prerequisites before attempting mutation.
- Remediation strings should be concrete and command-oriented.

### OBS1 Requirements

- Checks are individually identified.
- Each check has `pass`, `warn`, `fail`, or `skip`.
- Verbose mode may add timing and transport execution details without secrets.

## Observability Steps

When requested, commands may include step traces.

```json
{
  "id": "records.fetch",
  "status": "ok",
  "message": "fetched records for example.com",
  "durationMs": 184,
  "metadata": {
    "zone": "example.com",
    "filter": {
      "type": "A",
      "name": "www"
    }
  }
}
```

Rules:

- Steps are safe to log.
- Steps do not include credentials or raw API auth payloads.
- Step IDs are stable enough for tests and automation.
- Human verbose logs can be rendered from the same step model.

## Exit Code Mapping

The current exit-code contract remains:

- `0`: success, including idempotent no-op.
- `1`: API, SSH, transport, or runtime failure.
- `2`: config, auth, or usage failure.
- `3`: dry-run prevented a write.

Envelope `status` and error `category` should clarify which `2` or `1` occurred.

## Backward Compatibility

The following must remain valid:

```bash
cloudns auth check
cloudns zone list
cloudns record add example.com -T A -N www -V 192.0.2.10
cloudns preset diff example.com fastmail
cloudns backup create example.com
```

Existing text output can evolve but should not become less readable.

Existing minimal JSON output should be migrated carefully:

- Phase 1 can add envelope output only to new commands.
- Phase 2 can add `--format json-v1` or migrate `json` with a release note.
- Preferred path: migrate `json` in a minor release before publishing widely.

## Implementation Phases

### Phase A: Result Model

- Introduce internal result envelope builder.
- Introduce structured error builder.
- Introduce change object helpers.
- Keep existing output unchanged where possible.

### Phase B: CAP1

- Add `cloudns capabilities`.
- Add command metadata table.
- Test JSON schema-level expectations.

### Phase C: DISC1 Doctor

- Add `cloudns doctor`.
- Reuse `loadConfig` and transport resolution logic.
- Add checks without changing auth-check behavior.
- Test missing config, direct config, SSH config, and auth failures.

### Phase D: OBS1 Step Tracing

- Replace ad hoc verbose log calls with structured step collection.
- Render steps to stderr for `--verbose`.
- Include steps in JSON under `observability.steps` when requested.

### Phase E: API1

- Add `cloudns api --input`.
- Map structured operations to existing command handlers.
- Keep this behind schema version `1`.

## Test Matrix

Minimum tests:

- `capabilities -f json` returns schema version, command metadata, record types, transport modes.
- `doctor -f json` fails with `transport_required` in non-interactive mode when transport is absent.
- `doctor -f json` reports missing SSH keys for SSH mode.
- `doctor -f json` succeeds against mocked transport probe.
- JSON errors include stable `code`, `category`, and `retryable`.
- Verbose diagnostics remain on `stderr`.
- `api --input -` rejects unknown operation.
- `api --input -` maps `record.add` dry-run to the same result as CLI dry-run.
- Destructive API operations require explicit confirmation.

## Open Decisions

- Whether to migrate existing `-f json` immediately to the envelope or add envelope only to new commands first.
- Whether `doctor` should perform a live API probe by default or require `--live` for network checks.
- Whether structured observability steps should be included only with `--verbose` or always included in JSON.
- Whether `api` should accept inline JSON with `--json` in addition to `--input`.

## Recommendation

Implement in this order:

1. `CAP1`: low mutation risk, high discovery value.
2. `DISC1 doctor`: high operational value for both agents and humans.
3. `OBS1 step tracing`: makes later API behavior easier to debug.
4. `API1`: highest value for agents, but should sit on top of the stable result and discovery contracts.
