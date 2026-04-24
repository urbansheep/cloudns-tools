import { spawn } from "node:child_process";

const CLOUDNS_API_BASE_URL = "https://api.cloudns.net";
const CURL_STATUS_MARKER = "__CLOUDNS_HTTP_STATUS__:";

export class CloudnsApiError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CloudnsApiError";
  }
}

export class CloudnsAuthError extends CloudnsApiError {
  constructor(message, options) {
    super(message, options);
    this.name = "CloudnsAuthError";
  }
}

export class SshTransportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SshTransportError";
  }
}

export class SshCloudnsTransport {
  constructor({
    cloudnsAuthId,
    cloudnsAuthPassword,
    vpsHost,
    vpsUser,
    vpsSshKey,
    spawnImpl = spawn,
  }) {
    this.cloudnsAuthId = cloudnsAuthId;
    this.cloudnsAuthPassword = cloudnsAuthPassword;
    this.vpsHost = vpsHost;
    this.vpsUser = vpsUser;
    this.vpsSshKey = vpsSshKey;
    this.spawnImpl = spawnImpl;
  }

  async listZones() {
    return await this.request("/dns/list-zones.json", {
      page: 1,
      "rows-per-page": 10,
    });
  }

  async request(path, params = {}, { responseType = "json" } = {}) {
    const url = this.buildUrl(path);
    const body = this.buildRequestBody(params);
    const stdout = await runSshCommand({
      spawnImpl: this.spawnImpl,
      vpsUser: this.vpsUser,
      vpsHost: this.vpsHost,
      vpsSshKey: this.vpsSshKey,
      remoteCommand:
        `curl -sS --connect-timeout 10 --max-time 30 --data-binary @- ` +
        `-w '\\n${CURL_STATUS_MARKER}%{http_code}' ${quoteForPosixShell(url.toString())}`,
      stdin: body,
    });

    return responseType === "raw" ? parseRawCloudnsResponse(stdout) : parseCloudnsResponse(stdout);
  }

  buildUrl(path) {
    return new URL(path, CLOUDNS_API_BASE_URL);
  }

  buildRequestBody(params) {
    const requestParams = new URLSearchParams();
    requestParams.set("auth-id", this.cloudnsAuthId);
    requestParams.set("auth-password", this.cloudnsAuthPassword);

    for (const [key, value] of Object.entries(params)) {
      requestParams.set(key, String(value));
    }

    return requestParams.toString();
  }
}

function runSshCommand({ spawnImpl, vpsUser, vpsHost, vpsSshKey, remoteCommand, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      "ssh",
      [
        "-i",
        vpsSshKey,
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=accept-new",
        `${vpsUser}@${vpsHost}`,
        remoteCommand,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGKILL");
      reject(new SshTransportError("SSH transport timed out", { stderr }));
    }, 45000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(new SshTransportError("SSH transport failed", { cause: error, stderr }));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new SshTransportError("SSH transport failed", { cause: new Error(`exit ${code}`), stderr }));
    });
  });
}

function parseRawCloudnsResponse(stdout) {
  const parsed = splitResponse(stdout);
  if (parsed.httpStatus >= 400) {
    return parseFailedCloudnsResponse(parsed.body, parsed.httpStatus);
  }

  return parsed.body;
}

function parseCloudnsResponse(stdout) {
  const parsed = splitResponse(stdout);
  if (parsed.httpStatus >= 400) {
    return parseFailedCloudnsResponse(parsed.body, parsed.httpStatus);
  }

  let payload;
  try {
    payload = JSON.parse(parsed.body);
  } catch (error) {
    throw new CloudnsApiError("CloudNS API returned invalid JSON", { cause: error });
  }

  if (payload && typeof payload === "object" && payload.status === "Failed") {
    if (isAuthFailureMessage(payload.statusDescription)) {
      throw new CloudnsAuthError("CloudNS authentication failed");
    }

    throw new CloudnsApiError("CloudNS API rejected the probe");
  }

  return payload;
}

function splitResponse(stdout) {
  const marker = `\n${CURL_STATUS_MARKER}`;
  const markerIndex = stdout.lastIndexOf(marker);

  if (markerIndex === -1) {
    throw new CloudnsApiError("CloudNS API returned an unexpected response");
  }

  const body = stdout.slice(0, markerIndex);
  const httpStatus = Number(stdout.slice(markerIndex + marker.length).trim());

  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new CloudnsApiError("CloudNS API returned an invalid status marker");
  }

  return { body, httpStatus };
}

function parseFailedCloudnsResponse(body, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) {
    throw new CloudnsAuthError("CloudNS authentication failed");
  }

  try {
    const payload = JSON.parse(body);
    if (payload && typeof payload === "object" && payload.status === "Failed") {
      if (isAuthFailureMessage(payload.statusDescription)) {
        throw new CloudnsAuthError("CloudNS authentication failed");
      }

      throw new CloudnsApiError("CloudNS API rejected the probe");
    }
  } catch (error) {
    if (error instanceof CloudnsApiError || error instanceof CloudnsAuthError) {
      throw error;
    }
  }

  throw new CloudnsApiError("CloudNS API rejected the probe");
}

function isAuthFailureMessage(message) {
  return (
    typeof message === "string" &&
    /authentication|invalid .*auth|incorrect .*password|incorrect .*user|auth-id|auth-password|sub-auth/i.test(
      message,
    )
  );
}

function quoteForPosixShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
