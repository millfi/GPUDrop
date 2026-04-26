declare module 'mp4box' {
  export interface MP4ArrayBuffer extends ArrayBuffer { fileStart: number; }

  export interface MP4VideoTrack {
    id: number;
    codec: string;
    timescale: number;
    duration: number;
    nb_samples: number;
    video: { width: number; height: number };
  }

  export interface MP4Info {
    videoTracks: MP4VideoTrack[];
  }

  export interface MP4Sample {
    is_sync: boolean;
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    data: Uint8Array;
  }

  export interface MP4File {
    onReady: ((info: MP4Info) => void) | null;
    onError: ((e: unknown) => void) | null;
    onSamples: ((id: number, user: unknown, samples: MP4Sample[]) => void) | null;
    appendBuffer(buffer: MP4ArrayBuffer): number;
    flush(): void;
    start(): void;
    stop(): void;
    setExtractionOptions(id: number, user?: unknown, options?: { nbSamples?: number }): void;
    getTrackById(id: number): unknown;
  }

  const MP4Box: {
    createFile: () => MP4File;
    DataStream: new (
      arrayBuffer?: ArrayBuffer,
      byteOffset?: number,
      endianness?: number,
    ) => { buffer: ArrayBuffer; [k: string]: unknown };
  } & {
    DataStream: { BIG_ENDIAN: number; LITTLE_ENDIAN: number };
  };

  export default MP4Box;
}
