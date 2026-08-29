/**
 * scripts/demo-full.ts — the demo sequence, run through the real route bodies.
 *
 *   npm run demo:full
 *
 * Not a UI and not a mock: the same functions server/index.ts and the Vercel
 * serverless function call, in the demo order, with each step's output printed.
 * It doubles as a smoke test (a broken deploy fails here first) and as a repo
 * artifact — a judge can clone the repo, run this, and watch the same thing.
 *
 * Steps 1–4 are offline (size/). Steps 5–8 hit the live UCP endpoints of
 * kith.com and stompingground.myshopify.com, so those need a network and can
 * fail if a store's endpoint is down — which is the point of a smoke test.
 *
 * The browser footage is filmed separately; this is the running order, not the
 * thing on screen. A terminal can't show the panel updating under the agent's
 * hand, which is the judged mechanic.
 */

import { routeEstimate, routeRecommend, routeSearch, routeCheckFit } from "../server/routes.js";

const KITH = "kith.com";
const SG = "stompingground.myshopify.com";
const GENDER = "men" as const;

type Stmt = { brand: string; gender: "men"; system: "us"; value: number };
const stmt = (brand: string, value: number): Stmt => ({ brand, gender: GENDER, system: "us", value });

function head(n: number, title: string): void {
  console.log(`\n${n}. ${title}\n${"─".repeat(64)}`);
}
const line = (s: string) => console.log(`   ${s}`);
const row = (i: number, p: { title: string; brand: string; fit?: { verdict: string; recommendedLabel: string | null } }) =>
  line(
    `${String(i).padStart(2)}. ${p.title.slice(0, 44).padEnd(44)}  ${(p.brand || "?").padEnd(12)}  ` +
      `${(p.fit?.verdict ?? "-").padEnd(14)} ${p.fit?.recommendedLabel ?? ""}`,
  );

async function main(): Promise<void> {
  let ok = true;
  const fail = (e: unknown) => {
    ok = false;
    line(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  };

  const statements: Stmt[] = [];
  let footMm = 0;

  // 1 — profile from one known-good fit ------------------------------------
  head(1, 'profile: men, "Nike 9 fits"');
  statements.push(stmt("Nike", 9));
  {
    const est = await routeEstimate({ statements });
    footMm = est.bestMm ?? est.low ?? 0;
    line(`estimate: ${est.status}   ${est.low}–${est.high} mm   best ${est.bestMm} mm`);
  }

  // 2 — a different brand's answer to the same foot ----------------------
  head(2, "recommend Birkenstock");
  try {
    const rec = await routeRecommend({ brand: "Birkenstock", gender: GENDER, footLengthMm: footMm });
    line(`${rec.label ?? `US ${rec.us}`}`);
    line(`US ${rec.us} / UK ${rec.uk} / EU ${rec.eu}   [${rec.status}]`);
  } catch (e) {
    fail(e);
  }

  // 3 — a second fit that disagrees ------------------------------------
  head(3, 'add "Converse 9.5 fits"');
  statements.push(stmt("Converse", 9.5));
  {
    const est = await routeEstimate({ statements });
    line(`estimate: ${est.status}   ${est.low}–${est.high} mm   spread ${est.spreadMm} mm`);
    if (est.conflictNote) line(`note: ${est.conflictNote}`);
  }

  // 4 — resolve the disagreement -------------------------------------
  head(4, 'remove it, add "Converse 9 fits"');
  statements.pop();
  statements.push(stmt("Converse", 9));
  {
    const est = await routeEstimate({ statements });
    footMm = est.bestMm ?? footMm;
    line(`estimate: ${est.status}   ${est.low}–${est.high} mm   best ${est.bestMm} mm`);
  }

  // 5 — live catalog, store one -------------------------------------
  head(5, `search ${KITH} "sneakers"`);
  let kith: Awaited<ReturnType<typeof routeSearch>> | undefined;
  try {
    kith = await routeSearch({ domain: KITH, query: "sneakers", footLengthMm: footMm, gender: GENDER });
    line(`option name: ${kith.products[0]?.sizeOptionName ?? "?"}`);
    line(`scanned ${kith.scanned}, matched ${kith.matched}`);
    kith.products.slice(0, 5).forEach((p, i) => row(i + 1, p));
  } catch (e) {
    fail(e);
  }

  // 6 — an authoritative per-product check ------------------------
  head(6, "check_fit on result 2");
  try {
    const target = kith?.products[1];
    if (!target) throw new Error("no result 2 from the search");
    const v = await routeCheckFit({ domain: KITH, productId: target.id, footLengthMm: footMm, gender: GENDER });
    line(`${v.title.slice(0, 52)}  ·  ${v.brand}`);
    line(`${v.recommendedLabel ?? "—"}  ·  ${v.verdict}`);
    line(v.sentence);
  } catch (e) {
    fail(e);
  }

  // 7 — a second, unrelated store --------------------------------
  head(7, `search ${SG} "sneakers"`);
  let sg: Awaited<ReturnType<typeof routeSearch>> | undefined;
  try {
    sg = await routeSearch({ domain: SG, query: "sneakers", footLengthMm: footMm, gender: GENDER });
    line(`option name: ${sg.products[0]?.sizeOptionName ?? "?"}   (Kith calls it "Size")`);
    line(`scanned ${sg.scanned}, matched ${sg.matched}`);
    sg.products.slice(0, 6).forEach((p, i) => row(i + 1, p));
  } catch (e) {
    fail(e);
  }

  // 8 — an honest "I don't know this brand" --------------------
  head(8, "check_fit on a Veja (unmapped_brand)");
  try {
    const veja =
      sg?.products.find((p) => p.fit?.verdict === "unmapped_brand") ??
      sg?.products.find((p) => p.brand === "veja");
    if (!veja) throw new Error("no unmapped-brand product in the results");
    const v = await routeCheckFit({ domain: SG, productId: veja.id, footLengthMm: footMm, gender: GENDER });
    line(`${v.title.slice(0, 52)}  ·  ${v.brand || "?"}`);
    line(`${v.verdict}`);
    line(v.sentence);
  } catch (e) {
    fail(e);
  }

  console.log(`\n${"─".repeat(64)}`);
  console.log(ok ? "demo:full — every step ran" : "demo:full — one or more steps FAILED (above)");
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
