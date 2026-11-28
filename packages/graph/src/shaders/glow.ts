// The glow of a constellation: its nodes are splatted, in its color, into a small image
// by adding, then blurred. A pixel takes the weighted mean of the colors in it, and its
// brightness saturates, so that it follows membership and not just how crowded it is.

import { POSITIONS } from './positions.ts';

/** Colors a palette may hold. */
export const MAX_GLOW_COLORS = 16;

export const SPLAT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${POSITIONS}
layout(location = 0) in vec2 corner; // -1..1
layout(location = 1) in float radius; // world units, per instance
layout(location = 2) in float color; // palette index, per instance

uniform vec3 uPalette[${MAX_GLOW_COLORS}];
uniform float uSpread; // world units
uniform vec2 uMinMaxSpread; // pixels of the target

out vec2 vOffset;
flat out vec3 vColor;

void main() {
  float pixels = clamp(uSpread * uCamera.z, uMinMaxSpread.x, uMinMaxSpread.y);
  vOffset = corner;
  vColor = uPalette[int(min(color, ${MAX_GLOW_COLORS - 1}.0))];
  gl_Position = toClip(toScreen(nodePosition(uint(gl_InstanceID))) + corner * pixels);
  // Removed, or in no constellation: outside the view.
  if (radius <= 0.0 || color > ${MAX_GLOW_COLORS - 1}.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const SPLAT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uWeight;
in vec2 vOffset;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float falloff = max(0.0, 1.0 - dot(vOffset, vOffset));
  float weight = falloff * falloff * uWeight;
  outColor = vec4(vColor * weight, weight);
}
`;

export const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform float uGain; // how fast brightness saturates
uniform float uOpacity;
in vec2 uv;
out vec4 color;
void main() {
  vec4 sum = texture(uImage, uv);
  if (sum.a <= 0.0) discard;
  float alpha = (1.0 - exp(-sum.a * uGain)) * uOpacity;
  // Premultiplied, over what is already there.
  color = vec4(sum.rgb / sum.a * alpha, alpha);
}
`;
