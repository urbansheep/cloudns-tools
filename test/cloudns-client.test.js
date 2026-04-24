import assert from "node:assert/strict";
import test from "node:test";
import { CloudnsClient } from "../src/cloudns-client.js";
import { CloudnsApiError } from "../src/transport/ssh-cloudns.js";

test("listZones fails hard when zone pagination exceeds the cap", async () => {
  const client = new CloudnsClient({
    async request() {
      return { "one.com": { name: "one.com" } };
    },
  });

  await assert.rejects(
    async () => await client.listZones(),
    (error) =>
      error instanceof CloudnsApiError &&
      error.message === "CloudNS zone pagination limit exceeded",
  );
});

test("zoneExists fails hard when zone pagination exceeds the cap", async () => {
  const client = new CloudnsClient({
    async request() {
      return { "one.com": { name: "one.com" } };
    },
  });

  await assert.rejects(
    async () => await client.zoneExists("missing.com"),
    (error) =>
      error instanceof CloudnsApiError &&
      error.message === "CloudNS zone pagination limit exceeded",
  );
});
