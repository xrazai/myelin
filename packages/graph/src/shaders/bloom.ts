// Bloom: what is brighter than the background goes into a smaller image, is blurred along
// each axis and added back over the frame. Its cost follows pixels, not nodes.

/** One triangle that covers the target. */
export const FULLSCREEN_VERTEX = /* glsl */ `#version 300 es
out vec2 uv;
void main() {
  uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const BRIGHT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uTexel; // of the source
uniform float uTaps; // 1 or 2 per axis
uniform vec3 uBackground;
uniform float uThreshold;
in vec2 uv;
out vec4 color;
void main() {
  // Four bilinear taps cover the 4x4 source pixels behind a quarter resolution pixel.
  vec3 sum = uTaps > 1.5
    ? (texture(uImage, uv + uTexel * vec2(-1, -1)).rgb + texture(uImage, uv + uTexel * vec2(1, -1)).rgb +
       texture(uImage, uv + uTexel * vec2(-1, 1)).rgb + texture(uImage, uv + uTexel * vec2(1, 1)).rgb) * 0.25
    : texture(uImage, uv).rgb;
  color = vec4(max(sum - uBackground - uThreshold, 0.0), 1.0);
}
`;

/** Gaussian blur along `uStep`, two texels per fetch through bilinear filtering. */
export function blurFragment(sigma: number): string {
  const radius = Math.max(2, Math.ceil(sigma * 2));
  const weights = Array.from({ length: radius + 2 }, (_, i) => (i > radius ? 0 : Math.exp(-(i * i) / (2 * sigma * sigma))));
  const total = weights.reduce((sum, weight, i) => sum + (i === 0 ? weight : 2 * weight), 0);
  const lines: string[] = [];
  for (let i = 1; i <= radius; i += 2) {
    const weight = weights[i]! + weights[i + 1]!;
    const offset = (i * weights[i]! + (i + 1) * weights[i + 1]!) / weight;
    lines.push(
      `sum += (texture(uImage, uv + uStep * ${offset.toFixed(5)}) + ` +
        `texture(uImage, uv - uStep * ${offset.toFixed(5)})) * ${(weight / total).toFixed(7)};`,
    );
  }
  return `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uStep;
in vec2 uv;
out vec4 color;
void main() {
  vec4 sum = texture(uImage, uv) * ${(weights[0]! / total).toFixed(7)};
  ${lines.join('\n  ')}
  color = sum;
}
`;
}

export const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform sampler2D uBloom;
uniform float uIntensity;
in vec2 uv;
out vec4 color;
void main() {
  color = vec4(texture(uImage, uv).rgb + texture(uBloom, uv).rgb * uIntensity, 1.0);
}
`;
