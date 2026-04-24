import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REQUIRED_CONFIG_KEYS = [
  "CLOUDNS_AUTH_ID",
  "CLOUDNS_AUTH_PASSWORD",
  "VPS_HOST",
  "VPS_USER",
  "VPS_SSH_KEY",
];

export async function loadConfig(cwd) {
  const values = parseDotEnv(await readFile(join(cwd, ".env"), "utf8"));
  const missingKeys = REQUIRED_CONFIG_KEYS.filter((key) => !hasNonEmptyValue(values[key]));

  if (missingKeys.length > 0) {
    return { ok: false, missingKeys };
  }

  return {
    ok: true,
    config: {
      cloudnsAuthId: values.CLOUDNS_AUTH_ID.trim(),
      cloudnsAuthPassword: values.CLOUDNS_AUTH_PASSWORD.trim(),
      vpsHost: values.VPS_HOST.trim(),
      vpsUser: values.VPS_USER.trim(),
      vpsSshKey: values.VPS_SSH_KEY.trim(),
    },
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
