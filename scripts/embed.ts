import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DATA_DIR = path.join(process.cwd(), "data");
const OUT = path.join(DATA_DIR, "embeddings.json");

// very simple chunker: ~800 chars per chunk
function chunk(text: string, size = 800, overlap = 100) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    chunks.push(text.slice(i, end));
    i += size - overlap;
  }
  return chunks;
}

async function run() {
  const files = (await fs.readdir(DATA_DIR)).filter(f => f.endsWith(".md"));
  const items: any[] = [];
  for (const file of files) {
    const full = path.join(DATA_DIR, file);
    const raw = await fs.readFile(full, "utf8");
    const parts = chunk(raw);

    for (let idx = 0; idx < parts.length; idx++) {
      const text = parts[idx];
      const emb = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });
      items.push({
        id: `${file}#${idx + 1}`,
        file,
        text,
        embedding: emb.data[0].embedding,
      });
    }
  }
  await fs.writeFile(OUT, JSON.stringify(items, null, 2), "utf8");
  console.log(`Wrote ${items.length} chunks to ${OUT}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
