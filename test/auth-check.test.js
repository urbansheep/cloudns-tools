import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("missing .env keys fail with exit code 2", async () => {
  const result = await runAuthCheck({
    envText: ["CLOUDNS_TRANSPORT=direct", "CLOUDNS_AUTH_ID=123", ""].join("\n"),
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /^✗ CloudNS auth check failed:/);
  assert.match(result.stdout, /CLOUDNS_AUTH_PASSWORD/);
  assert.equal(result.stderr, "");
});

test("successful zones-list probe prints a success status and exits 0", async () => {
  const result = await runAuthCheck({
    envText: validEnv(),
    responseBody: '{"example.com":{"zone":"example.com"}}',
    httpStatus: 200,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "✓ CloudNS auth check ok\n");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /example\.com/);

  const sshArgs = await readFile(result.sshArgsPath, "utf8");
  assert.match(
    sshArgs,
    /^-i\n\/tmp\/cloudns-test-key\n-o\nBatchMode=yes\n-o\nConnectTimeout=10\n-o\nStrictHostKeyChecking=accept-new\nops@example-vps\ncurl -sS --connect-timeout 10 --max-time 30 --data-binary @- -w '\\n__CLOUDNS_HTTP_STATUS__:%\{http_code\}' 'https:\/\/api\.cloudns\.net\/dns\/list-zones\.json'\n$/,
  );

  const stdin = await readFile(result.stdinPath, "utf8");
  assert.match(stdin, /auth-id=auth-id-123/);
  assert.match(stdin, /auth-password=auth-password-123/);
  assert.match(stdin, /page=1/);
  assert.match(stdin, /rows-per-page=10/);
  assert.doesNotMatch(sshArgs, /auth-id=auth-id-123|auth-password=auth-password-123/);
});

test("CloudNS auth failure prints a failure status and exits 2", async () => {
  const result = await runAuthCheck({
    envText: validEnv(),
    responseBody: '{"status":"Failed","statusDescription":"Authentication failed"}',
    httpStatus: 401,
  });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "✗ CloudNS auth check failed: CloudNS auth rejected\n");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /Authentication failed/);
});

test("CloudNS HTTP auth failure with empty body still exits 2", async () => {
  const result = await runAuthCheck({
    envText: validEnv(),
    responseBody: "",
    httpStatus: 403,
  });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "✗ CloudNS auth check failed: CloudNS auth rejected\n");
  assert.equal(result.stderr, "");
});

test("CloudNS API failure prints a failure status and exits 1", async () => {
  const result = await runAuthCheck({
    envText: validEnv(),
    responseBody: '{"status":"Failed","statusDescription":"Unexpected upstream failure"}',
    httpStatus: 500,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "✗ CloudNS auth check failed: CloudNS API rejected the probe\n");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /Unexpected upstream failure/);
});

test("invalid CloudNS status marker prints API failure and exits 1", async () => {
  const result = await runAuthCheck({
    envText: validEnv(),
    responseBody: "{}",
    httpStatus: "",
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "✗ CloudNS auth check failed: CloudNS API rejected the probe\n");
  assert.equal(result.stderr, "");
});

test("SSH transport failure prints a failure status and exits 1", async () => {
  const result = await runAuthCheck({
    envText: validEnv(),
    transportExit: 255,
    transportStderr: "network down",
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "✗ CloudNS auth check failed: SSH transport failed\n");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /network down/);
});

test("direct transport via env succeeds without VPS keys", async () => {
  const result = await runAuthCheck({
    envText: directEnv(),
    responseBody: '{"example.com":{"zone":"example.com"}}',
    httpStatus: 200,
    transport: "direct",
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "✓ CloudNS auth check ok\n");

  const stdin = await readFile(result.stdinPath, "utf8");
  assert.match(stdin, /auth-id=auth-id-123/);
  assert.match(stdin, /auth-password=auth-password-123/);
});

test("direct transport via cli flag succeeds", async () => {
  const result = await runAuthCheck({
    envText: [
      "CLOUDNS_AUTH_ID=auth-id-123",
      "CLOUDNS_AUTH_PASSWORD=auth-password-123",
      "",
    ].join("\n"),
    responseBody: '{"example.com":{"zone":"example.com"}}',
    httpStatus: 200,
    transport: "direct",
    cliArgs: ["-t", "direct"],
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "✓ CloudNS auth check ok\n");
});

test("direct transport failure prints a failure status and exits 1", async () => {
  const result = await runAuthCheck({
    envText: directEnv(),
    transportExit: 7,
    transportStderr: "curl: (7) failed",
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "✗ CloudNS auth check failed: Direct transport failed\n");
  assert.equal(result.stderr, "");
});

test("conflicting CLI and env transports fail with exit code 2", async () => {
  const result = await runAuthCheck({
    envText: validEnv(),
    cliArgs: ["-t", "direct"],
  });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "✗ CloudNS auth check failed: transport selector conflict between CLI and env\n");
});

test("missing transport in non-interactive mode fails with exit code 2", async () => {
  const result = await runAuthCheck({
    envText: [
      "CLOUDNS_AUTH_ID=auth-id-123",
      "CLOUDNS_AUTH_PASSWORD=auth-password-123",
      "VPS_HOST=example-vps",
      "VPS_USER=ops",
      "VPS_SSH_KEY=/tmp/cloudns-test-key",
      "",
    ].join("\n"),
  });

  assert.equal(result.code, 2);
  assert.equal(
    result.stdout,
    "✗ CloudNS auth check failed: transport must be set via --transport or CLOUDNS_TRANSPORT in non-interactive mode\n",
  );
});

async function runAuthCheck({
  envText,
  responseBody,
  httpStatus,
  transportExit,
  transportStderr,
  transport,
  cliArgs = [],
}) {
  const projectDir = await mkdtemp(join(tmpdir(), "cloudns-auth-check-"));
  cleanupPaths.add(projectDir);
  const fakeBin = join(projectDir, "bin");
  const sshArgsPath = join(projectDir, "ssh-args.txt");
  const curlArgsPath = join(projectDir, "curl-args.txt");
  const stdinPath = join(projectDir, "ssh-stdin.txt");
  await mkdir(fakeBin);
  await writeFile(join(projectDir, ".env"), envText);
  const responseScript =
    responseBody === undefined
      ? ""
      : `printf '%s\\n__CLOUDNS_HTTP_STATUS__:%s\\n' ${shellQuote(responseBody)} ${shellQuote(
          String(httpStatus ?? 200),
        )}\n`;
  const failureScript =
    transportExit === undefined
      ? ""
      : `${transportStderr ? `printf '%s\\n' ${shellQuote(transportStderr)} >&2\n` : ""}exit ${transportExit}\n`;
  await writeFile(
    join(fakeBin, "ssh"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(sshArgsPath)}\ncat > ${shellQuote(stdinPath)}\n${responseScript}${failureScript}`,
  );
  await chmod(join(fakeBin, "ssh"), 0o755);
  await writeFile(
    join(fakeBin, "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(curlArgsPath)}\ncat > ${shellQuote(stdinPath)}\n${responseScript}${failureScript}`,
  );
  await chmod(join(fakeBin, "curl"), 0o755);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, "auth", "check", ...cliArgs],
      {
        cwd: projectDir,
        env,
        timeout: CLI_TEST_TIMEOUT_MS,
      },
    );
    return { code: 0, stdout, stderr, sshArgsPath, curlArgsPath, stdinPath, transport };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      sshArgsPath,
      curlArgsPath,
      stdinPath,
      transport,
    };
  }
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

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
