// Light along an edge: a head with a fading tail that travels, or the edge lit from one
// end up to the head. One instance per beam.

import { POSITIONS } from './positions.ts';

export const BEAM_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${POSITIONS}
layout(location = 0) in vec2 corner; // x: which end (-1, 1); y: which side
layout(location = 1) in uvec2 ends; // node ids, per instance
layout(location = 2) in vec2 progress; // head, mode, per instance

uniform float uHalfWidth; // device pixels

out float vAlong; // 0 at the start, 1 at the end
out float vAcross;
flat out vec2 vProgress;

void main() {
  vec2 from = toScreen(nodePosition(ends.x));
  vec2 to = toScreen(nodePosition(ends.y));
  vec2 along = to - from;
  float len = length(along);
  vec2 side = len > 0.0 ? vec2(-along.y, along.x) / len : vec2(0.0);
  vAlong = corner.x < 0.0 ? 0.0 : 1.0;
  vAcross = corner.y * (uHalfWidth + 0.5);
  vProgress = progress;
  gl_Position = toClip((corner.x < 0.0 ? from : to) + side * vAcross);
}
`;

export const BEAM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uHalfWidth;
in float vAlong;
in float vAcross;
flat in vec2 vProgress;
out vec4 outColor;
void main() {
  float behind = vProgress.x - vAlong;
  float light = vProgress.y > 0.5
    ? step(0.0, behind) * 0.7
    : (behind >= 0.0 ? exp(-behind * 9.0) : exp(behind * 60.0));
  float alpha = clamp(uHalfWidth + 0.5 - abs(vAcross), 0.0, 1.0) * light;
  if (alpha <= 0.002) discard;
  outColor = vec4(uColor * alpha, alpha);
}
`;
