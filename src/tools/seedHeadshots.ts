import {
  getHeadshotSeedOptions,
  seedCachedHeadshot,
  type HeadshotAge,
  type HeadshotRace,
  type HeadshotSeedInput,
  type HeadshotSex,
} from "../../server/headshots";

const SOURCE_SIZE = "1024x1024";

interface CliOptions {
  count: number;
  roles?: string[];
  races?: HeadshotRace[];
  sexes?: HeadshotSex[];
  ages?: HeadshotAge[];
  dryRun: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const options = getHeadshotSeedOptions();

  if (cli.help) {
    printHelp(options.roles, options.races, options.sexes, options.ages);
    return;
  }

  const roles = cli.roles ?? options.roles;
  const races = cli.races ?? options.races;
  const sexes = cli.sexes ?? options.sexes;
  const ages = cli.ages ?? options.ages;
  validateRoles(roles, options.roles);
  validateRaces(races, options.races);
  validateSexes(sexes, options.sexes);
  validateAges(ages, options.ages);

  const pairCount = roles.length * races.length * sexes.length * ages.length;
  console.log(`Headshot seed plan: ${cli.count} each for ${pairCount} role/race/sex/age pair${pairCount === 1 ? "" : "s"} (${pairCount * cli.count} images).`);
  console.log(`Settings: quality=low, source=${SOURCE_SIZE}`);

  if (cli.dryRun) {
    for (const role of roles) {
      for (const race of races) {
        for (const sex of sexes) {
          for (const age of ages) console.log(`- ${role} / ${race} / ${sex} / ${age}`);
        }
      }
    }
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to seed headshots.");
  }

  let completed = 0;
  const total = pairCount * cli.count;
  for (const role of roles) {
    for (const race of races) {
      for (const sex of sexes) {
        for (const age of ages) {
          console.log(`\n${role} / ${race} / ${sex} / ${age}`);
          for (let index = 0; index < cli.count; index += 1) {
            const result = await seedCachedHeadshot(toSeedInput(role, race, sex, age));
            completed += 1;
            console.log(`  ${index + 1}/${cli.count} created ${result.entry.id} (${completed}/${total}, ${result.available} ready)`);
          }
        }
      }
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
      case "--race":
      case "--races":
        options.races = parseRaceList(value());
        break;
      case "--sex":
      case "--sexes":
        options.sexes = parseSexList(value());
        break;
      case "--age":
      case "--ages":
        options.ages = parseAgeList(value());
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseRaceList(value: string): HeadshotRace[] {
  return parseList(value) as HeadshotRace[];
}

function parseSexList(value: string): HeadshotSex[] {
  return parseList(value) as HeadshotSex[];
}

function parseAgeList(value: string): HeadshotAge[] {
  return parseList(value) as HeadshotAge[];
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

function validateRaces(selected: readonly HeadshotRace[], allowed: readonly HeadshotRace[]): void {
  const invalid = selected.filter((item) => !allowed.includes(item));
  if (invalid.length > 0) {
    throw new Error(`Unknown race: ${invalid.join(", ")}. Allowed: ${allowed.join(", ")}.`);
  }
}

function validateSexes(selected: readonly HeadshotSex[], allowed: readonly HeadshotSex[]): void {
  const invalid = selected.filter((item) => !allowed.includes(item));
  if (invalid.length > 0) {
    throw new Error(`Unknown sex: ${invalid.join(", ")}. Allowed: ${allowed.join(", ")}.`);
  }
}

function validateAges(selected: readonly HeadshotAge[], allowed: readonly HeadshotAge[]): void {
  const invalid = selected.filter((item) => !allowed.includes(item));
  if (invalid.length > 0) {
    throw new Error(`Unknown age band: ${invalid.join(", ")}. Allowed: ${allowed.join(", ")}.`);
  }
}

function toSeedInput(role: string, race: HeadshotRace, sex: HeadshotSex, age: HeadshotAge): HeadshotSeedInput {
  return {
    role,
    race,
    sex,
    age,
  };
}

function printHelp(roles: readonly string[], races: readonly HeadshotRace[], sexes: readonly HeadshotSex[], ages: readonly HeadshotAge[]): void {
  console.log(`Seed cached OpenAI headshots.

Usage:
  npm run headshots:seed -- --count 2
  npm run headshots:seed -- 3 --roles pilot,navigator --races human,alien --sexes female,male --ages "adult,middle aged"

Options:
  -n, --count <n>       Images to create for each role/race/sex/age pair. Default: 1.
  --roles <list>        Comma list. Default: ${roles.join(", ")}.
  --races <list>        Comma list. Default: ${races.join(", ")}.
  --sexes <list>        Comma list. Default: ${sexes.join(", ")}.
  --ages <list>         Comma list. Default: ${ages.join(", ")}.
  --dry-run             Print the plan without calling OpenAI.
  -h, --help            Show this help.

Generation uses quality=low and source size ${SOURCE_SIZE}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
