# size/ — label ↔ foot length

A brand's printed size is not a measurement. This layer turns a size label into a
**foot length in millimetres** (what actually fits a foot) and back, then decides
whether a given product fits.

```
sizely-shoe-sample.csv   reference rows from SizeAI — real measurements, not a curve
resolver.ts              SizeTable: resolve() / recommend() / estimateFootLength() / parseSizeLabel()
fit.ts                   checkFit(): a Size run + a profile -> a per-product verdict
resolver.test.ts / fit.test.ts   npm test — node:test via tsx
demo.ts                  npm run demo — the "labels lie, length is truth" pitch, end to end
```

## Source-agnostic

`checkFit(input, table)` takes `runLabels: string[]` (the Size option's values)
plus the profile — it does not know or care where the labels came from. UCP is
**one adapter**: `server/routes.ts` negotiates a store, reads the catalog, hands
`checkFit` the labels. An agent already on a product page that can read the
`<select>` itself is another — that path skips UCP entirely (`check_labels` /
`/api/check-labels`). Same resolver, same verdict; only the label source differs.

**Data source:** `sizely-shoe-sample.csv` is a sample dataset from **SizeAI**
(sizeai.co), provided by Eddy (founder) for this submission on 2026-08-28. Real
measured rows. Shared with credit — credit SizeAI if this data is reused.

## The point, on one screen

A men's **US 9** is a different foot length in every brand:

| Brand | Foot length |
|---|---|
| Nike | 263 mm |
| Converse | 265 mm |
| ASICS | 268 mm |
| Adidas / New Balance / Birkenstock | 270 mm |

Same label, **7 mm** of real spread. Resolve on length, not on the label.

## Resolver contract

`table.resolve({ brand, gender, system, value })` → one of:

| `status` | When | `footLengthMm` | `confidence` |
|---|---|---|---|
| `exact` | the size is a real row | measured | `high` |
| `interpolated` | a gap **inside** a brand we map (e.g. Nike men's US 11) | linear between the two bracketing rows; `between: [10, 11.5]` | `high` |
| `extrapolated` | **outside** a mapped brand's range | nearest-two projection | `low` |
| `unknown` | brand has **no rows at all**, or none for that gender | — | `low` |

`unknown` is reserved for "no mapping." A size we don't have a row for but the
brand *is* mapped comes back interpolated/extrapolated with a `between` bracket —
never `unknown`.

### `recommend` — foot length → size to buy

`table.recommend({ brand, gender, footLengthMm })` returns the size to buy
(`us`/`uk`/`eu`, plus `sizeLengthMm` and `headroomMm`). It rounds **up**: the
smallest size whose row length is `>=` the foot. A shoe slightly longer than the
foot is wearable; one shorter than the foot is not — so it never returns a size
shorter than the foot while a longer one exists. `status` is `exact` (a row
equals the foot), `rounded_up`, `beyond_range` (foot longer than every mapped
size — `confidence: "low"`), or `unknown`.

### `estimateFootLength` — fit reports → one foot length

`estimateFootLength(table, fits[])` resolves each "this fits me" statement to a
length and combines them:

- lengths within ~one half-size (`agreementMm`, default 4) → `status: "ok"`,
  with `low`/`high`/`spreadMm` and a `bestMm` midpoint.
- wider than that → `status: "conflict"`: **no `bestMm`**, plus
  `longerStatement` / `shorterStatement` so the UI can ask *which fits better*.
  A conflict is real signal, not noise to average away.
- nothing resolvable → `status: "unresolved"`.

## Brand rules (from SizeAI, 2026-08-28)

- **Jordan → Nike.** Aliased; Jordan follows Nike sizing and Kith carries a lot
  of Jordans. Add more aliases in `BRAND_ALIASES`.
- **Birkenstock resolves via EU**, its native system. A US/UK lookup still
  returns a length but is flagged `confidence: "low"` with a warning — even
  Birkenstock's own US labels are internally inconsistent. Prefer the product's
  EU label when it exposes one.
- **New Balance and Converse are men's-only** in this slice. Women's rows for
  those two didn't clear SizeAI's quality bar, so a women's lookup is `unknown`
  with a gender-specific reason, not fabricated numbers.
- **Width grades** (New Balance, Nike, ASICS) are a separate girth dimension —
  surfaced via `offersWidthGrades`, never a change in length.

## Known-shaky bits

- `parseSizeLabel` is heuristic: explicit `US`/`UK`/`EU` tokens win; a bare
  number ≥ 33 is read as EU, below 33 as US (ambiguous with UK — flagged
  `ambiguous: true`). It handles the `42 2/3` fraction form.
- Interpolation is linear in the size number. Fine across one size step, rougher
  across a wide gap — check `between` before trusting a wide bracket.
- This is a 6-brand sample. `resolve()` on anything else is `unknown` by design.
