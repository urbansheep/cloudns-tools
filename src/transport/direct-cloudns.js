import { BaseCloudnsTransport, CURL_STATUS_MARKER, DirectTransportError, runChildProcess } from "./cloudns-transport-core.js";

export class DirectCloudnsTransport extends BaseCloudnsTransport {
  async executeRequest({ url, stdin }) {
    return await runLocalCurl({
      spawnImpl: this.spawnImpl,
      args: [
        "-sS",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "--data-binary",
        "@-",
        "-w",
        `\n${CURL_STATUS_MARKER}%{http_code}`,
        url.toString(),
      ],
      stdin,
    });
  }
}

function runLocalCurl({ spawnImpl, args, stdin }) {
  return runChildProcess({
    spawnImpl,
    command: "curl",
    args,
    stdin,
    ErrorClass: DirectTransportError,
    timeoutMessage: "Direct transport timed out",
    failureMessage: "Direct transport failed",
  });
}
