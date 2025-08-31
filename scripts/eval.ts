// scripts/eval.ts
import fs from "node:fs/promises";
import path from "node:path";

type TestCase = { q: string; must?: string[]; minCitations?: number };
type AgentMeta = { ms?: number; costUSD?: number; tokens?: { prompt: number; completion: number; total: number } };
type AgentResult = { summary?: string; plan?: string | string[]; assumptions?: string[]; nextSteps?: string; citations?: number[]; sourceMap?: any[]; raw?: string; error?: string };

const BASE = process.env.BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const FILE = process.env.EVAL_FILE || "evals/questions.json";

function flatten(r: AgentResult | null | undefined) {
  if (!r) return "";
  const parts: string[] = [];
  if (r.summary) parts.push(r.summary);
  if (r.plan) parts.push(typeof r.plan === "string" ? r.plan : r.plan.join("\n"));
  if (r.assumptions?.length) parts.push(r.assumptions.join("\n"));
  if (r.nextSteps) parts.push(r.nextSteps);
  if (r.raw) parts.push(r.raw);
  return parts.join("\n").toLowerCase();
}

async function loadTests(): Promise<TestCase[]> {
  try {
    const p = path.join(process.cwd(), FILE);
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return [
      { q: "Give me a 2-day Kyoto plan with an early Fushimi Inari visit and a budget focus.", must: ["Fushimi", "budget"], minCitations: 1 }
    ];
  }
}

async function ask(q: string): Promise<{ result: AgentResult; meta?: AgentMeta }> {
  const res = await fetch(`${BASE}/api/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: q }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function run() {
  const tests = await loadTests();
  let pass = 0, totalMs = 0, totalPrompt = 0, totalCompletion = 0, totalCost = 0;

  console.log(`Running ${tests.length} tests against ${BASE}...\n`);

  for (const [i, t] of tests.entries()) {
    const start = Date.now();
    let ok = true;
    let reasons: string[] = [];
    let meta: AgentMeta | undefined;
    let resJson: { result: AgentResult; meta?: AgentMeta } | null = null;

    try {
      resJson = await ask(t.q);
      meta = resJson.meta;
      const text = flatten(resJson.result);
      for (const m of (t.must ?? [])) {
        if (!text.includes(m.toLowerCase())) {
          ok = false;
          reasons.push(`missing term "${m}"`);
        }
      }
      const c = Array.isArray(resJson.result.citations) ? resJson.result.citations.length : 0;
      const minC = t.minCitations ?? 0;
      if (c < minC) {
        ok = false;
        reasons.push(`citations ${c} < required ${minC}`);
      }
    } catch (e: any) {
      ok = false;
      reasons.push(`request failed: ${String(e?.message || e)}`);
    }

    const ms = meta?.ms ?? (Date.now() - start);
    totalMs += ms;
    totalPrompt += meta?.tokens?.prompt ?? 0;
    totalCompletion += meta?.tokens?.completion ?? 0;
    totalCost += meta?.costUSD ?? 0;

    console.log(`${ok ? "✅" : "❌"} [${i + 1}/${tests.length}] ${t.q}`);
    console.log(`   ${ms} ms`);
    if (!ok) console.log(`   Reasons: ${reasons.join("; ")}`);
    console.log();
    if (ok) pass++;
  }

  const n = Math.max(1, tests.length);
  console.log(`Score: ${pass}/${tests.length} passed`);
  console.log(`Avg latency: ${Math.round(totalMs / n)} ms`);
  console.log(`Avg tokens — prompt: ${Math.round(totalPrompt / n)}, completion: ${Math.round(totalCompletion / n)}`);
  console.log(`Total est. cost: $${totalCost.toFixed(6)} (set MODEL_* env vars to enable)`);
  process.exit(pass === tests.length ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
