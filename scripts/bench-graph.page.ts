// Page of `bench-graph.ts`: draws with the library's WebGL2 backend into an offscreen
// framebuffer and times frames. `bench-graph.main.cjs` drives it through `window.bench`.

import { WebGL2Backend } from '../packages/graph/src/backend/webgl2.ts';
import { boundsOf, fit, type Camera } from '../packages/graph/src/camera.ts';
import { buildScene, createStyle } from '../packages/graph/src/scene.ts';
import type { PageJob, Percentiles, Sample } from './bench-graph.types.ts';

const WARMUP_FRAMES = 30;
const STYLE = createStyle({
  background: '#0b0f0e',
  node: '#8a9992',
  activeNode: '#52b788',
  edge: '#8a9992',
  strongEdge: '#52b788',
});

const canvas = new OffscreenCanvas(16, 16);
const backend = new WebGL2Backend(canvas, STYLE);
const gl = backend.gl;
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
} | null;

interface Target {
  width: number;
  height: number;
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

function target(width: number, height: number): Target {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer');
  return { width, height, texture, framebuffer };
}

/** The target of one resolution; `draw` leaves the finished frame, glow included, in it. */
function pipeline(width: number, height: number, glow: number, pixelRatio: number) {
  const output = target(width, height);
  return {
    output,
    draw(camera: Camera) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
      backend.render({ width, height, pixelRatio, camera, glow });
    },
    destroy() {
      gl.deleteTexture(output.texture);
      gl.deleteFramebuffer(output.framebuffer);
    },
  };
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!;
  return { median: Math.round(at(0.5) * 1000) / 1000, p95: Math.round(at(0.95) * 1000) / 1000 };
}

/** Waits for a pixel of `framebuffer`, which waits for everything drawn before. */
function sync(framebuffer: WebGLFramebuffer): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

/** `before` is CPU work of the frame outside the GPU query, such as an upload. */
async function timeFrames(frames: number, draw: () => void, before?: () => void) {
  // A disjoint event (clocks changed, say) voids the batch's GPU times: it is repeated.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (timer) gl.getParameter(timer.GPU_DISJOINT_EXT);
    const cpu: number[] = [];
    const queries: WebGLQuery[] = [];
    for (let frame = 0; frame < frames; frame++) {
      const query = timer ? gl.createQuery() : null;
      const start = performance.now();
      // An upload belongs to the frame: it is inside both times.
      if (query) gl.beginQuery(timer!.TIME_ELAPSED_EXT, query);
      before?.();
      draw();
      if (query) gl.endQuery(timer!.TIME_ELAPSED_EXT);
      gl.flush();
      cpu.push(performance.now() - start);
      if (query) queries.push(query);
      await nextTask();
    }
    if (!timer) return { cpu: percentiles(cpu), gpu: null };
    for (let wait = 0; !gl.getQueryParameter(queries.at(-1)!, gl.QUERY_RESULT_AVAILABLE); wait++) {
      if (wait > 2000) throw new Error('the GPU timer never answered');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT) as boolean;
    const gpu = queries.map((query) => (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6);
    for (const query of queries) gl.deleteQuery(query);
    if (!disjoint) return { cpu: percentiles(cpu), gpu: percentiles(gpu) };
  }
  throw new Error('the GPU timer was disjoint 5 times in a row');
}

function decode(base64: string): ArrayBuffer {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer;
}

function litShare(output: Target): number {
  gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
  const pixels = new Uint8Array(output.width * output.height * 4);
  gl.readPixels(0, 0, output.width, output.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const background = STYLE.background.map((channel) => Math.round(channel * 255));
  let lit = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (Math.abs(pixels[i + 1]! - background[1]!) > 3) lit++;
  }
  return Math.round((lit / (pixels.length / 4)) * 10000) / 10000;
}

async function run(job: PageJob): Promise<{ edges: number; samples: Sample[] }> {
  const edges = new Uint32Array(decode(job.edges));
  const weights = new Float32Array(decode(job.weights));
  const positions = new Float32Array(decode(job.positions));
  backend.setGraph(buildScene({ nodeCount: job.nodeCount, edges, weights }));
  backend.setPositions(positions);
  const bounds = boundsOf(positions)!;
  // The upload alternates between two layouts, so that nothing can skip it as unchanged.
  const moved = positions.map((value) => value + 1);

  const cases = job.zooms.flatMap((zoom) =>
    job.resolutions.flatMap((size) => job.glows.map((glow) => ({ size, glow, zoom }))),
  );
  const samples: Sample[] = [];
  for (const { size: [width, height], glow, zoom } of cases) {
    const frame = pipeline(width, height, glow, job.pixelRatio);
    const fitted = fit(bounds, { width: width / job.pixelRatio, height: height / job.pixelRatio });
    const camera = { ...fitted, zoom: fitted.zoom * zoom };
    const draw = () => frame.draw(camera);

    await timeFrames(WARMUP_FRAMES, draw);
    const still = await timeFrames(job.frames, draw);
    let step = 0;
    const upload = await timeFrames(job.frames, draw, () => backend.setPositions(step++ % 2 ? positions : moved));
    backend.setPositions(positions);

    sync(frame.output.framebuffer);
    const start = performance.now();
    for (let i = 0; i < job.frames; i++) draw();
    sync(frame.output.framebuffer);
    const syncedFrameMs = Math.round(((performance.now() - start) / job.frames) * 1000) / 1000;

    const lit = litShare(frame.output);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error} at ${width}x${height}, glow ${glow}`);
    frame.destroy();
    samples.push({
      width,
      height,
      glow,
      zoom,
      gpuMs: still.gpu,
      cpuMs: still.cpu,
      cpuWithUploadMs: upload.cpu,
      gpuWithUploadMs: upload.gpu,
      syncedFrameMs,
      litShare: lit,
    });
  }
  return { edges: edges.length / 2, samples };
}

function info() {
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    timerQuery: timer !== null,
  };
}

Object.assign(window, { bench: { info, run } });
