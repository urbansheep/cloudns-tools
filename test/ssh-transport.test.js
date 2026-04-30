import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SshCloudnsTransport } from "../src/transport/ssh-cloudns.js";
import { SshTransportError } from "../src/transport/cloudns-transport-core.js";

test("SshCloudnsTransport preserves stderr on command failures", async () => {
  const transport = new SshCloudnsTransport({
    cloudnsAuthId: "id-123",
    cloudnsAuthPassword: "password-123",
    vpsHost: "example-vps",
    vpsUser: "ops",
    vpsSshKey: "/tmp/cloudns-test-key",
    spawnImpl: createSpawnStub([{ code: 255, stderr: "Host key verification failed" }]),
  });

  await assert.rejects(
    async () => await transport.listZones(),
    (error) =>
      error instanceof SshTransportError &&
      error.message === "SSH transport failed" &&
      error.stderr === "Host key verification failed",
  );
});

function createSpawnStub(responses) {
  return function spawnStub() {
    const response = responses.shift();
    const child = new FakeChildProcess();
    queueMicrotask(() => {
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
