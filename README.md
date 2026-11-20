[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![GTA VI trophy forecast](https://img.shields.io/badge/GTA%20VI-trophy%20forecast-green)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)

# gta6-trophy-rarity-forecast-01

Forecast each Grand Theft Auto VI (PS5) trophy's earn rate on Exophase at
2026-11-26T00:00:00Z, as five quantiles per trophy, from the house's recording
of the trophy page up to the case checkpoint. Entry for the
[make.fun bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`node /bot/main.ts` (Node 22, standard library only, no network). Reads every
`<id>.in` in the input directory (`$MAKEFUN_INPUT_DIR`, else `/input`) and
writes `<id>.out` to the output directory (`$MAKEFUN_OUTPUT_DIR`, else
`/output`): `{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}, ...]}`,
one row per trophy, quantiles non-decreasing in percent. Deterministic: two
runs write byte-identical files. Runs in ~0.2 s per case, far under the 8 s cap.

## Model

Two regimes, chosen by how much signal the case's history carries (see the
header comment in `main.ts` for the full reasoning):

1. **Flat / uninformative history** (fewer than 3 distinct reads): the page
   has been frozen since the first read, so no trend is identified. The
   dominant risk is an Exophase refresh before the target, which re-counts
   tracked players and dilutes every rate except a universal one. The
   competition's own rules describe one such refresh on launch night
   (638 → 3,868 players, 943 → 4,276 trophies earned); the 100% trophy
   absorbs all 3,230 new players' earns of itself, leaving 103 new earns
   for the other 54 trophies, so a refresh multiplies those rates by about
   0.22. Prior median: last rate × 0.22, 0.5-logit spread.
2. **Informative history** (3+ distinct reads): hierarchical log-log trend —
   least-squares fit of `logit(rate)` on `ln(1 + hours since release)` over
   the last 24 hours of distinct reads (the launch-week curve is concave, so
   the recent window's slope is the honest local trend), each trophy's slope
   shrunk toward the cross-trophy median slope, read at the target. Spread
   is honest: pooled residual scale + slope uncertainty over the
   extrapolation distance + a small random walk in `sqrt(days)`.

Practice check (against reconstructions of the 04:30 UTC refresh built from
the rules' own aggregates — the true practice answers are not in the kit):
**pinball loss ≈ 0.12–0.15, vs ≈ 1.40 for the persistence baseline**,
across four different reconstructions of the refresh. On a synthetic
final-like history (2 days of reads, refreshes every ~4 h, target +4.5 days)
the model scores 0.17 vs 0.40 for persistence and 0.26 for the curve
baseline.

## Files

- `main.ts` — the whole forecaster (single file, no dependencies)
- `LICENSE` — MIT (`SPDX-License-Identifier: MIT`)
- `.makefun/owner.json` — payout wallet
