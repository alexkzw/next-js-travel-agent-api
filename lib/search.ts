// lib/search.ts
// Loads ./data/embeddings.json and provides topK + LLM re-ranker.
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

export type EmbeddingItem = {
  id: string;          // "kyoto-food.md#1"
  file: string;        // "kyoto-food.md"
  text: string;        // chunk text
  embedding: number[]; // embedding vector
};

const EMB_PATH = path.join(process.cwd(), "data", "embeddings.json");

let CACHE: EmbeddingItem[] | null = null;

export async function loadEmbeddings(): Promise<EmbeddingItem[]> {
  if (CACHE) return CACHE;
  try {
    const buf = await fs.readFile(EMB_PATH, "utf8");
    const data = JSON.parse(buf);
    if (!Array.isArray(data)) {
      throw new Error("embeddings.json is not an array");
    }
    CACHE = data as EmbeddingItem[];
    return CACHE;
  } catch (e: any) {
    const hint =
      e?.code === "ENOENT"
        ? "No data/embeddings.json found. Run: pnpm dlx tsx scripts/embed.ts"
        : e.message;
    throw new Error(`Failed to load ${EMB_PATH}. ${hint}`);
  }
}

function cosine(a: number[], b: number[]) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function topK(items: EmbeddingItem[], q: number[], k = 4): EmbeddingItem[] {
  const scored = items.map((it) => ({ it, score: cosine(it.embedding, q) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.it);
}

function parseJsonLoose(raw: string) {
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  const s = raw.indexOf("["), e = raw.lastIndexOf("]");
  if (s !== -1 && e !== -1 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch {} }
  return null;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** LLM reranker: returns the best `finalK` of the provided candidates. */
export async function rerankWithLLM(
  query: string,
  candidates: EmbeddingItem[],
  finalK = 4,
  model = "gpt-4o-mini"
): Promise<EmbeddingItem[]> {
  if (candidates.length <= finalK) return candidates;

  const compact = candidates.map((h, i) => ({
    n: i + 1,
    id: h.id,
    file: h.file,
    text: h.text.length > 600 ? `${h.text.slice(0, 600)}…` : h.text,
  }));

  const system =
    "You are a precise retrieval reranker. Score each candidate for how well it answers the query. " +
    'Return JSON ONLY as an array: [{"n":1,"score":9.2}, ...]. 0=irrelevant, 10=perfect.';
  const user =
    `Query:\n${query}\n\nCandidates:\n` +
    compact.map((c) => `[${c.n}] (${c.file}) ${c.text}`).join("\n---\n");

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const raw = resp.choices[0]?.message?.content ?? "[]";
  const arr = parseJsonLoose(raw);
  if (!Array.isArray(arr)) return candidates.slice(0, finalK);

  const scores = new Map<number, number>();
  for (const item of arr) {
    const n = Number(item?.n),
      s = Number(item?.score);
    if (Number.isFinite(n) && Number.isFinite(s)) scores.set(n, s);
  }

  // Sort by LLM score (fallback to 0 if missing)
  const ranked = [...candidates].sort((a, b) => {
    const an = candidates.indexOf(a) + 1;
    const bn = candidates.indexOf(b) + 1;
    const sa = scores.get(an) ?? 0,
      sb = scores.get(bn) ?? 0;
    return sb - sa;
  });

  return ranked.slice(0, finalK);
}
