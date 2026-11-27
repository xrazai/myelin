// Shared by the node and edge vertex shaders. Node positions live in one texture, a texel
// per node, read by id: a layout step uploads them once, and edges only store node ids.

/** A power of two. */
export const POSITION_TEXTURE_WIDTH = 2048;

export const POSITIONS = /* glsl */ `
uniform highp sampler2D uPositions;
uniform vec3 uCamera; // world center (x, y), device pixels per world unit
uniform vec2 uViewport; // device pixels

vec2 nodePosition(uint id) {
  ivec2 texel = ivec2(id % ${POSITION_TEXTURE_WIDTH}u, id / ${POSITION_TEXTURE_WIDTH}u);
  return texelFetch(uPositions, texel, 0).xy;
}

// Device pixels from the center of the viewport, y down.
vec2 toScreen(vec2 world) {
  return (world - uCamera.xy) * uCamera.z;
}

vec4 toClip(vec2 screen) {
  return vec4(screen * vec2(2.0, -2.0) / uViewport, 0.0, 1.0);
}
`;
