import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeRecordLike, recordsEquivalent } from "./cloudns-client.js";

const DEFAULT_FS = { mkdir, writeFile, rename, rm };

export async function writeBackup(path, backup, fs = DEFAULT_FS) {
  await atomicWriteFile(path, JSON.stringify(backup, null, 2), fs);
}

export async function writeRawBackup(path, contents, fs = DEFAULT_FS) {
  await atomicWriteFile(path, contents, fs);
}

async function atomicWriteFile(path, contents, fs) {
  const tmpPath = `${path}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    await fs.writeFile(tmpPath, contents);
    await fs.rename(tmpPath, path);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readJsonBackup(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed.zone !== "string" || parsed.zone.trim() === "" || !Array.isArray(parsed.records)) {
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
