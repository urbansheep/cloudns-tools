import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(testDir, "..", "bin", "cloudns.js");
const cleanupPaths = new Set();

after(async () => {
  await Promise.all([...cleanupPaths].map(async (path) => await rm(path, { recursive: true, force: true })));
});

test("capabilities emits a machine-readable command contract without requiring config", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cloudns-capabilities-"));
  cleanupPaths.add(projectDir);
  await writeFile(join(projectDir, ".env.example"), "CLOUDNS_TRANSPORT=\n");

  const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, "capabilities", "-f", "json"], {
    cwd: projectDir,
  });
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "capabilities");
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.data.name, "cloudns-tools");
  assert.equal(parsed.data.schemaVersion, 1);
  assert.deepEqual(parsed.data.transports, ["ssh", "direct"]);
  assert.deepEqual(parsed.data.recordTypes, ["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SRV", "CAA"]);
  assert.ok(parsed.data.commands.some((command) => command.name === "record.add" && command.mutates === true));
  assert.ok(parsed.data.commands.some((command) => command.name === "backup.restore" && command.requiresConfirm === true));
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.errors, []);
});
