import { getHeadshotSeedOptions, seedCachedHeadshot, type HeadshotSeedInput } from "../../server/headshots";

const SOURCE_SIZE = "1024x1024";

interface CliOptions {
  count: number;
  roles?: string[];
  clothing?: string;
  dryRun: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const options = getHeadshotSeedOptions();

  if (cli.help) {
    printHelp(options.roles);
    return;
  }

  const roles = cli.roles ?? options.roles;
  validateRoles(roles, options.roles);

  console.log(`Headshot seed plan: ${cli.count} each for ${roles.length} role${roles.length === 1 ? "" : "s"} (${roles.length * cli.count} images).`);
  console.log(`Settings: quality=low, source=${SOURCE_SIZE}${cli.clothing ? `, clothing="${cli.clothing}"` : ""}`);

  if (cli.dryRun) {
    for (const role of roles) console.log(`- ${role}`);
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to seed headshots.");
  }

  let completed = 0;
  const total = roles.length * cli.count;
  for (const role of roles) {
    console.log(`\n${role}`);
    for (let index = 0; index < cli.count; index += 1) {
      const result = await seedCachedHeadshot(toSeedInput(role, cli));
      completed += 1;
      console.log(`  ${index + 1}/${cli.count} created ${result.entry.id} (${completed}/${total}, ${result.available} ready)`);
    }
  }

  console.log(`\nDone. Seeded ${completed} cached headshot${completed === 1 ? "" : "s"}.`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    count: 1,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (/^\d+$/.test(token)) {
      options.count = parsePositiveInteger(token, "count");
      continue;
    }

    const [name, inlineValue] = token.split("=", 2);
    const value = () => inlineValue ?? args[++index] ?? "";

    switch (name) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--count":
      case "-n":
        options.count = parsePositiveInteger(value(), "count");
        break;
      case "--role":
      case "--roles":
        options.roles = parseList(value());
        break;
      case "--clothing":
        options.clothing = value().trim() || undefined;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function parsePositiveInteger(value: string, label: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) throw new Error(`${label} must be a positive integer.`);
  return numeric;
}

function validateRoles(selected: readonly string[], allowed: readonly string[]): void {
  const invalid = selected.filter((item) => !allowed.includes(item));
  if (invalid.length > 0) {
    throw new Error(`Unknown role: ${invalid.join(", ")}. Allowed: ${allowed.join(", ")}.`);
  }
}

function toSeedInput(role: string, options: CliOptions): HeadshotSeedInput {
  return {
    role,
    clothing: options.clothing,
  };
}

function printHelp(roles: readonly string[]): void {
  console.log(`Seed cached OpenAI headshots.

Usage:
  npm run headshots:seed -- --count 2
  npm run headshots:seed -- 3 --roles pilot,navigator

Options:
  -n, --count <n>       Images to create for each role. Default: 1.
  --roles <list>        Comma list. Default: ${roles.join(", ")}.
  --clothing <text>     Optional clothing guidance applied to every generated headshot.
  --dry-run             Print the plan without calling OpenAI.
  -h, --help            Show this help.

Generation uses quality=low and source size ${SOURCE_SIZE}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
