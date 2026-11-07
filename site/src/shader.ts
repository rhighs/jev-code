type UniformValue = number | string;

export interface ShaderOptions {
  uniforms: Record<string, UniformValue>;
  /** Uniforms given in CSS pixels; they are scaled by the device pixel ratio. */
  pixelUniforms?: string[];
  animate?: boolean;
}

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create shader');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compile failed');
  }
  return shader;
}

function setup(canvas: HTMLCanvasElement, fragment: string, options: ShaderOptions) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
  if (!gl) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const scaled = new Set(options.pixelUniforms ?? []);
  const resolution = gl.getUniformLocation(program, 'u_resolution');
  const time = gl.getUniformLocation(program, 'u_time');
  const start = performance.now();

  return (cssWidth: number, cssHeight: number): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.uniform2f(resolution, width, height);
    if (time) gl.uniform1f(time, (performance.now() - start) / 1000);
    for (const [name, value] of Object.entries(options.uniforms)) {
      const location = gl.getUniformLocation(program, name);
      if (!location) continue;
      if (typeof value === 'string') gl.uniform3f(location, ...hexToRgb(value));
      else gl.uniform1f(location, scaled.has(name) ? value * dpr : value);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
}

/** Draws a fragment shader across a canvas element, redrawing on resize and, if animated, every frame. */
export function mountShader(canvas: HTMLCanvasElement, fragment: string, options: ShaderOptions): void {
  const render = setup(canvas, fragment, options);
  if (!render) return;
  const draw = (): void => render(canvas.clientWidth, canvas.clientHeight);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0;
  let visible = true;

  const loop = (): void => {
    draw();
    if (options.animate && visible && !reduceMotion.matches) frame = requestAnimationFrame(loop);
  };

  if (options.animate) {
    new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      cancelAnimationFrame(frame);
      if (visible) loop();
    }).observe(canvas);
  }

  new ResizeObserver(() => draw()).observe(canvas);
  loop();
}

/** Returns a function that renders the shader at a CSS size into an image URL, reusing one WebGL context. */
export function imageRenderer(fragment: string, options: ShaderOptions): (width: number, height: number) => string | null {
  const canvas = document.createElement('canvas');
  const render = setup(canvas, fragment, options);
  return (width, height) => {
    if (!render) return null;
    render(width, height);
    return canvas.toDataURL();
  };
}
