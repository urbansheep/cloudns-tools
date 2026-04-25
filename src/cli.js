import { join, resolve } from "node:path";
import { ConfigPromptAbortError, loadConfig } from "./config.js";
import { SshCloudnsTransport } from "./transport/ssh-cloudns.js";
import {
  CloudnsApiError,
  CloudnsAuthError,
  DirectTransportError,
  SshTransportError,
  TransportError,
} from "./transport/cloudns-transport-core.js";
import { DirectCloudnsTransport } from "./transport/direct-cloudns.js";
import { TransportResolutionError } from "./transport/resolve-transport.js";
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

export async function runCli({ argv, cwd, stdout, stdin, stderr = process.stderr }) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return writeUsage(stdout, error.message);
  }

  const { positionals, flags } = parsed;
  const [group, action, ...args] = positionals;

  const log = makeLog(stderr, flags);

  if (group === "auth" && action === "check" && args.length === 0) {
    return await runAuthCheck({ cwd, stdout, stdin, flags, log });
  }

  try {
    if (!group) {
      return writeHelp(stdout);
    }
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

    const client = await loadClient(cwd, { flags, stdin, stdout, log });
    if (group === "zone") {
      return await runZoneCommand({ action, args, flags, stdout, client, log });
    }
    if (group === "record") {
      return await runRecordCommand({ action, args, flags, stdout, client, log });
    }
    if (group === "preset") {
      return await runPresetCommand({ action, args, flags, stdout, cwd, client, log });
    }
    if (group === "backup") {
      return await runBackupCommand({ action, args, flags, stdout, cwd, client, log });
    }

    return writeUsage(stdout, "unknown command");
  } catch (error) {
    return handleError(stdout, error);
  }
}

async function runAuthCheck({ cwd, stdout, stdin, flags, log }) {
  let loaded;
  try {
    loaded = await loadConfig(cwd, { flags, stdin, stdout });
  } catch (error) {
    if (error instanceof TransportResolutionError || error instanceof ConfigPromptAbortError) {
      stdout.write(`✗ CloudNS auth check failed: ${error.message}\n`);
      return 2;
    }
    stdout.write("✗ CloudNS auth check failed: could not read .env\n");
    return 2;
  }

  if (!loaded.ok) {
    stdout.write(
      `✗ CloudNS auth check failed: missing required .env keys: ${loaded.missingKeys.join(", ")}\n`,
    );
    return 2;
  }

  logConfig(log, loaded.config, flags);
  try {
    log("probing CloudNS API");
    const transport = createTransport(loaded.config);
    await transport.listZones();
    stdout.write("✓ CloudNS auth check ok\n");
    return 0;
  } catch (error) {
    return handleAuthError(stdout, error);
  }
}

async function loadClient(cwd, { flags, stdin, stdout, log }) {
  let loaded;
  try {
    loaded = await loadConfig(cwd, { flags, stdin, stdout });
  } catch (error) {
    if (error instanceof TransportResolutionError || error instanceof ConfigPromptAbortError) {
      throw new UsageError(error.message);
    }
    throw new UsageError("could not read .env file");
  }
  if (!loaded.ok) {
    throw new UsageError(`missing required .env keys: ${loaded.missingKeys.join(", ")}`);
  }
  logConfig(log, loaded.config, flags);
  return new CloudnsClient(createTransport(loaded.config));
}

function createTransport(config) {
  if (config.transport === "direct") {
    return new DirectCloudnsTransport(config);
  }

  return new SshCloudnsTransport(config);
}

async function runZoneCommand({ action, args, flags, stdout, client, log }) {
  if (action === "list") {
    log("fetching zones");
    const zones = await client.listZones();
    return finish(stdout, ok("zone list", zones.length, "ok", zones), flags, 0);
  }

  const [name] = args;
  if (!name) {
    return writeUsage(stdout, `zone ${action} requires <name>`);
  }

  log(`checking zone: ${name}`);
  const exists = await client.zoneExists(name);

  if (action === "add") {
    if (exists) {
      log("zone already exists, skipping");
      return finish(stdout, skipped("zone add", 0, "already exists"), flags, 0);
    }
    if (flags.dryRun) {
      log("zone not found · dry-run, skipping add");
      return finish(stdout, skipped("zone add", 0, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
    }
    log("zone not found, adding");
    await client.addZone(name);
    return finish(stdout, ok("zone add", 1, "ok"), flags, 0);
  }

  if (action !== "rm") {
    return writeUsage(stdout, "unknown zone command");
  }

  if (!exists) {
    log("zone not found, skipping");
    return finish(stdout, skipped("zone rm", 0, "not found"), flags, 0);
  }
  if (flags.dryRun) {
    log("zone found · dry-run, skipping delete");
    return finish(stdout, skipped("zone rm", 1, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
  }
  log("zone found, deleting");
  await client.deleteZone(name);
  return finish(stdout, ok("zone rm", 1, "ok"), flags, 0);
}

async function runRecordCommand({ action, args, flags, stdout, client, log }) {
  const [zone] = args;
  if (!zone) {
    return writeUsage(stdout, `record ${action} requires <zone>`);
  }

  if (action === "list") {
    const filterDesc = [flags.type && `type=${flags.type}`, flags.name && `name=${flags.name}`].filter(Boolean).join(", ");
    log(`fetching records: ${zone}${filterDesc ? ` (${filterDesc})` : ""}`);
    const records = await client.listRecords(zone, { type: flags.type, name: flags.name });
    return finish(stdout, ok("record list", records.length, "ok", records), flags, 0);
  }

  if (action === "add") {
    const record = recordFromFlags(flags);
    validateRecord(record);
    log(`fetching records: ${zone} (type=${record.type}, name=${record.name})`);
    const live = await client.listRecords(zone, { type: record.type, name: record.name });
    if (live.some((liveRecord) => recordsEquivalent(liveRecord, record))) {
      log("matching record already exists, skipping");
      return finish(stdout, skipped("record add", 0, "already exists"), flags, 0);
    }
    if (flags.dryRun) {
      log("no match found · dry-run, skipping add");
      return finish(stdout, skipped("record add", 1, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
    }
    log("no match found, adding");
    await client.addRecord(zone, record);
    return finish(stdout, ok("record add", 1, "ok"), flags, 0);
  }

  if (action === "rm") {
    if (flags.id) {
      if (flags.dryRun) {
        log(`dry-run, skipping delete of record id=${flags.id}`);
        return finish(stdout, skipped("record rm", 1, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
      }
      log(`deleting record id=${flags.id}`);
      await client.deleteRecord(zone, flags.id);
      return finish(stdout, ok("record rm", 1, "ok"), flags, 0);
    }

    if (!flags.type || !flags.name) {
      return writeUsage(stdout, "record rm requires --id or --type and --name");
    }

    log(`fetching records: ${zone} (type=${flags.type}, name=${flags.name})`);
    const live = await client.listRecords(zone, { type: flags.type, name: flags.name });
    const matches = live.filter((record) => {
      if (record.type !== String(flags.type).toUpperCase() || record.name !== flags.name) {
        return false;
      }
      return flags.value === undefined || record.value === flags.value;
    });

    if (matches.length === 0) {
      log("no matching record found, skipping");
      return finish(stdout, skipped("record rm", 0, "not found"), flags, 0);
    }
    if (matches.length > 1) {
      stdout.write(`✗ usage · ambiguous record match: ${matches.map((record) => record.id).join(", ")}\n`);
      return 2;
    }
    if (flags.dryRun) {
      log(`1 match found · dry-run, skipping delete`);
      return finish(stdout, skipped("record rm", 1, "dry-run"), flags, WRITE_DRY_RUN_EXIT);
    }
    log(`1 match found, deleting record id=${matches[0].id}`);
    await client.deleteRecord(zone, matches[0].id);
    return finish(stdout, ok("record rm", 1, "ok"), flags, 0);
  }

  return writeUsage(stdout, "unknown record command");
}

async function runPresetCommand({ action, args, flags, stdout, cwd, client, log }) {
  const [zone, name] = args;
  if (!zone || !name) {
    return writeUsage(stdout, `preset ${action} requires <zone> <preset>`);
  }

  log(`loading preset: ${name}`);
  const preset = await loadPreset(cwd, name);
  log(`fetching records: ${zone}`);
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
    log(`diff: ${diff.additions.length} additions, ${diff.driftRemovals.length} drift removals`);
    if (flags.format === "json") {
      writeJson(stdout, changes);
      return 0;
    }
    return finish(stdout, ok("preset diff", changes.length, "ok", changes), flags, 0);
  }

  if (action === "apply") {
    log(`diff: ${diff.additions.length} additions`);
    if (flags.dryRun) {
      log("dry-run, skipping apply");
      return finish(stdout, skipped("preset apply", diff.additions.length, "dry-run", diff.additions), flags, WRITE_DRY_RUN_EXIT);
    }
    log(`applying ${diff.additions.length} additions`);
    for (const change of diff.additions) {
      await client.addRecord(zone, change.record);
    }
    return finish(stdout, ok("preset apply", diff.additions.length, "ok", diff.additions), flags, 0);
  }

  if (action === "remove") {
    log(`${removals.length} preset-owned records to remove`);
    if (flags.dryRun) {
      log("dry-run, skipping remove");
      return finish(stdout, skipped("preset remove", removals.length, "dry-run", removals), flags, WRITE_DRY_RUN_EXIT);
    }
    log(`removing ${removals.length} records`);
    for (const change of removals) {
      await client.deleteRecord(zone, change.record.id);
    }
    return finish(stdout, ok("preset remove", removals.length, "ok", removals), flags, 0);
  }

  return writeUsage(stdout, "unknown preset command");
}

async function runBackupCommand({ action, args, flags, stdout, cwd, client, log }) {
  const [zone] = args;
  if (!zone) {
    return writeUsage(stdout, `backup ${action} requires <zone>`);
  }

  if (action === "create") {
    const outputPath = resolve(cwd, flags.output ?? defaultBackupName(zone, flags.format));
    if (flags.format === "bind") {
      log(`fetching bind export: ${zone}`);
      const raw = await client.exportBind(zone);
      log(`writing ${outputPath}`);
      await writeRawBackup(outputPath, raw);
      return finish(stdout, ok("backup create", 0, "ok", undefined, { outputPath, format: "bind" }), flags, 0);
    }
    log(`fetching records: ${zone}`);
    const records = await client.listRecords(zone);
    log(`writing ${outputPath}`);
    await writeBackup(outputPath, { zone, createdAt: new Date().toISOString(), records });
    return finish(stdout, ok("backup create", records.length, "ok", undefined, { outputPath, format: "json" }), flags, 0);
  }

  if (action === "restore") {
    if (!flags.input) {
      return writeUsage(stdout, "backup restore requires --input");
    }
    log(`reading backup: ${flags.input}`);
    const backup = await readJsonBackup(resolve(cwd, flags.input));
    if (backup.zone && backup.zone !== zone) {
      return writeUsage(stdout, `backup zone mismatch: file is for ${backup.zone}, not ${zone}`);
    }
    log(`fetching live records: ${zone}`);
    const live = await client.listRecords(zone);
    const plan = planRestore(backup.records, live);
    const affected = plan.additions.length + plan.removals.length;
    log(`restore plan: ${plan.additions.length} additions, ${plan.removals.length} removals`);
    if (flags.dryRun) {
      log("dry-run, skipping restore");
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
  if (!SUPPORTED_RECORD_TYPES.has(record.type)) {
    throw new UsageError(`unsupported record type: ${record.type || "(none)"}`);
  }
  if (!record.value) {
    throw new UsageError("record add requires --value");
  }
  if (record.type === "SRV" && (record.priority === undefined || record.weight === undefined || record.port === undefined)) {
    throw new UsageError("SRV requires --priority, --weight, and --port");
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
  if (error instanceof TransportError) {
    stdout.write(`✗ api · 0 records affected · ${describeTransportError(error)}\n`);
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

  if (error instanceof TransportError) {
    stdout.write(`✗ CloudNS auth check failed: ${describeTransportError(error)}\n`);
    return 1;
  }

  stdout.write("✗ CloudNS auth check failed: runtime error\n");
  return 1;
}

function describeTransportError(error) {
  if (error instanceof DirectTransportError) {
    return "Direct transport failed";
  }
  if (error instanceof SshTransportError) {
    return "SSH transport failed";
  }

  return "transport failed";
}

function writeHelp(stdout) {
  stdout.write(
    "usage: cloudns <command> [options]\n\n" +
    "Commands:\n" +
    "  auth check\n" +
    "  zone list|add|rm\n" +
    "  record list|add|rm\n" +
    "  preset diff|apply|remove\n" +
    "  backup create|restore\n\n" +
    "Options:\n" +
    "  -t, --transport ssh|direct\n" +
    "  -f, --format    text|json|bind\n" +
    "  -n, --dry-run\n" +
    "  -y, --confirm\n" +
    "  -v, --verbose\n"
  );
  return 2;
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

function makeLog(stdout, flags) {
  if (!flags.verbose) return () => {};
  return (message) => stdout.write(`· ${message}\n`);
}

function logConfig(log, config, flags) {
  if (config.transport === "ssh") {
    log(`transport: ssh · VPS: ${config.vpsUser}@${config.vpsHost}`);
  } else {
    log("transport: direct");
  }
  if (flags.dryRun) {
    log("dry-run: on");
  }
}
