const BOOLEAN_FLAGS = new Set(["dry-run", "verbose", "confirm", "refresh-templates"]);
const VALUE_FLAGS = new Set([
  "format",
  "type",
  "name",
  "value",
  "ttl",
  "priority",
  "weight",
  "port",
  "id",
  "output",
  "input",
  "caa-flag",
  "caa-type",
]);

export function parseArgs(argv) {
  const positionals = [];
  const flags = {
    dryRun: false,
    verbose: false,
    confirm: false,
    refreshTemplates: false,
    format: "text",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    if (BOOLEAN_FLAGS.has(rawName)) {
      flags[toCamelCase(rawName)] = true;
      continue;
    }

    if (!VALUE_FLAGS.has(rawName)) {
      throw new UsageError(`unknown flag --${rawName}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`missing value for --${rawName}`);
    }
    index += inlineValue === undefined ? 1 : 0;
    flags[toCamelCase(rawName)] = value;
  }

  if (flags.format !== "text" && flags.format !== "json" && flags.format !== "bind") {
    throw new UsageError("format must be text, json, or bind");
  }

  return { positionals, flags };
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function toCamelCase(name) {
  return name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
