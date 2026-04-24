import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DirectCloudnsTransport } from "../src/transport/direct-cloudns.js";
import { CloudnsApiError, CloudnsAuthError, DirectTransportError } from "../src/transport/cloudns-transport-core.js";

test("DirectCloudnsTransport listZones succeeds", async () => {
  const spawnCalls = [];
  const transport = new DirectCloudnsTransport({
    cloudnsAuthId: "id-123",
    cloudnsAuthPassword: "password-123",
    spawnImpl: createSpawnStub(
      [
        {
          code: 0,
          stdout: '{"example.com":{"zone":"example.com"}}\n__CLOUDNS_HTTP_STATUS__:200',
        },
      ],
      spawnCalls,
    ),
  });

  const result = await transport.listZones();
  assert.deepEqual(result, { "example.com": { zone: "example.com" } });
  assert.equal(spawnCalls[0].command, "curl");
  assert.deepEqual(spawnCalls[0].args.slice(0, 6), [
    "-sS",
    "--connect-timeout",
    "10",
    "--max-time",
    "30",
    "--data-binary",
  ]);
});

test("DirectCloudnsTransport maps auth failures", async () => {
  const transport = new DirectCloudnsTransport({
    cloudnsAuthId: "id-123",
    cloudnsAuthPassword: "password-123",
    spawnImpl: createSpawnStub([
      {
        code: 0,
        stdout: '{"status":"Failed","statusDescription":"Authentication failed"}\n__CLOUDNS_HTTP_STATUS__:401',
      },
    ]),
  });

  await assert.rejects(
    async () => await transport.listZones(),
    (error) => error instanceof CloudnsAuthError && error.message === "CloudNS authentication failed",
  );
});

test("DirectCloudnsTransport maps api failures", async () => {
  const transport = new DirectCloudnsTransport({
    cloudnsAuthId: "id-123",
    cloudnsAuthPassword: "password-123",
    spawnImpl: createSpawnStub([
      {
        code: 0,
        stdout: '{"status":"Failed","statusDescription":"Unexpected upstream failure"}\n__CLOUDNS_HTTP_STATUS__:500',
      },
    ]),
  });

  await assert.rejects(
    async () => await transport.listZones(),
    (error) => error instanceof CloudnsApiError && error.message === "CloudNS API rejected the probe",
  );
});

test("DirectCloudnsTransport rejects invalid status markers", async () => {
  const transport = new DirectCloudnsTransport({
    cloudnsAuthId: "id-123",
    cloudnsAuthPassword: "password-123",
    spawnImpl: createSpawnStub([{ code: 0, stdout: "{}" }]),
  });

  await assert.rejects(
    async () => await transport.listZones(),
    (error) =>
      error instanceof CloudnsApiError && error.message === "CloudNS API returned an unexpected response",
  );
});

test("DirectCloudnsTransport surfaces local command failures", async () => {
  const transport = new DirectCloudnsTransport({
    cloudnsAuthId: "id-123",
    cloudnsAuthPassword: "password-123",
    spawnImpl: createSpawnStub([{ code: 7, stderr: "curl: (7) failed" }]),
  });

  await assert.rejects(
    async () => await transport.listZones(),
    (error) => error instanceof DirectTransportError && error.message === "Direct transport failed",
  );
});

function createSpawnStub(responses, calls = []) {
  return function spawnStub(command, args, options) {
    calls.push({ command, args, options });
    const response = responses.shift();
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      if (response.stdout) {
        child.stdout.emit("data", response.stdout);
      }
      if (response.stderr) {
        child.stderr.emit("data", response.stderr);
      }
      child.emit("close", response.code ?? 0);
    });
    return child;
  };
}

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeReadable();
    this.stderr = new FakeReadable();
    this.stdin = new FakeWritable();
  }

  kill() {}
}

class FakeReadable extends EventEmitter {
  setEncoding() {}
}

class FakeWritable {
  end() {}
}
