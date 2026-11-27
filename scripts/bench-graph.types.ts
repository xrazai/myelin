// What `bench-graph.ts` (Node) and its page (browser) exchange. Types only: each side is
// typechecked with its own libraries.

export interface PageJob {
  /** Base64 of the typed arrays. */
  edges: string;
  weights: string;
  positions: string;
  nodeCount: number;
  resolutions: [number, number][];
  /** Resolution of the bloom as a share of the frame's; 0 is glow off. */
  glows: number[];
  /** Zoom factors over the view of the whole graph, measured at the last resolution. */
  zooms: number[];
  zoomGlow: number;
  frames: number;
  pixelRatio: number;
}

export interface Percentiles {
  median: number;
  p95: number;
}

export interface Sample {
  width: number;
  height: number;
  glow: number;
  /** Zoom over the view that shows the whole graph. */
  zoom: number;
  /** GPU time of a frame; null without the timer query extension. */
  gpuMs: Percentiles | null;
  /** Main thread time to submit a frame. */
  cpuMs: Percentiles;
  /** The same with a new layout step to upload first. */
  cpuWithUploadMs: Percentiles;
  gpuWithUploadMs: Percentiles | null;
  /** Wall time per frame of a batch that ends by reading a pixel: submission and GPU. */
  syncedFrameMs: number;
  /** Share of pixels that differ from the background, to prove that the frame was drawn. */
  litShare: number;
}
