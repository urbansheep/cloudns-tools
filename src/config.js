import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveTransport } from "./transport/resolve-transport.js";

export const REQUIRED_AUTH_KEYS = [
  "CLOUDNS_AUTH_ID",
  "CLOUDNS_AUTH_PASSWORD",
];
export const REQUIRED_SSH_KEYS = ["VPS_HOST", "VPS_USER", "VPS_SSH_KEY"];
const SECRET_CONFIG_KEYS = new Set(["CLOUDNS_AUTH_PASSWORD"]);

export class ConfigPromptAbortError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ConfigPromptAbortError";
  }
}

export async function loadConfig(cwd, { flags = {}, stdin, stdout, promptImpl, promptValueImpl } = {}) {
  const envState = await readEnvState(cwd);
  let values = parseDotEnv(envState.text);
  const shouldPersistPromptedTransport =
    !flags.transport && !hasNonEmptyValue(values.CLOUDNS_TRANSPORT) && stdin?.isTTY && stdout?.isTTY;
  const transport = await resolveTransport({
    cliTransport: flags.transport,
    envTransport: normalizeTransportValue(values.CLOUDNS_TRANSPORT),
    stdin,
    stdout,
    promptImpl,
  });
  if (shouldPersistPromptedTransport) {
    const nextText = upsertEnvValue(envState.text, "CLOUDNS_TRANSPORT", transport);
    if (nextText !== envState.text) {
      await writeFile(join(cwd, ".env"), nextText);
    }
    values.CLOUDNS_TRANSPORT = transport;
  }
  const requiredKeys =
    transport === "ssh" ? [...REQUIRED_AUTH_KEYS, ...REQUIRED_SSH_KEYS] : REQUIRED_AUTH_KEYS;
  let missingKeys = requiredKeys.filter((key) => !hasNonEmptyValue(values[key]));

  if (missingKeys.length > 0 && stdin?.isTTY && stdout?.isTTY) {
    const nextText = await fillMissingConfigValues(join(cwd, ".env"), {
      text: await readFile(join(cwd, ".env"), "utf8"),
      missingKeys,
      stdin,
      stdout,
      promptValueImpl,
    });
    values = parseDotEnv(nextText);
    missingKeys = requiredKeys.filter((key) => !hasNonEmptyValue(values[key]));
  }

  if (missingKeys.length > 0) {
    return { ok: false, missingKeys };
  }

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

  return {
    ok: true,
    config,
  };
}

export function parseDotEnv(text) {
  const values = {};

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();

    if (key !== "") {
      values[key] = parseValue(rawValue);
    }
  }

  return values;
}

// Strips matching outer quotes only. Does not handle escape sequences or
// embedded quotes — use unquoted values for anything that contains quotes.
function parseValue(rawValue) {
  if (
    rawValue.length >= 2 &&
    ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'")))
  ) {
    return rawValue.slice(1, -1);
  }

  return rawValue.replace(/\s+#.*$/, "");
}

function hasNonEmptyValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeTransportValue(value) {
  if (!hasNonEmptyValue(value)) {
    return undefined;
  }

  return value.trim();
}

async function fillMissingConfigValues(envPath, { text, missingKeys, stdin, stdout, promptValueImpl }) {
  let nextText = text;

  for (const key of missingKeys) {
    const value = await (promptValueImpl ?? promptForConfigValue)({
      key,
      secret: SECRET_CONFIG_KEYS.has(key),
      stdin,
      stdout,
    });
    nextText = upsertEnvValue(nextText, key, value);
  }

  if (nextText !== text) {
    await writeFile(envPath, nextText);
  }

  return nextText;
}

async function readEnvState(cwd) {
  const envPath = join(cwd, ".env");

  try {
    return { text: await readFile(envPath, "utf8") };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const examplePath = join(cwd, ".env.example");
  const exampleText = await readFile(examplePath, "utf8");
  await writeFile(envPath, exampleText);
  return { text: exampleText };
}

function upsertEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let replaced = false;

  const nextLines = lines.map((existingLine) => {
    const trimmed = existingLine.trim();
    if (!trimmed.startsWith(`${key}=`)) {
      return existingLine;
    }

    replaced = true;
    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push(line);
      nextLines.push("");
    } else {
      nextLines.splice(Math.max(0, nextLines.length - 1), 0, line);
    }
  }

  return nextLines.join("\n");
}

async function promptForConfigValue({ key, secret, stdin, stdout }) {
  stdout.write(`${describeConfigKey(key)}: `);

  if (!secret || typeof stdin.setRawMode !== "function") {
    return await readLine(stdin);
  }

  return await readSecret(stdin, stdout);
}

function describeConfigKey(key) {
  const labels = {
    CLOUDNS_AUTH_ID: "ClouDNS auth ID",
    CLOUDNS_AUTH_PASSWORD: "ClouDNS auth password",
    VPS_HOST: "VPS host",
    VPS_USER: "VPS user",
    VPS_SSH_KEY: "VPS SSH key path",
  };

  return labels[key] ?? key;
}

async function readLine(stdin) {
  return await new Promise((resolve) => {
    stdin.setEncoding("utf8");
    stdin.once("data", (chunk) => {
      stdin.pause();
      resolve(String(chunk).trim());
    });
  });
}

async function readSecret(stdin, stdout) {
  return await new Promise((resolve, reject) => {
    let value = "";
    stdin.setEncoding("utf8");
    stdin.resume?.();
    stdin.setRawMode(true);

    const onData = (chunk) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause?.();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause?.();
          stdin.off("data", onData);
          reject(new ConfigPromptAbortError("interactive setup canceled"));
          return;
        }
        if (char === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdin.on("data", onData);
  });
}
