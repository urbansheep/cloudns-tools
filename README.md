# CloudNS Tools

DNS operations CLI for [ClouDNS](https://www.cloudns.net/) accounts reached through an IP-whitelisted VPS. It can run either from an operator machine through SSH, or directly on the whitelisted VPS itself. Target audience is agents managing DNS for their site-owners.

## Install

```bash
npm install
```

## Configure

Create `.env` in the project root:

```bash
cp .env.example .env
```

Fill in:

```text
CLOUDNS_TRANSPORT=ssh|direct
CLOUDNS_AUTH_ID=
CLOUDNS_AUTH_PASSWORD=
```

For `CLOUDNS_TRANSPORT=ssh`, also set:

```text
VPS_HOST=
VPS_USER=
VPS_SSH_KEY=
```

Transport selection can also be passed on the command line with `--transport` or `-t`.

- `ssh`: run API calls as remote `curl` commands over SSH on the whitelisted VPS
- `direct`: run local `curl` on the current machine, intended for agents already running on the whitelisted VPS

If both env and CLI transport selectors are present, they must match. If neither is set:

- interactive TTY runs prompt for transport selection once
- non-interactive runs fail fast with exit code `2`

On first interactive run, if `.env` is missing, the CLI creates it from `.env.example`, writes the selected `CLOUDNS_TRANSPORT` value back into `.env`, and then prompts for any remaining missing required fields. Secret fields such as `CLOUDNS_AUTH_PASSWORD` are captured without echoing the value back into terminal output.

In SSH mode, credentials are sent in POST data over SSH stdin and are not placed in the local SSH command line.

## Examples

### Auth check

```
$ ./bin/cloudns.js auth check -t direct
✓ CloudNS auth check ok

$ ./bin/cloudns.js auth check
✗ CloudNS auth check failed: transport must be set via --transport or CLOUDNS_TRANSPORT in non-interactive mode
```

### Zone list

```
$ ./bin/cloudns.js zone list
✓ zone list · 2 zones · ok
  - fieldnotes.net
  - fieldnotes.ru

$ ./bin/cloudns.js zone list -f json
{"action":"zone list","status":"ok","recordsAffected":2,"data":[{"name":"fieldnotes.net"},{"name":"fieldnotes.ru"}]}
```

### Record list

```
$ ./bin/cloudns.js record list fieldnotes.net
✓ record list · 5 records · ok
  - A · @ · 203.0.113.42 · ttl 3600
  - A · www · 203.0.113.42 · ttl 3600
  - MX · @ · in1-smtp.messagingengine.com · ttl 3600
  - TXT · @ · v=spf1 include:spf.messagingengine.com ?all · ttl 3600
  - CNAME · blog · ext.blogging.example · ttl 3600
```

### Record add — idempotent

```
$ ./bin/cloudns.js record add fieldnotes.net -T A -N dev -V 203.0.113.55
✓ record add · 1 records affected · ok

$ ./bin/cloudns.js record add fieldnotes.net -T A -N dev -V 203.0.113.55
skipped record add · 0 records affected · already exists
```

### Preset diff

```
$ ./bin/cloudns.js preset diff fieldnotes.net fastmail
✓ preset diff · 3 changes · ok
  additions:
  - MX · @ · in1-smtp.messagingengine.com
  - MX · @ · in2-smtp.messagingengine.com
  - TXT · @ · v=spf1 include:spf.messagingengine.com ?all
```

### Backup

```
$ ./bin/cloudns.js backup create fieldnotes.net
✓ backup create · 5 records affected · ok
wrote backups/fieldnotes.net-20260425T093000.json
```

## Exit Codes

- `0`: success
- `1`: API, SSH, or runtime failure
- `2`: config, auth, or usage failure
- `3`: dry-run prevented a write

See [docs/guide.md](docs/guide.md) for the full command reference.

Runtime-safe presets live in `templates/`.
The richer provider reference catalog lives in `docs/examples/`.

## Where Credit Is Due

Created with Claude Code, Codex, Perplexity, [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent and [Get Shit Done](https://github.com/gsd-build/get-shit-done/) by TÂCHES, in cross-review and careful testing.
