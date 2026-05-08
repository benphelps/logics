import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { INTERFACE_TOUR, TUTORIAL_CUES, TUTORIAL_INTROS } from "../sim/tutorial";

// Generates Opus/Ogg voice clips for every UI overview tour stop using the
// ElevenLabs v3 model (the only model that responds to audio tags like
// [amused], [curious], etc.). Reads INTERFACE_TOUR.tts as the source of
// truth — generation never touches the displayed body copy.
//
// Idempotent: skips files that already exist on disk so re-runs only fill
// gaps. Pass --force to regenerate everything (e.g. after editing copy).
//
// Required env: ELEVENLABS_API_KEY.

const VOICE_ID = "UECVFkauaHTBda6jJAOP";
const MODEL_ID = "eleven_v3";
const OUTPUT_FORMAT = "opus_48000_128";
const FILE_EXT = ".ogg";
const REQUEST_GAP_MS = 350;

const outDir = fileURLToPath(new URL("../../public/audio/tutorial/", import.meta.url));

async function main(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is required. Set it in your shell env before running.");
  }

  const force = process.argv.includes("--force");
  const onlyArg = process.argv.find(a => a.startsWith("--only="));
  const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

  await mkdir(outDir, { recursive: true });

  // Flatten tour stops + first-time-mechanic intros + audio cues into
  // one list. All three produce the same kind of voice clip; they only
  // differ in when the controller plays them.
  const items: { id: string; tts: string }[] = [
    ...INTERFACE_TOUR.map(s => ({ id: s.id, tts: s.tts })),
    ...Object.values(TUTORIAL_INTROS).map(i => ({ id: i.id, tts: i.tts })),
    ...Object.values(TUTORIAL_CUES).map(c => ({ id: c.id, tts: c.tts })),
  ];

  console.log(`Tutorial audio generation`);
  console.log(`  voice:   ${VOICE_ID}`);
  console.log(`  model:   ${MODEL_ID}`);
  console.log(`  format:  ${OUTPUT_FORMAT}`);
  console.log(`  out dir: ${outDir}`);
  console.log(`  items:   ${items.length} (${INTERFACE_TOUR.length} tour + ${Object.keys(TUTORIAL_INTROS).length} intro + ${Object.keys(TUTORIAL_CUES).length} cue)${only ? ` (filtered to ${only.size})` : ""}`);
  console.log(`  force:   ${force}`);
  console.log();

  let generated = 0;
  let skipped = 0;
  for (const stop of items) {
    if (only && !only.has(stop.id)) continue;
    const dest = `${outDir}${stop.id}${FILE_EXT}`;

    if (!force && (await exists(dest))) {
      console.log(`skip   ${stop.id}  (file exists)`);
      skipped += 1;
      continue;
    }

    console.log(`gen    ${stop.id}  (${stop.tts.length} chars)…`);
    const bytes = await synthesize(stop.tts, apiKey);
    await writeFile(dest, bytes);
    console.log(`       → ${dest} (${bytes.length} bytes)`);
    generated += 1;

    // Tiny breather between requests so we don't hammer the API on a
    // tight loop. ElevenLabs handles concurrency fine, but a 350ms
    // pause keeps logs readable and gives Ctrl-C a fair chance.
    await sleep(REQUEST_GAP_MS);
  }

  console.log();
  console.log(`Done. Generated ${generated}, skipped ${skipped}.`);
}

async function synthesize(text: string, apiKey: string): Promise<Buffer> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/ogg",
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(`ElevenLabs ${res.status} ${res.statusText}: ${detail.slice(0, 400)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
