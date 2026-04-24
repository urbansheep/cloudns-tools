import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import {
  CloudnsApiError,
  CloudnsAuthError,
  SshCloudnsTransport,
  SshTransportError,
} from "./transport/ssh-cloudns.js";
import { parseArgs, UsageError } from "./options.js";
import { ok, skipped, writeJson, writeResult } from "./output.js";
import { CloudnsClient, normalizeRecordLike, recordsEquivalent } from "./cloudns-client.js";
import { diffPreset, loadPreset, presetOwnedRemovals, PresetError } from "./presets.js";
import { BackupError, planRestore, readJsonBackup, writeBackup, writeRawBackup } from "./backup.js";

const WRITE_DRY_RUN_EXIT = 3;
const KNOWN_COMMANDS = {
  zone: new Set(["list", "add", "rm"]),
  record: new Set(["list", "add", "rm"]),
  preset: new Set(["diff", "apply", "remove"]),
  backup: new Set(["create", "restore"]),
};
const CONFIRMATION_MESSAGES = new Map([
  ["zone:rm", "zone rm requires --confirm"],
  ["record:rm", "record rm requires --confirm"],
  ["backup:restore", "backup restore requires --confirm"],
]);
const SUPPORTED_RECORD_TYPES = new Set(["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SRV", "CAA"]);

export async function runCli({ argv, cwd, stdout }) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return writeUsage(stdout, error.message);
  }

  const { positionals, flags } = parsed;
  const [group, action, ...args] = positionals;

  if (group === "auth" && action === "check" && args.length === 0) {
    return await runAuthCheck({ cwd, stdout });
  }

  try {
    if (!isKnownCommand(group, action)) {
      return writeUsage(stdout, "unknown command");
    }
    if (flags.refreshTemplates) {
      return writeUsage(stdout, "--refresh-templates is not implemented");
    }
    const confirmationMessage = getConfirmationMessage(group, action, flags);
    if (confirmationMessage) {
      return writeUsage(stdout, confirmationMessage);
    }

    const client = await loadClient(cwd);
    if (group === "zone") {
      return await runZoneCommand({ action, args, flags, stdout, client });
    }
    if (group === "record") {
      return await runRecordCommand({ action, args, flags, stdout, client });
    }
    if (group === "preset") {
      return await runPresetCommand({ action, args, flags, stdout, cwd, client });
    }
    if (group === "backup") {
      return await runBackupCommand({ action, args, flags, stdout, cwd, client });
    }

    return writeUsage(stdout, "unknown command");
  } catch (error) {
    return handleError(stdout, error);
  }
}

async function runAuthCheck({ cwd, stdout }) {
  let loaded;
  try {
    loaded = await loadConfig(cwd);
  } catch {
    stdout.write("✗ CloudNS auth check failed: could not read .env\n");
    return 2;
  }

  if (!loaded.ok) {
    stdout.write(
      `✗ CloudNS auth check failed: missing required .env keys: ${loaded.missingKeys.join(", ")}\n`,
    );
    return 2;
  }

  try {
    const transport = new SshCloudnsTransport(loaded.config);
    await transport.listZones();
    stdout.write("✓ CloudNS auth check ok\n");
    return 0;
  } catch (error) {
    return handleAuthError(stdout, error);
  }
}

async function loadClient(cwd) {
  let loaded;
  try {
    loaded = await loadConfig(cwd);
  } catch {
    throw new UsageError("could not read .env file");
  }
  if (!loaded.ok) {
    throw new UsageError(`missing required .env keys: ${loaded.missingKeys.join(", ")}`);
  }
  return new CloudnsClient(new SshCloudnsTransport(loaded.config));
}

async function runZoneCommand({ action, args, flags, stdout, client }) {
  if (action === "list") {
    const zones = await client.listZones();
    return finish(stdout, ok("zone list", zones.length, "ok", zones), flags, 0);
  }

  const [name] = args;
  if (!name) {
    return writeUsage(stdout, `zone ${action} requires <name>`);
  }
  const exists = await client.zoneExists(name);

  if (action === "add") {
    if (exists) {
      return finish(stdout, skipped("zone add", 0, "already exists"), flags, 0);
    }
    if (flags.dryRun) {
      return finish(stdout, skipped("zone add", 0, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
    }
    await client.addZone(name);
    return finish(stdout, ok("zone add", 1, "ok"), flags, 0);
  }

  if (action !== "rm") {
    return writeUsage(stdout, "unknown zone command");
  }

  if (!exists) {
    return finish(stdout, skipped("zone rm", 0, "not found"), flags, 0);
  }
  if (flags.dryRun) {
    return finish(stdout, skipped("zone rm", 1, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
  }
  await client.deleteZone(name);
  return finish(stdout, ok("zone rm", 1, "ok"), flags, 0);
}

async function runRecordCommand({ action, args, flags, stdout, client }) {
  const [zone] = args;
  if (!zone) {
    return writeUsage(stdout, `record ${action} requires <zone>`);
  }

  if (action === "list") {
    const records = await client.listRecords(zone, { type: flags.type, name: flags.name });
    return finish(stdout, ok("record list", records.length, "ok", records), flags, 0);
  }

  if (action === "add") {
    const record = recordFromFlags(flags);
    validateRecord(record);
    const live = await client.listRecords(zone, { type: record.type, name: record.name });
    if (live.some((liveRecord) => recordsEquivalent(liveRecord, record))) {
      return finish(stdout, skipped("record add", 0, "already exists"), flags, 0);
    }
    if (flags.dryRun) {
      return finish(stdout, skipped("record add", 1, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
    }
    await client.addRecord(zone, record);
    return finish(stdout, ok("record add", 1, "ok"), flags, 0);
  }

  if (action === "rm") {
    if (flags.id) {
      if (flags.dryRun) {
        return finish(stdout, skipped("record rm", 1, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
      }
      await client.deleteRecord(zone, flags.id);
      return finish(stdout, ok("record rm", 1, "ok"), flags, 0);
    }

    if (!flags.type || !flags.name) {
      return writeUsage(stdout, "record rm requires --id or --type and --name");
    }

    const live = await client.listRecords(zone, { type: flags.type, name: flags.name });
    const matches = live.filter((record) => {
      if (record.type !== String(flags.type).toUpperCase() || record.name !== flags.name) {
        return false;
      }
      return flags.value === undefined || record.value === flags.value;
    });

    if (matches.length === 0) {
      return finish(stdout, skipped("record rm", 0, "not found"), flags, 0);
    }
    if (matches.length > 1) {
      stdout.write(`✗ usage · ambiguous record match: ${matches.map((record) => record.id).join(", ")}\n`);
      return 2;
    }
    if (flags.dryRun) {
      return finish(stdout, skipped("record rm", 1, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
    }
    await client.deleteRecord(zone, matches[0].id);
    return finish(stdout, ok("record rm", 1, "ok"), flags, 0);
  }

  return writeUsage(stdout, "unknown record command");
}

async function runPresetCommand({ action, args, flags, stdout, cwd, client }) {
  const [zone, name] = args;
  if (!zone || !name) {
    return writeUsage(stdout, `preset ${action} requires <zone> <preset>`);
  }

  const preset = await loadPreset(cwd, name);
  const live = await client.listRecords(zone);
  const diff = diffPreset(preset.records, live);
  const removals = presetOwnedRemovals(preset.records, live);

  if (action === "diff") {
    const changes = [...diff.additions, ...diff.driftRemovals].map(({ action: changeAction, type, name: recordName, value }) => ({
      action: changeAction,
      type,
      name: recordName,
      value,
    }));
    if (flags.format === "json") {
      writeJson(stdout, changes);
      return 0;
    }
    return finish(stdout, ok("preset diff", changes.length, "ok", changes), flags, 0);
  }

  if (action === "apply") {
    if (flags.dryRun) {
      return finish(stdout, skipped("preset apply", diff.additions.length, "dry-run", diff.additions), flags, WRITE_DRY_RUN_EXIT);
    }
    for (const change of diff.additions) {
      await client.addRecord(zone, change.record);
    }
    return finish(stdout, ok("preset apply", diff.additions.length, "ok"), flags, 0);
  }

  if (action === "remove") {
    if (flags.dryRun) {
      return finish(stdout, skipped("preset remove", removals.length, "dry-run", removals), flags, WRITE_DRY_RUN_EXIT);
    }
    for (const change of removals) {
      await client.deleteRecord(zone, change.record.id);
    }
    return finish(stdout, ok("preset remove", removals.length, "ok"), flags, 0);
  }

  return writeUsage(stdout, "unknown preset command");
}

async function runBackupCommand({ action, args, flags, stdout, cwd, client }) {
  const [zone] = args;
  if (!zone) {
    return writeUsage(stdout, `backup ${action} requires <zone>`);
  }

  if (action === "create") {
    const outputPath = resolve(cwd, flags.output ?? defaultBackupName(zone, flags.format));
    if (flags.format === "bind") {
      const raw = await client.exportBind(zone);
      await writeRawBackup(outputPath, raw);
      return finish(stdout, ok("backup create", 0, "ok", undefined, { outputPath, format: "bind" }), flags, 0);
    }
    const records = await client.listRecords(zone);
    await writeBackup(outputPath, { zone, createdAt: new Date().toISOString(), records });
    return finish(stdout, ok("backup create", records.length, "ok", undefined, { outputPath, format: "json" }), flags, 0);
  }

  if (action === "restore") {
    if (!flags.input) {
      return writeUsage(stdout, "backup restore requires --input");
    }
    const backup = await readJsonBackup(resolve(cwd, flags.input));
    if (backup.zone && backup.zone !== zone) {
      return writeUsage(stdout, `backup zone mismatch: file is for ${backup.zone}, not ${zone}`);
    }
    const live = await client.listRecords(zone);
    const plan = planRestore(backup.records, live);
    const affected = plan.additions.length + plan.removals.length;
    if (flags.dryRun) {
      return finish(stdout, skipped("backup restore", affected, "dry-run", plan), flags, WRITE_DRY_RUN_EXIT);
    }
    for (const record of plan.removals) {
      await client.deleteRecord(zone, record.id);
    }
    for (const record of plan.additions) {
      await client.addRecord(zone, record);
    }
    return finish(stdout, ok("backup restore", affected, "ok"), flags, 0);
  }

  return writeUsage(stdout, "unknown backup command");
}

function recordFromFlags(flags) {
  return normalizeRecordLike({
    type: flags.type,
    name: flags.name ?? "@",
    value: flags.value,
    ttl: flags.ttl ?? 3600,
    priority: flags.priority,
    weight: flags.weight,
    port: flags.port,
    caaFlag: flags.caaFlag,
    caaType: flags.caaType,
  });
}

function validateRecord(record) {
  if (!SUPPORTED_RECORD_TYPES.has(record.type) || !record.value) {
    throw new UsageError("invalid record");
  }
  if (record.type === "SRV" && (record.priority === undefined || record.weight === undefined || record.port === undefined)) {
    throw new UsageError("SRV requires priority, weight, and port");
  }
}

function finish(stdout, result, flags, exitCode) {
  writeResult(stdout, result, flags);
  return exitCode;
}

function handleError(stdout, error) {
  if (error instanceof UsageError || error instanceof PresetError || error instanceof BackupError) {
    return writeUsage(stdout, error.message);
  }
  if (error instanceof CloudnsAuthError) {
    stdout.write("✗ api · 0 records affected · CloudNS auth rejected\n");
    return 2;
  }
  if (error instanceof CloudnsApiError) {
    stdout.write("✗ api · 0 records affected · CloudNS API rejected request\n");
    return 1;
  }
  if (error instanceof SshTransportError) {
    stdout.write("✗ api · 0 records affected · SSH transport failed\n");
    return 1;
  }

  stdout.write("✗ api · 0 records affected · runtime error\n");
  return 1;
}

function handleAuthError(stdout, error) {
  if (error instanceof CloudnsAuthError) {
    stdout.write("✗ CloudNS auth check failed: CloudNS auth rejected\n");
    return 2;
  }

  if (error instanceof CloudnsApiError) {
    stdout.write("✗ CloudNS auth check failed: CloudNS API rejected the probe\n");
    return 1;
  }

  if (error instanceof SshTransportError) {
    stdout.write("✗ CloudNS auth check failed: SSH transport failed\n");
    return 1;
  }

  stdout.write("✗ CloudNS auth check failed: runtime error\n");
  return 1;
}

function writeUsage(stdout, message) {
  stdout.write(`✗ usage · ${message}\n`);
  return 2;
}

function isKnownCommand(group, action) {
  return KNOWN_COMMANDS[group]?.has(action) ?? false;
}

function getConfirmationMessage(group, action, flags) {
  if (flags.confirm) {
    return null;
  }

  return CONFIRMATION_MESSAGES.get(`${group}:${action}`) ?? null;
}

function defaultBackupName(zone, format) {
  const suffix = format === "bind" ? "zone" : "json";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `backups/${zone}-${stamp}.${suffix}`;
}
