// imdusd.com's score, "Peg". The cue every scene shares: each loop owns one note, and every time it
// sounds it starts a little off that pitch and is pulled onto it, the way the peg pulls the dollar back
// to one. What pulls, and how, is the scene's own instrument, taken from what its picture does (below).
// Under it the scene's weather, and about once a minute a squall. Played by the engine in score.tsx.
import { seeded, type Kit, type Score } from "./score";
import { click, env, osc, pitch, place, squall, timbre, weather } from "./score-voices";
import { IMDUSD_VIBES } from "./vibe-imdusd";
import { IMDUSD_SOUND_KEY } from "./sound-key";

const D = 73.42; // D2
const PENT = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3];
const LYDIAN = [1, 9 / 8, 5 / 4, 45 / 32, 3 / 2, 15 / 8];
const MINOR = [1, 6 / 5, 4 / 3, 3 / 2, 9 / 5];
const DORIAN = [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 5 / 3];
const SUS = [1, 9 / 8, 4 / 3, 3 / 2, 16 / 9];

/** Each loop's one note: scale position and octave over the root. */
const NOTES: [number, number][] = [
  [0, 2],
  [2, 2],
  [4, 1],
  [1, 3],
  [3, 2],
  [2, 3],
];
const SQUALL = NOTES.length; // the loop after the notes is the squall

/** One sounding of a loop: its note, how far off the peg it starts, and how fast it is pulled on. */
type Peg = {
  f: number;
  when: number;
  /** The starting pitch as a ratio of the note (a few tens of cents either side of 1). */
  start: number;
  /** The pull's time constant, seconds. */
  pull: number;
  level: number;
  pan: number;
  n: number;
  r: () => number;
};

/** A pitch parameter starting off the peg and pulled onto it. */
function peg(param: AudioParam, f: number, c: Peg, delay = 0.05, pull = c.pull) {
  param.setValueAtTime(f * c.start, c.when);
  param.setTargetAtTime(f, c.when + delay, pull);
}

/** Each scene's instrument. All take the same cue; the loudness of each is set by ear and by meter. */
const VOICES: Record<string, (kit: Kit, c: Peg) => void> = {
  // Rosette: two rosettes cut in opposite phase. Two tones, one sharp and one flat of the note, beating
  // against each other; the pull draws both onto it and the beating slows until the pair is one tone.
  rosette: (kit, c) => {
    const { ac } = kit;
    const { f, when } = c;
    const end = when + 8;
    const out = env(ac, when, 0.8, 2.2, 4, c.level * 0.5);
    out.connect(place(kit, c.pan, 0.3));
    for (const [k, a] of [
      [1, 1],
      [3, 0.12],
    ]) {
      for (const flip of [false, true]) {
        const o = osc(kit, "sine", f * k, when, end);
        peg(o.frequency, f * k, { ...c, start: flip ? 1 / c.start : c.start });
        const g = ac.createGain();
        g.gain.value = a;
        o.connect(g).connect(out);
      }
    }
  },

  // Lathe: lines rolling sideways with a swinging angle. A bowed string with a wide vibrato that the
  // pull steadies, so the wobble narrows to a held, still note.
  lathe: (kit, c) => {
    const { ac } = kit;
    const { f, when } = c;
    const end = when + 8;
    const o = osc(kit, "sawtooth", f, when, end);
    peg(o.frequency, f, c);
    const lfo = osc(kit, "sine", 5.2, when, end);
    const depth = ac.createGain();
    depth.gain.setValueAtTime(38, when);
    depth.gain.setTargetAtTime(2, when + 0.3, c.pull * 1.4);
    lfo.connect(depth).connect(o.detune);
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.min(f * 2.6, 3000);
    lp.Q.value = 0.8;
    o.connect(lp).connect(env(ac, when, 1.4, 2.4, 3, c.level * 0.32)).connect(place(kit, c.pan, 0.35));
  },

  // Topography: a survey map, every fifth contour heavier. A wooden mallet that lands a little off and
  // settles at once, with a bounce; every fifth strike is the heavy line, doubled an octave down.
  topography: (kit, c) => {
    const { ac } = kit;
    const { f, when } = c;
    const dest = place(kit, c.pan, 0.25);
    const strike = (at: number, freq: number, lv: number) => {
      const body = osc(kit, "sine", freq, at, at + 1.6);
      peg(body.frequency, freq, { ...c, when: at }, 0.005, c.pull * 0.06);
      body.connect(env(ac, at, 0.004, 0, 1.3, lv)).connect(dest);
      const wood = osc(kit, "sine", freq * 3.93, at, at + 0.25);
      wood.connect(env(ac, at, 0.002, 0, 0.16, lv * 0.35)).connect(dest);
    };
    strike(when, f, c.level * 2);
    strike(when + 0.21, f, c.level * 0.7);
    if (c.n % 5 === 0) strike(when, f / 2, c.level * 1.6);
  },

  // Tide: rings spreading from drops in still water. A drop that rises onto its note, then its rings:
  // the same drop again, smaller each time, spreading out to both sides.
  tide: (kit, c) => {
    const { ac } = kit;
    const { f, when } = c;
    for (let k = 0; k < 4; k++) {
      const at = when + 0.38 * k;
      const o = osc(kit, "sine", f, at, at + 0.9);
      o.frequency.setValueAtTime(f * (k ? 0.8 : 0.55), at);
      o.frequency.exponentialRampToValueAtTime(f * c.start, at + 0.07);
      o.frequency.setTargetAtTime(f, at + 0.07, c.pull * 0.3);
      const pan = k === 0 ? c.pan : (k % 2 ? -1 : 1) * 0.3 * k;
      o.connect(env(ac, at, 0.005, 0.04, 0.5, c.level * 1.9 * 0.5 ** k)).connect(place(kit, pan, 0.4));
    }
  },

  // Ridgelines: a market drawn as a mountain range, scrolling like ticker tape. A reed whose pitch
  // ticks onto the note in steps, the way a price prints, each step marked by a tick.
  ridgelines: (kit, c) => {
    const { ac } = kit;
    const { f, when } = c;
    const end = when + 6;
    const reed = timbre(ac, "reed", [0, 1, 0, 0.33, 0, 0.2, 0, 0.14, 0, 0.11]);
    const o = osc(kit, reed, f, when, end);
    const dest = place(kit, c.pan, 0.3);
    const steps = 4;
    for (let k = 0; k <= steps; k++) {
      const at = when + k * c.pull * 0.35;
      o.frequency.setValueAtTime(f * c.start ** ((steps - k) / steps), at);
      if (k) click(kit, dest, at, 3200, c.level * 0.5, 0.012);
    }
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.min(f * 4, 4000);
    o.connect(lp).connect(env(ac, when, 0.06, 2, 1.6, c.level * 0.55)).connect(dest);
  },

  // Halftone: a screened print, its dots swelling and shrinking under drifting clouds. The note is made
  // of dots: tiny grains, scattered in pitch at first and gathering onto the note as it is pulled, their
  // density swelling and thinning like the tone of the print.
  halftone: (kit, c) => {
    const { ac } = kit;
    const { f, when } = c;
    const span = 3.4;
    const spread = Math.abs(Math.log2(c.start)) * 1200 * 3; // cents
    for (let g = 0; g < 40; g++) {
      const t = (span * (c.r() + c.r() + c.r())) / 3; // bunched in the middle: the swell
      const at = when + t;
      const cents = spread * Math.exp(-t / (c.pull * 1.2)) * (c.r() * 2 - 1);
      const freq = f * 2 ** (cents / 1200) * (c.r() < 0.18 ? 2 : 1);
      const o = osc(kit, "sine", freq, at, at + 0.12);
      o.connect(env(ac, at, 0.012, 0, 0.07, c.level * 1.1)).connect(place(kit, (c.r() * 2 - 1) * 0.6, 0.3));
    }
  },

  // Hatch: engraver's shading, hatching and then cross-hatching. Quick repeated strokes that find the
  // note as they go, then a second, lighter pass a fifth above, laid across from the other side.
  hatch: (kit, c) => {
    const { ac } = kit;
    const { f, when } = c;
    const pass = (from: number, count: number, every: number, freq: number, lv: number, pan: number) => {
      const dest = place(kit, pan, 0.3);
      for (let k = 0; k < count; k++) {
        const at = from + k * every;
        const o = osc(kit, "triangle", freq * c.start ** Math.exp(-k / 3), at, at + 0.16);
        o.connect(env(ac, at, 0.003, 0, 0.12, lv * (0.6 + 0.4 * c.r()))).connect(dest);
        click(kit, dest, at, 2400, lv * 0.12, 0.02);
      }
    };
    pass(when, 14, 0.085, f, c.level * 1.2, c.pan - 0.3);
    pass(when + 0.7, 10, 0.1, f * 1.5, c.level * 0.8, c.pan + 0.3);
  },

  // Grid: the page's dot grid with a pulse running through it, as if the paper breathed. A soft pad
  // that breathes fast at first, in a tremolo that slows and fades into a steady tone as it settles.
  grid: (kit, c) => {
    const { ac } = kit;
    const { f, when } = c;
    const end = when + 8;
    const trem = ac.createGain();
    trem.gain.value = 0.7;
    const lfo = osc(kit, "sine", 5, when, end);
    lfo.frequency.exponentialRampToValueAtTime(0.6, when + 3);
    const depth = ac.createGain();
    depth.gain.setValueAtTime(0.3, when);
    depth.gain.setTargetAtTime(0.03, when + 0.5, c.pull * 1.2);
    lfo.connect(depth).connect(trem.gain);
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.min(f * 2, 2500);
    for (const cents of [-6, 6]) {
      const o = osc(kit, "triangle", f, when, end);
      o.detune.value = cents;
      peg(o.frequency, f, c);
      o.connect(lp);
    }
    lp.connect(trem).connect(env(ac, when, 1, 2.6, 3, c.level * 0.55)).connect(place(kit, c.pan, 0.35));
  },
};

/** Each instrument's level against the others, measured so every scene plays at about the same loudness. */
const TRIM: Record<string, number> = {
  rosette: 0.62,
  lathe: 1.7,
  topography: 1,
  tide: 1.05,
  ridgelines: 0.78,
  halftone: 1.1,
  hatch: 1.7,
  grid: 0.85,
};

export const IMDUSD_SCORE: Score = {
  key: IMDUSD_SOUND_KEY,
  vibe: IMDUSD_VIBES,
  voicings: {
    rosette: { root: D, scale: PENT, weather: "wind" },
    lathe: { root: D, scale: LYDIAN, weather: "waves" },
    topography: { root: D * (9 / 8), scale: PENT, weather: "wind" },
    tide: { root: D * (4 / 3), scale: SUS, weather: "waves" },
    ridgelines: { root: D * (9 / 8), scale: DORIAN, weather: "wind" },
    halftone: { root: D * (6 / 5), scale: MINOR, weather: "rain" },
    hatch: { root: D * (3 / 4), scale: DORIAN, weather: "rain" },
    grid: { root: D, scale: SUS, weather: "wind" },
  },
  // Periods that share no small multiple, so the loops never meet the same way twice.
  loops: [
    { every: 19.7, at: 0 },
    { every: 23.9, at: 6.1 },
    { every: 29.3, at: 13.7 },
    { every: 34.1, at: 3.3 },
    { every: 41.9, at: 21.2 },
    { every: 50.3, at: 31.9 },
    { every: 61.7, at: 9.4 }, // the squall
  ],
  bed: (kit) => weather(kit, { body: kit.night ? 380 : 520, level: 0.05 }),
  play: (kit, i, n, when) => {
    if (i === SQUALL) {
      squall(kit, when, n, { band: kit.night ? 420 : 600, level: 0.07 });
      return;
    }
    const r = seeded(11, i, n);
    if (r() < 0.12) return; // a loop sometimes rests
    const cents = (r() < 0.5 ? -1 : 1) * (14 + 30 * r());
    const c: Peg = {
      f: pitch(kit, NOTES[i][0], NOTES[i][1]),
      when,
      start: 2 ** (cents / 1200),
      pull: 0.8 + 0.8 * r(),
      level: (0.07 + 0.03 * r()) * (kit.night ? 0.9 : 1) * (TRIM[kit.scene] ?? 1),
      pan: (i / (NOTES.length - 1)) * 1.2 - 0.6,
      n,
      r,
    };
    (VOICES[kit.scene] ?? VOICES.rosette)(kit, c);
  },
};
