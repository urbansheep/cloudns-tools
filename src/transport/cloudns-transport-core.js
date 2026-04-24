import { spawn } from "node:child_process";

export const CLOUDNS_API_BASE_URL = "https://api.cloudns.net";
export const CURL_STATUS_MARKER = "__CLOUDNS_HTTP_STATUS__:";

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

export class TransportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TransportError";
  }
}

export class SshTransportError extends TransportError {
  constructor(message, options) {
    super(message, options);
    this.name = "SshTransportError";
  }
}

export class DirectTransportError extends TransportError {
  constructor(message, options) {
    super(message, options);
    this.name = "DirectTransportError";
  }
}

export class BaseCloudnsTransport {
  constructor({ cloudnsAuthId, cloudnsAuthPassword, spawnImpl = spawn }) {
    this.cloudnsAuthId = cloudnsAuthId;
    this.cloudnsAuthPassword = cloudnsAuthPassword;
    this.spawnImpl = spawnImpl;
  }

  async listZones() {
    return await this.request("/dns/list-zones.json", {
      page: 1,
      "rows-per-page": 10,
    });
  }

  async request(path, params = {}, { responseType = "json" } = {}) {
    const stdout = await this.executeRequest({
      url: this.buildUrl(path),
      stdin: this.buildRequestBody(params),
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

export function parseRawCloudnsResponse(stdout) {
  const parsed = splitResponse(stdout);
  if (parsed.httpStatus >= 400) {
    return parseFailedCloudnsResponse(parsed.body, parsed.httpStatus);
  }

  return parsed.body;
}

export function parseCloudnsResponse(stdout) {
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

export function splitResponse(stdout) {
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

export function parseFailedCloudnsResponse(body, httpStatus) {
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

export function isAuthFailureMessage(message) {
  return (
    typeof message === "string" &&
    /authentication|invalid .*auth|incorrect .*password|incorrect .*user|auth-id|auth-password|sub-auth/i.test(
      message,
    )
  );
}

export function quoteForPosixShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
