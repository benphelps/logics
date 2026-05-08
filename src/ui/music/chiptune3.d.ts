declare module "chiptune3" {
  export class ChiptuneJsPlayer {
    constructor(config?: {
      repeatCount?: number;
      stereoSeparation?: number;
      interpolationFilter?: number;
    });

    context: AudioContext;
    onInitialized(handler: () => void): void;
    onEnded(handler: () => void): void;
    onError(handler: (error: { type?: string }) => void): void;
    onMetadata(handler: (metadata: { dur?: number; totalOrders?: number; totalPatterns?: number }) => void): void;
    onProgress(handler: (progress: { pos: number; order: number; pattern: number; row: number }) => void): void;
    play(buffer: ArrayBuffer): void;
    pause(): void;
    stop(): void;
    seek(position: number): void;
    setRepeatCount(repeatCount: number): void;
    setVol(volume: number): void;
  }
}
