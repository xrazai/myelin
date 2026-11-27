// An edge is one instance of a quad stretched between its two nodes: WebGL draws lines
// one pixel wide only. Width and brightness come from its strength.

import { POSITIONS } from './positions.ts';

export const EDGE_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${POSITIONS}
layout(location = 0) in vec2 corner; // x: which end (-1, 1); y: which side
layout(location = 1) in uvec2 ends; // node ids, per instance
layout(location = 2) in float strength; // 0..1, per instance

uniform vec2 uWidth; // device pixels, at strength 0 and 1
uniform vec2 uAlpha;

out float vAcross; // device pixels from the center line
flat out float vHalfWidth;
flat out float vAlpha;
flat out float vStrength;

void main() {
  vec2 from = toScreen(nodePosition(ends.x));
  vec2 to = toScreen(nodePosition(ends.y));
  vec2 along = to - from;
  float len = length(along);
  // A self-loop, or two nodes on one point: a quad of no area.
  vec2 side = len > 0.0 ? vec2(-along.y, along.x) / len : vec2(0.0);
  float width = mix(uWidth.x, uWidth.y, strength);
  // Thinner than a pixel is drawn one pixel wide and fainter, which does not shimmer.
  vHalfWidth = max(width, 1.0) * 0.5;
  vAlpha = mix(uAlpha.x, uAlpha.y, strength) * min(width, 1.0);
  vStrength = strength;
  vAcross = corner.y * (vHalfWidth + 0.5);
  gl_Position = toClip((corner.x < 0.0 ? from : to) + side * vAcross);
}
`;

export const EDGE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec3 uColor;
uniform vec3 uStrongColor;

in float vAcross;
flat in float vHalfWidth;
flat in float vAlpha;
flat in float vStrength;

out vec4 outColor;

void main() {
  float alpha = clamp(vHalfWidth + 0.5 - abs(vAcross), 0.0, 1.0) * vAlpha;
  outColor = vec4(mix(uColor, uStrongColor, vStrength) * alpha, alpha);
}
`;
