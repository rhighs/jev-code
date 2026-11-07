precision mediump float;

/** @resolution */
uniform vec2 u_resolution;

/**
 * @label Ink
 * @color
 * @default #E23FB0
 */
uniform vec3 u_ink;

/**
 * @label Pixel size
 * @default 6
 * @range 1, 24
 */
uniform float u_pixel;

/**
 * @label Fade start
 * @default 0.15
 * @range 0, 1
 */
uniform float u_start;

/**
 * @label Fade end
 * @default 0.85
 * @range 0, 1
 */
uniform float u_end;

/**
 * @label Grain
 * @default 0.18
 * @range 0, 1
 */
uniform float u_grain;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}

float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy / u_pixel);
  vec2 uv = (cell * u_pixel) / u_resolution;
  float v = smoothstep(u_start, u_end, uv.y);
  v += (hash(cell) - 0.5) * u_grain;
  float on = step(bayer4(cell), v);
  gl_FragColor = vec4(u_ink * on, on);
}
