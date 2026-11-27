// Page of `bench-graph.ts`: draws with the library's WebGL2 backend into an offscreen
// framebuffer and times frames. `bench-graph.main.cjs` drives it through `window.bench`.

import { WebGL2Backend } from '../packages/graph/src/backend/webgl2.ts';
import { boundsOf, fit, type Camera } from '../packages/graph/src/camera.ts';
import { buildScene, createStyle } from '../packages/graph/src/scene.ts';
import type { PageJob, Percentiles, Sample } from './bench-graph.types.ts';

const WARMUP_FRAMES = 30;
/** Blur radius of the stand-in bloom, in CSS pixels, at every bloom resolution. */
const BLOOM_SIGMA = 6;
const BLOOM_INTENSITY = 0.8;
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

// A STAND-IN for the bloom of the library, which does not exist yet: it is here so that the
// cost of a glow at each resolution is measured and not guessed. Bright pass into a smaller
// texture, separable Gaussian blur in two passes, additive composite over the frame.

const FULLSCREEN = `#version 300 es
out vec2 uv;
void main() {
  uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const BRIGHT = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uTexel; // of the source
uniform float uTaps; // 1 or 2 per axis
in vec2 uv;
out vec4 color;
void main() {
  // Four bilinear taps cover the 4x4 source pixels behind a quarter resolution pixel.
  vec3 sum = uTaps > 1.5
    ? (texture(uImage, uv + uTexel * vec2(-1, -1)).rgb + texture(uImage, uv + uTexel * vec2(1, -1)).rgb +
       texture(uImage, uv + uTexel * vec2(-1, 1)).rgb + texture(uImage, uv + uTexel * vec2(1, 1)).rgb) * 0.25
    : texture(uImage, uv).rgb;
  color = vec4(max(sum - 0.12, 0.0), 1.0);
}`;

/** Gaussian blur along one axis, two texels per fetch through bilinear filtering. */
function blurShader(sigma: number): string {
  const radius = Math.max(2, Math.ceil(sigma * 2));
  const weights = Array.from({ length: radius + 2 }, (_, i) => (i > radius ? 0 : Math.exp(-(i * i) / (2 * sigma * sigma))));
  const total = weights.reduce((sum, weight, i) => sum + (i === 0 ? weight : 2 * weight), 0);
  const lines: string[] = [];
  for (let i = 1; i <= radius; i += 2) {
    const weight = weights[i]! + weights[i + 1]!;
    const offset = (i * weights[i]! + (i + 1) * weights[i + 1]!) / weight;
    lines.push(
      `sum += (texture(uImage, uv + uStep * ${offset.toFixed(5)}).rgb + ` +
        `texture(uImage, uv - uStep * ${offset.toFixed(5)}).rgb) * ${(weight / total).toFixed(7)};`,
    );
  }
  return `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uStep;
in vec2 uv;
out vec4 color;
void main() {
  vec3 sum = texture(uImage, uv).rgb * ${(weights[0]! / total).toFixed(7)};
  ${lines.join('\n  ')}
  color = vec4(sum, 1.0);
}`;
}

const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform sampler2D uBloom;
in vec2 uv;
out vec4 color;
void main() {
  color = vec4(texture(uImage, uv).rgb + texture(uBloom, uv).rgb * ${BLOOM_INTENSITY.toFixed(2)}, 1.0);
}`;

function program(fragment: string): WebGLProgram {
  const result = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, FULLSCREEN], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(result, shader);
  }
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result) ?? 'link');
  return result;
}

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

/** The targets and programs of one resolution and glow; `output` holds the finished frame. */
function pipeline(width: number, height: number, glow: number, pixelRatio: number) {
  const output = target(width, height);
  const targets = [output];
  const programs: WebGLProgram[] = [];
  let bloom: ((scene: () => void) => void) | null = null;
  if (glow > 0) {
    const small = () => target(Math.round(width * glow), Math.round(height * glow));
    const sceneTarget = target(width, height);
    const first = small();
    const second = small();
    targets.push(sceneTarget, first, second);
    const bright = program(BRIGHT);
    const blur = program(blurShader(BLOOM_SIGMA * pixelRatio * glow));
    const composite = program(COMPOSITE);
    programs.push(bright, blur, composite);
    const location = (of: WebGLProgram, name: string) => gl.getUniformLocation(of, name);
    const brightTexel = location(bright, 'uTexel');
    const brightTaps = location(bright, 'uTaps');
    const brightImage = location(bright, 'uImage');
    const blurStep = location(blur, 'uStep');
    const blurImage = location(blur, 'uImage');
    const compositeImage = location(composite, 'uImage');
    const compositeBloom = location(composite, 'uBloom');
    const pass = (into: Target, using: WebGLProgram, set: () => void) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
      gl.viewport(0, 0, into.width, into.height);
      gl.useProgram(using);
      set();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    // Units 1 and 2: unit 0 is the backend's.
    const bind = (unit: number, texture: WebGLTexture | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    };
    bloom = (scene) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget.framebuffer);
      scene();
      gl.disable(gl.BLEND);
      pass(first, bright, () => {
        bind(1, sceneTarget.texture);
        gl.uniform1i(brightImage, 1);
        gl.uniform2f(brightTexel, 1 / width, 1 / height);
        gl.uniform1f(brightTaps, glow < 0.5 ? 2 : 1);
      });
      pass(second, blur, () => {
        bind(1, first.texture);
        gl.uniform1i(blurImage, 1);
        gl.uniform2f(blurStep, 1 / first.width, 0);
      });
      pass(first, blur, () => {
        bind(1, second.texture);
        gl.uniform1i(blurImage, 1);
        gl.uniform2f(blurStep, 0, 1 / first.height);
      });
      pass(output, composite, () => {
        bind(1, sceneTarget.texture);
        bind(2, first.texture);
        gl.uniform1i(compositeImage, 1);
        gl.uniform1i(compositeBloom, 2);
      });
      // No texture stays bound while it is drawn into.
      for (const unit of [1, 2]) bind(unit, null);
    };
  }
  return {
    output,
    draw(camera: Camera) {
      const scene = () => backend.render({ width, height, pixelRatio, camera });
      if (bloom) {
        bloom(scene);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
        scene();
      }
    },
    destroy() {
      for (const { texture, framebuffer } of targets) {
        gl.deleteTexture(texture);
        gl.deleteFramebuffer(framebuffer);
      }
      for (const each of programs) gl.deleteProgram(each);
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
