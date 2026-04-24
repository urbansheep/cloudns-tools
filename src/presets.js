import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { normalizeRecordLike, recordsEquivalent } from "./cloudns-client.js";

const SUPPORTED_TYPES = new Set(["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SRV", "CAA"]);
const PRESET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function loadPreset(cwd, name) {
  if (!PRESET_NAME_PATTERN.test(name)) {
    throw new PresetError(`invalid preset name: ${name}`);
  }

  const path = join(cwd, "templates", `${name}.yaml`);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new PresetError(`preset not found: ${name}`);
    }
    throw error;
  }

  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new PresetError(`preset ${name} contains invalid YAML: ${error.message}`);
  }
  if (!parsed || parsed.name !== name || !Array.isArray(parsed.records)) {
    throw new PresetError(`invalid preset ${name}`);
  }
  if (parsed.agent_hints?.safe_to_apply === false) {
    throw new PresetError(`preset ${name} is documentation-only and cannot be applied automatically`);
  }

  const records = parsed.records.map((record) => normalizeRecordLike(record));
  for (const record of records) {
    if (!SUPPORTED_TYPES.has(record.type) || !record.name || !record.value) {
      throw new PresetError(`invalid preset ${name}`);
    }
    if (hasUnresolvedPlaceholder(record.name) || hasUnresolvedPlaceholder(record.value)) {
      throw new PresetError(`preset ${name} contains unresolved placeholders`);
    }
  }

  return { name, description: parsed.description ?? "", records };
}

// Diff mode answers: "what must change in the live zone to match this preset?"
export function diffPreset(presetRecords, liveRecords) {
  const additions = presetRecords
    .filter((presetRecord) => !liveRecords.some((liveRecord) => recordsEquivalent(liveRecord, presetRecord)))
    .map((record) => ({ action: "add", type: record.type, name: record.name, value: record.value, record }));

  const driftRemovals = liveRecords
    .filter((liveRecord) => !presetRecords.some((presetRecord) => recordsEquivalent(liveRecord, presetRecord)))
    .map((record) => ({ action: "remove", type: record.type, name: record.name, value: record.value, record }));

  return { additions, driftRemovals };
}

// Remove mode answers: "which live records belong to this preset and should be un-applied?"
export function presetOwnedRemovals(presetRecords, liveRecords) {
  return liveRecords
    .filter((liveRecord) => presetRecords.some((presetRecord) => recordsEquivalent(liveRecord, presetRecord)))
    .map((record) => ({ action: "remove", type: record.type, name: record.name, value: record.value, record }));
}

export class PresetError extends Error {
  constructor(message) {
    super(message);
    this.name = "PresetError";
  }
}

function hasUnresolvedPlaceholder(value) {
  return typeof value === "string" && (/<[^>]+>/.test(value) || /\{[^}]+\}/.test(value));
}
