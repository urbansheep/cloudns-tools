import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ConfigPromptAbortError, loadConfig } from "../src/config.js";
import { resolveTransport, TransportResolutionError } from "../src/transport/resolve-transport.js";

function makeMockTTYStdin(dataToEmit) {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.pauseCount = 0;
  stdin.setEncoding = () => {};
  stdin.pause = () => { stdin.pauseCount += 1; };
  // emit reactively when a data listener is added, so timing works
  // regardless of how much async work precedes the read
  stdin.on("newListener", (event) => {
    if (event === "data") {
      setImmediate(() => stdin.emit("data", dataToEmit));
    }
  });
  return stdin;
}

const cleanupPaths = new Set();

after(async () => {
  await Promise.all([...cleanupPaths].map(async (path) => await rm(path, { recursive: true, force: true })));
});

test("loadConfig accepts direct transport without VPS keys", async () => {
  const cwd = await writeEnv([
    "CLOUDNS_AUTH_ID=id-123",
    "CLOUDNS_AUTH_PASSWORD=password-123",
    "CLOUDNS_TRANSPORT=direct",
  ]);

  const loaded = await loadConfig(cwd, {
    flags: {},
    stdin: { isTTY: false },
    stdout: { isTTY: false, write() {} },
  });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.config.transport, "direct");
  assert.equal(loaded.config.cloudnsAuthId, "id-123");
  assert.equal(loaded.config.cloudnsAuthPassword, "password-123");
  assert.equal(loaded.config.vpsHost, undefined);
});

test("loadConfig requires VPS keys for ssh transport", async () => {
  const cwd = await writeEnv([
    "CLOUDNS_AUTH_ID=id-123",
    "CLOUDNS_AUTH_PASSWORD=password-123",
    "CLOUDNS_TRANSPORT=ssh",
  ]);

  const loaded = await loadConfig(cwd, {
    flags: {},
    stdin: { isTTY: false },
    stdout: { isTTY: false, write() {} },
  });

  assert.deepEqual(loaded, {
    ok: false,
    missingKeys: ["VPS_HOST", "VPS_USER", "VPS_SSH_KEY"],
  });
});

test("resolveTransport accepts matching CLI and env selectors", async () => {
  const transport = await resolveTransport({
    cliTransport: "direct",
    envTransport: "direct",
    stdin: { isTTY: false },
    stdout: { isTTY: false, write() {} },
  });

  assert.equal(transport, "direct");
});

test("resolveTransport rejects conflicting CLI and env selectors", async () => {
  await assert.rejects(
    async () =>
      await resolveTransport({
        cliTransport: "direct",
        envTransport: "ssh",
        stdin: { isTTY: false },
        stdout: { isTTY: false, write() {} },
      }),
    (error) =>
      error instanceof TransportResolutionError &&
      error.message === "transport selector conflict between CLI and env",
  );
});

test("resolveTransport fails fast without selector in non-interactive mode", async () => {
  await assert.rejects(
    async () =>
      await resolveTransport({
        stdin: { isTTY: false },
        stdout: { isTTY: false, write() {} },
      }),
    (error) =>
      error instanceof TransportResolutionError &&
      error.message === "transport must be set via --transport or CLOUDNS_TRANSPORT in non-interactive mode",
  );
});

test("resolveTransport prompts in interactive mode", async () => {
  const transport = await resolveTransport({
    stdin: { isTTY: true },
    stdout: { isTTY: true, write() {} },
    promptImpl: async () => "2",
  });

  assert.equal(transport, "direct");
});

test("loadConfig creates .env from .env.example and persists prompted transport", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cloudns-config-"));
  cleanupPaths.add(cwd);
  await writeFile(
    join(cwd, ".env.example"),
    ["CLOUDNS_TRANSPORT=", "CLOUDNS_AUTH_ID=", "CLOUDNS_AUTH_PASSWORD=", ""].join("\n"),
  );

  const loaded = await loadConfig(cwd, {
    flags: {},
    stdin: { isTTY: true },
    stdout: { isTTY: true, write() {} },
    promptImpl: async () => "direct",
    promptValueImpl: async () => "",
  });

  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.missingKeys, ["CLOUDNS_AUTH_ID", "CLOUDNS_AUTH_PASSWORD"]);

  const envText = await readFile(join(cwd, ".env"), "utf8");
  assert.match(envText, /^CLOUDNS_TRANSPORT=direct$/m);
});

test("loadConfig updates existing .env with prompted transport", async () => {
  const cwd = await writeEnv(["CLOUDNS_AUTH_ID=id-123", "CLOUDNS_AUTH_PASSWORD=password-123"]);

  const loaded = await loadConfig(cwd, {
    flags: {},
    stdin: { isTTY: true },
    stdout: { isTTY: true, write() {} },
    promptImpl: async () => "ssh",
    promptValueImpl: async () => "",
  });

  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.missingKeys, ["VPS_HOST", "VPS_USER", "VPS_SSH_KEY"]);

  const envText = await readFile(join(cwd, ".env"), "utf8");
  assert.match(envText, /^CLOUDNS_TRANSPORT=ssh$/m);
  assert.match(envText, /^CLOUDNS_AUTH_ID=id-123$/m);
});

test("loadConfig interactively fills missing direct-mode auth fields", async () => {
  const cwd = await writeEnv(["CLOUDNS_TRANSPORT=direct", "CLOUDNS_AUTH_ID=", "CLOUDNS_AUTH_PASSWORD="]);
  const prompts = [];
  const loaded = await loadConfig(cwd, {
    flags: {},
    stdin: { isTTY: true },
    stdout: { isTTY: true, write() {} },
    promptValueImpl: async ({ key, secret }) => {
      prompts.push({ key, secret });
      if (key === "CLOUDNS_AUTH_ID") {
        return "auth-id-123";
      }
      if (key === "CLOUDNS_AUTH_PASSWORD") {
        return "auth-password-123";
      }
      throw new Error(`unexpected key: ${key}`);
    },
  });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.config.transport, "direct");
  assert.equal(loaded.config.cloudnsAuthId, "auth-id-123");
  assert.equal(loaded.config.cloudnsAuthPassword, "auth-password-123");
  assert.deepEqual(prompts, [
    { key: "CLOUDNS_AUTH_ID", secret: false },
    { key: "CLOUDNS_AUTH_PASSWORD", secret: true },
  ]);

  const envText = await readFile(join(cwd, ".env"), "utf8");
  assert.match(envText, /^CLOUDNS_AUTH_ID=auth-id-123$/m);
  assert.match(envText, /^CLOUDNS_AUTH_PASSWORD=auth-password-123$/m);
});

test("loadConfig interactively fills missing ssh fields and preserves existing values", async () => {
  const cwd = await writeEnv([
    "CLOUDNS_TRANSPORT=ssh",
    "CLOUDNS_AUTH_ID=existing-id",
    "CLOUDNS_AUTH_PASSWORD=",
    "VPS_HOST=",
    "VPS_USER=ops",
    "VPS_SSH_KEY=",
  ]);
  const prompts = [];
  const loaded = await loadConfig(cwd, {
    flags: {},
    stdin: { isTTY: true },
    stdout: { isTTY: true, write() {} },
    promptValueImpl: async ({ key, secret }) => {
      prompts.push({ key, secret });
      if (key === "CLOUDNS_AUTH_PASSWORD") {
        return "auth-password-123";
      }
      if (key === "VPS_HOST") {
        return "example-vps";
      }
      if (key === "VPS_SSH_KEY") {
        return "/tmp/cloudns-test-key";
      }
      throw new Error(`unexpected key: ${key}`);
    },
  });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.config.transport, "ssh");
  assert.equal(loaded.config.cloudnsAuthId, "existing-id");
  assert.equal(loaded.config.cloudnsAuthPassword, "auth-password-123");
  assert.equal(loaded.config.vpsHost, "example-vps");
  assert.equal(loaded.config.vpsUser, "ops");
  assert.equal(loaded.config.vpsSshKey, "/tmp/cloudns-test-key");
  assert.deepEqual(prompts, [
    { key: "CLOUDNS_AUTH_PASSWORD", secret: true },
    { key: "VPS_HOST", secret: false },
    { key: "VPS_SSH_KEY", secret: false },
  ]);

  const envText = await readFile(join(cwd, ".env"), "utf8");
  assert.match(envText, /^CLOUDNS_AUTH_ID=existing-id$/m);
  assert.match(envText, /^CLOUDNS_AUTH_PASSWORD=auth-password-123$/m);
  assert.match(envText, /^VPS_HOST=example-vps$/m);
  assert.match(envText, /^VPS_USER=ops$/m);
  assert.match(envText, /^VPS_SSH_KEY=\/tmp\/cloudns-test-key$/m);
});

test("loadConfig aborts instead of persisting an empty secret when prompting is canceled", async () => {
  const cwd = await writeEnv(["CLOUDNS_TRANSPORT=direct", "CLOUDNS_AUTH_ID=id-123", "CLOUDNS_AUTH_PASSWORD="]);

  await assert.rejects(
    async () =>
      await loadConfig(cwd, {
        flags: {},
        stdin: { isTTY: true },
        stdout: { isTTY: true, write() {} },
        promptValueImpl: async ({ key }) => {
          if (key === "CLOUDNS_AUTH_PASSWORD") {
            throw new ConfigPromptAbortError("interactive setup canceled");
          }
          return "";
        },
      }),
    (error) => error instanceof ConfigPromptAbortError && error.message === "interactive setup canceled",
  );

  const envText = await readFile(join(cwd, ".env"), "utf8");
  assert.match(envText, /^CLOUDNS_AUTH_PASSWORD=$/m);
});

test("promptForTransport pauses stdin after reading transport selection", async () => {
  const stdin = makeMockTTYStdin("1");

  const transport = await resolveTransport({
    stdin,
    stdout: { isTTY: true, write() {} },
  });

  assert.equal(transport, "ssh");
  assert.equal(stdin.pauseCount, 1);
});

test("readLine pauses stdin after reading a config value", async () => {
  const cwd = await writeEnv(["CLOUDNS_TRANSPORT=direct", "CLOUDNS_AUTH_ID=", "CLOUDNS_AUTH_PASSWORD=pw-123"]);
  const stdin = makeMockTTYStdin("id-456\n");

  const loaded = await loadConfig(cwd, {
    flags: {},
    stdin,
    stdout: { isTTY: true, write() {} },
  });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.config.cloudnsAuthId, "id-456");
  assert.equal(stdin.pauseCount, 1);
});

async function writeEnv(lines) {
  const cwd = await mkdtemp(join(tmpdir(), "cloudns-config-"));
  cleanupPaths.add(cwd);
  await writeFile(join(cwd, ".env"), `${lines.join("\n")}\n`);
  return cwd;
}
