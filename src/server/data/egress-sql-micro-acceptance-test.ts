// Micro-tests 1 and 2 of docs/design/dashboard-capper-detail-egress.md §8, run BEFORE
// anything else trusts the shared SQL blocks (page-aggregate-fragments.ts):
//   (1) float8 -> jsonb -> JSON.parse is the identity over 10^6 random doubles, including
//       subnormals and 1e+-300 - i.e. the database emits the SHORTEST round-trip form
//       (Postgres >= 12), so a number that travels through a jsonb bundle arrives as the
//       very double that was summed. The Postgres version is printed: the doc asks for the
//       Supabase-equivalent major, and this only proves the server it ran against.
//   (2) round2HalfUpSql equals JS `Math.round(x * 100) / 100` over 10^6 random doubles and
//       every exact-.5 tie (Postgres round(float8) is half-to-even and round(numeric) is
//       half-away-from-zero, both wrong for Math.round's ties-toward-+Infinity).
// Read-only (it writes nothing, so it needs no localhost guard); DB-backed like the rest.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { round2HalfUpSql } from "@/server/data/page-aggregate-fragments";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buf = new DataView(new ArrayBuffer(8));
// A uniformly random FINITE double: random bit patterns cover every exponent, subnormals
// included, far better than random()*scale does.
function randomDouble(r: () => number): number {
  for (;;) {
    buf.setUint32(0, Math.floor(r() * 4294967296));
    buf.setUint32(4, Math.floor(r() * 4294967296));
    const x = buf.getFloat64(0);
    if (Number.isFinite(x)) return x;
  }
}

function nextUp(x: number, dir = 1): number {
  // Adjacent double by bit arithmetic (x != 0).
  buf.setFloat64(0, x);
  let bits = buf.getBigUint64(0);
  bits += (x > 0) === (dir > 0) ? 1n : -1n;
  buf.setBigUint64(0, bits);
  return buf.getFloat64(0);
}
const nextDown = (x: number) => nextUp(x, -1);

function edgeDoubles(): number[] {
  const out = [0, -0, 1, -1, 0.1, 0.2, 0.3, 1 / 3, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Number.EPSILON, 5e-324, 2.2250738585072014e-308, 2.225073858507201e-308, 1e300, -1e300, 1e-300, -1e-300, 1e21, 1e22, 123456789012345680000, 4.35, 0.615, 1.005, 8.345];
  for (let e = -320; e <= 308; e += 7) out.push(Number(`1e${e}`), Number(`-9.87654321e${e}`));
  return out;
}

const BATCH = 50_000;
const N = 1_000_000;

async function roundTripBatch(xs: number[]): Promise<{ bad: number; first: string }> {
  // The doubles are sent as TEXT (JS's shortest round-trip form, which Postgres parses
  // exactly): Prisma encodes a JS number[] parameter through a lossy decimal path (1.7976931348623157e308
  // arrives rounded to 16 digits and overflows), so a number[] bind is not a trustworthy ground truth.
  // The result then comes back through $queryRaw's jsonb handling - the path a page bundle uses.
  const rows = await prisma.$queryRaw<{ out: unknown }[]>(
    Prisma.sql`SELECT jsonb_agg(v::float8 ORDER BY o) AS out FROM unnest(${xs.map(String)}::text[]) WITH ORDINALITY AS t(v, o)`
  );
  const back = rows[0].out as number[];
  let bad = 0;
  let first = "";
  if (back.length !== xs.length) return { bad: xs.length, first: `length ${back.length} vs ${xs.length}` };
  for (let i = 0; i < xs.length; i++) {
    // Object.is would distinguish -0; jsonb has no -0 (numeric), and every consumer treats them equal.
    if (back[i] !== xs[i]) {
      bad++;
      if (!first) first = `${xs[i]} -> ${back[i]}`;
    }
  }
  return { bad, first };
}

async function roundBatch(xs: number[]): Promise<{ bad: number; first: string }> {
  const rows = await prisma.$queryRaw<{ r: number }[]>(
    Prisma.sql`SELECT ${round2HalfUpSql(Prisma.sql`v`)} AS r FROM (SELECT v::float8 AS v, o FROM unnest(${xs.map(String)}::text[]) WITH ORDINALITY AS u(v, o)) t ORDER BY o`
  );
  let bad = 0;
  let first = "";
  for (let i = 0; i < xs.length; i++) {
    const js = Math.round(xs[i] * 100) / 100;
    const sql = rows[i].r;
    // Overflow: x*100 = Infinity in both. NaN cannot arise from finite input.
    if (!(js === sql || (Number.isNaN(js) && Number.isNaN(sql)))) {
      bad++;
      if (!first) first = `x=${xs[i]} JS=${js} SQL=${sql}`;
    }
  }
  return { bad, first };
}

async function main() {
  const [{ v }] = await prisma.$queryRaw<{ v: string }[]>`SELECT current_setting('server_version') AS v`;
  const major = parseInt(v, 10);
  console.log(`server_version: ${v}`);
  check("Postgres >= 12 (shortest round-trip float8 output)", major >= 12, v);
  const [{ n }] = await prisma.$queryRaw<{ n: string }[]>`SELECT (0.1::float8)::numeric::text AS n`;
  check("float8 0.1 renders as 0.1, not 0.1000000000000000055...", n === "0.1", n);

  // (1) float8 -> jsonb -> JSON.parse
  const r1 = rng(20260928);
  const values: number[] = edgeDoubles();
  while (values.length < N) values.push(randomDouble(r1));
  // Plus ordinary-magnitude doubles, the ones money sums actually produce.
  for (let i = 0; i < 200_000; i++) values.push((r1() - 0.5) * 10 ** Math.floor(r1() * 8));
  let bad1 = 0;
  let first1 = "";
  for (let i = 0; i < values.length; i += BATCH) {
    const b = await roundTripBatch(values.slice(i, i + BATCH));
    bad1 += b.bad;
    if (!first1) first1 = b.first;
  }
  check(`float8 -> jsonb -> JSON.parse identity over ${values.length} doubles (random bit patterns, subnormals, +-1e300, edge values)`, bad1 === 0, `${bad1} differ, first: ${first1}`);

  // (2) SQL round-half-up == Math.round(x * 100) / 100
  const r2 = rng(7);
  const xs: number[] = [];
  // Exact ties: y = k + 0.5 for k spanning sign, small and large magnitudes, then x = y / 100.
  const ties: number[] = [];
  for (let k = -5000; k <= 5000; k++) ties.push((k + 0.5) / 100);
  for (let e = 3; e <= 15; e++) for (let k = -50; k <= 50; k++) ties.push((k * 10 ** e + 0.5) / 100);
  // Values one ULP either side of a tie, and the classic float traps.
  const neighbours: number[] = [];
  for (const t of ties.slice(0, 4000)) {
    neighbours.push(t, nextUp(t), nextDown(t));
  }
  xs.push(...ties, ...neighbours, 0.005, 0.015, 0.025, -0.005, -0.015, -0.025, 1.005, 2.675, 1.255, 0.285, 1.345, -1.345, 0.49999999999999994, 4.35, 8.345, 0, -0.001, -0.004, 0.004);
  // Running sums of the shape the app produces: hundredths and thirds accumulate representation error.
  let acc = 0;
  for (let i = 0; i < 100_000; i++) {
    acc += (Math.floor(r2() * 400) - 200) / 100 + (r2() < 0.3 ? (r2() * 100) / 100 * (100 / 110) : 0);
    xs.push(acc);
  }
  while (xs.length < N) xs.push(randomDouble(r2) % 1e6 || (r2() - 0.5) * 1e4);
  while (xs.length < N + 200_000) xs.push((r2() - 0.5) * 2000);
  let bad2 = 0;
  let first2 = "";
  for (let i = 0; i < xs.length; i += BATCH) {
    const b = await roundBatch(xs.slice(i, i + BATCH));
    bad2 += b.bad;
    if (!first2) first2 = b.first;
  }
  check(`round2HalfUpSql == Math.round(x*100)/100 over ${xs.length} doubles incl. ${ties.length} exact-.5 ties`, bad2 === 0, `${bad2} differ, first: ${first2}`);
  // Guard the premise: the built-ins the doc rules out genuinely disagree at ties, so the test can fail.
  const [{ he, ha }] = await prisma.$queryRaw<{ he: number; ha: string }[]>`SELECT round(2.5::float8) AS he, round(2.5::numeric)::text AS ha`;
  check("premise: round(float8) is half-to-even (2.5 -> 2) and round(numeric) half-away (2.5 -> 3); JS Math.round(2.5) = 3", he === 2 && ha === "3" && Math.round(2.5) === 3);

  console.log(`\n${failures} failed.`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures > 0 ? 1 : 0);
  });
