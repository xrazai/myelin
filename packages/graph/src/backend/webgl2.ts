// The WebGL2 backend: the constellation glow, then edges, beams and nodes over it, one
// instanced draw each.
// `render` draws into whatever framebuffer is bound.

import { BEAM_FRAGMENT, BEAM_VERTEX } from '../shaders/beam.ts';
import { MAX_GLOW_COLORS } from '../shaders/glow.ts';
import { EDGE_FRAGMENT, EDGE_VERTEX } from '../shaders/edge.ts';
import { NODE_FRAGMENT, NODE_VERTEX } from '../shaders/node.ts';
import { POSITION_TEXTURE_WIDTH } from '../shaders/positions.ts';
import type { Backend, Frame, Scene, Style } from './backend.ts';
import { Bloom } from './bloom.ts';
import { ConstellationGlow } from './glow.ts';
import { linkProgram, type Program } from './program.ts';

const CORNERS = Float32Array.of(-1, -1, 1, -1, -1, 1, 1, 1);
/** World radius a node lights in the glow of its constellation. */
const GLOW_SPREAD = 200;
/** Its limits, in pixels of the small image the glow is computed in. */
const GLOW_PIXELS: [number, number] = [1.5, 12];
const GLOW_OPACITY = 0.55;
/** Half width of a beam, CSS pixels. */
const BEAM_HALF_WIDTH = 1.2;

type Level = 'coarse' | 'fine';

export class WebGL2Backend implements Backend {
  readonly gl: WebGL2RenderingContext;
  private readonly style: Style;
  private readonly nodes: Program;
  private readonly edges: Program;
  private readonly corners: WebGLBuffer;
  private readonly radii: WebGLBuffer;
  private readonly states: WebGLBuffer;
  private readonly ends: WebGLBuffer;
  private readonly strengths: WebGLBuffer;
  private readonly nodeArray: WebGLVertexArrayObject;
  private readonly edgeArray: WebGLVertexArrayObject;
  private texture: WebGLTexture | null = null;
  private nodeCount = 0;
  private edgeCount = 0;
  /** Nodes the position texture holds. */
  private capacity = 0;
  private placed = false;
  /** Made when a frame first asks for glow. */
  private bloom: Bloom | null = null;
  private constellations: ConstellationGlow | null = null;
  private readonly beams: Program;
  private readonly beamEnds: WebGLBuffer;
  private readonly beamProgress: WebGLBuffer;
  private readonly beamArray: WebGLVertexArrayObject;
  private readonly colors: Record<Level, WebGLBuffer>;
  private readonly glowArrays: Record<Level, WebGLVertexArrayObject>;
  /** Nodes the color buffers cover. */
  private colored = 0;
  private readonly palette: Float32Array;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, style: Style) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      // Shapes smooth their own edges.
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.style = style;
    this.nodes = linkProgram(gl, NODE_VERTEX, NODE_FRAGMENT);
    this.edges = linkProgram(gl, EDGE_VERTEX, EDGE_FRAGMENT);
    this.corners = gl.createBuffer();
    this.radii = gl.createBuffer();
    this.states = gl.createBuffer();
    this.ends = gl.createBuffer();
    this.strengths = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
    this.beams = linkProgram(gl, BEAM_VERTEX, BEAM_FRAGMENT);
    this.beamEnds = gl.createBuffer();
    this.beamProgress = gl.createBuffer();
    this.beamArray = this.vertexArray(() => {
      this.pairAttribute(this.beamEnds);
      this.floatAttribute(2, this.beamProgress, 2);
    });
    this.colors = { coarse: gl.createBuffer(), fine: gl.createBuffer() };
    const glowArray = (colors: WebGLBuffer) =>
      this.vertexArray(() => {
        this.floatAttribute(1, this.radii, 1);
        this.floatAttribute(2, colors, 1);
      });
    this.glowArrays = { coarse: glowArray(this.colors.coarse), fine: glowArray(this.colors.fine) };
    this.palette = new Float32Array(MAX_GLOW_COLORS * 3);
    style.constellations.slice(0, MAX_GLOW_COLORS).forEach((color, i) => this.palette.set(color, i * 3));

    this.nodeArray = this.vertexArray(() => {
      this.floatAttribute(1, this.radii, 1);
      this.floatAttribute(2, this.states, 1);
    });
    this.edgeArray = this.vertexArray(() => {
      this.pairAttribute(this.ends);
      this.floatAttribute(2, this.strengths, 1);
    });
  }

  setGraph({ nodeCount, edgeCount, edges, strengths, radii, states }: Scene): void {
    const { gl } = this;
    // Room for as many nodes as the arrays hold, so that adding some uploads only them.
    const capacity = radii.length;
    const rows = Math.max(1, Math.ceil(capacity / POSITION_TEXTURE_WIDTH));
    const maxRows = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    // A lost context reports no limit.
    if (maxRows && rows > maxRows) throw new RangeError(`this GPU draws at most ${maxRows * POSITION_TEXTURE_WIDTH} nodes`);
    this.nodeCount = nodeCount;
    this.edgeCount = edgeCount;
    this.capacity = capacity;
    this.placed = false;
    this.colored = 0;

    const upload = (buffer: WebGLBuffer, data: ArrayBufferView) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    };
    upload(this.radii, radii);
    upload(this.states, states);
    upload(this.ends, edges);
    upload(this.strengths, strengths);

    gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, POSITION_TEXTURE_WIDTH, rows);
    // Float textures are read texel by texel; the default filter would leave it incomplete.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  updateGraph(scene: Scene, nodes: [number, number] | null, edges: [number, number] | null): void {
    const { gl } = this;
    this.nodeCount = scene.nodeCount;
    this.edgeCount = scene.edgeCount;
    const patch = (buffer: WebGLBuffer, data: Float32Array | Uint32Array, from: number, to: number, size: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, from * size * 4, data, from * size, (to - from) * size);
    };
    if (nodes) {
      patch(this.radii, scene.radii, nodes[0], nodes[1], 1);
      patch(this.states, scene.states, nodes[0], nodes[1], 1);
    }
    if (edges) {
      patch(this.ends, scene.edges, edges[0], edges[1], 2);
      patch(this.strengths, scene.strengths, edges[0], edges[1], 1);
    }
  }

  setColors(coarse: Float32Array, fine: Float32Array): void {
    const { gl } = this;
    for (const [level, data] of [['coarse', coarse], ['fine', fine]] as const) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colors[level]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    }
    this.colored = Math.min(coarse.length, fine.length);
  }

  setPositions(positions: Float32Array): void {
    const { gl, nodeCount } = this;
    if (positions.length !== nodeCount * 2) throw new RangeError('positions must hold two values per node');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const width = POSITION_TEXTURE_WIDTH;
    const fullRows = Math.floor(nodeCount / width);
    const rest = nodeCount - fullRows * width;
    if (fullRows > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, fullRows, gl.RG, gl.FLOAT, positions);
    if (rest > 0) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, fullRows, rest, 1, gl.RG, gl.FLOAT, positions, fullRows * width * 2);
    }
    this.placed = true;
  }

  render(frame: Frame): void {
    const { gl, style } = this;
    const { glow = 0 } = frame;
    if (glow <= 0 || !this.placed || this.nodeCount === 0) {
      this.bloom?.release();
      this.draw(frame, gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null);
      return;
    }
    // Whatever the caller bound gets the finished frame.
    const destination = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    this.bloom ??= new Bloom(gl);
    const scene = this.bloom.begin(frame.width, frame.height, glow);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene);
    this.draw(frame, scene);
    this.bloom.end(destination, glow, frame.pixelRatio, style.background);
  }

  /** The glow of the constellations over what `into` holds. */
  private glowBehind(frame: Frame, into: WebGLFramebuffer | null): void {
    const { gl } = this;
    const strengths = frame.constellations;
    const levels = (['coarse', 'fine'] as const).filter((level) => (strengths?.[level] ?? 0) > 0.01);
    // Without a color per node the draw would read past the buffers.
    if (levels.length === 0 || this.style.constellations.length === 0 || this.colored < this.nodeCount) return;
    this.constellations ??= new ConstellationGlow(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    for (const level of levels) {
      const opacity = strengths![level] * GLOW_OPACITY;
      this.constellations.draw(into, frame.width, frame.height, opacity, ({ uniform }, width, height, scale) => {
        gl.uniform1i(uniform('uPositions'), 0);
        gl.uniform3f(uniform('uCamera'), frame.camera.x, frame.camera.y, frame.camera.zoom * frame.pixelRatio * scale);
        gl.uniform2f(uniform('uViewport'), width, height);
        gl.uniform1f(uniform('uSpread'), GLOW_SPREAD);
        gl.uniform2f(uniform('uMinMaxSpread'), ...GLOW_PIXELS);
        gl.uniform3fv(uniform('uPalette'), this.palette);
        gl.bindVertexArray(this.glowArrays[level]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
        gl.bindVertexArray(null);
      });
    }
  }

  /** The glow, edges, beams, then nodes, into `into`, which is bound. */
  private draw(frame: Frame, into: WebGLFramebuffer | null): void {
    const { width, height, pixelRatio, camera } = frame;
    const { gl, style } = this;
    gl.viewport(0, 0, width, height);
    gl.clearColor(...style.background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.placed || this.nodeCount === 0) return;
    this.glowBehind(frame, into);

    gl.enable(gl.BLEND);
    // Colors come premultiplied by alpha.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const use = ({ program, uniform }: Program) => {
      gl.useProgram(program);
      gl.uniform1i(uniform('uPositions'), 0);
      gl.uniform3f(uniform('uCamera'), camera.x, camera.y, camera.zoom * pixelRatio);
      gl.uniform2f(uniform('uViewport'), width, height);
    };

    if (this.edgeCount > 0) {
      const { uniform } = this.edges;
      use(this.edges);
      gl.uniform2f(uniform('uWidth'), style.edgeWidth[0] * pixelRatio, style.edgeWidth[1] * pixelRatio);
      gl.uniform2f(uniform('uAlpha'), ...(style.edgeAlpha as [number, number]));
      gl.uniform3f(uniform('uColor'), ...style.edge);
      gl.uniform3f(uniform('uStrongColor'), ...style.strongEdge);
      gl.bindVertexArray(this.edgeArray);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.edgeCount);
    }

    const beams = frame.beams;
    if (beams && beams.count > 0) {
      use(this.beams);
      gl.uniform1f(this.beams.uniform('uHalfWidth'), BEAM_HALF_WIDTH * pixelRatio);
      gl.uniform3f(this.beams.uniform('uColor'), ...style.pulse);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.beamEnds);
      gl.bufferData(gl.ARRAY_BUFFER, beams.ends, gl.STREAM_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.beamProgress);
      gl.bufferData(gl.ARRAY_BUFFER, beams.progress, gl.STREAM_DRAW);
      gl.bindVertexArray(this.beamArray);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, beams.count);
    }

    const { uniform } = this.nodes;
    use(this.nodes);
    gl.uniform1f(uniform('uBreath'), frame.breath ?? 0);
    gl.uniform2f(uniform('uMinMaxRadius'), style.minNodeRadius * pixelRatio, style.maxNodeRadius * pixelRatio);
    gl.uniform1f(uniform('uBaseRadius'), style.nodeRadius);
    gl.uniform3f(uniform('uColor'), ...style.node);
    gl.uniform3f(uniform('uActiveColor'), ...style.activeNode);
    gl.bindVertexArray(this.nodeArray);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
    gl.bindVertexArray(null);
  }

  destroy(): void {
    const { gl } = this;
    for (const { program } of [this.nodes, this.edges, this.beams]) gl.deleteProgram(program);
    const buffers = [this.corners, this.radii, this.states, this.ends, this.strengths, this.beamEnds, this.beamProgress];
    for (const buffer of [...buffers, this.colors.coarse, this.colors.fine]) gl.deleteBuffer(buffer);
    for (const array of [this.nodeArray, this.edgeArray, this.beamArray, ...Object.values(this.glowArrays)]) {
      gl.deleteVertexArray(array);
    }
    this.constellations?.destroy();
    this.constellations = null;
    gl.deleteTexture(this.texture);
    this.bloom?.destroy();
    this.bloom = null;
    this.texture = null;
    this.placed = false;
  }

  /** Location 0 is the shared quad; `instanced` adds the per-instance attributes. */
  private vertexArray(instanced: () => void): WebGLVertexArrayObject {
    const { gl } = this;
    const array = gl.createVertexArray();
    gl.bindVertexArray(array);
    this.floatAttribute(0, this.corners, 2, 0);
    instanced();
    gl.bindVertexArray(null);
    return array;
  }

  /** Location 1: two node ids per instance. */
  private pairAttribute(buffer: WebGLBuffer): void {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);
  }

  private floatAttribute(location: number, buffer: WebGLBuffer, size: number, divisor = 1): void {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, divisor);
  }
}
