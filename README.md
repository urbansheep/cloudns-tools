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

```bash
./bin/cloudns.js auth check
./bin/cloudns.js auth check -t direct
./bin/cloudns.js zone list
./bin/cloudns.js zone list -f json
./bin/cloudns.js record add example.com -T A -N www -V 192.0.2.10
./bin/cloudns.js preset diff example.com fastmail -f json
./bin/cloudns.js backup create example.com -o backups/example.com.json
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
