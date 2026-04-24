import { BaseCloudnsTransport, CURL_STATUS_MARKER, quoteForPosixShell, CloudnsApiError, CloudnsAuthError, SshTransportError } from "./cloudns-transport-core.js";

export { CloudnsApiError, CloudnsAuthError, SshTransportError };

export class SshCloudnsTransport extends BaseCloudnsTransport {
  constructor({ cloudnsAuthId, cloudnsAuthPassword, vpsHost, vpsUser, vpsSshKey, spawnImpl }) {
    super({ cloudnsAuthId, cloudnsAuthPassword, spawnImpl });
    this.vpsHost = vpsHost;
    this.vpsUser = vpsUser;
    this.vpsSshKey = vpsSshKey;
  }

  async executeRequest({ url, stdin }) {
    return await runSshCommand({
      spawnImpl: this.spawnImpl,
      vpsUser: this.vpsUser,
      vpsHost: this.vpsHost,
      vpsSshKey: this.vpsSshKey,
      remoteCommand:
        `curl -sS --connect-timeout 10 --max-time 30 --data-binary @- ` +
        `-w '\\n${CURL_STATUS_MARKER}%{http_code}' ${quoteForPosixShell(url.toString())}`,
      stdin,
    });
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
