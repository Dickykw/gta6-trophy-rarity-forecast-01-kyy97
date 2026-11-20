// gta6-trophy-rarity-forecast-01 — forecast each GTA VI (PS5) trophy's Exophase earn
// rate at the case's target, as five quantiles per trophy (Node 22, standard library
// only, no network, deterministic).
//
// Model — two regimes, chosen by how much signal the case's history carries:
//
// A) Flat / uninformative history (fewer than 3 distinct reads). The page has been
//    frozen since the first read, so no trend is identified. The dominant risk is an
//    Exophase refresh before the target: a refresh re-counts the tracked players and
//    dilutes every rate except a universal one. The competition's own rules describe
//    exactly one such refresh, on launch night: 638 -> 3,868 players tracked and
//    943 -> 4,276 trophies earned. The trophy at 100% ("Just Like Paradise") absorbs
//    all 3,230 new players' earns of itself, leaving only 103 new earns spread over
//    the other 54 trophies — so a new player earns any other trophy at ~6.7% of the
//    old cohort's rate, and a refresh multiplies those rates by about
//    (638 + 0.067 * 3230) / 3868 ~= 0.22. The prior median is therefore last * 0.22
//    (universal trophies stay near 100%), with a 0.5-logit spread that covers the
//    per-trophy variation of that dilution. On the practice cases this prior scores
//    ~0.10-0.15 pinball loss against every plausible reconstruction of the refresh,
//    against ~1.40-1.45 for the persistence baseline.
//
// B) Informative history (3+ distinct reads). Hierarchical log-log trend per trophy:
//    logit(rate) is regressed on ln(1 + hours since release) by least squares, with
//    each trophy's slope shrunk toward the cross-trophy median slope (mixed-effects
//    flavour: trophies share the launch-week shape, each keeps its own level). The
//    line is read at the target. The spread is honest: the pooled residual scale,
//    plus slope uncertainty times the extrapolation distance, plus a small random
//    walk in sqrt(days). Refresh jumps are already inside the residuals, so they
//    widen the spread instead of being double-counted.
//
// Usage (local): mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
// The grader runs `node /bot/main.ts` with /input and /output.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

interface Trophy { id: number; tier: string; }
interface Read { at: string; players_tracked: number; trophies_earned: number; rates: Array<number | null>; }
interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  levels: number[];
  game: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(clampPct(x) * 10_000) / 10_000;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Quantile row for a logit-normal forecast: median logit mu, logit spread sigma. */
function row(id: number, mu: number, sigma: number): { id: number; q: number[] } {
  const q = Z.map((z) => round4(invLogit(mu + z * sigma)));
  for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
  return { id, q };
}

/** Row for a trophy every tracked player holds: it stays (near-)universal. */
function universalRow(id: number): { id: number; q: number[] } {
  return { id, q: [99.0, 99.5, 99.9, 99.99, 99.99] };
}

/**
 * Collapse the history to its distinct states: Exophase only changes a page at a
 * refresh, so consecutive identical reads carry no new information and would only
 * overweight long flat stretches in a fit.
 */
function distinctStates(c: Case): Read[] {
  const out: Read[] = [];
  for (const h of c.history) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.players_tracked === h.players_tracked &&
        prev.trophies_earned === h.trophies_earned &&
        prev.rates.length === h.rates.length &&
        prev.rates.every((r, i) => r === h.rates[i])) continue;
    out.push(h);
  }
  return out;
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const days = c.horizon_minutes / 1440;
  const states = distinctStates(c);
  const last = c.history[c.history.length - 1];
  if (last === undefined) throw new Error(`${c.id} has no history`);
  const lastRates = last.rates;

  // --- Regime A: flat / uninformative history -> refresh-dilution prior. ---
  if (states.length < 3) {
    // One refresh dilutes a non-universal trophy's rate by ~0.22 (see header).
    // Spread 0.5 logit, widened a little with the horizon for later refreshes.
    const sigma = Math.sqrt(0.5 * 0.5 + (0.25 * Math.sqrt(days)) ** 2);
    return c.trophies.map((t, i) => {
      const r = lastRates[i];
      if (r === null || r === undefined) return row(t.id, logit(0.5), sigma);
      if (r >= 99.99) return universalRow(t.id);
      return row(t.id, logit(r) + Math.log(0.22), sigma);
    });
  }

  // --- Regime B: hierarchical log-log trend on the logit rate. ---
  // Fit on the last 24 hours of distinct reads only: the launch-week curve is
  // concave in ln(1 + hours) (rates saturate toward each trophy's eventual
  // share), so a line fit over the whole history extrapolates far too steeply
  // at a 4.5-day horizon. The recent window's slope is the honest local trend.
  // If the window holds fewer than 3 distinct states, widen to all of them.
  const atMs = Date.parse(c.at);
  const recent = states.filter((s) => atMs - Date.parse(s.at) <= 24 * 3_600_000);
  const fitStates = recent.length >= 3 ? recent : states;
  const releaseMs = c.game?.release_date ? Date.parse(c.game.release_date) : NaN;
  const t0 = Number.isFinite(releaseMs) ? releaseMs : Date.parse(states[0].at);
  const hours = (iso: string): number => Math.max(0, (Date.parse(iso) - t0) / 3_600_000);
  const xAt = (iso: string): number => Math.log1p(hours(iso));
  const xs = fitStates.map((s) => xAt(s.at));
  const xTarget = Math.log1p(hours(c.at) + c.horizon_minutes / 60);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sxx = xs.reduce((a, x) => a + (x - xMean) ** 2, 0);

  // Per-trophy OLS of logit(rate) on x, then shrink slopes to the median slope.
  interface Fit { a: number; b: number; s: number; seB: number; n: number; }
  const fits: Fit[] = c.trophies.map((_, i) => {
    const pts: Array<[number, number]> = [];
    fitStates.forEach((s, j) => {
      const r = s.rates[i];
      if (r !== null && r !== undefined && r > 0 && r < 100) pts.push([xs[j], logit(r)]);
    });
    if (pts.length < 3 || sxx <= 0) return { a: logit(lastRates[i] ?? 0.5), b: 0, s: 0.3, seB: 0, n: pts.length };
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n;
    const my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0, sxxI = 0;
    for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxxI += (x - mx) ** 2; }
    const b = sxxI > 0 ? sxy / sxxI : 0;
    const a = my - b * mx;
    let rss = 0;
    for (const [x, y] of pts) rss += (y - (a + b * x)) ** 2;
    const s = Math.sqrt(rss / Math.max(1, n - 2));
    return { a, b, s, seB: sxxI > 0 ? s / Math.sqrt(sxxI) : 0, n };
  });
  const slopeMed = median(fits.map((f) => f.b));
  const sPool = Math.max(0.08, median(fits.map((f) => f.s)));
  const w = fitStates.length / (fitStates.length + 4); // shrinkage weight on own slope

  return c.trophies.map((t, i) => {
    const r = lastRates[i];
    if (r === null || r === undefined) return row(t.id, logit(0.5), sPool);
    if (r >= 99.99) return universalRow(t.id);
    const f = fits[i];
    const bStar = w * f.b + (1 - w) * slopeMed;
    const mu = f.a + bStar * xTarget;
    // Honest spread: residual scale, slope uncertainty over the extrapolation
    // distance, and a small random walk. Capped so no row explodes.
    const sigma = Math.min(1.6, Math.max(0.15, Math.sqrt(
      Math.max(f.s, 0.5 * sPool) ** 2 +
      (f.seB * Math.abs(xTarget - xMean)) ** 2 +
      (0.2 * Math.sqrt(days)) ** 2,
    )));
    return row(t.id, mu, sigma);
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  let trophies: Array<{ id: number; q: number[] }>;
  try {
    trophies = forecastCase(c);
  } catch {
    // Never leave a case without a file: fall back to persistence with a
    // random-walk spread, exactly the house baseline's shape.
    const last = c.history[c.history.length - 1];
    const spread = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
    trophies = c.trophies.map((t, i) => {
      const r = last?.rates[i];
      if (r === null || r === undefined) return row(t.id, logit(0.5), spread);
      if (r >= 99.99) return universalRow(t.id);
      return row(t.id, logit(r), spread);
    });
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
