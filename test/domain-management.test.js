import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(testDir, "..", "bin", "cloudns.js");
const cleanupPaths = new Set();
const CLI_TEST_TIMEOUT_MS = 30_000;

after(async () => {
  await Promise.all([...cleanupPaths].map(async (path) => await rm(path, { recursive: true, force: true })));
});

test("unknown command fails with usage exit code 2", async () => {
  const result = await runCli(["wat"]);

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage/);
});

test("zone list paginates and emits json", async () => {
  const result = await runCli(["zone", "list", "--format", "json"], {
    responses: [
      { body: '{"one.com":{"name":"one.com"},"two.com":{"name":"two.com"}}' },
      { body: "{}" },
    ],
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    action: "zone list",
    status: "ok",
    recordsAffected: 2,
    data: [{ name: "one.com" }, { name: "two.com" }],
  });
  assert.equal(result.requests.length, 2);
  assert.match(result.requests[0].stdin, /page=1/);
  assert.match(result.requests[1].stdin, /page=2/);
});

test("zone list accepts the short format flag", async () => {
  const result = await runCli(["zone", "list", "-f", "json"], {
    responses: [{ body: '{"one.com":{"name":"one.com"}}' }],
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    action: "zone list",
    status: "ok",
    recordsAffected: 1,
    data: [{ name: "one.com" }],
  });
});

test("zone list plain output includes zone names", async () => {
  const result = await runCli(["zone", "list"], {
    responses: [{ body: '{"one.com":{"name":"one.com"},"two.com":{"name":"two.com"}}' }],
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^✓ zone list · 2 zones · ok\n/m);
  assert.match(result.stdout, /- one\.com/);
  assert.match(result.stdout, /- two\.com/);
});

test("zone list works with direct transport", async () => {
  const result = await runCli(["zone", "list"], {
    envText: directEnv(),
    responses: [{ body: '{"one.com":{"name":"one.com"}}' }],
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^✓ zone list · 1 zones · ok\n/m);
  assert.equal(result.requests.length, 2);
  assert.match(result.requests[0].args, /https:\/\/api\.cloudns\.net\/dns\/list-zones\.json/);
});

test("zone list reports direct transport failures as transport errors", async () => {
  const result = await runCli(["zone", "list"], {
    envText: directEnv(),
    responses: [{ exitCode: 7, stderr: "curl: (7) failed" }],
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "✗ api · 0 records affected · Direct transport failed\n");
  assert.equal(result.stderr, "");
});

test("zone add skips existing zones", async () => {
  const result = await runCli(["zone", "add", "one.com"], {
    responses: [{ body: '{"one.com":{"name":"one.com"}}' }],
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "skipped zone add · 0 records affected · already exists\n");
  assert.equal(result.requests.length, 1);
});

test("zone add dry-run does not call register and exits 3", async () => {
  const result = await runCli(["zone", "add", "new.com", "--dry-run"], {
    responses: [{ body: "{}" }],
  });

  assert.equal(result.code, 3);
  assert.equal(result.stdout, "skipped zone add · 0 records affected · dry-run\n");
  assert.equal(result.requests.length, 1);
  assert.doesNotMatch(result.requests[0].args, /register\.json/);
});

test("zone rm requires confirm", async () => {
  const result = await runCli(["zone", "rm", "one.com"]);

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage/);
  assert.equal(result.requests.length, 0);
});

test("record add skips duplicate A record", async () => {
  const result = await runCli(
    ["record", "add", "one.com", "--type", "A", "--name", "@", "--value", "192.0.2.1"],
    {
      responses: [
        {
          body:
            '{"10":{"id":"10","type":"A","host":"@","record":"192.0.2.1","ttl":"3600"}}',
        },
      ],
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "skipped record add · 0 records affected · already exists\n");
  assert.equal(result.requests.length, 1);
});

test("record add sends record-type, host, record, and ttl", async () => {
  const result = await runCli(
    ["record", "add", "one.com", "--type", "A", "--name", "www", "--value", "192.0.2.2"],
    {
      responses: [{ body: "{}" }, { body: '{"status":"Success","data":{"id":"11"}}' }],
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "✓ record add · 1 records affected · ok\n");
  assert.match(result.requests[1].args, /add-record\.json/);
  assert.match(result.requests[1].stdin, /record-type=A/);
  assert.match(result.requests[1].stdin, /host=www/);
  assert.match(result.requests[1].stdin, /record=192.0.2.2/);
  assert.match(result.requests[1].stdin, /ttl=3600/);
});

test("record add accepts short aliases for transport and record flags", async () => {
  const result = await runCli(
    ["record", "add", "one.com", "-t", "ssh", "-T", "A", "-N", "www", "-V", "192.0.2.2"],
    {
      responses: [{ body: "{}" }, { body: '{"status":"Success","data":{"id":"11"}}' }],
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "✓ record add · 1 records affected · ok\n");
  assert.match(result.requests[1].stdin, /record-type=A/);
  assert.match(result.requests[1].stdin, /host=www/);
  assert.match(result.requests[1].stdin, /record=192.0.2.2/);
});

test("record list plain output includes record rows", async () => {
  const result = await runCli(["record", "list", "one.com"], {
    responses: [
      {
        body:
          '{"10":{"id":"10","type":"A","host":"@","record":"192.0.2.1","ttl":"3600"},"11":{"id":"11","type":"TXT","host":"@","record":"hello","ttl":"7200"}}',
      },
    ],
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^✓ record list · 2 records · ok\n/m);
  assert.match(result.stdout, /- A · @ · 192\.0\.2\.1 · ttl 3600/);
  assert.match(result.stdout, /- TXT · @ · hello · ttl 7200/);
});

test("record rm by ambiguous match exits 2 and prints candidate ids", async () => {
  const result = await runCli(["record", "rm", "one.com", "--type", "TXT", "--name", "@", "--confirm"], {
    responses: [
      {
        body:
          '{"10":{"id":"10","type":"TXT","host":"@","record":"one"},"11":{"id":"11","type":"TXT","host":"@","record":"two"}}',
      },
    ],
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /ambiguous/);
  assert.match(result.stdout, /10/);
  assert.match(result.stdout, /11/);
});

test("record rm requires confirm", async () => {
  const result = await runCli(["record", "rm", "one.com", "--id", "10"]);

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage · record rm requires --confirm\n$/);
  assert.equal(result.requests.length, 0);
});

test("preset diff json emits add/remove objects only", async () => {
  const result = await runCli(["preset", "diff", "one.com", "fastmail", "--format", "json"], {
    files: {
      "templates/fastmail.yaml": [
        "name: fastmail",
        "records:",
        "  - type: MX",
        "    name: '@'",
        "    value: in1-smtp.messagingengine.com",
        "    priority: 10",
        "",
      ].join("\n"),
    },
    responses: [{ body: "{}" }],
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), [
    { action: "add", type: "MX", name: "@", value: "in1-smtp.messagingengine.com" },
  ]);
});

test("preset diff with missing preset returns a usage error", async () => {
  const result = await runCli(["preset", "diff", "one.com", "missing"]);

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage · preset not found: missing\n$/);
  assert.equal(result.requests.length, 0);
});

test("preset diff rejects names that escape the templates directory", async () => {
  const result = await runCli(["preset", "diff", "one.com", "../escape"], {
    files: {
      "escape.yaml": [
        "name: ../escape",
        "records:",
        "  - type: TXT",
        "    name: '@'",
        "    value: escaped",
        "",
      ].join("\n"),
    },
    responses: [{ body: "{}" }],
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage · invalid preset name: \.\.\/escape\n$/);
  assert.equal(result.requests.length, 0);
});

test("preset diff with invalid YAML returns a usage error", async () => {
  const result = await runCli(["preset", "diff", "one.com", "broken"], {
    files: {
      "templates/broken.yaml": "name: broken\nrecords: [\n",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage · preset broken contains invalid YAML:/);
  assert.equal(result.requests.length, 0);
});

test("preset diff rejects documentation-only presets marked unsafe to apply", async () => {
  const result = await runCli(["preset", "diff", "one.com", "manual-only"], {
    files: {
      "templates/manual-only.yaml": [
        "name: manual-only",
        "agent_hints:",
        "  safe_to_apply: false",
        "records:",
        "  - type: TXT",
        "    name: '@'",
        "    value: literal-value",
        "",
      ].join("\n"),
    },
  });

  assert.equal(result.code, 2);
  assert.match(
    result.stdout,
    /^✗ usage · preset manual-only is documentation-only and cannot be applied automatically\n$/,
  );
  assert.equal(result.requests.length, 0);
});

test("preset diff rejects unresolved placeholders in preset records", async () => {
  const result = await runCli(["preset", "diff", "one.com", "placeholder"], {
    files: {
      "templates/placeholder.yaml": [
        "name: placeholder",
        "records:",
        "  - type: TXT",
        "    host: '@'",
        "    value: token=<replace-me>",
        "",
      ].join("\n"),
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage · preset placeholder contains unresolved placeholders\n$/);
  assert.equal(result.requests.length, 0);
});

test("preset diff plain output includes grouped changes", async () => {
  const result = await runCli(["preset", "diff", "one.com", "fastmail"], {
    files: {
      "templates/fastmail.yaml": [
        "name: fastmail",
        "records:",
        "  - type: MX",
        "    name: '@'",
        "    value: in1-smtp.messagingengine.com",
        "    priority: 10",
        "",
      ].join("\n"),
    },
    responses: [{ body: '{"10":{"id":"10","type":"TXT","host":"@","record":"old","ttl":"3600"}}' }],
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^✓ preset diff · 2 changes · ok\n/m);
  assert.match(result.stdout, /additions:\n  - MX · @ · in1-smtp\.messagingengine\.com/);
  assert.match(result.stdout, /removals:\n  - TXT · @ · old/);
});

test("preset apply dry-run exits 3 without mutating", async () => {
  const result = await runCli(["preset", "apply", "one.com", "fastmail", "--dry-run"], {
    files: {
      "templates/fastmail.yaml": [
        "name: fastmail",
        "records:",
        "  - type: TXT",
        "    name: '@'",
        "    value: v=spf1 include:spf.messagingengine.com ?all",
        "",
      ].join("\n"),
    },
    responses: [{ body: "{}" }],
  });

  assert.equal(result.code, 3);
  assert.match(result.stdout, /^skipped preset apply · 1 changes · dry-run\n/m);
  assert.match(result.stdout, /additions:\n  - TXT · @ · v=spf1 include:spf\.messagingengine\.com \?all · ttl 3600/);
  assert.equal(result.requests.length, 1);
});

test("backup create json writes normalized records without secrets", async () => {
  const result = await runCli(["backup", "create", "one.com", "--output", "backup.json"], {
    responses: [
      {
        body: '{"10":{"id":"10","type":"A","host":"@","record":"192.0.2.1","ttl":"3600"}}',
      },
    ],
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^✓ backup create · 1 records affected · ok\n/);
  assert.match(result.stdout, /wrote .*backup\.json\n$/);
  const backup = JSON.parse(await readFile(join(result.projectDir, "backup.json"), "utf8"));
  assert.equal(backup.zone, "one.com");
  assert.deepEqual(backup.records, [
    { id: "10", type: "A", name: "@", value: "192.0.2.1", ttl: 3600 },
  ]);
  assert.doesNotMatch(JSON.stringify(backup), /auth-password|VPS|ssh/i);
});

test("backup create bind writes raw export", async () => {
  const result = await runCli(
    ["backup", "create", "one.com", "--format", "bind", "--output", "backup.zone"],
    {
      responses: [{ body: "$ORIGIN one.com.\\n@ 3600 IN A 192.0.2.1", raw: true }],
    },
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^✓ backup create · 0 records affected · ok\n/);
  assert.match(result.stdout, /wrote .*backup\.zone \(bind\)\n$/);
  assert.equal(await readFile(join(result.projectDir, "backup.zone"), "utf8"), "$ORIGIN one.com.\\n@ 3600 IN A 192.0.2.1");
});

test("zone list with missing .env returns a useful usage error", async () => {
  const result = await runCli(["zone", "list"], { envText: null });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage · could not read \.env file\n$/);
  assert.equal(result.requests.length, 0);
});

test("refresh-templates is rejected as not implemented", async () => {
  const result = await runCli(["preset", "diff", "one.com", "fastmail", "--refresh-templates"], {
    files: {
      "templates/fastmail.yaml": "name: fastmail\nrecords:\n  - type: TXT\n    name: '@'\n    value: ok\n",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage · --refresh-templates is not implemented\n$/);
  assert.equal(result.requests.length, 0);
});

test("zone list rejects an invalid CloudNS status marker", async () => {
  const result = await runCli(["zone", "list"], {
    responses: [{ body: "{}", httpStatus: "" }],
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /^✗ api · 0 records affected · CloudNS API rejected request\n$/);
  assert.equal(result.requests.length, 1);
});

test("backup create honors absolute output paths", async () => {
  const absoluteOutput = join(tmpdir(), `cloudns-absolute-${Date.now()}.json`);
  cleanupPaths.add(absoluteOutput);
  const result = await runCli(["backup", "create", "one.com", "--output", absoluteOutput], {
    responses: [
      {
        body: '{"10":{"id":"10","type":"A","host":"@","record":"192.0.2.1","ttl":"3600"}}',
      },
    ],
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`wrote ${escapeRegExp(absoluteOutput)}\\n$`));
  const backup = JSON.parse(await readFile(absoluteOutput, "utf8"));
  assert.equal(backup.zone, "one.com");
  assert.equal(typeof backup.createdAt, "string");
  assert.deepEqual(backup.records, [{ id: "10", type: "A", name: "@", value: "192.0.2.1", ttl: 3600 }]);
});

test("backup restore json dry-run plans adds and removes without mutating", async () => {
  const backup = {
    zone: "one.com",
    records: [{ type: "A", name: "@", value: "192.0.2.2", ttl: 3600 }],
  };
  const result = await runCli(
    ["backup", "restore", "one.com", "--input", "backup.json", "--confirm", "--dry-run"],
    {
      files: { "backup.json": JSON.stringify(backup) },
      responses: [
        {
          body: '{"10":{"id":"10","type":"A","host":"@","record":"192.0.2.1","ttl":"3600"}}',
        },
      ],
    },
  );

  assert.equal(result.code, 3);
  assert.match(result.stdout, /^skipped backup restore · 2 changes · dry-run\n/m);
  assert.match(result.stdout, /additions:\n  - A · @ · 192\.0\.2\.2 · ttl 3600/);
  assert.match(result.stdout, /removals:\n  - A · @ · 192\.0\.2\.1 · ttl 3600/);
  assert.equal(result.requests.length, 1);
});

test("backup restore rejects backup files for a different zone", async () => {
  const backup = {
    zone: "two.com",
    records: [{ type: "A", name: "@", value: "192.0.2.2", ttl: 3600 }],
  };
  const result = await runCli(["backup", "restore", "one.com", "--input", "backup.json", "--confirm"], {
    files: { "backup.json": JSON.stringify(backup) },
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ usage · backup zone mismatch: file is for two\.com, not one\.com\n$/);
  assert.equal(result.requests.length, 0);
});

test("preset remove dry-run reports preset-owned removals", async () => {
  const result = await runCli(["preset", "remove", "one.com", "fastmail", "--dry-run"], {
    files: {
      "templates/fastmail.yaml": [
        "name: fastmail",
        "records:",
        "  - type: TXT",
        "    name: '@'",
        "    value: old",
        "",
      ].join("\n"),
    },
    responses: [
      {
        body:
          '{"10":{"id":"10","type":"TXT","host":"@","record":"old","ttl":"3600"},"11":{"id":"11","type":"A","host":"@","record":"192.0.2.1","ttl":"3600"}}',
      },
    ],
  });

  assert.equal(result.code, 3);
  assert.match(result.stdout, /^skipped preset remove · 1 changes · dry-run\n/m);
  assert.match(result.stdout, /removals:\n  - TXT · @ · old · ttl 3600/);
});

test("preset remove deletes only records owned by the preset", async () => {
  const result = await runCli(["preset", "remove", "one.com", "fastmail"], {
    files: {
      "templates/fastmail.yaml": [
        "name: fastmail",
        "records:",
        "  - type: TXT",
        "    name: '@'",
        "    value: old",
        "",
      ].join("\n"),
    },
    responses: [
      {
        body:
          '{"10":{"id":"10","type":"TXT","host":"@","record":"old","ttl":"3600"},"11":{"id":"11","type":"A","host":"@","record":"192.0.2.1","ttl":"3600"}}',
      },
      { body: '{"status":"Success"}' },
    ],
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "✓ preset remove · 1 records affected · ok\n");
  assert.equal(result.requests.length, 2);
  assert.match(result.requests[1].args, /delete-record\.json/);
  assert.match(result.requests[1].stdin, /record-id=10/);
  assert.doesNotMatch(result.requests[1].stdin, /record-id=11/);
});

test("preset remove with no matching preset records makes no deletions", async () => {
  const result = await runCli(["preset", "remove", "one.com", "fastmail"], {
    files: {
      "templates/fastmail.yaml": [
        "name: fastmail",
        "records:",
        "  - type: TXT",
        "    name: '@'",
        "    value: old",
        "",
      ].join("\n"),
    },
    responses: [
      {
        body:
          '{"11":{"id":"11","type":"A","host":"@","record":"192.0.2.1","ttl":"3600"}}',
      },
    ],
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "✓ preset remove · 0 records affected · ok\n");
  assert.equal(result.requests.length, 1);
});

async function runCli(args, { responses = [], files = {}, envText = validEnv() } = {}) {
  const projectDir = await mkdtemp(join(tmpdir(), "cloudns-domain-"));
  cleanupPaths.add(projectDir);
  const fakeBin = join(projectDir, "bin");
  const stateDir = join(projectDir, "state");
  await mkdir(fakeBin);
  await mkdir(stateDir);
  if (envText !== null) {
    await writeFile(join(projectDir, ".env"), envText);
  }

  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(projectDir, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }

  const responsesPath = join(stateDir, "responses.json");
  const requestsPath = join(stateDir, "requests.jsonl");
  await writeFile(responsesPath, JSON.stringify(responses));
  await writeFile(requestsPath, "");
  await writeFile(
    join(fakeBin, "ssh"),
    createFakeTransportScript(),
  );
  await chmod(join(fakeBin, "ssh"), 0o755);
  await writeFile(
    join(fakeBin, "curl"),
    createFakeTransportScript(),
  );
  await chmod(join(fakeBin, "curl"), 0o755);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    CLOUDNS_TEST_RESPONSES: responsesPath,
    CLOUDNS_TEST_REQUESTS: requestsPath,
  };

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, ...args], {
      cwd: projectDir,
      env,
      timeout: CLI_TEST_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr, projectDir, requests: await readRequests(requestsPath) };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      projectDir,
      requests: await readRequests(requestsPath),
    };
  }
}

function createFakeTransportScript() {
  return [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const responsesPath = process.env.CLOUDNS_TEST_RESPONSES;",
    "const requestsPath = process.env.CLOUDNS_TEST_REQUESTS;",
    "const responses = JSON.parse(fs.readFileSync(responsesPath, 'utf8'));",
    "const stdin = fs.readFileSync(0, 'utf8');",
    "fs.appendFileSync(requestsPath, JSON.stringify({ args: process.argv.slice(2).join('\\n'), stdin }) + '\\n');",
    "const response = responses.shift() || { body: '{}' };",
    "fs.writeFileSync(responsesPath, JSON.stringify(responses));",
    "if (response.exitCode) { if (response.stderr) process.stderr.write(response.stderr); process.exit(response.exitCode); }",
    "if (response.raw) { process.stdout.write(response.body); process.stdout.write('\\n__CLOUDNS_HTTP_STATUS__:' + (response.httpStatus ?? 200) + '\\n'); process.exit(0); }",
    "process.stdout.write(response.body);",
    "process.stdout.write('\\n__CLOUDNS_HTTP_STATUS__:' + (response.httpStatus ?? 200) + '\\n');",
    "",
  ].join("\n");
}

async function readRequests(requestsPath) {
  const text = await readFile(requestsPath, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function validEnv() {
  return [
    "CLOUDNS_TRANSPORT=ssh",
    "CLOUDNS_AUTH_ID=auth-id-123",
    "CLOUDNS_AUTH_PASSWORD=auth-password-123",
    "VPS_HOST=example-vps",
    "VPS_USER=ops",
    "VPS_SSH_KEY=/tmp/cloudns-test-key",
    "",
  ].join("\n");
}

function directEnv() {
  return [
    "CLOUDNS_TRANSPORT=direct",
    "CLOUDNS_AUTH_ID=auth-id-123",
    "CLOUDNS_AUTH_PASSWORD=auth-password-123",
    "",
  ].join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
