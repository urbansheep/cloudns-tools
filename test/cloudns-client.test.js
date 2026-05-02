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

test("listRecords rejects non-object record entries", async () => {
  const client = new CloudnsClient({
    async request() {
      return { 10: "not-a-record" };
    },
  });

  await assert.rejects(
    async () => await client.listRecords("one.com"),
    (error) =>
      error instanceof CloudnsApiError &&
      error.message === "CloudNS API returned an invalid record collection",
  );
});

test("listRecords fails hard when record pagination exceeds the cap", async () => {
  let calls = 0;
  const page = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      String(index),
      { type: "A", host: `host-${index}`, record: "192.0.2.1", ttl: "3600" },
    ]),
  );
  const client = new CloudnsClient({
    async request() {
      calls += 1;
      return calls <= 501 ? page : {};
    },
  });

  await assert.rejects(
    async () => await client.listRecords("one.com"),
    (error) =>
      error instanceof CloudnsApiError &&
      error.message === "CloudNS record pagination limit exceeded",
  );
});
