export class TransportResolutionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TransportResolutionError";
  }
}

export async function resolveTransport({
  cliTransport,
  envTransport,
  stdin,
  stdout,
  promptImpl = promptForTransport,
} = {}) {
  if (cliTransport && envTransport) {
    if (cliTransport !== envTransport) {
      throw new TransportResolutionError("transport selector conflict between CLI and env");
    }

    return cliTransport;
  }

  if (cliTransport) {
    return cliTransport;
  }

  if (envTransport) {
    return envTransport;
  }

  if (stdin?.isTTY && stdout?.isTTY) {
    return normalizePromptSelection(await promptImpl({ stdin, stdout }));
  }

  throw new TransportResolutionError(
    "transport must be set via --transport or CLOUDNS_TRANSPORT in non-interactive mode",
  );
}

async function promptForTransport({ stdin, stdout }) {
  stdout.write("Select transport: [1] ssh via VPS [2] direct on this machine\n");
  stdout.write("> ");

  return await new Promise((resolve) => {
    const input = stdin;
    input.setEncoding("utf8");
    input.once("data", (chunk) => {
      input.pause();
      resolve(String(chunk).trim());
    });
  });
}

function normalizePromptSelection(answer) {
  if (answer === "1" || String(answer).toLowerCase() === "ssh") {
    return "ssh";
  }
  if (answer === "2" || String(answer).toLowerCase() === "direct") {
    return "direct";
  }

  throw new TransportResolutionError("invalid transport selection");
}
