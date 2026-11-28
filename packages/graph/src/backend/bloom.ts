// The offscreen targets and passes of the bloom. The scene is drawn into `begin()`'s
// framebuffer; `end` puts it, with the glow added, into the destination.

import { BRIGHT_FRAGMENT, blurFragment, COMPOSITE_FRAGMENT, FULLSCREEN_VERTEX } from '../shaders/bloom.ts';
import { linkProgram, type Program } from './program.ts';
import type { Rgb } from './backend.ts';

/** Blur radius in CSS pixels, at every resolution. */
const SIGMA = 6;
const INTENSITY = 0.8;
/** How much brighter than the background a pixel must be to glow. */
const THRESHOLD = 0.08;

interface Target {
  width: number;
  height: number;
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

export class Bloom {
  private readonly gl: WebGL2RenderingContext;
  private readonly bright: Program;
  private readonly composite: Program;
  private blur: { sigma: number; program: Program } | null = null;
  private targets: { key: string; scene: Target; first: Target; second: Target } | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.bright = linkProgram(gl, FULLSCREEN_VERTEX, BRIGHT_FRAGMENT);
    this.composite = linkProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
  }

  /** The framebuffer the scene is drawn into, for a frame of this size and bloom scale. */
  begin(width: number, height: number, scale: number): WebGLFramebuffer {
    const key = `${width} ${height} ${scale}`;
    if (this.targets?.key !== key) {
      this.release();
      const small = () => this.target(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      this.targets = { key, scene: this.target(width, height), first: small(), second: small() };
    }
    return this.targets.scene.framebuffer;
  }

  end(destination: WebGLFramebuffer | null, scale: number, pixelRatio: number, background: Rgb): void {
    const { gl } = this;
    const { scene, first, second } = this.targets!;
    const sigma = SIGMA * pixelRatio * scale;
    if (this.blur?.sigma !== sigma) {
      if (this.blur) gl.deleteProgram(this.blur.program.program);
      this.blur = { sigma, program: linkProgram(gl, FULLSCREEN_VERTEX, blurFragment(sigma)) };
    }
    const blur = this.blur.program;
    // Units 1 and 2: unit 0 holds the positions.
    const bind = (unit: number, texture: WebGLTexture | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    };
    const pass = (into: WebGLFramebuffer | null, size: { width: number; height: number }) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, into);
      gl.viewport(0, 0, size.width, size.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    gl.disable(gl.BLEND);

    gl.useProgram(this.bright.program);
    bind(1, scene.texture);
    gl.uniform1i(this.bright.uniform('uImage'), 1);
    gl.uniform2f(this.bright.uniform('uTexel'), 1 / scene.width, 1 / scene.height);
    gl.uniform1f(this.bright.uniform('uTaps'), scale < 0.5 ? 2 : 1);
    gl.uniform3f(this.bright.uniform('uBackground'), ...background);
    gl.uniform1f(this.bright.uniform('uThreshold'), THRESHOLD);
    pass(first.framebuffer, first);

    gl.useProgram(blur.program);
    gl.uniform1i(blur.uniform('uImage'), 1);
    bind(1, first.texture);
    gl.uniform2f(blur.uniform('uStep'), 1 / first.width, 0);
    pass(second.framebuffer, second);
    bind(1, second.texture);
    gl.uniform2f(blur.uniform('uStep'), 0, 1 / first.height);
    pass(first.framebuffer, first);

    gl.useProgram(this.composite.program);
    bind(1, scene.texture);
    bind(2, first.texture);
    gl.uniform1i(this.composite.uniform('uImage'), 1);
    gl.uniform1i(this.composite.uniform('uBloom'), 2);
    gl.uniform1f(this.composite.uniform('uIntensity'), INTENSITY);
    pass(destination, scene);
    // No texture stays bound while it is drawn into.
    bind(2, null);
    bind(1, null);
  }

  /** Frees the targets: with the glow off they would only hold memory. */
  release(): void {
    if (!this.targets) return;
    const { scene, first, second } = this.targets;
    for (const { texture, framebuffer } of [scene, first, second]) {
      this.gl.deleteTexture(texture);
      this.gl.deleteFramebuffer(framebuffer);
    }
    this.targets = null;
  }

  destroy(): void {
    this.release();
    const programs = [this.bright, this.composite, ...(this.blur ? [this.blur.program] : [])];
    for (const { program } of programs) this.gl.deleteProgram(program);
    this.blur = null;
  }

  private target(width: number, height: number): Target {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { width, height, texture, framebuffer };
  }
}
