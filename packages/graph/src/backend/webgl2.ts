// The WebGL2 backend: edges, then nodes over them, one instanced draw each.
// `render` draws into whatever framebuffer is bound.

import { EDGE_FRAGMENT, EDGE_VERTEX } from '../shaders/edge.ts';
import { NODE_FRAGMENT, NODE_VERTEX } from '../shaders/node.ts';
import { POSITION_TEXTURE_WIDTH } from '../shaders/positions.ts';
import type { Backend, Frame, Scene, Style } from './backend.ts';

interface Program {
  program: WebGLProgram;
  uniform: (name: string) => WebGLUniformLocation | null;
}

const CORNERS = Float32Array.of(-1, -1, 1, -1, -1, 1, 1, 1);

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
    this.nodes = this.link(NODE_VERTEX, NODE_FRAGMENT);
    this.edges = this.link(EDGE_VERTEX, EDGE_FRAGMENT);
    this.corners = gl.createBuffer();
    this.radii = gl.createBuffer();
    this.states = gl.createBuffer();
    this.ends = gl.createBuffer();
    this.strengths = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);

    this.nodeArray = this.vertexArray(() => {
      this.floatAttribute(1, this.radii, 1);
      this.floatAttribute(2, this.states, 1);
    });
    this.edgeArray = this.vertexArray(() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ends);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_INT, 0, 0);
      gl.vertexAttribDivisor(1, 1);
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

  render({ width, height, pixelRatio, camera }: Frame): void {
    const { gl, style } = this;
    gl.viewport(0, 0, width, height);
    gl.clearColor(...style.background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.placed || this.nodeCount === 0) return;

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

    const { uniform } = this.nodes;
    use(this.nodes);
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
    for (const { program } of [this.nodes, this.edges]) gl.deleteProgram(program);
    for (const buffer of [this.corners, this.radii, this.states, this.ends, this.strengths]) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.nodeArray);
    gl.deleteVertexArray(this.edgeArray);
    gl.deleteTexture(this.texture);
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

  private floatAttribute(location: number, buffer: WebGLBuffer, size: number, divisor = 1): void {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, divisor);
  }

  private link(vertexSource: string, fragmentSource: string): Program {
    const { gl } = this;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    // A lost context fails everything; it is handled by its own event.
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)];
      throw new Error(`the shaders did not compile: ${log.filter(Boolean).join('\n')}`);
    }
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    const locations = new Map<string, WebGLUniformLocation | null>();
    return {
      program,
      uniform: (name) => {
        if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
        return locations.get(name)!;
      },
    };
  }
}
