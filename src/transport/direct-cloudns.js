import { BaseCloudnsTransport, CURL_STATUS_MARKER, DirectTransportError } from "./cloudns-transport-core.js";

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
  return new Promise((resolve, reject) => {
    const child = spawnImpl("curl", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGKILL");
      reject(new DirectTransportError("Direct transport timed out", { stderr }));
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
      reject(new DirectTransportError("Direct transport failed", { cause: error, stderr }));
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

      reject(new DirectTransportError("Direct transport failed", { cause: new Error(`exit ${code}`), stderr }));
    });
  });
}
