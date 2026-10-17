// The sites' "vibe": an engraved background drawn by small WebGL2 shaders, and the header button that
// changes it. Each site brings its own suite of scenes (vibe-imdusd.tsx for imdusd.com,
// infer/vibes.tsx for infer.imdusd.com), drawn in the theme's own two colours (--text on --bg) and
// nothing else, in either theme. This file is the engine they share, with no React in it: each page's first
// script (boot) starts the background before the app's code has loaded. The header button is in vibe.tsx.
//
// Costs nothing it does not have to: one full-screen triangle, no textures, no library, and only the
// chosen scene is compiled. It stops drawing in a hidden tab, holds one still frame for reduced
// motion, and where WebGL2 is unavailable the page is exactly the page it was. The canvas fills the
// screen edge to edge, behind the whole page as it scrolls. The choice is remembered per visitor.
import type { ReactNode } from "react";

/** A scene: its id, its name, its button glyph, and the body of its fragment shader (main() and any helpers). */
export type Scene = {
  id: string;
  label: string;
  /** The button's glyph while this scene is on, drawn in a 24-unit box. */
  icon: ReactNode;
  main: string;
};
/** A site's set of scenes. */
export type Suite = {
  /** The localStorage key the visitor's choice is kept under. */
  key: string;
  /** In order: the first is the default, and the button steps through them. */
  scenes: Scene[];
  /** The scenes' focus as fractions of the screen (x from the left, y from the bottom) and its
   *  radius as a fraction of the screen's shorter side. */
  focus: (wide: boolean) => [number, number, number];
};

// ------------------------------------------------------------------ shaders

const HEADER = `#version 300 es
precision highp float;
uniform vec2 uRes;      // canvas size in device pixels
uniform float uTime;    // seconds, frozen under reduced motion
uniform vec3 uInk;
uniform vec3 uPaper;
uniform vec2 uCenter;   // the scene's focus, device pixels from the bottom left
uniform float uScale;   // its radius, device pixels
uniform float uInk1;    // line strength, set per theme so both read the same
uniform float uWide;    // 1 on wide screens, 0 on narrow
out vec4 outColor;

// A hairline wherever v crosses a whole number: about one device pixel wide at any zoom.
float lines(float v, float weight) {
  float d = abs(fract(v + 0.5) - 0.5);
  float w = fwidth(v) * weight;
  return 1.0 - smoothstep(0.0, w, d);
}
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}
mat2 rot(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }
// Every scene fills the screen. Kept as a function so a scene can still be faded locally later.
float presence(vec2 frag) {
  return 1.0;
}
vec4 paint(float ink) { return vec4(mix(uPaper, uInk, clamp(ink, 0.0, 1.0)), 1.0); }
`;

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// ------------------------------------------------------------------ choice

export type Store = {
  get: () => string;
  set: (id: string) => void;
  subscribe: (fn: () => void) => () => void;
};
const stores = new Map<string, Store>();
/** One store per suite, created on first use: the saved choice if it is still a scene, else the first. */
export function vibeStore(suite: Suite): Store {
  let s = stores.get(suite.key);
  if (s) return s;
  let current = suite.scenes[0].id;
  try {
    const saved = localStorage.getItem(suite.key);
    if (suite.scenes.some((v) => v.id === saved)) current = saved!;
  } catch {
    /* Storage may be disabled: the default stands for this visit. */
  }
  const listeners = new Set<() => void>();
  s = {
    get: () => current,
    set: (id) => {
      current = id;
      try {
        localStorage.setItem(suite.key, id);
      } catch {
        /* Optional persistence. */
      }
      listeners.forEach((fn) => fn());
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  stores.set(suite.key, s);
  return s;
}

// ------------------------------------------------------------------ the canvas

/** A CSS colour token as 0..1 RGB, through the browser's own parser. */
function token(name: string): [number, number, number] {
  const probe = document.createElement("i");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) ?? [
    "0",
    "0",
    "0",
  ];
  probe.remove();
  return [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255];
}

/**
 * Draws one scene on one canvas until the returned stop function is called. The first frame is drawn
 * before this returns, so a page that starts the background as its script loads paints with it.
 */
function run(el: HTMLCanvasElement, scene: Scene, suite: Suite): () => void {
  const gl = el.getContext("webgl2", {
    antialias: false,
    alpha: false,
    premultipliedAlpha: false,
  });
  if (!gl) {
    el.hidden = true; // no WebGL2: the page is the page it was
    return () => {};
  }
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  let program: WebGLProgram;
  try {
    program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, HEADER + scene.main));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error("link");
  } catch (e) {
    console.warn(`vibe ${scene.id}: ${(e as Error).message}`);
    el.hidden = true;
    return () => {};
  }
  el.hidden = false;
  gl.useProgram(program);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const u = (n: string) => gl.getUniformLocation(program, n);
  const uRes = u("uRes"),
    uTime = u("uTime"),
    uInk = u("uInk"),
    uPaper = u("uPaper");
  const uCenter = u("uCenter"),
    uScale = u("uScale"),
    uInk1 = u("uInk1"),
    uWide = u("uWide");

  const colours = () => {
    gl.uniform3fv(uInk, token("--text"));
    gl.uniform3fv(uPaper, token("--bg"));
    // Light ink on dark paper reads stronger than dark on light at the same mix: even them out.
    gl.uniform1f(
      uInk1,
      document.documentElement.dataset.theme === "dark" ? 0.13 : 0.18,
    );
  };
  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * dpr),
      h = Math.round(window.innerHeight * dpr);
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uRes, w, h);
    const wide = window.innerWidth > 1100;
    const [fx, fy, fs] = suite.focus(wide);
    gl.uniform1f(uWide, wide ? 1 : 0);
    gl.uniform2f(uCenter, w * fx, h * fy);
    gl.uniform1f(uScale, Math.min(w, h) * fs);
  };
  colours();
  size();

  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  const draw = () => {
    gl.uniform1f(uTime, still.matches ? 12 : clock());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frame = still.matches || document.hidden ? 0 : requestAnimationFrame(draw);
  };
  const restart = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  };
  draw();

  const onResize = () => {
    size();
    restart();
  };
  const observer = new MutationObserver(() => {
    colours();
    restart();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  window.addEventListener("resize", onResize);
  document.addEventListener("visibilitychange", restart);
  still.addEventListener("change", restart);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", restart);
    still.removeEventListener("change", restart);
    gl.deleteBuffer(buf);
    gl.deleteProgram(program);
    // Hand the context back now: browsers cap live WebGL contexts per page.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}

// ------------------------------------------------------------------ the clock and the controller

const CLOCK = "vibe-clock";
let origin = 0;
/**
 * Seconds on one clock for the whole tab: each page continues the motion where the last one left it
 * rather than starting again. Restarted after six hours, before 32-bit shader time loses smoothness.
 */
function clock(): number {
  if (!origin) {
    origin = Date.now();
    try {
      const saved = Number(sessionStorage.getItem(CLOCK));
      if (saved > 0 && origin - saved < 6 * 3600e3) origin = saved;
      else sessionStorage.setItem(CLOCK, String(origin));
    } catch {
      /* Storage may be disabled: this page keeps its own clock. */
    }
  }
  return (Date.now() - origin) / 1000;
}

const started = new Set<string>();
/**
 * Puts a suite's background behind the page and keeps it on the visitor's choice. Each site calls it
 * as its script loads, before React renders, so the new page's first paint already shows the
 * background (the browser holds the old page until then). Safe to call more than once.
 *
 * The canvas lives at the end of <body>, outside any header or page box, so no stacking context can
 * lift it above the page. A scene change draws the new scene on a fresh canvas (a WebGL context keeps
 * its program) before the old one is removed, so there is no blank frame between them.
 */
export function startVibe(suite: Suite) {
  if (typeof document === "undefined" || started.has(suite.key)) return;
  started.add(suite.key);
  const s = vibeStore(suite);
  let current: HTMLCanvasElement | undefined;
  let stop = () => {};
  const show = () => {
    const scene = suite.scenes.find((v) => v.id === s.get()) ?? suite.scenes[0];
    const el = document.createElement("canvas");
    el.className = "vibe-canvas";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    const stopNext = run(el, scene, suite);
    stop();
    current?.remove();
    current = el;
    stop = stopNext;
  };
  show();
  s.subscribe(show);
}
