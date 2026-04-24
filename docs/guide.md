---
verified: 2026-04-20
---

# CloudNS Tools Guide

## Configuration

The CLI reads `.env` from the current working directory. Required keys:

```text
CLOUDNS_AUTH_ID=
CLOUDNS_AUTH_PASSWORD=
VPS_HOST=
VPS_USER=
VPS_SSH_KEY=
```

All API requests run as remote `curl` commands over:

```bash
ssh -i "$VPS_SSH_KEY" "$VPS_USER@$VPS_HOST"
```

## Global Flags

- `--dry-run`: preview write commands without mutating ClouDNS
- `--format json`: emit structured JSON for agents and scripts
- `--verbose`: reserved for detailed diagnostics
- `--confirm`: required for destructive commands
- `--refresh-templates`: reserved for future preset refresh behavior; currently not implemented

## Auth

```bash
./bin/cloudns.js auth check
```

Runs a read-only zones-list probe through the VPS. Success exits `0`. Missing config or rejected credentials exit `2`.

## Zones

```bash
./bin/cloudns.js zone list
./bin/cloudns.js zone add example.com
./bin/cloudns.js zone add example.com --dry-run
./bin/cloudns.js zone rm example.com --confirm
```

`zone add` and `zone rm` are idempotent. Removing a zone requires `--confirm`.
`zone list` prints zone names in plain text by default.

## Records

```bash
./bin/cloudns.js record list example.com
./bin/cloudns.js record add example.com --type A --name @ --value 192.0.2.1
./bin/cloudns.js record rm example.com --id 12345 --confirm
./bin/cloudns.js record rm example.com --type TXT --name @ --value "v=spf1 -all" --confirm
```

Supported first-pass record types are `A`, `AAAA`, `MX`, `TXT`, `CNAME`, `NS`, `SRV`, and `CAA`. Default TTL is `3600`.
`record list` prints record rows in plain text by default.
Removing records requires `--confirm`.

## Presets

```bash
./bin/cloudns.js preset diff example.com fastmail
./bin/cloudns.js preset diff example.com fastmail --format json
./bin/cloudns.js preset apply example.com fastmail
./bin/cloudns.js preset remove example.com fastmail --dry-run
```

Preset files live in `templates/`. Apply and remove are idempotent. `preset diff --format json` emits objects with `action`, `type`, `name`, and `value`.
Plain `preset diff` shows additions and removals in human-readable form.
Reference-only provider examples and source notes live in `docs/examples/`.
Templates that require manual lookup or still contain placeholders are intentionally kept out of `templates/`.

## Backup And Restore

```bash
./bin/cloudns.js backup create example.com --output backups/example.com.json
./bin/cloudns.js backup create example.com --format bind --output backups/example.com.zone
./bin/cloudns.js backup restore example.com --input backups/example.com.json --confirm --dry-run
./bin/cloudns.js backup restore example.com --input backups/example.com.json --confirm
```

JSON backups are the safe restore format. BIND export is supported for archival use. BIND import is intentionally not the default restore path because ClouDNS import can replace existing records in bulk.
`backup create` prints the resolved output path in plain text. `backup restore --dry-run` prints the planned changes.

## Live Verification

Use a disposable test zone for live verification. Do not run destructive live commands without a fresh command-specific confirmation.
