#!/usr/bin/env node
import { runCli } from "../src/cli.js";

try {
  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error) {
  process.stderr.write(`fatal: ${error?.message ?? "unexpected error"}\n`);
  process.exitCode = 1;
}
