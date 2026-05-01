import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
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

test("doctor reports missing transport without creating .env", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cloudns-doctor-missing-"));
  cleanupPaths.add(projectDir);
  await writeFile(join(projectDir, ".env.example"), "CLOUDNS_TRANSPORT=\n");

  const result = await runDoctor(projectDir);
  const parsed = JSON.parse(result.stdout);

  assert.equal(result.code, 2);
  assert.equal(result.stderr, "");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "doctor");
  assert.equal(parsed.status, "config_error");
  assert.equal(parsed.exitCode, 2);
  assert.ok(parsed.checks.some((check) => check.id === "transport.selected" && check.status === "fail"));
  assert.ok(parsed.errors.some((error) => error.code === "transport_required" && error.category === "config"));
  await assert.rejects(async () => await access(join(projectDir, ".env"), constants.F_OK));
});

test("doctor succeeds for direct transport with a read-only API probe", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cloudns-doctor-direct-"));
  cleanupPaths.add(projectDir);
  const fakeBin = join(projectDir, "bin");
  const stdinPath = join(projectDir, "curl-stdin.txt");
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
      `cat > ${shellQuote(stdinPath)}`,
      "marker=$(printf '%s\\n' \"$@\" | sed -n \"s/.*__CLOUDNS_HTTP_STATUS_\\([^%]*:\\)%{http_code}.*/__CLOUDNS_HTTP_STATUS_\\1/p\" | head -n 1)",
      "printf '%s\\n%s%s\\n' '{\"example.com\":{\"zone\":\"example.com\"}}' \"$marker\" 200",
      "",
    ].join("\n"),
  );
  await chmod(join(fakeBin, "curl"), 0o755);

  const result = await runDoctor(projectDir, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` });
  const parsed = JSON.parse(result.stdout);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.transport.mode, "direct");
  assert.ok(parsed.checks.some((check) => check.id === "api.probe" && check.status === "pass"));

  const stdin = await readFile(stdinPath, "utf8");
  assert.match(stdin, /auth-id=auth-id-123/);
  assert.match(stdin, /auth-password=auth-password-123/);
});

test("doctor verbose json includes safe observability steps", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cloudns-doctor-observe-"));
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
      "marker=$(printf '%s\\n' \"$@\" | sed -n \"s/.*__CLOUDNS_HTTP_STATUS_\\([^%]*:\\)%{http_code}.*/__CLOUDNS_HTTP_STATUS_\\1/p\" | head -n 1)",
      "printf '%s\\n%s%s\\n' '{\"example.com\":{\"zone\":\"example.com\"}}' \"$marker\" 200",
      "",
    ].join("\n"),
  );
  await chmod(join(fakeBin, "curl"), 0o755);

  const result = await runDoctor(projectDir, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }, ["-v"]);
  const parsed = JSON.parse(result.stdout);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.ok(Array.isArray(parsed.observability.steps));
  assert.ok(parsed.observability.steps.some((step) => step.id === "api.probe" && step.status === "ok"));
  assert.doesNotMatch(result.stdout, /auth-password-123/);
});

test("doctor rejects unreadable SSH key paths before probing", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cloudns-doctor-ssh-key-"));
  cleanupPaths.add(projectDir);
  const keyPath = join(projectDir, "id_ed25519");
  await writeFile(keyPath, "not-a-real-key");
  await chmod(keyPath, 0o000);
  await writeFile(
    join(projectDir, ".env"),
    [
      "CLOUDNS_TRANSPORT=ssh",
      "CLOUDNS_AUTH_ID=auth-id-123",
      "CLOUDNS_AUTH_PASSWORD=auth-password-123",
      "VPS_HOST=example-vps",
      "VPS_USER=ops",
      `VPS_SSH_KEY=${keyPath}`,
      "",
    ].join("\n"),
  );

  const result = await runDoctor(projectDir);
  const parsed = JSON.parse(result.stdout);

  await chmod(keyPath, 0o600);
  assert.equal(result.code, 2);
  assert.equal(parsed.status, "config_error");
  assert.ok(parsed.checks.some((check) => check.id === "ssh.key_path" && check.status === "fail"));
  assert.ok(parsed.errors.some((error) => error.code === "ssh_key_not_found"));
  assert.ok(!parsed.checks.some((check) => check.id === "api.probe"));
});

async function runDoctor(projectDir, env = {}, extraArgs = []) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, "doctor", "-f", "json", ...extraArgs], {
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
