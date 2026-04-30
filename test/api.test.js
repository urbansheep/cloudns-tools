import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(testDir, "..", "bin", "cloudns.js");
const cleanupPaths = new Set();
const CLI_TEST_TIMEOUT_MS = 30_000;

after(async () => {
  await Promise.all([...cleanupPaths].map(async (path) => await rm(path, { recursive: true, force: true })));
});

test("api rejects unknown operations with a stable error object", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cloudns-api-unknown-"));
  cleanupPaths.add(projectDir);
  const result = await runApi(projectDir, {
    schemaVersion: 1,
    operation: "unknown.operation",
  });
  const parsed = JSON.parse(result.stdout);

  assert.equal(result.code, 2);
  assert.equal(result.stderr, "");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "api");
  assert.equal(parsed.status, "usage_error");
  assert.equal(parsed.exitCode, 2);
  assert.deepEqual(parsed.errors, [
    {
      code: "unknown_operation",
      message: "unknown operation: unknown.operation",
      category: "usage",
      retryable: false,
      details: { operation: "unknown.operation" },
    },
  ]);
});

test("api maps record.add dry-run requests to an agent envelope", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cloudns-api-record-"));
  cleanupPaths.add(projectDir);
  const fakeBin = join(projectDir, "bin");
  await mkdir(fakeBin);
  await writeFile(
    join(projectDir, ".env"),
    [
      "CLOUDNS_TRANSPORT=direct",
      "CLOUDNS_AUTH_ID=auth-id-123",
      "CLOUDNS_AUTH_PASSWORD=auth-password-123",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(fakeBin, "curl"),
    [
      "#!/bin/sh",
      "cat >/dev/null",
      "printf '%s\\n__CLOUDNS_HTTP_STATUS__:%s\\n' '{}' 200",
      "",
    ].join("\n"),
  );
  await chmod(join(fakeBin, "curl"), 0o755);

  const result = await runApi(
    projectDir,
    {
      schemaVersion: 1,
      operation: "record.add",
      options: {
        dryRun: true,
        transport: "direct",
      },
      target: {
        zone: "example.com",
      },
      record: {
        type: "A",
        name: "www",
        value: "192.0.2.10",
        ttl: 3600,
      },
    },
    { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
  );
  const parsed = JSON.parse(result.stdout);

  assert.equal(result.code, 3);
  assert.equal(result.stderr, "");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "record.add");
  assert.equal(parsed.status, "planned");
  assert.equal(parsed.exitCode, 3);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.target, { zone: "example.com" });
  assert.deepEqual(parsed.data, {
    action: "record add",
    status: "skipped",
    recordsAffected: 1,
  });
  assert.deepEqual(parsed.errors, []);
});

async function runApi(projectDir, request, env = {}) {
  const requestPath = join(projectDir, "request.json");
  await writeFile(requestPath, JSON.stringify(request));
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, "api", "--input", requestPath], {
      cwd: projectDir,
      env: { ...process.env, ...env },
      timeout: CLI_TEST_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}
