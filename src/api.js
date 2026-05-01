import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, relative } from "node:path";

const OPERATION_ARGV = new Map([
  ["auth.check", ["auth", "check"]],
  ["zone.list", ["zone", "list"]],
  ["zone.add", ["zone", "add"]],
  ["zone.remove", ["zone", "rm"]],
  ["record.list", ["record", "list"]],
  ["record.add", ["record", "add"]],
  ["record.remove", ["record", "rm"]],
  ["preset.diff", ["preset", "diff"]],
  ["preset.apply", ["preset", "apply"]],
  ["preset.remove", ["preset", "remove"]],
  ["backup.create", ["backup", "create"]],
  ["backup.restore", ["backup", "restore"]],
  ["capabilities", ["capabilities"]],
  ["doctor", ["doctor"]],
]);

export async function readApiRequest({ inputPath, stdin }) {
  const text = inputPath === "-" ? await readAllStdin(stdin) : await readFile(inputPath, "utf8");
  return JSON.parse(text);
}

export async function executeApiRequest(request, { runCli, cwd, stdin, stderr }) {
  const validationError = validateRequest(request);
  if (validationError) {
    return validationError;
  }
  const pathValidationError = validateRequestPaths(request, cwd);
  if (pathValidationError) {
    return pathValidationError;
  }

  const argv = requestToArgv(request);
  const captured = createCapturedStdout();
  const exitCode = await runCli({ argv, cwd, stdin, stdout: captured, stderr });
  const legacyOutput = captured.toString();
  const legacyJson = parseJsonOrText(legacyOutput);
  const ok = exitCode === 0 || (exitCode === 3 && request.options?.dryRun === true);

  return {
    ok,
    command: request.operation,
    status: apiStatus({ exitCode, request, legacyJson }),
    exitCode,
    dryRun: request.options?.dryRun === true,
    ...(request.options?.transport ? { transport: { mode: request.options.transport, selectedBy: "request" } } : {}),
    ...(request.target ? { target: request.target } : {}),
    data: legacyJson,
    warnings: [],
    errors: ok ? [] : [errorObject("operation_failed", "operation failed", "runtime", true)],
  };
}

function validateRequest(request) {
  if (!request || typeof request !== "object") {
    return usageError("invalid_request", "request must be a JSON object");
  }
  if (request.schemaVersion !== 1) {
    return usageError("unsupported_schema_version", `unsupported schemaVersion: ${request.schemaVersion}`);
  }
  if (!OPERATION_ARGV.has(request.operation)) {
    return usageError("unknown_operation", `unknown operation: ${request.operation}`, { operation: request.operation });
  }
  return null;
}

function validateRequestPaths(request, cwd) {
  const input = request.backup?.input ?? request.options?.input;
  const output = request.backup?.output ?? request.options?.output;

  if (input && input !== "-" && !isInsideCwd(cwd, input)) {
    return usageError("path_outside_cwd", "backup input path must stay inside the working directory", {
      path: input,
    });
  }
  if (output && !isInsideCwd(cwd, output)) {
    return usageError("path_outside_cwd", "backup output path must stay inside the working directory", {
      path: output,
    });
  }
  return null;
}

function isInsideCwd(cwd, path) {
  const resolvedCwd = resolve(cwd);
  const resolvedPath = resolve(cwd, path);
  const relativePath = relative(resolvedCwd, resolvedPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function requestToArgv(request) {
  const argv = [...OPERATION_ARGV.get(request.operation)];
  appendPositionals(argv, request);
  appendRequestFlags(argv, request);
  return argv;
}

function appendPositionals(argv, request) {
  const zone = request.target?.zone;
  const preset = request.target?.preset;

  if (request.operation.startsWith("zone.") && request.operation !== "zone.list") {
    if (request.target?.name) argv.push(request.target.name);
    return;
  }
  if (request.operation.startsWith("record.") && request.operation !== "record.list") {
    if (zone) argv.push(zone);
    return;
  }
  if (request.operation === "record.list") {
    if (zone) argv.push(zone);
    return;
  }
  if (request.operation.startsWith("preset.")) {
    if (zone) argv.push(zone);
    if (preset) argv.push(preset);
    return;
  }
  if (request.operation.startsWith("backup.")) {
    if (zone) argv.push(zone);
  }
}

function appendRequestFlags(argv, request) {
  const options = request.options ?? {};
  appendFlag(argv, "--format", "json");
  appendFlag(argv, "--transport", options.transport);
  if (options.dryRun) argv.push("--dry-run");
  if (options.confirm) argv.push("--confirm");
  if (options.verbose) argv.push("--verbose");

  appendRecordFlags(argv, request.record);
  appendFlag(argv, "--id", request.record?.id);
  appendFlag(argv, "--input", request.backup?.input ?? options.input);
  appendFlag(argv, "--output", request.backup?.output ?? options.output);
}

function appendRecordFlags(argv, record) {
  if (!record) return;
  appendFlag(argv, "--type", record.type);
  appendFlag(argv, "--name", record.name);
  appendFlag(argv, "--value", record.value);
  appendFlag(argv, "--ttl", record.ttl);
  appendFlag(argv, "--priority", record.priority);
  appendFlag(argv, "--weight", record.weight);
  appendFlag(argv, "--port", record.port);
  appendFlag(argv, "--caa-flag", record.caaFlag);
  appendFlag(argv, "--caa-type", record.caaType);
}

function appendFlag(argv, name, value) {
  if (value === undefined || value === null || value === "") return;
  argv.push(name, String(value));
}

function apiStatus({ exitCode, request, legacyJson }) {
  if (exitCode === 0) {
    return legacyJson?.status === "skipped" ? "skipped" : "ok";
  }
  if (exitCode === 3 && request.options?.dryRun === true) {
    return "planned";
  }
  if (exitCode === 2) {
    return "usage_error";
  }
  return "runtime_error";
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { output: text };
  }
}

function usageError(code, message, details) {
  return {
    ok: false,
    command: "api",
    status: "usage_error",
    exitCode: 2,
    warnings: [],
    errors: [errorObject(code, message, "usage", false, details)],
  };
}

function errorObject(code, message, category, retryable, details) {
  return { code, message, category, retryable, ...(details ? { details } : {}) };
}

function createCapturedStdout() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
    },
    toString() {
      return chunks.join("");
    },
  };
}

async function readAllStdin(stdin) {
  return await new Promise((resolve, reject) => {
    let text = "";
    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk) => {
      text += String(chunk);
    });
    stdin.on("error", reject);
    stdin.on("end", () => resolve(text));
    stdin.resume?.();
  });
}
