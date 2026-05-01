import assert from "node:assert/strict";
import test from "node:test";
import { writeBackup } from "../src/backup.js";

test("writeBackup writes to a temporary file before replacing the target", async () => {
  const calls = [];
  const targetPath = "/tmp/cloudns-backup-test/backup.json";

  await assert.rejects(
    async () =>
      await writeBackup(
        targetPath,
        { zone: "one.com", records: [] },
        {
          mkdir: async (path, options) => calls.push(["mkdir", path, options]),
          writeFile: async (path) => {
            calls.push(["writeFile", path]);
            throw new Error("disk full");
          },
          rename: async (from, to) => calls.push(["rename", from, to]),
          rm: async (path, options) => calls.push(["rm", path, options]),
        },
      ),
    /disk full/,
  );

  assert.deepEqual(calls.map((call) => call[0]), ["mkdir", "writeFile", "rm"]);
  assert.equal(calls[1][1], `${targetPath}.tmp`);
});
