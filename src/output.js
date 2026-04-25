export function ok(action, recordsAffected = 0, message = "ok", data, meta) {
  return { action, status: "ok", recordsAffected, message, data, meta };
}

export function skipped(action, recordsAffected = 0, message = "skipped", data, meta) {
  return { action, status: "skipped", recordsAffected, message, data, meta };
}

export function writeResult(stdout, result, flags = {}) {
  if (flags.format === "json") {
    stdout.write(`${JSON.stringify(toJsonResult(result))}\n`);
    return;
  }

  writeHumanResult(stdout, result);
}

export function writeJson(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function writeHumanResult(stdout, result) {
  const symbol = result.status === "ok" ? "✓" : result.status === "skipped" ? "skipped" : "✗";
  stdout.write(`${symbol} ${result.action} · ${formatCountLabel(result)} · ${result.message}\n`);

  if (result.action === "zone list") {
    writeList(stdout, result.data, formatZoneLine);
  } else if (result.action === "record list") {
    writeList(stdout, result.data, formatRecordLine);
  } else if (result.action === "preset diff") {
    writePresetDiff(stdout, result.data);
  } else if (result.action === "preset apply" && Array.isArray(result.data)) {
    writePresetPlan(stdout, "additions", result.data, result.status === "ok");
  } else if (result.action === "preset remove" && Array.isArray(result.data)) {
    writePresetPlan(stdout, "removals", result.data, result.status === "ok");
  } else if (isDryRunChangeSet(result) && result.action === "backup restore") {
    writeRestorePlan(stdout, result.data);
  } else if (result.action === "backup create" && result.meta?.outputPath) {
    stdout.write(`wrote ${result.meta.outputPath}${result.meta.format === "bind" ? " (bind)" : ""}\n`);
  }
}

function formatCountLabel(result) {
  if (result.action === "zone list") {
    return `${result.recordsAffected} zones`;
  }
  if (result.action === "record list") {
    return `${result.recordsAffected} records`;
  }
  if (result.action === "preset diff") {
    return `${result.recordsAffected} changes`;
  }
  if (isDryRunChangeSet(result)) {
    return `${result.recordsAffected} changes`;
  }
  return `${result.recordsAffected} records affected`;
}

function isDryRunChangeSet(result) {
  return (
    result.status === "skipped" &&
    result.message === "dry-run" &&
    (result.action === "preset apply" || result.action === "preset remove" || result.action === "backup restore")
  );
}

function writeList(stdout, items, formatLine) {
  if (!Array.isArray(items) || items.length === 0) {
    stdout.write("  (none)\n");
    return;
  }

  for (const item of items) {
    stdout.write(`  - ${formatLine(item)}\n`);
  }
}

function formatZoneLine(zone) {
  return zone?.name ?? "";
}

function formatRecordLine(record) {
  const parts = [
    record?.type ?? "",
    record?.name ?? "",
    record?.value ?? "",
  ].filter(Boolean);
  const ttl = record?.ttl !== undefined ? `ttl ${record.ttl}` : "";
  return [...parts, ttl].filter(Boolean).join(" · ");
}

function writePresetDiff(stdout, changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    stdout.write("  (no changes)\n");
    return;
  }

  const additions = changes.filter((change) => change.action === "add");
  const removals = changes.filter((change) => change.action === "remove");

  if (additions.length > 0) {
    stdout.write("  additions:\n");
    writeList(stdout, additions, formatRecordLine);
  }
  if (removals.length > 0) {
    stdout.write("  removals:\n");
    writeList(stdout, removals, formatRecordLine);
  }
}

function writePresetPlan(stdout, label, changes, hideEmpty = false) {
  if (!Array.isArray(changes) || changes.length === 0) {
    if (!hideEmpty) stdout.write("  (no changes)\n");
    return;
  }

  stdout.write(`  ${label}:\n`);
  writeList(stdout, changes, (change) => formatRecordLine(change.record));
}

function writeRestorePlan(stdout, plan) {
  if (!plan || (!Array.isArray(plan.additions) && !Array.isArray(plan.removals))) {
    stdout.write("  (no plan)\n");
    return;
  }

  if ((plan.additions ?? []).length === 0 && (plan.removals ?? []).length === 0) {
    stdout.write("  (no changes)\n");
    return;
  }

  if (plan.additions?.length > 0) {
    stdout.write("  additions:\n");
    writeList(stdout, plan.additions, formatRecordLine);
  }
  if (plan.removals?.length > 0) {
    stdout.write("  removals:\n");
    writeList(stdout, plan.removals, formatRecordLine);
  }
}

function toJsonResult(result) {
  const json = {
    action: result.action,
    status: result.status,
    recordsAffected: result.recordsAffected,
  };

  if (result.data !== undefined) {
    json.data = result.data;
  }

  return json;
}
