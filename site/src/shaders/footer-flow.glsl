precision mediump float;

/** @resolution */
uniform vec2 u_resolution;

/** @time */
uniform float u_time;

/**
 * @label Background
 * @color
 * @default #140A12
 */
uniform vec3 u_bg;

/**
 * @label Ink
 * @color
 * @default #6B1F5B
 */
uniform vec3 u_ink;

/**
 * @label Pixel size
 * @default 5
 * @range 1, 16
 */
uniform float u_pixel;

/**
 * @label Scale
 * @default 2.4
 * @range 0.5, 8
 */
uniform float u_scale;

/**
 * @label Speed
 * @default 0.06
 * @range 0, 0.5
 */
uniform float u_speed;

/**
 * @label Intensity
 * @default 1.6
 * @range 0, 4
 */
uniform float u_intensity;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
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
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = uv * vec2(aspect, 1.0) * u_scale;
  float t = u_time * u_speed;

  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - vec2(t * 0.7, 0.0)));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t * 0.5), fbm(p + 4.0 * q + vec2(8.3, 2.8) - t * 0.3));
  float f = fbm(p + 4.0 * r);

  float rise = smoothstep(1.05, 0.0, uv.y);
  float v = clamp(f * f * u_intensity * rise, 0.0, 1.0);
  float on = step(bayer4(cell) + 0.02, v);

  gl_FragColor = vec4(mix(u_bg, u_ink, on), 1.0);
}
