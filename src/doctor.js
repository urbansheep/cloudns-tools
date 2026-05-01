import { access, constants, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDotEnv, REQUIRED_AUTH_KEYS, REQUIRED_SSH_KEYS } from "./config.js";
import { CloudnsApiError, CloudnsAuthError, TransportError } from "./transport/cloudns-transport-core.js";
import { resolveTransport, TransportResolutionError } from "./transport/resolve-transport.js";

export async function runDoctorChecks(cwd, { flags = {}, createTransport }) {
  const checks = [];
  const errors = [];
  const values = await readEnv(cwd, checks, errors);
  const transport = await checkTransport({ flags, values, checks, errors });
  const selectedBy = flags.transport ? "cli" : values.CLOUDNS_TRANSPORT ? "env" : undefined;

  if (transport) {
    checkRequiredKeys({ transport, values, checks, errors });
    await checkSshKey({ transport, values, checks, errors });
  }

  if (errors.length > 0 || !transport) {
    return buildReport({
      ok: false,
      status: "config_error",
      exitCode: 2,
      checks,
      errors,
      transport: transport ? { mode: transport, selectedBy } : undefined,
      includeObservability: flags.verbose,
    });
  }

  const config = buildConfig(values, transport);
  checks.push(pass("config.complete", "required configuration is present"));

  try {
    await createTransport(config).listZones();
    checks.push(pass("api.probe", "read-only CloudNS API probe succeeded"));
    return buildReport({
      ok: true,
      status: "ok",
      exitCode: 0,
      checks,
      errors: [],
      transport: describeTransport(config, selectedBy),
      includeObservability: flags.verbose,
    });
  } catch (error) {
    return buildProbeFailure({ error, checks, transport: describeTransport(config, selectedBy), includeObservability: flags.verbose });
  }
}

async function readEnv(cwd, checks, errors) {
  try {
    const text = await readFile(join(cwd, ".env"), "utf8");
    checks.push(pass("env.file", ".env file found"));
    return parseDotEnv(text);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      checks.push(fail("env.file", "could not read .env file", "Check file permissions for .env."));
      errors.push(configError("env_read_failed", "could not read .env file"));
      return {};
    }

    checks.push(fail("env.file", ".env file not found", "Create .env or pass required options explicitly."));
    return {};
  }
}

async function checkTransport({ flags, values, checks, errors }) {
  try {
    const transport = await resolveTransport({
      cliTransport: flags.transport,
      envTransport: normalizeTransportValue(values.CLOUDNS_TRANSPORT),
      stdin: { isTTY: false },
      stdout: { isTTY: false, write() {} },
    });
    checks.push(pass("transport.selected", `transport selected: ${transport}`));
    return transport;
  } catch (error) {
    if (error instanceof TransportResolutionError) {
      checks.push(fail("transport.selected", error.message, "Set CLOUDNS_TRANSPORT=ssh or pass --transport direct."));
      errors.push(configError(transportErrorCode(error.message), error.message));
      return undefined;
    }
    throw error;
  }
}

function checkRequiredKeys({ transport, values, checks, errors }) {
  const requiredKeys = transport === "ssh" ? [...REQUIRED_AUTH_KEYS, ...REQUIRED_SSH_KEYS] : REQUIRED_AUTH_KEYS;
  const missingKeys = requiredKeys.filter((key) => !hasNonEmptyValue(values[key]));

  if (missingKeys.length === 0) {
    checks.push(pass("config.required_keys", "required keys are present"));
    return;
  }

  checks.push(
    fail(
      "config.required_keys",
      `missing required .env keys: ${missingKeys.join(", ")}`,
      `Set ${missingKeys.join(", ")} in .env.`,
      { missingKeys },
    ),
  );
  errors.push(
    configError("missing_required_keys", `missing required .env keys: ${missingKeys.join(", ")}`, { missingKeys }),
  );
}

async function checkSshKey({ transport, values, checks, errors }) {
  if (transport !== "ssh" || !hasNonEmptyValue(values.VPS_SSH_KEY)) {
    return;
  }

  try {
    await access(values.VPS_SSH_KEY.trim(), constants.R_OK);
    checks.push(pass("ssh.key_path", "VPS_SSH_KEY path is readable"));
  } catch {
    checks.push(fail("ssh.key_path", "VPS_SSH_KEY path is not readable", "Set VPS_SSH_KEY to a readable SSH key path."));
    errors.push(configError("ssh_key_not_found", "VPS_SSH_KEY path is not readable"));
  }
}

function buildProbeFailure({ error, checks, transport, includeObservability }) {
  if (error instanceof CloudnsAuthError) {
    checks.push(fail("api.probe", "CloudNS auth rejected", "Check CLOUDNS_AUTH_ID and CLOUDNS_AUTH_PASSWORD."));
    return buildReport({
      ok: false,
      status: "auth_error",
      exitCode: 2,
      checks,
      errors: [authError("cloudns_auth_rejected", "CloudNS auth rejected")],
      transport,
      includeObservability,
    });
  }

  if (error instanceof CloudnsApiError) {
    checks.push(fail("api.probe", "CloudNS API rejected the probe", "Retry later or inspect CloudNS API status."));
    return buildReport({
      ok: false,
      status: "api_error",
      exitCode: 1,
      checks,
      errors: [apiError("cloudns_api_rejected", "CloudNS API rejected the probe")],
      transport,
      includeObservability,
    });
  }

  if (error instanceof TransportError) {
    checks.push(fail("api.probe", "transport failed", "Check SSH/direct transport reachability."));
    return buildReport({
      ok: false,
      status: "transport_error",
      exitCode: 1,
      checks,
      errors: [transportFailure("transport_failed", "transport failed")],
      transport,
      includeObservability,
    });
  }

  checks.push(fail("api.probe", "runtime error", "Run with --verbose or inspect local environment."));
  return buildReport({
    ok: false,
    status: "runtime_error",
    exitCode: 1,
    checks,
    errors: [runtimeError("runtime_error", "runtime error")],
    transport,
    includeObservability,
  });
}

function buildReport({ ok, status, exitCode, checks, errors, transport, includeObservability = false }) {
  return {
    ok,
    command: "doctor",
    status,
    exitCode,
    ...(transport ? { transport } : {}),
    checks,
    warnings: checks.filter((check) => check.status === "warn"),
    errors,
    ...(includeObservability ? { observability: { steps: checks.map(checkToStep) } } : {}),
  };
}

function checkToStep(check) {
  return {
    id: check.id,
    status: check.status === "pass" ? "ok" : check.status,
    message: check.message,
  };
}

function buildConfig(values, transport) {
  const config = {
    transport,
    cloudnsAuthId: values.CLOUDNS_AUTH_ID.trim(),
    cloudnsAuthPassword: values.CLOUDNS_AUTH_PASSWORD.trim(),
  };

  if (transport === "ssh") {
    config.vpsHost = values.VPS_HOST.trim();
    config.vpsUser = values.VPS_USER.trim();
    config.vpsSshKey = values.VPS_SSH_KEY.trim();
  }

  return config;
}

function describeTransport(config, selectedBy) {
  if (config.transport === "ssh") {
    return {
      mode: "ssh",
      selectedBy,
      endpoint: `${config.vpsUser}@${config.vpsHost}`,
    };
  }

  return { mode: "direct", selectedBy };
}

function pass(id, message, details) {
  return { id, status: "pass", message, ...(details ? { details } : {}) };
}

function fail(id, message, remediation, details) {
  return { id, status: "fail", message, remediation, ...(details ? { details } : {}) };
}

function configError(code, message, details) {
  return errorObject({ code, message, category: "config", retryable: false, details });
}

function authError(code, message) {
  return errorObject({ code, message, category: "auth", retryable: false });
}

function apiError(code, message) {
  return errorObject({ code, message, category: "api", retryable: true });
}

function transportFailure(code, message) {
  return errorObject({ code, message, category: "transport", retryable: true });
}

function runtimeError(code, message) {
  return errorObject({ code, message, category: "runtime", retryable: false });
}

function errorObject({ code, message, category, retryable, details }) {
  return { code, message, category, retryable, ...(details ? { details } : {}) };
}

function transportErrorCode(message) {
  return message.includes("conflict") ? "transport_conflict" : "transport_required";
}

function hasNonEmptyValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeTransportValue(value) {
  return hasNonEmptyValue(value) ? value.trim() : undefined;
}
