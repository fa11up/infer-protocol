// infer.imdusd.com's score, "Sampled". The cue every scene shares: no loop has a note of its own. Each
// time one comes round it samples one from a distribution over the scale (logits favour the current
// chord and the loop's own register) at a temperature that slowly rises and falls, so the piece drifts
// from settled, nearly repeating phrases to wandering ones and back; hot moments stream a few tokens at
// once. Seeded by the wall clock, so everyone hears the same draw. How a draw sounds is the scene's own
// instrument, taken from what its picture does (below). Played by the engine in ../score.tsx.
import { seeded, type Kit, type Score } from "../score";
import { click, env, hiss, osc, pitch, place, squall, timbre, weather } from "../score-voices";
import { INFER_VIBES } from "./vibes";
import { INFER_SOUND_KEY } from "../sound-key";

const A = 110; // A2
const PENT = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3];
const MINOR = [1, 6 / 5, 4 / 3, 3 / 2, 9 / 5];
const DORIAN = [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 5 / 3];
const LYDIAN = [1, 9 / 8, 5 / 4, 45 / 32, 3 / 2, 15 / 8];
const MIXO = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 16 / 9];

/** Each loop's home: the scale position its draws centre on. */
const HOME = [3, 5, 7, 6, 9, 11];
const SQUALL = HOME.length; // the loop after the voices is the squall
const CHORD_EVERY = 31; // seconds per chord
const PROGRESSION = [0, 3, 1, 4];
const LOOPS = [
  { every: 11.3, at: 0 },
  { every: 16.9, at: 4.2 },
  { every: 21.1, at: 9.9 },
  { every: 27.7, at: 1.7 },
  { every: 35.3, at: 15.4 },
  { every: 46.1, at: 26.8 },
  { every: 57.9, at: 33.1 }, // the squall
];

/** The temperature at a wall-clock second: 0.3 (settled) to 1.5 (wandering), over about 3.5 minutes. */
export const temperature = (wall: number) => 0.3 + 1.2 * (0.5 - 0.5 * Math.cos((2 * Math.PI * wall) / 211));

const chordAt = (wall: number) => PROGRESSION[Math.floor(wall / CHORD_EVERY) % PROGRESSION.length];

/** The distribution over two octaves of scale positions: softmax(logits / t). */
function distribution(kit: Kit, i: number, wall: number, t: number, not = -1): number[] {
  const len = kit.voicing.scale.length;
  const chord = chordAt(wall);
  const logits: number[] = [];
  for (let d = 0; d <= 2 * len + 2; d++) {
    const step = (((d - chord) % len) + len) % len;
    const tone = step === 0 ? 1.8 : step === 2 || step === 4 ? 1.2 : 0;
    logits.push(d === not ? -Infinity : tone - 0.45 * Math.abs(d - HOME[i]));
  }
  const m = Math.max(...logits);
  const w = logits.map((l) => Math.exp((l - m) / t));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}

/** A draw from the distribution, sampled with r. */
function draw(kit: Kit, i: number, wall: number, r: () => number, t: number, not = -1): number {
  const p = distribution(kit, i, wall, t, not);
  let x = r();
  for (let d = 0; d < p.length; d++) if ((x -= p[d]) <= 0) return d;
  return HOME[i];
}

/** One turn of a loop: what was drawn, the temperature it was drawn at, and the tokens streamed after. */
type Sample = {
  when: number;
  wall: number;
  i: number;
  level: number;
  pan: number;
  t: number;
  /** The drawn scale position. */
  d: number;
  /** When hot: the further tokens, each its own draw, with its offset in seconds. */
  stream: { d: number; at: number }[];
  /** What this loop drew last time round (for a voice that looks back). */
  earlier: number;
  r: () => number;
  /** Another draw now, avoiding `not`, at the temperature times `scale`. */
  again: (not?: number, scale?: number) => number;
  f: (d: number, octave?: number) => number;
};

/** For a one-note voice: the drawn note, then each streamed token a little quieter. */
function each(c: Sample, note: (d: number, at: number, lv: number, k: number) => void) {
  note(c.d, c.when, c.level, 0);
  c.stream.forEach((s, k) => note(s.d, c.when + s.at, c.level * 0.75 ** (k + 1), k + 1));
}

/** Each scene's instrument. All take the same cue; the loudness of each is set by ear and by meter. */
const VOICES: Record<string, (kit: Kit, c: Sample) => void> = {
  // Network: a forward pass, signals running layer to layer. Each draw is computed: two quick hidden
  // layers (sampled hot, then cooler) crossing the stereo field, landing on the drawn note as the output.
  network: (kit, c) => {
    const { ac } = kit;
    let at = c.when;
    let prev = -1;
    for (const [scale, pan] of [
      [2, -0.6],
      [1, -0.1],
    ]) {
      prev = c.again(prev, scale);
      const o = osc(kit, "sine", c.f(prev, 1), at, at + 0.3);
      o.connect(env(ac, at, 0.003, 0, 0.14, c.level * 0.7)).connect(place(kit, pan, 0.3));
      at += 0.11;
    }
    each({ ...c, when: at }, (d, t, lv) => {
      const dest = place(kit, 0.45, 0.35);
      for (const [k, a] of [
        [1, 1],
        [2, 0.25],
      ]) {
        const o = osc(kit, "sine", c.f(d, 1) * k, t, t + 2.2);
        o.connect(env(ac, t, 0.005, 0.1, 1.6, lv * a)).connect(dest);
      }
    });
  },

  // Ledger: entries drawn as dotted leaders running out to a figure. A run of soft ticks (the dots),
  // then the figure: a small tuned bell on the drawn note. Hot tokens are further, shorter entries.
  ledger: (kit, c) => {
    const { ac } = kit;
    each(c, (d, at, lv, k) => {
      const dest = place(kit, c.pan + (k % 2 ? 0.3 : 0), 0.35);
      const dots = k ? 3 : 5 + Math.floor(c.r() * 5);
      for (let j = 0; j < dots; j++) click(kit, dest, at + j * 0.055, 3600, lv * 0.35, 0.006);
      const t = at + dots * 0.055;
      for (const [ratio, a, dec] of [
        [1, 1, 2.2],
        [2.76, 0.35, 0.9],
        [5.4, 0.12, 0.4],
      ]) {
        const o = osc(kit, "sine", c.f(d, 1) * ratio, t, t + dec + 0.2);
        o.connect(env(ac, t, 0.002, 0, dec, lv * a * 0.9)).connect(dest);
      }
    });
  },

  // Tape: punched paper tape read column by column, holes for ones. Eight columns of a seeded byte: a
  // sprocket tick on every column and, on each hole, a soft square bleep reading the next draw.
  tape: (kit, c) => {
    const { ac } = kit;
    const square = timbre(ac, "square", [0, 1, 0, 0.3, 0, 0.12, 0, 0.05]);
    const byte = Math.floor(c.r() * 256) | 0x11;
    const dest = place(kit, c.pan, 0.25);
    const cols = c.t > 1 ? 16 : 8; // hot: a longer stretch of tape
    let d = c.d;
    for (let col = 0; col < cols; col++) {
      const at = c.when + col * 0.1;
      click(kit, dest, at, 1800, c.level * 0.08, 0.008);
      if (!((byte >> col % 8) & 1)) continue;
      const o = osc(kit, square, c.f(d, 1), at, at + 0.2);
      o.connect(env(ac, at, 0.004, 0.03, 0.09, c.level * 0.6)).connect(dest);
      d = c.again(d);
    }
  },

  // Attention: each token reaching back to an earlier one with an arc. A soft electric piano plays the
  // draw (the query), a faint tone arcs back across to what this loop drew last time (the key), and the
  // key sounds again, quieter, from the other side.
  attention: (kit, c) => {
    const { ac } = kit;
    const ep = (d: number, at: number, lv: number, pan: number, index: number) => {
      const f = c.f(d, 1);
      const car = osc(kit, "sine", f, at, at + 2.6);
      const mod = osc(kit, "sine", f, at, at + 2.6);
      const mg = ac.createGain();
      mg.gain.setValueAtTime(f * index, at);
      mg.gain.setTargetAtTime(f * 0.2, at, 0.35);
      mod.connect(mg).connect(car.frequency);
      car.connect(env(ac, at, 0.004, 0, 2.2, lv)).connect(place(kit, pan, 0.35));
    };
    each(c, (d, at, lv, k) => ep(d, at, lv, c.pan, k ? 1 : 2.5));
    const t = c.when + 0.3;
    const arc = osc(kit, "sine", c.f(c.d, 2), t, t + 0.7);
    arc.frequency.exponentialRampToValueAtTime(c.f(c.earlier, 2), t + 0.4);
    arc.connect(env(ac, t, 0.05, 0.25, 0.3, c.level * 0.12)).connect(place(kit, 0, 0.5));
    ep(c.earlier, c.when + 0.7, c.level * 0.5, -c.pan, 1.2);
  },

  // Descent: runs of gradient descent stepping down a loss surface to its minimum. A kalimba walks down
  // the scale from above the draw to the chord's root (the minimum), its steps slowing as it nears; when
  // the temperature is high some steps kick back up, as noisy gradients do.
  descent: (kit, c) => {
    const { ac } = kit;
    const len = kit.voicing.scale.length;
    let min = c.d;
    while (min > 0 && (((min - chordAt(c.wall)) % len) + len) % len) min--;
    let d = c.d + 3 + Math.floor(c.r() * 3);
    let at = c.when;
    let gap = 0.11;
    const tine = (pos: number, t: number, lv: number, ring: number) => {
      const f = c.f(pos, 1);
      const dest = place(kit, c.pan + (pos - min) * 0.06, 0.3);
      osc(kit, "sine", f, t, t + ring + 0.2).connect(env(ac, t, 0.003, 0, ring, lv)).connect(dest);
      osc(kit, "sine", f * 5.4, t, t + 0.2).connect(env(ac, t, 0.002, 0, 0.12, lv * 0.4)).connect(dest);
    };
    for (let step = 0; step < 12 && d > min; step++) {
      tine(d, at, c.level * 0.55, 0.6);
      d += c.r() < c.t * 0.22 ? 1 : -1;
      at += gap;
      gap *= 1.18;
    }
    tine(min, at, c.level, 2.4);
  },

  // Diffusion: a picture generated out of noise, held, then dissolved. Noise narrows onto the drawn
  // pitch until it is a tone, the tone holds (shorter when hot), and it dissolves back into noise.
  diffusion: (kit, c) => {
    const { ac } = kit;
    const f = c.f(c.d, 1);
    const form = 1.6,
      hold = 1.4 - 0.6 * ((c.t - 0.3) / 1.2),
      melt = 1.5;
    const dest = place(kit, c.pan, 0.4);
    const end = c.when + form + hold + melt;
    const src = hiss(kit, c.when, end + 0.1);
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f;
    bp.Q.setValueAtTime(1.5, c.when);
    bp.Q.exponentialRampToValueAtTime(60, c.when + form);
    bp.Q.setValueAtTime(60, c.when + form + hold);
    bp.Q.exponentialRampToValueAtTime(1.5, end);
    const ng = ac.createGain();
    ng.gain.value = 0;
    ng.gain.setValueAtTime(0, c.when);
    ng.gain.linearRampToValueAtTime(c.level * 0.5, c.when + 0.4);
    ng.gain.linearRampToValueAtTime(c.level * 2.5, c.when + form);
    ng.gain.linearRampToValueAtTime(0, c.when + form + 0.4);
    ng.gain.setValueAtTime(0, c.when + form + hold);
    ng.gain.linearRampToValueAtTime(c.level * 2.5, c.when + form + hold + 0.3);
    ng.gain.linearRampToValueAtTime(0, end);
    src.connect(bp).connect(ng).connect(dest);
    const o = osc(kit, "sine", f, c.when, end);
    const g = ac.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, c.when + form * 0.6);
    g.gain.linearRampToValueAtTime(c.level * 0.9, c.when + form);
    g.gain.setValueAtTime(c.level * 0.9, c.when + form + hold);
    g.gain.linearRampToValueAtTime(0, c.when + form + hold + melt * 0.6);
    o.connect(g).connect(dest);
  },

  // Softmax: small next-token distributions, the most likely token inked solid. The three likeliest
  // notes sound together as a soft organ chord, each as loud as it is likely; the likeliest is held
  // longest. Cool, it is nearly one note; hot, the three even out.
  softmax: (kit, c) => {
    const { ac } = kit;
    const organ = timbre(ac, "organ", [0, 1, 0.3, 0.12, 0.05]);
    const p = distribution(kit, c.i, c.wall, c.t);
    const top = p
      .map((x, d) => [x, d])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3);
    const sum = top.reduce((a, [x]) => a + x, 0);
    top.forEach(([x, d], k) => {
      const hold = k ? 0.5 : 1.6;
      const dest = place(kit, c.pan + (k - 1) * 0.3, 0.35);
      const o = osc(kit, organ, c.f(d, 1), c.when, c.when + hold + 2);
      o.connect(env(ac, c.when, 0.04, hold, k ? 0.8 : 1.5, c.level * 1.1 * (x / sum))).connect(dest);
    });
    // The token actually sampled gets a small mark, whichever it was.
    click(kit, place(kit, c.pan, 0), c.when, c.f(c.d, 3), c.level * 0.3, 0.03);
  },

  // Sheet: rings of activation spreading across a dot grid. A vibraphone note, its motor's tremolo
  // turning, and two echoes of it spreading outward to either side, wider and fainter each time.
  sheet: (kit, c) => {
    const { ac } = kit;
    const vibe = (f: number, at: number, lv: number, pan: number, ring: number) => {
      const trem = ac.createGain();
      trem.gain.value = 0.75;
      const lfo = osc(kit, "sine", 5.5, at, at + ring + 0.3);
      const depth = ac.createGain();
      depth.gain.value = 0.25;
      lfo.connect(depth).connect(trem.gain);
      const dest = place(kit, pan, 0.4);
      osc(kit, "sine", f, at, at + ring + 0.3).connect(trem);
      trem.connect(env(ac, at, 0.003, 0, ring, lv)).connect(dest);
      osc(kit, "sine", f * 4, at, at + 0.6).connect(env(ac, at, 0.002, 0, 0.45, lv * 0.25)).connect(dest);
    };
    each(c, (d, at, lv) => {
      const f = c.f(d, 1);
      vibe(f, at, lv, c.pan, 2.8);
      vibe(f, at + 0.32, lv * 0.4, c.pan - 0.5, 1.2);
      vibe(f, at + 0.64, lv * 0.2, c.pan + 0.9, 1);
    });
  },
};

/** Each instrument's level against the others, measured so every scene plays at about the same loudness. */
const TRIM: Record<string, number> = {
  network: 1.7,
  ledger: 1.3,
  tape: 1.5,
  attention: 1,
  descent: 1,
  diffusion: 0.48,
  softmax: 0.6,
  sheet: 1.1,
};

export const INFER_SCORE: Score = {
  key: INFER_SOUND_KEY,
  vibe: INFER_VIBES,
  voicings: {
    network: { root: A, scale: PENT, weather: "wind" },
    ledger: { root: A * (9 / 8), scale: DORIAN, weather: "wind" },
    tape: { root: A, scale: MIXO, weather: "rain" },
    attention: { root: A * (4 / 3), scale: PENT, weather: "wind" },
    descent: { root: A * (5 / 6), scale: MINOR, weather: "rain" },
    diffusion: { root: A * (3 / 4), scale: LYDIAN, weather: "waves" },
    softmax: { root: A, scale: DORIAN, weather: "wind" },
    sheet: { root: A * (9 / 8), scale: PENT, weather: "waves" },
  },
  loops: LOOPS,
  bed: (kit) => weather(kit, { body: kit.night ? 450 : 650, level: 0.075 }),
  play: (kit, i, n, when, wall) => {
    if (i === SQUALL) {
      squall(kit, when, n, { band: kit.night ? 500 : 700, level: 0.09 });
      return;
    }
    const r = seeded(29, i, n);
    if (r() < 0.1) return;
    const t = temperature(wall);
    const level = (0.08 + 0.03 * r()) * (kit.night ? 0.85 : 1) * (TRIM[kit.scene] ?? 1);
    const d = draw(kit, i, wall, r, t);
    // Hot: stream a few more tokens, each its own draw.
    const stream: Sample["stream"] = [];
    if (r() < 0.06 + 0.3 * ((t - 0.3) / 1.2)) {
      const more = 2 + Math.floor(3 * r());
      let at = 0,
        prev = d;
      for (let k = 1; k <= more; k++) {
        at += 0.13 + 0.09 * r();
        prev = draw(kit, i, wall + k, r, t, prev);
        stream.push({ d: prev, at });
      }
    }
    // What this loop drew last time round: the same draw, replayed from its own seed.
    const before = wall - LOOPS[i].every * (kit.night ? 1.3 : 1);
    const replay = seeded(29, i, n - 1);
    replay(); // its rest check
    replay(); // its level
    const earlier = draw(kit, i, before, replay, temperature(before));
    const c: Sample = {
      when,
      wall,
      i,
      level,
      pan: (i / (HOME.length - 1)) * 1.2 - 0.6,
      t,
      d,
      stream,
      earlier,
      r,
      again: (not = -1, scale = 1) => draw(kit, i, wall, r, t * scale, not),
      f: (pos, octave = 1) => pitch(kit, pos, octave),
    };
    (VOICES[kit.scene] ?? VOICES.network)(kit, c);
  },
};
