---
verified: 2026-04-20
---

# CloudNS Tools Guide

## Configuration

The CLI reads `.env` from the current working directory.

Common required keys:

```text
CLOUDNS_TRANSPORT=ssh|direct
CLOUDNS_AUTH_ID=
CLOUDNS_AUTH_PASSWORD=
```

SSH mode additionally requires:

```text
VPS_HOST=
VPS_USER=
VPS_SSH_KEY=
```

Transport can also be selected per command with `--transport <ssh|direct>` or `-t <ssh|direct>`.

- `ssh`: run remote `curl` over the whitelisted VPS
- `direct`: run local `curl` on the current machine, intended for agents already running on the whitelisted VPS

If both env and CLI specify a transport, they must match. Otherwise the command exits with code `2`.

If neither env nor CLI specifies a transport:

- interactive TTY runs prompt once for transport selection
- non-interactive runs fail fast with exit code `2`

If `.env` is missing during an interactive first run, the CLI creates it from `.env.example`, persists the selected `CLOUDNS_TRANSPORT` value into the new `.env` file, and then prompts for any remaining missing required fields. Existing values are preserved, and secret fields such as `CLOUDNS_AUTH_PASSWORD` are captured without echoing the entered value back into terminal output.

SSH mode executes:

```bash
ssh -i "$VPS_SSH_KEY" "$VPS_USER@$VPS_HOST"
```

Direct mode executes local `curl` without SSH.

## Global Flags

- `-n`, `--dry-run`: preview write commands without mutating ClouDNS
- `-f`, `--format json`: emit structured JSON for agents and scripts
- `-t`, `--transport`: select `ssh` or `direct`
- `-v`, `--verbose`: emit diagnostic messages to `stderr` (transport selection, dry-run state); safe alongside `--format json` since verbose output never goes to `stdout`
- `-y`, `--confirm`: required for destructive commands
- `--refresh-templates`: reserved for future preset refresh behavior; currently not implemented
- `-T`, `--type`: record type selector
- `-N`, `--name`: record name selector
- `-V`, `--value`: record value selector
- `-o`, `--output`: backup output path

## Auth

```bash
cloudns auth check
cloudns auth check -t direct
```

Runs a read-only zones-list probe through the selected transport. Success exits `0`. Missing config or rejected credentials exit `2`.

## Zones

```bash
cloudns zone list
cloudns zone list -f json
cloudns zone add example.com
cloudns zone add example.com -n
cloudns zone rm example.com -y
```

`zone add` and `zone rm` are idempotent: adding an existing zone or removing an absent zone is a no-op and exits `0`. Removing a zone requires `--confirm`.
`zone list` prints zone names in plain text by default.

## Records

```bash
cloudns record list example.com
cloudns record add example.com --type A --name @ --value 192.0.2.1
cloudns record add example.com -T A -N @ -V 192.0.2.1
cloudns record rm example.com --id 12345 -y
cloudns record rm example.com --type TXT --name @ --value "v=spf1 -all" -y
```

Supported first-pass record types are `A`, `AAAA`, `MX`, `TXT`, `CNAME`, `NS`, `SRV`, and `CAA`. Default TTL is `3600`.
`record add` is idempotent: adding a record that already exists is a no-op and exits `0`.
`record list` prints record rows in plain text by default.
Removing records requires `--confirm`.

## Presets

```bash
cloudns preset diff example.com fastmail
cloudns preset diff example.com fastmail -f json
cloudns preset apply example.com fastmail
cloudns preset remove example.com fastmail -n
```

Preset files live in `templates/`. Apply and remove are idempotent: running the same command twice leaves the zone in the same state. `preset diff --format json` emits objects with `action`, `type`, `name`, and `value`.
Plain `preset diff` shows additions and removals in human-readable form.
Reference-only provider examples and source notes live in `docs/examples/`.
Templates that require manual lookup or still contain placeholders are intentionally kept out of `templates/`.

## Backup And Restore

```bash
cloudns backup create example.com -o backups/example.com.json
cloudns backup create example.com -f bind -o backups/example.com.zone
cloudns backup restore example.com --input backups/example.com.json -y -n
cloudns backup restore example.com --input backups/example.com.json -y
```

JSON backups are the safe restore format. BIND export is supported for archival use. BIND import is intentionally not the default restore path because ClouDNS import can replace existing records in bulk.
`backup create` prints the resolved output path in plain text. `backup restore --dry-run` prints the planned changes.

## Live Verification

Use a disposable test zone for live verification. Do not run destructive live commands without a fresh command-specific confirmation.

For agent automation, set transport explicitly with `CLOUDNS_TRANSPORT` or `-t/--transport`. Do not rely on interactive prompting in unattended runs.
