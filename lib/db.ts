// Minimal pgvector wiring for chunks storage and nearest-neighbor search.
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "";

export async function getClient() {
  if (!DATABASE_URL) throw new Error("Missing DATABASE_URL for pgvector backend.");
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

export async function ensureSchema() {
  const client = await getClient();
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    // 1536 dims for text-embedding-3-small
    await client.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id           BIGSERIAL PRIMARY KEY,
        file         TEXT NOT NULL,
        chunk_index  INT  NOT NULL,
        text         TEXT NOT NULL,
        embedding    vector(1536) NOT NULL,
        UNIQUE (file, chunk_index)
      );
    `);
    // cosine distance index; adjust lists for your dataset size
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'chunks_embedding_cosine'
        ) THEN
          CREATE INDEX chunks_embedding_cosine
          ON chunks
          USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100);
        END IF;
      END$$;
    `);
  } finally {
    await client.end();
  }
}

export async function upsertChunks(rows: { id: string; file: string; text: string; embedding: number[] }[]) {
  const client = await getClient();
  try {
    // Upsert rows (file, chunk_index) extracted from id like "file#idx"
    const q = `
      INSERT INTO chunks (file, chunk_index, text, embedding)
      VALUES ($1, $2, $3, $4::vector)
      ON CONFLICT (file, chunk_index)
      DO UPDATE SET text = EXCLUDED.text, embedding = EXCLUDED.embedding;
    `;
    for (const r of rows) {
      const idx = Number((r.id.split("#")[1] || "1"));
      const vec = `[${r.embedding.join(",")}]`;
      await client.query(q, [r.file, idx, r.text, vec]);
    }
  } finally {
    await client.end();
  }
}

// Nearest neighbors by cosine distance.
// Returns {id,file,text} similar to your file backend’s EmbeddingItem.
export type DBHit = { id: string; file: string; text: string };

export async function searchNearest(embedding: number[], k = 12): Promise<DBHit[]> {
  const client = await getClient();
  try {
    const vec = `[${embedding.join(",")}]`;
    const res = await client.query(
      `
      SELECT file, chunk_index, text
      FROM chunks
      ORDER BY embedding <-> $1::vector
      LIMIT $2
      `,
      [vec, k]
    );
    return res.rows.map((r: any) => ({
      id: `${r.file}#${r.chunk_index}`,
      file: r.file,
      text: r.text,
    }));
  } finally {
    await client.end();
  }
}
