// scripts/embed.ts
// Build embeddings from ./data/*.md using sentence-aware chunks.
// Writes to pgvector when VECTOR_BACKEND=pg; otherwise to ./data/embeddings.json

import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

type Row = { id: string; file: string; text: string; embedding: number[] };

// ---- minimal .env loader (no dotenv needed) ----
async function loadEnvLocal(filename = ".env.local") {
  try {
    const p = path.join(process.cwd(), filename);
    const txt = await fs.readFile(p, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}

// ---- sentence-aware chunker with overlap ----
function splitSentences(text: string): string[] {
  // Simple heuristic splitter that respects ., !, ?, and Japanese 。！？ plus quotes.
  const parts = text
    .replace(/\s+/g, " ")
    .split(/(?<=[\.\!\?。！？]['")\]]?)\s+(?=[A-Z0-9“"(['«「『一-龯ぁ-んァ-ヶ])/g);
  return parts.map(s => s.trim()).filter(Boolean);
}
function sentenceChunk(text: string, targetChars = 900, overlapSentences = 1): string[] {
  const paras = text.split(/\n{2,}/g).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const para of paras) {
    const sents = splitSentences(para);
    if (sents.length === 0) continue;
    let buf: string[] = [];
    let i = 0;
    while (i < sents.length) {
      if (buf.join(" ").length + sents[i].length + 1 <= targetChars) {
        buf.push(sents[i]);
        i++;
      } else {
        if (buf.length > 0) {
          chunks.push(buf.join(" "));
          // overlap: keep last N sentences
          buf = buf.slice(Math.max(0, buf.length - overlapSentences));
        } else {
          // single very long sentence, force push
          chunks.push(sents[i]);
          i++;
        }
      }
    }
    if (buf.length) chunks.push(buf.join(" "));
  }
  return chunks;
}

// ---- file discovery ----
async function listMarkdownFiles(): Promise<string[]> {
  const root = path.join(process.cwd(), "data");
  const out: string[] = [];
  const names = await fs.readdir(root);
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === "readme.md") continue;
    if (!lower.endsWith(".md")) continue;
    out.push(path.join(root, name));
  }
  return out;
}

async function main() {
  await loadEnvLocal();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY (set in .env.local or your shell).");
    process.exit(1);
  }
  const backend = (process.env.VECTOR_BACKEND || "file").toLowerCase(); // 'file' | 'pg'
  const openai = new OpenAI({ apiKey });

  const mdFiles = await listMarkdownFiles().catch(() => []);
  if (mdFiles.length === 0) {
    console.error("No .md files found in ./data. Add docs like data/kyoto-food.md.");
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const filePath of mdFiles) {
    const file = path.basename(filePath);
    const raw = await fs.readFile(filePath, "utf8");
    const chunks = sentenceChunk(raw, 900, 1);
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i];
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });
      rows.push({
        id: `${file}#${i + 1}`,
        file,
        text,
        embedding: emb.data[0].embedding,
      });
      // small delay in dev to be nice
      await new Promise(r => setTimeout(r, 20));
    }
  }

  if (backend === "pg") {
    // ---- write to pgvector ----
    const { upsertChunks, ensureSchema } = await import("../lib/db.js"); // Node will resolve TS transpile; if TS, use tsx
    await ensureSchema();
    await upsertChunks(rows);
    console.log(`Upserted ${rows.length} chunks to pgvector from files: ${[...new Set(rows.map(r => r.file))].join(", ")}`);
  } else {
    // ---- write to file ----
    await fs.mkdir(path.join(process.cwd(), "data"), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), "data", "embeddings.json"), JSON.stringify(rows, null, 2));
    console.log(`Wrote data/embeddings.json with ${rows.length} chunks from files: ${[...new Set(rows.map(r => r.file))].join(", ")}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
