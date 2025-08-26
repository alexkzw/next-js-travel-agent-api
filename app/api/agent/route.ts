import { NextResponse } from "next/server";
import OpenAI from "openai";
import { loadEmbeddings, topK } from "@/lib/search"; // path alias works in Next 15
export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const { message } = (await req.json()) as { message: string };

    // 1) embed the query
    const q = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: message,
    });

    // 2) retrieve top passages
    const items = await loadEmbeddings();
    const hits = topK(items, q.data[0].embedding, 4);

    // 3) build a context block with numbered sources
    const sources = hits
      .map((h, i) => `Source [${i + 1}] (${h.file}): ${h.text}`)
      .join("\n---\n");

    const system = [
      "You are TravelAgentTS: concise, practical, cost-aware.",
      "Use ONLY the sources provided to ground your answer.",
      "Return JSON only with keys: summary, plan, assumptions, nextSteps, citations.",
      "citations should be an array of source numbers you used (e.g., [1,3]).",
      "No markdown, no extra commentary beyond JSON.",
    ].join(" ");

    const user = [
      `User question:\n${message}`,
      `\nContext (use to ground facts, cite like [1], [2], etc.):\n${sources}`,
    ].join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.5,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    let result: any;
    try {
      result = JSON.parse(raw);
    } catch {
      result = { summary: "Could not parse response", raw };
    }

    // attach human-friendly source map
    result.sourceMap = hits.map((h, i) => ({ n: i + 1, id: h.id, file: h.file }));

    return NextResponse.json({ result });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { result: { summary: "Internal error", error: String(err) } },
      { status: 500 }
    );
  }
}
