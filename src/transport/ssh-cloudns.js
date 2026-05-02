import {
  BaseCloudnsTransport,
  CURL_STATUS_MARKER,
  quoteForPosixShell,
  CloudnsApiError,
  CloudnsAuthError,
  SshTransportError,
  runChildProcess,
} from "./cloudns-transport-core.js";

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
  return runChildProcess({
    spawnImpl,
    command: "ssh",
    args: [
      "-i",
      vpsSshKey,
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=yes",
      "-l",
      vpsUser,
      vpsHost,
      remoteCommand,
    ],
    stdin,
    ErrorClass: SshTransportError,
    timeoutMessage: "SSH transport timed out",
    failureMessage: "SSH transport failed",
  });
}
