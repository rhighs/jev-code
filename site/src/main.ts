import './style.css';
import { imageRenderer, mountShader } from './shader';
import { session } from './session';
import decisionField from './shaders/decision-field.glsl?raw';
import footerFlow from './shaders/footer-flow.glsl?raw';
import ditherFade from './shaders/dither-fade.glsl?raw';

const base = import.meta.env.BASE_URL;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Backgrounds */

const narrow = window.matchMedia('(max-width: 760px)').matches;

const heroCanvas = document.querySelector<HTMLCanvasElement>('canvas[data-shader="hero"]');
if (heroCanvas) {
  mountShader(heroCanvas, decisionField, {
    uniforms: narrow
      ? { u_bg: '#140A12', u_ink: '#E23FB0', u_pixel: 3, u_scale: 1.6, u_fx: 0.22, u_fy: 0.86, u_spread: 0.3, u_seed: 3 }
      : { u_bg: '#140A12', u_ink: '#E23FB0', u_pixel: 4, u_scale: 2.2, u_fx: 0.8, u_fy: 0.72, u_spread: 0.44, u_seed: 3 },
    pixelUniforms: ['u_pixel'],
  });
}

const footerCanvas = document.querySelector<HTMLCanvasElement>('canvas[data-shader="footer"]');
if (footerCanvas) {
  mountShader(footerCanvas, footerFlow, {
    uniforms: {
      u_bg: '#140A12',
      u_ink: '#371030',
      u_pixel: 5,
      u_scale: 2.2,
      u_speed: 0.06,
      u_intensity: 1.25,
    },
    pixelUniforms: ['u_pixel'],
    animate: true,
  });
}

/* Dithered footer wordmark: render the fade shader and clip it to the text */

const wordmark = document.querySelector<HTMLElement>('.wordmark');
if (wordmark) {
  const render = imageRenderer(ditherFade, {
    uniforms: { u_ink: '#E23FB0', u_pixel: narrow ? 3 : 6, u_start: -0.05, u_end: 0.8, u_grain: 0.2 },
    pixelUniforms: ['u_pixel'],
  });
  let painted = 0;
  const paint = (): void => {
    const { width, height } = wordmark.getBoundingClientRect();
    if (Math.round(width) === painted || width === 0) return;
    painted = Math.round(width);
    const image = render(width, height);
    if (!image) return;
    wordmark.style.backgroundImage = `url(${image})`;
    wordmark.classList.add('is-dithered');
  };
  void document.fonts.ready.then(paint);
  let timer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(paint, 150);
  });
}

/* Languages */

const languages: [file: string, name: string][] = [
  ['python', 'Python'],
  ['typescript', 'TypeScript'],
  ['javascript', 'JavaScript'],
  ['gnubash', 'Bash'],
  ['rust', 'Rust'],
  ['go', 'Go'],
  ['c', 'C'],
  ['lua', 'Lua'],
  ['ruby', 'Ruby'],
];

const list = document.getElementById('languages-list');
if (list) {
  for (const [file, name] of languages) {
    const item = document.createElement('li');
    const logo = document.createElement('span');
    logo.className = 'languages__logo';
    logo.setAttribute('aria-hidden', 'true');
    logo.style.setProperty('--logo', `url("${base}logos/${file}.svg")`);
    const label = document.createElement('span');
    label.className = 'languages__name';
    label.textContent = name;
    item.append(logo, label);
    list.append(item);
  }
}

/* Copy button */

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  const source = document.getElementById(button.dataset.copy ?? '');
  const label = button.querySelector('.install__label');
  button.addEventListener('click', async () => {
    if (!source || !label) return;
    try {
      await navigator.clipboard.writeText(source.textContent?.trim() ?? '');
      label.textContent = 'Copied';
    } catch {
      label.textContent = 'Press Ctrl+C';
    }
    window.setTimeout(() => (label.textContent = 'Copy'), 1600);
  });
}

/* Session: types the prompt, then reveals each line, then loops */

const sessionEl = document.getElementById('session');
if (sessionEl) {
  const lines = session.map((segments) => {
    const line = document.createElement('span');
    line.className = 'line';
    for (const [text, cls] of segments) {
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = text;
      line.append(span);
    }
    sessionEl.append(line);
    return line;
  });
  const cursorLine = document.createElement('span');
  cursorLine.className = 'line';
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  cursorLine.append(cursor);
  sessionEl.append(cursorLine);
  const all = [...lines, cursorLine];

  if (!reduceMotion) {
    const promptLength = session[0]?.[0]?.[0].length ?? 40;
    sessionEl.style.setProperty('--prompt-steps', String(promptLength));
    const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    let started = false;

    const play = async (): Promise<void> => {
      for (;;) {
        all.forEach((line) => {
          line.classList.remove('is-typing', 'is-in');
          line.classList.add('is-hidden');
        });
        await wait(600);
        const [prompt, ...rest] = all;
        if (prompt) {
          prompt.classList.remove('is-hidden');
          prompt.classList.add('is-typing');
          await wait(1800);
        }
        for (const line of rest) {
          await wait(160);
          line.classList.remove('is-hidden');
          line.classList.add('is-in');
        }
        await wait(3500);
      }
    };

    new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !started) {
        started = true;
        void play();
      }
    }).observe(sessionEl);
  }
}
