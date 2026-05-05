export type TrackerModeId = "space-voyage" | "helly-space" | "spacecraft" | "space-light" | "scifi";

export interface TrackerMode {
  id: TrackerModeId;
  label: string;
  format: string;
  bpm: number;
  channelCount: number;
  channelLabels: readonly string[];
  moduleUrl: string;
  manifestUrl: string;
  credit?: string;
}

export interface TrackerCell {
  label: string;
}

export interface TrackerRow {
  step: number;
  section: string;
  channels: Array<TrackerCell | undefined>;
}

export interface TrackerSnapshot {
  playing: boolean;
  loading: boolean;
  mode: TrackerMode;
  order: number;
  patternIndex: number;
  row: number;
  position: number;
  duration: number;
  volume: number;
  channelLabels: readonly string[];
  pattern: TrackerRow[];
  levels: readonly number[];
  error: string | null;
}

interface ModuleManifest {
  id?: string;
  title: string;
  displayTitle?: string;
  format: string;
  bpm: number;
  channels: string[];
  sourceChannels?: number;
  tracker?: string;
  orders: Array<{ pattern: number; section: string }>;
  patterns: Array<{
    section: string;
    rows: Array<{
      step: number;
      section: string;
      channels: Array<string | null>;
    }>;
  }>;
}

interface ChiptuneProgress {
  pos: number;
  order: number;
  pattern: number;
  row: number;
}

interface ChiptuneMetadata {
  dur?: number;
  totalOrders?: number;
  totalPatterns?: number;
}

interface ChiptunePlayer {
  context: AudioContext;
  onInitialized: (handler: () => void) => void;
  onEnded: (handler: () => void) => void;
  onError: (handler: (error: { type?: string }) => void) => void;
  onMetadata: (handler: (metadata: ChiptuneMetadata) => void) => void;
  onProgress: (handler: (progress: ChiptuneProgress) => void) => void;
  play: (buffer: ArrayBuffer) => void;
  pause: () => void;
  stop: () => void;
  setRepeatCount: (repeatCount: number) => void;
  setVol: (volume: number) => void;
}

type ChiptuneConstructor = new (config?: {
  repeatCount?: number;
  stereoSeparation?: number;
  interpolationFilter?: number;
}) => ChiptunePlayer;

type ChiptuneModule = {
  ChiptuneJsPlayer: ChiptuneConstructor;
};

export const TRACKER_MODES: readonly TrackerMode[] = [
  {
    id: "space-voyage",
    label: "Space Voyage",
    format: "MOD",
    bpm: 125,
    channelCount: 4,
    channelLabels: channelLabels(4),
    moduleUrl: "/audio/tracker/pirate_-_space_voyage.mod",
    manifestUrl: "/audio/tracker/space-voyage.json",
  },
  {
    id: "helly-space",
    label: "Helly Space",
    format: "MOD",
    bpm: 125,
    channelCount: 4,
    channelLabels: channelLabels(4),
    moduleUrl: "/audio/tracker/helly_-_space.mod",
    manifestUrl: "/audio/tracker/helly-space.json",
  },
  {
    id: "spacecraft",
    label: "Spacecraft",
    format: "XM",
    bpm: 198,
    channelCount: 6,
    channelLabels: channelLabels(6),
    moduleUrl: "/audio/tracker/enacostione_-_spacecraft.xm",
    manifestUrl: "/audio/tracker/spacecraft.json",
  },
  {
    id: "space-light",
    label: "Space Light",
    format: "IT",
    bpm: 242,
    channelCount: 32,
    channelLabels: channelLabels(32),
    moduleUrl: "/audio/tracker/01_space_light.it",
    manifestUrl: "/audio/tracker/space-light.json",
  },
  {
    id: "scifi",
    label: "Sci-Fi Satellites",
    format: "S3M",
    bpm: 192,
    channelCount: 16,
    channelLabels: channelLabels(16),
    moduleUrl: "/audio/tracker/scifi.s3m",
    manifestUrl: "/audio/tracker/scifi.json",
  },
];

export function createTrackerSnapshot(): TrackerSnapshot {
  const mode = TRACKER_MODES[0];
  return {
    playing: false,
    loading: false,
    mode,
    order: 0,
    patternIndex: 0,
    row: 0,
    position: 0,
    duration: 0,
    volume: 0.48,
    channelLabels: mode.channelLabels,
    pattern: emptyPattern("INT", mode.channelCount),
    levels: emptyLevels(mode.channelCount),
    error: null,
  };
}

export class KeygenTracker {
  private mode = TRACKER_MODES[0];
  private volume = 0.48;
  private playing = false;
  private loading = false;
  private order = 0;
  private patternIndex = 0;
  private row = 0;
  private position = 0;
  private duration = 0;
  private channelLabels = this.mode.channelLabels;
  private pattern = emptyPattern("INT", this.mode.channelCount);
  private levels = emptyLevels(this.mode.channelCount);
  private error: string | null = null;
  private manifest: ModuleManifest | null = null;
  private player: ChiptunePlayer | null = null;
  private playerPromise: Promise<ChiptunePlayer> | null = null;
  private loadSerial = 0;
  private lastProgressEmitAt = 0;
  private readonly manifests = new Map<TrackerModeId, Promise<ModuleManifest>>();
  private readonly modules = new Map<TrackerModeId, Promise<ArrayBuffer>>();
  private readonly onSnapshot: (snapshot: TrackerSnapshot) => void;

  constructor(onSnapshot: (snapshot: TrackerSnapshot) => void) {
    this.onSnapshot = onSnapshot;
    void this.preloadManifest(this.mode);
  }

  snapshot(): TrackerSnapshot {
    return {
      playing: this.playing,
      loading: this.loading,
      mode: this.mode,
      order: this.order,
      patternIndex: this.patternIndex,
      row: this.row,
      position: this.position,
      duration: this.duration,
      volume: this.volume,
      channelLabels: this.channelLabels,
      pattern: this.pattern,
      levels: [...this.levels],
      error: this.error,
    };
  }

  async start(): Promise<void> {
    await this.playMode(false);
  }

  stop(): void {
    this.player?.pause();
    this.playing = false;
    this.loading = false;
    this.levels = emptyLevels(this.channelLabels.length);
    this.emit();
  }

  dispose(): void {
    this.player?.stop();
    void this.player?.context.close();
    this.player = null;
    this.playerPromise = null;
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.player?.setVol(this.volume);
    this.emit();
  }

  setMode(modeId: TrackerModeId): void {
    const nextMode = TRACKER_MODES.find(mode => mode.id === modeId) ?? TRACKER_MODES[0];
    if (nextMode.id === this.mode.id) return;
    this.mode = nextMode;
    this.order = 0;
    this.patternIndex = 0;
    this.row = 0;
    this.position = 0;
    this.duration = 0;
    this.manifest = null;
    this.channelLabels = nextMode.channelLabels;
    this.pattern = emptyPattern("INT", nextMode.channelCount);
    this.levels = emptyLevels(nextMode.channelCount);
    this.error = null;
    if (this.playing) void this.playMode(true);
    else void this.preloadManifest(nextMode);
    this.emit();
  }

  regenerate(): void {
    void this.playMode(true);
  }

  private async playMode(forceRestart: boolean): Promise<void> {
    if (this.playing && !forceRestart) return;
    const serial = ++this.loadSerial;
    const mode = this.mode;
    this.loading = true;
    this.error = null;
    this.emit();

    try {
      const [player, manifest, buffer] = await Promise.all([
        this.ensurePlayer(),
        this.loadManifest(mode),
        this.loadModule(mode),
      ]);
      if (serial !== this.loadSerial || mode.id !== this.mode.id) return;
      this.manifest = manifest;
      this.duration = 0;
      this.order = 0;
      this.patternIndex = manifest.orders[0]?.pattern ?? 0;
      this.row = 0;
      this.position = 0;
      this.channelLabels = labelsForManifest(mode, manifest);
      this.pattern = rowsForManifest(manifest, this.patternIndex, this.order, this.channelLabels.length);
      this.levels = levelsForRow(this.pattern[0], this.channelLabels.length);
      this.lastProgressEmitAt = 0;
      player.setRepeatCount(-1);
      player.setVol(this.volume);
      await player.context.resume();
      if (forceRestart) player.stop();
      player.play(buffer.slice(0));
      this.playing = true;
      this.loading = false;
      this.emit();
    } catch (error) {
      if (serial !== this.loadSerial) return;
      this.error = error instanceof Error ? error.message : "Tracker module could not start.";
      this.playing = false;
      this.loading = false;
      this.emit();
    }
  }

  private async ensurePlayer(): Promise<ChiptunePlayer> {
    if (this.player) return this.player;
    if (this.playerPromise) return this.playerPromise;
    this.playerPromise = import("chiptune3")
      .then(module => {
        const { ChiptuneJsPlayer } = module as ChiptuneModule;
        const player = new ChiptuneJsPlayer({
          repeatCount: -1,
          stereoSeparation: 76,
          interpolationFilter: 1,
        });
        return new Promise<ChiptunePlayer>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error("Tracker player timed out while initializing.")), 6000);
          player.onInitialized(() => {
            window.clearTimeout(timeout);
            this.player = player;
            this.bindPlayer(player);
            resolve(player);
          });
          player.onError(error => {
            window.clearTimeout(timeout);
            reject(new Error(`Tracker player error: ${error.type ?? "unknown"}`));
          });
        });
      })
      .catch(error => {
        this.playerPromise = null;
        throw error;
      });
    return this.playerPromise;
  }

  private bindPlayer(player: ChiptunePlayer): void {
    player.onMetadata(metadata => {
      this.duration = metadata.dur ?? this.duration;
      this.emit();
    });
    player.onProgress(progress => {
      if (!this.playing || !this.manifest) return;
      const nextOrder = clamp(Math.floor(progress.order), 0, Math.max(0, this.manifest.orders.length - 1));
      const nextPattern = clamp(Math.floor(progress.pattern), 0, Math.max(0, this.manifest.patterns.length - 1));
      const nextRow = clamp(Math.floor(progress.row), 0, Math.max(0, (this.manifest.patterns[nextPattern]?.rows.length ?? 1) - 1));
      const rowChanged = nextOrder !== this.order || nextPattern !== this.patternIndex || nextRow !== this.row;
      this.position = progress.pos;
      if (rowChanged) {
        this.order = nextOrder;
        this.patternIndex = nextPattern;
        this.row = nextRow;
        this.pattern = rowsForManifest(this.manifest, this.patternIndex, this.order, this.channelLabels.length);
        this.levels = levelsForRow(this.pattern[this.row], this.channelLabels.length);
      }
      if (rowChanged || Math.abs(this.position - this.lastProgressEmitAt) >= 0.2 || this.position < this.lastProgressEmitAt) {
        this.lastProgressEmitAt = this.position;
        this.emit();
      }
    });
    player.onEnded(() => {
      this.playing = false;
      this.levels = emptyLevels(this.channelLabels.length);
      this.emit();
    });
    player.onError(error => {
      this.error = `Tracker player error: ${error.type ?? "unknown"}`;
      this.playing = false;
      this.loading = false;
      this.emit();
    });
  }

  private async preloadManifest(mode: TrackerMode): Promise<void> {
    try {
      const manifest = await this.loadManifest(mode);
      if (mode.id !== this.mode.id || this.manifest) return;
      this.manifest = manifest;
      this.patternIndex = manifest.orders[0]?.pattern ?? 0;
      this.channelLabels = labelsForManifest(mode, manifest);
      this.pattern = rowsForManifest(manifest, this.patternIndex, 0, this.channelLabels.length);
      this.emit();
    } catch {
      // Playback will surface the load error if the user starts the tracker.
    }
  }

  private loadManifest(mode: TrackerMode): Promise<ModuleManifest> {
    const cached = this.manifests.get(mode.id);
    if (cached) return cached;
    const loaded = fetch(mode.manifestUrl)
      .then(response => {
        if (!response.ok) throw new Error(`Could not load ${mode.label} tracker manifest.`);
        return response.json() as Promise<ModuleManifest>;
      });
    this.manifests.set(mode.id, loaded);
    return loaded;
  }

  private loadModule(mode: TrackerMode): Promise<ArrayBuffer> {
    const cached = this.modules.get(mode.id);
    if (cached) return cached;
    const loaded = fetch(mode.moduleUrl)
      .then(response => {
        if (!response.ok) throw new Error(`Could not load ${mode.label} module.`);
        return response.arrayBuffer();
      });
    this.modules.set(mode.id, loaded);
    return loaded;
  }

  private emit(): void {
    this.onSnapshot(this.snapshot());
  }
}

function rowsForManifest(manifest: ModuleManifest, patternIndex: number, order: number, channelCount: number): TrackerRow[] {
  const section = manifest.orders[order]?.section ?? manifest.patterns[patternIndex]?.section ?? "...";
  const pattern = manifest.patterns[patternIndex] ?? manifest.patterns[0];
  if (!pattern) return emptyPattern(section, channelCount);
  return pattern.rows.map(row => ({
    step: row.step,
    section,
    channels: Array.from({ length: channelCount }, (_, index) => cell(row.channels[index])),
  }));
}

function cell(label: string | null | undefined): TrackerCell | undefined {
  return label ? { label } : undefined;
}

function labelsForManifest(mode: TrackerMode, manifest: ModuleManifest): readonly string[] {
  const declaredCount = manifest.sourceChannels ?? manifest.channels.length;
  const count = declaredCount > 0 ? declaredCount : mode.channelCount;
  return Array.from({ length: count }, (_, index) => manifest.channels[index] || mode.channelLabels[index] || `C${index + 1}`);
}

function levelsForRow(row: TrackerRow | undefined, channelCount: number): number[] {
  return Array.from({ length: channelCount }, (_, index) => row?.channels[index] ? 0.86 : 0.08);
}

function emptyPattern(section: string, channelCount: number): TrackerRow[] {
  return Array.from({ length: 64 }, (_, step) => ({
    step,
    section,
    channels: Array.from<TrackerCell | undefined>({ length: channelCount }),
  }));
}

function emptyLevels(channelCount: number): number[] {
  return Array.from({ length: channelCount }, () => 0);
}

function channelLabels(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `C${index + 1}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
