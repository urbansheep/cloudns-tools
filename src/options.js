const BOOLEAN_FLAGS = new Set(["dry-run", "verbose", "confirm", "refresh-templates"]);
const VALUE_FLAGS = new Set([
  "transport",
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
const SHORT_FLAG_ALIASES = new Map([
  ["t", "transport"],
  ["f", "format"],
  ["n", "dry-run"],
  ["v", "verbose"],
  ["y", "confirm"],
  ["T", "type"],
  ["N", "name"],
  ["V", "value"],
  ["o", "output"],
]);
const VALID_TRANSPORTS = new Set(["ssh", "direct"]);

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
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      const shortName = arg.slice(1);
      const longName = SHORT_FLAG_ALIASES.get(shortName);

      if (!longName) {
        throw new UsageError(`unknown flag -${shortName}`);
      }

      index = assignFlag(flags, argv, index, longName);
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    index = assignFlag(flags, argv, index, rawName, { inlineValue });
  }

  if (flags.format !== "text" && flags.format !== "json" && flags.format !== "bind") {
    throw new UsageError("format must be text, json, or bind");
  }
  if (flags.transport !== undefined && !VALID_TRANSPORTS.has(flags.transport)) {
    throw new UsageError("transport must be ssh or direct");
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

function assignFlag(flags, argv, index, rawName, { inlineValue } = {}) {
  if (BOOLEAN_FLAGS.has(rawName)) {
    flags[toCamelCase(rawName)] = true;
    return index;
  }

  if (!VALUE_FLAGS.has(rawName)) {
    throw new UsageError(`unknown flag --${rawName}`);
  }

  const value = inlineValue ?? argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`missing value for --${rawName}`);
  }

  flags[toCamelCase(rawName)] = value;
  return index + (inlineValue === undefined ? 1 : 0);
}
