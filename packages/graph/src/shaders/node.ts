// A node is one instance of a quad; the circle and its soft edge come from the signed
// distance to its center. Output is premultiplied by alpha.

import { POSITIONS } from './positions.ts';

export const NODE_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${POSITIONS}
layout(location = 0) in vec2 corner; // -1..1
layout(location = 1) in float radius; // world units, per instance
layout(location = 2) in float state; // 0..1, per instance

uniform vec2 uMinMaxRadius; // device pixels
uniform float uBaseRadius; // world units
uniform float uBreath; // -1..1, size change of active nodes

out vec2 vOffset; // device pixels from the center
flat out float vRadius;
flat out float vState;

void main() {
  // The floor grows with the node, so that hubs still stand out from far away.
  float floorRadius = uMinMaxRadius.x * sqrt(radius / uBaseRadius);
  float pixels = clamp(radius * uCamera.z, floorRadius, uMinMaxRadius.y);
  pixels *= 1.0 + 0.3 * uBreath * state;
  // One more pixel for the soft edge.
  vOffset = corner * (pixels + 1.0);
  vRadius = pixels;
  vState = state;
  gl_Position = toClip(toScreen(nodePosition(uint(gl_InstanceID))) + vOffset);
  // A removed node (or one with no place yet): outside the view, so nothing is drawn.
  if (radius <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const NODE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec3 uColor;
uniform vec3 uActiveColor;

in vec2 vOffset;
flat in float vRadius;
flat in float vState;

out vec4 outColor;

void main() {
  float distanceToEdge = length(vOffset) - vRadius;
  // At least a pixel of falloff, and a little more on large nodes.
  float softness = max(0.5, vRadius * 0.08);
  float alpha = 1.0 - smoothstep(-softness, softness, distanceToEdge);
  if (alpha <= 0.0) discard;
  vec3 color = mix(uColor, uActiveColor, vState);
  outColor = vec4(color * alpha, alpha);
}
`;
