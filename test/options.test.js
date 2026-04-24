import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, UsageError } from "../src/options.js";

test("parseArgs accepts --transport with a valid value", () => {
  const parsed = parseArgs(["auth", "check", "--transport", "direct"]);

  assert.deepEqual(parsed.positionals, ["auth", "check"]);
  assert.equal(parsed.flags.transport, "direct");
});

test("parseArgs accepts short aliases for common flags", () => {
  const parsed = parseArgs([
    "record",
    "add",
    "example.com",
    "-t",
    "ssh",
    "-f",
    "json",
    "-n",
    "-y",
    "-T",
    "A",
    "-N",
    "www",
    "-V",
    "192.0.2.10",
  ]);

  assert.deepEqual(parsed.positionals, ["record", "add", "example.com"]);
  assert.equal(parsed.flags.transport, "ssh");
  assert.equal(parsed.flags.format, "json");
  assert.equal(parsed.flags.dryRun, true);
  assert.equal(parsed.flags.confirm, true);
  assert.equal(parsed.flags.type, "A");
  assert.equal(parsed.flags.name, "www");
  assert.equal(parsed.flags.value, "192.0.2.10");
});

test("parseArgs rejects invalid transport values", () => {
  assert.throws(
    () => parseArgs(["auth", "check", "--transport", "vpn"]),
    (error) => error instanceof UsageError && error.message === "transport must be ssh or direct",
  );
});

test("parseArgs rejects unknown short flags", () => {
  assert.throws(
    () => parseArgs(["zone", "list", "-z"]),
    (error) => error instanceof UsageError && error.message === "unknown flag -z",
  );
});
