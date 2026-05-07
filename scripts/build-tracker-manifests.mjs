import { mkdir, readFile, writeFile } from "node:fs/promises";

const outDir = new URL("../public/audio/tracker/", import.meta.url);
const noteNames = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
const encoder = new TextEncoder();

const tracks = [
  { id: "space-voyage", file: "pirate_-_space_voyage.mod", title: "Space Voyage" },
  { id: "helly-space", file: "helly_-_space.mod", title: "Helly Space" },
  { id: "spacecraft", file: "enacostione_-_spacecraft.xm", title: "Spacecraft" },
  { id: "space-light", file: "01_space_light.it", title: "Space Light" },
  { id: "scifi", file: "scifi.s3m", title: "Sci-Fi Satellites" },
  { id: "space-debris", file: "space_debris.mod", title: "Space Debris" },
  { id: "endless-hallways", file: "lost_in_endless_hallways.mptm", title: "Lost in Endless Hallways" },
  { id: "tom-hanks", file: "tom_hanks.mod", title: "Tom Hanks" },
  { id: "eight-bit-bytes", file: "platonist_-_eight_8-bit_sized_bytes.mptm", title: "Eight 8-bit Sized Bytes" },
  { id: "endfield", file: "endfield.mod", title: "Endfield" },
  { id: "virtual-light", file: "phandral_-_virtual_light.s3m", title: "Virtual Light" },
  { id: "twylight-intro", file: "4-mat_-_twylight_intro_ver.mod", title: "Twylight (Intro)" },
  { id: "drifting-mix", file: "drifting_mix.mod", title: "Drifting Mix" },
  { id: "satell", file: "SATELL.S3M", title: "Satell" },
  { id: "celestial-fantasia", file: "celestial_fantasia.s3m", title: "Celestial Fantasia" },
  { id: "yuki-satellites", file: "radix_-_yuki_satellites.xm", title: "Yuki Satellites" },
  { id: "pod", file: "pod.s3m", title: "POD" },
  { id: "multi-universe-traveler", file: "theduccinator_-_multi-universe_traveler.it", title: "Multi-Universe Traveler" },
];

await mkdir(outDir, { recursive: true });

const libopenmpt = (await import("chiptune3/libopenmpt.worklet.js")).default;
const lib = await libopenmpt();

for (const track of tracks) {
  const manifest = await buildManifest(track);
  await writeFile(new URL(`${track.id}.json`, outDir), `${JSON.stringify(manifest)}\n`);
  console.log(`${track.file}: ${manifest.format}, ${manifest.sourceChannels}ch, ${manifest.orders.length} orders`);
}

async function buildManifest(track) {
  const fileUrl = new URL(track.file, outDir);
  const bytes = await readFile(fileUrl);
  const ptr = lib._malloc(bytes.byteLength);
  lib.HEAPU8.set(bytes, ptr);
  const modulePtr = lib._openmpt_module_create_from_memory(ptr, bytes.byteLength, 0, 0, 0);
  lib._free(ptr);
  if (!modulePtr) throw new Error(`Could not parse ${fileUrl.pathname}`);

  try {
    const orderCount = lib._openmpt_module_get_num_orders(modulePtr);
    const patternCount = lib._openmpt_module_get_num_patterns(modulePtr);
    const sourceChannels = lib._openmpt_module_get_num_channels(modulePtr);
    const format = (metadata(modulePtr, "type") || extensionFor(track.file)).toUpperCase();
    const moduleTitle = metadata(modulePtr, "title") || track.title;
    const tracker = metadata(modulePtr, "tracker");
    const orders = [];
    const patterns = [];

    for (let order = 0; order < orderCount; order += 1) {
      const pattern = lib._openmpt_module_get_order_pattern(modulePtr, order);
      const name = utf8(lib._openmpt_module_get_order_name(modulePtr, order));
      orders.push({ pattern, section: name || `ORD${hex(order, 2)}` });
    }

    for (let patternIndex = 0; patternIndex < patternCount; patternIndex += 1) {
      const name = utf8(lib._openmpt_module_get_pattern_name(modulePtr, patternIndex));
      const rows = [];
      const rowCount = lib._openmpt_module_get_pattern_num_rows(modulePtr, patternIndex);
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const channels = [];
        for (let channelIndex = 0; channelIndex < sourceChannels; channelIndex += 1) {
          const commands = [];
          for (let commandIndex = 0; commandIndex < 6; commandIndex += 1) {
            commands.push(lib._openmpt_module_get_pattern_row_channel_command(modulePtr, patternIndex, rowIndex, channelIndex, commandIndex));
          }
          channels.push(labelOpenMptCell(commands));
        }
        rows.push({ step: rowIndex, section: name || `PAT${hex(patternIndex, 2)}`, channels });
      }
      patterns.push({ section: name || `PAT${hex(patternIndex, 2)}`, rows });
    }

    return {
      id: track.id,
      title: moduleTitle,
      displayTitle: track.title,
      format,
      tracker,
      bpm: Math.round(lib._openmpt_module_get_current_estimated_bpm(modulePtr) || 125),
      sourceChannels,
      channels: Array.from({ length: sourceChannels }, (_, index) => channelName(modulePtr, index)),
      orders,
      patterns,
    };
  } finally {
    lib._openmpt_module_destroy(modulePtr);
  }
}

function labelOpenMptCell([noteValue, instrument, volumeEffect, effect, volume, parameter]) {
  const parts = [];
  if (noteValue > 0) parts.push(openMptNoteName(noteValue));
  if (instrument > 0) parts.push(instrument.toString(16).toUpperCase().padStart(2, "0"));
  if (volumeEffect > 0 || volume > 0) parts.push(`V${hex(volumeEffect, 1)}${hex(volume, 2)}`);
  if (effect > 0 || parameter > 0) parts.push(`${effect.toString(16).toUpperCase()}${hex(parameter, 2)}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

function openMptNoteName(value) {
  if (value >= 1 && value <= 120) {
    const note = value - 1;
    return `${noteNames[modulo(note, 12)]}${Math.floor(note / 12)}`;
  }
  if (value === 121) return "OFF";
  if (value === 122) return "CUT";
  if (value === 123) return "FADE";
  return `N${hex(value, 2)}`;
}

function channelName(modulePtr, index) {
  const name = utf8(lib._openmpt_module_get_channel_name(modulePtr, index));
  return name || `C${index + 1}`;
}

function metadata(modulePtr, key) {
  const encoded = encoder.encode(key);
  const keyPtr = lib._malloc(encoded.length + 1);
  lib.HEAPU8.set(encoded, keyPtr);
  lib.HEAPU8[keyPtr + encoded.length] = 0;
  const valuePtr = lib._openmpt_module_get_metadata(modulePtr, keyPtr);
  lib._free(keyPtr);
  return utf8(valuePtr);
}

function utf8(ptr) {
  return ptr ? lib.UTF8ToString(ptr).trim() : "";
}

function extensionFor(file) {
  return file.slice(file.lastIndexOf(".") + 1);
}

function hex(value, size) {
  return value.toString(16).toUpperCase().padStart(size, "0");
}

function modulo(value, mod) {
  return ((value % mod) + mod) % mod;
}
