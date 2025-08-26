import fs from "node:fs/promises";
import path from "node:path";

type Item = { id: string; file: string; text: string; embedding: number[] };

let cache: Item[] | null = null;

function dot(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a: number[]) {
  return Math.sqrt(dot(a, a));
}
function cosine(a: number[], b: number[]) {
  return dot(a, b) / (norm(a) * norm(b) + 1e-12);
}

export async function loadEmbeddings() {
  if (cache) return cache;
  const p = path.join(process.cwd(), "data", "embeddings.json");
  cache = JSON.parse(await fs.readFile(p, "utf8"));
  return cache!;
}

export function topK(items: Item[], queryEmb: number[], k = 4) {
  return items
    .map(it => ({ ...it, score: cosine(it.embedding, queryEmb) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
