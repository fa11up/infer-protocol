// The sites' sound: a quiet piece built live in the browser from a few oscillators and a little noise,
// with no audio files, and the header button that turns it on. The technique is Eno's from Music for
// Airports: a handful of loops, each repeating on its own period, the periods chosen so they never
// line up the same way twice, over a bed. Here the bed is weather (wind, rain or the sea), matched to the background scene.
//
// Each site brings its own idea (score-imdusd.ts: every note is pulled onto its pitch the way a peg
// holds; infer/score.ts: every note is sampled from a distribution with a temperature), and each
// background scene re-voices it, so switching the background changes the music. The theme sets the
// register: dark plays lower, darker and slower.
//
// Every visitor hears the same piece at the same moment: when a loop sounds and what it plays are a
// function of the wall clock alone (seeded, never Math.random), so moving between pages, or two people
// in a room, stay in time. The same schedule renders offline (renderScore), which is how it is checked.
//
// Off by default. The choice is remembered, and moving to another page carries the piece on: it starts at
// once, in time with the last page (every note is placed by the wall clock), as the background does. A
// browser that holds sound until the visitor touches the page (Safari, a first visit) starts it at the
// first click or key instead. Silent in a hidden tab.
import { useEffect, useSyncExternalStore } from "react";
import { vibeStore, type Suite } from "./vibe";

/** What the bed under the notes sounds like. Each scene has its own, to match the picture. */
export type Weather = "wind" | "waves" | "rain";
export const WEATHERS: Weather[] = ["wind", "waves", "rain"];

/** A scene's voicing: its root, the scale the loops play (as ratios over it) and its weather. */
export type Voicing = { root: number; scale: number[]; weather: Weather };

/** What a site's score draws on to play a note. */
export type Kit = {
  ac: BaseAudioContext;
  /** The dry bus; everything a voice sends here also reaches the room. */
  out: AudioNode;
  /** The room (reverb and the echo) alone, for sounds that should sit far back. */
  room: AudioNode;
  voicing: Voicing;
  night: boolean;
  /** A wave with a few soft harmonics, for plucked voices. */
  soft: PeriodicWave;
  weather: Weather;
  /** The background scene showing: each one has its own instrument. */
  scene: string;
};

/** The bed: started once, retuned when the voicing changes, and (for events like waves) scheduled. */
export type Bed = {
  retune: (v: Voicing, at: number) => void;
  /** Bed events whose wall-clock time falls in [from, to); `at(wall)` is their context time. */
  schedule?: (kit: Kit, from: number, to: number, at: (wall: number) => number) => void;
};

export type Score = {
  /** localStorage key for on/off. */
  key: string;
  vibe: Suite;
  /** Per scene id; scenes not listed take the first entry. */
  voicings: Record<string, Voicing>;
  /** Loop periods in seconds (by day; night stretches them) and their phase offsets. */
  loops: { every: number; at: number }[];
  /** The bed for kit.weather. */
  bed: (kit: Kit) => Bed;
  /** Loop i's n-th turn, sounding at context time `when` (wall-clock second `wall`). */
  play: (kit: Kit, i: number, n: number, when: number, wall: number) => void;
};

/** A deterministic 0..1 sequence from integer keys (a small mix of splitmix and murmur finalizers). */
export function seeded(...keys: number[]): () => number {
  let h = 0x9e3779b9;
  for (const k of keys) h = Math.imul(h ^ Math.floor(k), 0x85ebca6b) ^ (h >>> 13);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ the engine

const NIGHT_TEMPO = 1.3; // night stretches every period by this
const NIGHT_PITCH = 3 / 4; // and plays a fourth lower

/** Builds the score on a context and schedules it; `wall0` is the wall-clock second at context time 0. */
function build(ac: BaseAudioContext, score: Score, scene: () => string, night: () => boolean, wall0: () => number, forced?: Weather) {
  const master = ac.createGain();
  master.gain.value = 0;
  // A gentle limiter so overlapping swells can never clip, then out.
  const limit = ac.createDynamicsCompressor();
  limit.threshold.value = -14;
  limit.knee.value = 10;
  limit.ratio.value = 12;
  limit.attack.value = 0.005;
  limit.release.value = 0.4;
  master.connect(limit).connect(ac.destination);

  // The tone control: the theme's register. Night is darker.
  const tone = ac.createBiquadFilter();
  tone.type = "lowpass";
  tone.Q.value = 0.5;
  tone.connect(master);

  const dry = ac.createGain();
  dry.connect(tone);

  // The room: a generated plate (decaying stereo noise) and a slow ping-pong echo, both dark.
  const send = ac.createGain();
  send.gain.value = 1;
  dry.connect(send);
  const plate = ac.createConvolver();
  const len = Math.round(ac.sampleRate * 3.6);
  const ir = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    const r = seeded(7, c);
    for (let k = 0; k < len; k++) d[k] = (r() * 2 - 1) * Math.pow(1 - k / len, 3.2);
  }
  plate.buffer = ir;
  const plateOut = ac.createGain();
  plateOut.gain.value = 0.32;
  send.connect(plate).connect(plateOut).connect(tone);

  const merge = ac.createChannelMerger(2);
  const dl = ac.createDelay(2),
    dr = ac.createDelay(2);
  dl.delayTime.value = 0.41;
  dr.delayTime.value = 0.59;
  const fb = ac.createGain();
  fb.gain.value = 0.38;
  const dim = ac.createBiquadFilter();
  dim.type = "lowpass";
  dim.frequency.value = 1500;
  const echo = ac.createGain();
  echo.gain.value = 0.22;
  send.connect(dl);
  dl.connect(dr);
  dl.connect(merge, 0, 0);
  dr.connect(merge, 0, 1);
  dr.connect(dim).connect(fb).connect(dl);
  merge.connect(echo).connect(tone);

  const roomOnly = ac.createGain();
  roomOnly.connect(send);

  const harmonics = [0, 1, 0.32, 0.14, 0.05, 0.025];
  const soft = ac.createPeriodicWave(new Float32Array(harmonics.length), new Float32Array(harmonics));

  const voicing = (): Voicing => {
    const v = score.voicings[scene()] ?? Object.values(score.voicings)[0];
    const w = forced ?? v.weather;
    return { root: v.root * (night() ? NIGHT_PITCH : 1), scale: v.scale, weather: w };
  };
  const kit = (): Kit => ({ ac, out: dry, room: roomOnly, voicing: voicing(), night: night(), soft, weather: voicing().weather, scene: scene() });

  // One bed per weather, built the first time its scene is shown, each behind its own fader so a
  // scene change crossfades the weather. A faded bed keeps running silently (a few noise sources).
  type Layer = { bed: Bed; out: GainNode; room: GainNode; weather: Weather };
  const layers = new Map<Weather, Layer>();
  const layerKit = (l: Layer): Kit => ({ ...kit(), out: l.out, room: l.room, weather: l.weather });
  const layer = (w: Weather, at: number): Layer => {
    let l = layers.get(w);
    if (!l) {
      const out = ac.createGain(),
        room = ac.createGain();
      out.gain.value = room.gain.value = 0;
      out.connect(dry);
      room.connect(roomOnly);
      l = { out, room, weather: w, bed: { retune: () => {} } };
      l.bed = score.bed(layerKit(l));
      layers.set(w, l);
    }
    for (const g of [l.out.gain, l.room.gain]) {
      g.cancelScheduledValues(at);
      g.setTargetAtTime(1, at, layers.size > 1 ? 2.5 : 0.01);
    }
    return l;
  };

  const setTone = (at: number) => {
    tone.frequency.setTargetAtTime(night() ? 1500 : 3200, at, 1.5);
  };
  tone.frequency.value = night() ? 1500 : 3200;
  let bed = layer(voicing().weather, 0); // the layer playing now

  /** Every loop turn whose wall-clock time falls in [from, to), played at its exact moment. */
  const schedule = (from: number, to: number) => {
    const stretch = night() ? NIGHT_TEMPO : 1;
    const k = kit();
    score.loops.forEach((loop, i) => {
      const p = loop.every * stretch;
      for (let n = Math.ceil((from - loop.at) / p); loop.at + n * p < to; n++) {
        const wall = loop.at + n * p;
        score.play(k, i, n, Math.max(0, wall - wall0()), wall);
      }
    });
    bed.bed.schedule?.(layerKit(bed), from, to, (wall) => Math.max(0, wall - wall0()));
  };
  const revoice = (at: number) => {
    const w = voicing().weather;
    if (w !== bed.weather) {
      for (const g of [bed.out.gain, bed.room.gain]) {
        g.cancelScheduledValues(at);
        g.setTargetAtTime(0, at, 2.5);
      }
      bed = layer(w, at);
    }
    for (const l of layers.values()) l.bed.retune(voicing(), at);
    setTone(at);
  };
  return { master, schedule, revoice };
}

/** Renders `seconds` of a score offline, starting at wall-clock second `wall`. For checks and previews. */
export async function renderScore(score: Score, opts: { scene: string; night: boolean; seconds: number; wall: number; sampleRate?: number; weather?: Weather }) {
  const ac = new OfflineAudioContext(2, Math.round(opts.seconds * (opts.sampleRate ?? 44100)), opts.sampleRate ?? 44100);
  const s = build(ac, score, () => opts.scene, () => opts.night, () => opts.wall, opts.weather);
  s.master.gain.setValueAtTime(0, 0);
  s.master.gain.linearRampToValueAtTime(1, 2);
  s.schedule(opts.wall, opts.wall + opts.seconds);
  return ac.startRendering();
}

// ------------------------------------------------------------------ live playback and the button

/** A weather the page's ?weather= forces on every scene (for trying them side by side), if any. */
function pageWeather(): Weather | undefined {
  const asked = new URLSearchParams(location.search).get("weather");
  return WEATHERS.find((w) => w === asked);
}

type State = "off" | "armed" | "on"; // armed: remembered on, waiting for the browser to allow sound
type Player = {
  state: State;
  toggle: () => void;
  /** Called once the page is up: a remembered "on" picks the piece up where the last page left it. */
  carry: () => void;
  subscribe: (fn: () => void) => () => void;
};
const players = new Map<string, Player>();

export function player(score: Score): Player {
  const had = players.get(score.key);
  if (had) return had;
  let state: State = "off";
  try {
    if (localStorage.getItem(score.key) === "1") state = "armed";
  } catch {
    /* Storage may be disabled: off for this visit. */
  }
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  const remember = (on: boolean) => {
    try {
      localStorage.setItem(score.key, on ? "1" : "0");
    } catch {
      /* Optional persistence. */
    }
  };

  let ac: AudioContext | null = null;
  let live: ReturnType<typeof build> | null = null;
  let timer = 0;
  let until = 0; // wall-clock second scheduled up to
  const now = () => Date.now() / 1000;
  const night = () => document.documentElement.dataset.theme === "dark";
  const choice = vibeStore(score.vibe);

  const tick = () => {
    // Nothing is scheduled while the context is held: its clock is stopped, so the notes would all land
    // together when it starts.
    if (!ac || !live || document.hidden || ac.state !== "running") return;
    const horizon = now() + 2;
    if (until < now()) until = now();
    live.schedule(until, horizon);
    until = horizon;
  };
  const fade = (to: number, tau: number) => {
    if (!ac || !live) return;
    live.master.gain.cancelScheduledValues(ac.currentTime);
    live.master.gain.setTargetAtTime(to, ac.currentTime, tau);
  };
  const start = (tau = 1.2) => {
    if (!ac) {
      // On an iPhone, Web Audio is "ambient" by default, which the silent switch mutes. Saying it is
      // playback (Safari 16.4+) makes it sound like any other media, as a music page should.
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (session) session.type = "playback";
      ac = new AudioContext();
      const ctx = ac;
      ctx.addEventListener("statechange", () => {
        if (ctx.state !== "running") return;
        if (state === "armed") {
          // The browser let this page play without a touch (Chrome does after a click on the same site).
          state = "on";
          disarm();
          emit();
        }
        if (state === "on") {
          until = now();
          tick();
        }
      });
      // Leaving for another page: a quick fade rather than a cut. The next page starts in time with this
      // one, since every note is placed by the wall clock.
      window.addEventListener("pagehide", () => fade(0, 0.03));
      window.addEventListener("pageshow", (e) => {
        if (e.persisted && state === "on") {
          void ctx.resume();
          until = now();
          fade(1, 0.3);
        }
      });
      // Context time 0 is "now" on the wall clock, corrected for however far the context has run.
      live = build(ctx, score, choice.get, night, () => now() - ctx.currentTime, pageWeather());
      choice.subscribe(() => live?.revoice(ctx.currentTime));
      new MutationObserver(() => {
        // A theme change moves the register and the tempo; notes already scheduled (two seconds at most)
        // play out as they were.
        live?.revoice(ctx.currentTime);
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      document.addEventListener("visibilitychange", () => {
        if (state !== "on" || !ac) return;
        if (document.hidden) {
          fade(0, 0.2);
          setTimeout(() => document.hidden && void ac?.suspend(), 800);
        } else {
          void ac.resume();
          until = now();
          fade(1, 1);
        }
      });
    }
    void ac.resume();
    until = now();
    tick();
    clearInterval(timer);
    timer = window.setInterval(tick, 1000);
    fade(1, tau);
  };
  const stop = () => {
    clearInterval(timer);
    fade(0, 0.25);
    const ctx = ac;
    setTimeout(() => state !== "on" && void ctx?.suspend(), 1200);
  };

  const p: Player = {
    get state() {
      return state;
    },
    toggle: () => {
      state = state === "on" ? "off" : "on";
      remember(state === "on");
      disarm();
      if (state === "on") start();
      else stop();
      emit();
    },
    carry: () => {
      // Moving between pages with the sound on: start straight away with a short fade, so the music
      // carries on as the background does. If the browser holds it until a touch, the first touch starts it.
      if (state === "armed" && !ac) start(0.15);
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  // Remembered on but not yet allowed to play: the first touch anywhere starts it. A touch on the button
  // itself is handled by toggle (armed counts as off there, so the click turns it on rather than off).
  // Safari unlocks audio on a finished tap (click, touchend) or a key, never on a finger going down.
  const WAKE = ["click", "touchend", "keydown"] as const;
  const wake = (e: Event) => {
    if ((e.target as Element | null)?.closest?.(".score-toggle")) return;
    disarm();
    if (state !== "armed") return;
    state = "on";
    start();
    emit();
  };
  function disarm() {
    for (const t of WAKE) window.removeEventListener(t, wake, true);
  }
  if (state === "armed") for (const t of WAKE) window.addEventListener(t, wake, true);
  players.set(score.key, p);
  return p;
}

/** The header button: a speaker, sounding when on. */
export function Sound({ score }: { score: Score }) {
  const p = player(score);
  useEffect(() => p.carry(), [p]);
  const state = useSyncExternalStore(p.subscribe, () => p.state);
  const on = state === "on";
  const label = on ? "Sound on. Turn sound off." : "Sound off. Turn sound on.";
  return (
    <button
      type="button"
      className="theme-toggle score-toggle"
      aria-label={label}
      aria-pressed={on}
      title={label}
      data-state={state}
      onClick={p.toggle}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
          {on ? (
            <path d="M15 9.5c1.3 1.4 1.3 3.6 0 5M17.6 7c2.7 2.8 2.7 7.2 0 10" strokeLinecap="round" />
          ) : (
            <path
              d="M15.5 10l4 4M19.5 10l-4 4"
              strokeLinecap="round"
              opacity={state === "armed" ? 0.45 : 1}
            />
          )}
        </g>
      </svg>
    </button>
  );
}
