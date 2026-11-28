// The targets and passes of the constellation glow (`shaders/glow.ts`).

import { blurFragment, FULLSCREEN_VERTEX } from '../shaders/bloom.ts';
import { GLOW_FRAGMENT, SPLAT_FRAGMENT, SPLAT_VERTEX } from '../shaders/glow.ts';
import { linkProgram, type Program } from './program.ts';

/** The glow is computed at this share of the frame's resolution. */
const SCALE = 0.125;
/** Blur, in pixels of the small image. */
const SIGMA = 3;

interface Target {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
}

export class ConstellationGlow {
  private readonly gl: WebGL2RenderingContext;
  private readonly splat: Program;
  private readonly blur: Program;
  private readonly composite: Program;
  /** Sums of many nodes need more than 8 bits; where there are none, each node adds less. */
  private readonly float: boolean;
  private targets: { width: number; height: number; first: Target; second: Target } | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.float = gl.getExtension('EXT_color_buffer_float') !== null;
    this.splat = linkProgram(gl, SPLAT_VERTEX, SPLAT_FRAGMENT);
    this.blur = linkProgram(gl, FULLSCREEN_VERTEX, blurFragment(SIGMA));
    this.composite = linkProgram(gl, FULLSCREEN_VERTEX, GLOW_FRAGMENT);
  }

  /**
   * Draws the glow of one level over `destination` (a frame of `width` x `height`).
   * `splats` draws the nodes with the splat program in use and its own uniforms set.
   * The position texture stays on unit 0.
   */
  draw(
    destination: WebGLFramebuffer | null,
    width: number,
    height: number,
    opacity: number,
    splats: (program: Program, targetWidth: number, targetHeight: number, scale: number) => void,
  ): void {
    const { gl } = this;
    const small = { width: Math.max(1, Math.round(width * SCALE)), height: Math.max(1, Math.round(height * SCALE)) };
    if (this.targets?.width !== small.width || this.targets.height !== small.height) {
      this.release();
      this.targets = { ...small, first: this.target(small.width, small.height), second: this.target(small.width, small.height) };
    }
    const { first, second } = this.targets;

    gl.bindFramebuffer(gl.FRAMEBUFFER, first.framebuffer);
    gl.viewport(0, 0, small.width, small.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.splat.program);
    gl.uniform1f(this.splat.uniform('uWeight'), this.float ? 0.25 : 0.06);
    splats(this.splat, small.width, small.height, SCALE);

    gl.disable(gl.BLEND);
    const bind = (texture: WebGLTexture | null) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    };
    gl.useProgram(this.blur.program);
    gl.uniform1i(this.blur.uniform('uImage'), 1);
    bind(first.texture);
    gl.uniform2f(this.blur.uniform('uStep'), 1 / small.width, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, second.framebuffer);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    bind(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, first.framebuffer);
    bind(second.texture);
    gl.uniform2f(this.blur.uniform('uStep'), 0, 1 / small.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    bind(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.composite.program);
    bind(first.texture);
    gl.uniform1i(this.composite.uniform('uImage'), 1);
    gl.uniform1f(this.composite.uniform('uGain'), this.float ? 1.5 : 6);
    gl.uniform1f(this.composite.uniform('uOpacity'), opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    bind(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  release(): void {
    if (!this.targets) return;
    for (const { texture, framebuffer } of [this.targets.first, this.targets.second]) {
      this.gl.deleteTexture(texture);
      this.gl.deleteFramebuffer(framebuffer);
    }
    this.targets = null;
  }

  destroy(): void {
    this.release();
    for (const { program } of [this.splat, this.blur, this.composite]) this.gl.deleteProgram(program);
  }

  private target(width: number, height: number): Target {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.float ? gl.RGBA16F : gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { texture, framebuffer };
  }
}
