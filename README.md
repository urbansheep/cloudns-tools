# CloudNS Tools

DNS operations CLI for [ClouDNS](https://www.cloudns.net/) accounts reached through an IP-whitelisted VPS. Target audience is agents managing DNS for their site-owners.

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
CLOUDNS_AUTH_ID=
CLOUDNS_AUTH_PASSWORD=
VPS_HOST=
VPS_USER=
VPS_SSH_KEY=
```

All ClouDNS calls are run through SSH on the VPS. It's supposed that the host you are using is specifically whitelisted for API use in [ClouDNS admin panel](https://www.cloudns.net/api-settings/). Credentials are sent in POST data over SSH stdin and are not placed in the local SSH command line.

## Examples

```bash
./bin/cloudns.js auth check
./bin/cloudns.js zone list
./bin/cloudns.js record list example.com --format json
./bin/cloudns.js preset diff example.com fastmail --format json
./bin/cloudns.js backup create example.com --output backups/example.com.json
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
