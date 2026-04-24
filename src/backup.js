import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeRecordLike, recordsEquivalent } from "./cloudns-client.js";

export async function writeBackup(path, backup) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(backup, null, 2));
}

export async function writeRawBackup(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

export async function readJsonBackup(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || !Array.isArray(parsed.records)) {
    throw new BackupError("invalid backup");
  }
  return {
    zone: parsed.zone,
    createdAt: parsed.createdAt,
    records: parsed.records.map((record) => normalizeRecordLike(record)),
  };
}

export function planRestore(backupRecords, liveRecords) {
  const additions = backupRecords.filter(
    (backupRecord) => !liveRecords.some((liveRecord) => recordsEquivalent(liveRecord, backupRecord)),
  );
  const removals = liveRecords.filter(
    (liveRecord) => !backupRecords.some((backupRecord) => recordsEquivalent(liveRecord, backupRecord)),
  );
  return { additions, removals };
}

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupError";
  }
}
