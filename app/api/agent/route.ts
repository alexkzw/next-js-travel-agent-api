import { NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";
import { loadEmbeddings, topK, rerankWithLLM } from "../../../lib/search";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const enc = new TextEncoder();

// ------------ small helpers ------------
function parseJsonLoose(raw: string) {
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s !== -1 && e !== -1 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch {} }
  throw new Error("No JSON found");
}

function normalizeResult(result: any) {
  if (!result) result = {};
  if (!Array.isArray(result.assumptions)) {
    result.assumptions = typeof result.assumptions === "string" ? [result.assumptions] : [];
  }
  if (Array.isArray(result.nextSteps)) result.nextSteps = result.nextSteps.join("\n");
  if (!Array.isArray(result.citations)) result.citations = [];
  return result;
}

// ------------ currency tool ------------
const CurrencyArgs = z.object({
  amount: z.number().positive(),
  from: z.string().length(3),
  to: z.string().length(3),
});
async function convertCurrency(args: unknown) {
  const parsed = CurrencyArgs.parse({
    ...args,
    from: String((args as any)?.from ?? "").toUpperCase(),
    to: String((args as any)?.to ?? "").toUpperCase(),
  });
  const { amount, from, to } = parsed;
  const res = await fetch(
    `https://api.frankfurter.app/latest?amount=${amount}&from=${from}&to=${to}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error(`FX API error ${res.status}`);
  const data = await res.json();
  const rate = data?.rates?.[to];
  if (typeof rate !== "number") throw new Error("FX API: missing rate");
  const value = rate; // this API returns amount*fx
  const date = data?.date ?? null;
  return { amount, from, to, value, rate: value / amount, date, provider: "frankfurter.app" };
}

// ------------ planner ------------
const PLANNER_SYSTEM = [
  "You are a planner. Decide initial step as JSON.",
  "If the question lacks a clear destination AND either dates or number of days,",
  "  return {\"action\":\"clarify\",\"question\":\"Ask for destination and dates/days.\"}.",
  "If user asks for currency conversion, return {\"action\":\"use_currency\",\"args\":{\"amount\":<number>,\"from\":\"USD\",\"to\":\"JPY\"}}.",
  "Otherwise return {\"action\":\"answer\"}.",
].join(" ");

// ===================================================================
// GET: SSE – handshake → planner → optional tool → retrieve + rerank → stream
// ===================================================================
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const message = searchParams.get("message") ?? "";
  const force = searchParams.get("force"); // dev override

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(enc.encode(`event: ${event}\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const t0 = Date.now();

      try {
        // Handshake comment so the connection is "open" ASAP
        controller.enqueue(enc.encode(`: sse-handshake\n\n`));

        if (!process.env.OPENAI_API_KEY) {
          send("agent_error", { error: "Missing OPENAI_API_KEY" });
          send("done", { ok: false });
          controller.close();
          return;
        }
        if (!message.trim()) {
          send("agent_error", { error: "Missing ?message=" });
          send("done", { ok: false });
          controller.close();
          return;
        }

        // ---- planner ----
        let plan: any = { action: "answer" };
        try {
          const planner = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: PLANNER_SYSTEM },
              { role: "user", content: message },
            ],
          });
          plan = JSON.parse(planner.choices[0]?.message?.content ?? "{}");
        } catch (e: any) {
          send("agent_error", { error: `Planner failed: ${String(e?.message || e)}` });
          plan = { action: "answer" };
        }

        if (force === "clarify") plan = { action: "clarify", question: "Which city and what dates/days?" };
        if (force === "answer") plan = { action: "answer" };
        if (force === "use_currency") plan = { action: "use_currency", args: { amount: 100, from: "USD", to: "JPY" } };

        send("planner", { decision: plan.action, question: plan?.question ?? null });

        if (plan.action === "clarify") {
          send("clarify", { question: plan?.question ?? "Please specify destination and dates/days." });
          send("done", { ok: true, meta: { ms: Date.now() - t0 } });
          controller.close();
          return;
        }

        // ---- optional currency tool ----
        let toolNote = "";
        let toolUsed: string | null = null;
        if (plan.action === "use_currency") {
          try {
            send("tool", { name: "currency", status: "start", args: plan.args ?? null });
            const fx = await convertCurrency(plan.args ?? {});
            toolNote = `Tool[currency]: ${fx.amount} ${fx.from} ≈ ${fx.value} ${fx.to} on ${fx.date ?? "latest"} (rate ${fx.rate.toFixed(6)}).`;
            send("tool", { name: "currency", status: "done", result: fx });
            toolUsed = "currency";
          } catch (e: any) {
            send("tool", { name: "currency", status: "error", error: String(e?.message || e) });
            toolNote = `Tool[currency] failed: ${String(e?.message || e)}.`;
          }
        }

        // ---- retrieve + rerank ----
        let hits: Awaited<ReturnType<typeof loadEmbeddings>> = [];
        try {
          const qEmb = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: message,
          });

          const K0 = Number(process.env.RERANK_CANDIDATES ?? "12");
          const finalK = Number(process.env.RERANK_FINAL_K ?? "4");
          const items = await loadEmbeddings();
          const firstHits = topK(items, qEmb.data[0].embedding, K0);

          send("tool", { name: "reranker", status: "start", kIn: firstHits.length });
          hits = await rerankWithLLM(message, firstHits, finalK, "gpt-4o-mini");
          send("tool", {
            name: "reranker",
            status: "done",
            kOut: hits.length,
            top: hits.map((h, i) => ({ i: i + 1, id: h.id, file: h.file })),
          });
        } catch (e: any) {
          send("tool", { name: "reranker", status: "error", error: String(e?.message || e) });
          // fall back to plain topK(4) so the stream still succeeds
          try {
            const qEmb = await openai.embeddings.create({
              model: "text-embedding-3-small",
              input: message,
            });
            const items = await loadEmbeddings();
            hits = topK(items, qEmb.data[0].embedding, 4);
          } catch {
            hits = [];
          }
        }

        const sourcesCore = hits.map((h, i) => `Source [${i + 1}] (${h.file}): ${h.text}`).join("\n---\n");
        const sources = toolNote ? `${toolNote}\n---\n${sourcesCore}` : sourcesCore;

        // ---- answer (stream) ----
        const system =
          "You are TravelAgentTS: concise, practical, cost-aware. " +
          "Use ONLY the provided sources/tool notes to ground facts. " +
          "Return a valid JSON object ONLY (no code fences) with keys: " +
          "summary, plan, assumptions, nextSteps, citations (array of source numbers).";
        const user = `User question:\n${message}\n\nContext:\n${sources}`;

        let buffer = "";
        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0.5,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            stream: true,
          });

          for await (const part of completion) {
            const delta = part.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              buffer += delta;
              send("token", { token: delta });
            }
          }
        } catch (e: any) {
          send("agent_error", { error: `Answer stream failed: ${String(e?.message || e)}` });
          send("done", { ok: false });
          controller.close();
          return;
        }

        let result: any;
        try { result = parseJsonLoose(buffer); }
        catch { result = { summary: "Could not parse response", raw: buffer }; }
        result = normalizeResult(result);

        if (!Array.isArray(result.citations) || result.citations.length === 0) {
          result.citations = hits.map((_, i) => i + 1);
        }
        result.sourceMap = hits.map((h, i) => ({ n: i + 1, id: h.id, file: h.file }));
        if (toolUsed) result.tool_used = toolUsed;

        const meta = { ms: Date.now() - t0 };
        send("result", { result, meta });
        send("done", { ok: true });
        controller.close();
      } catch (err: any) {
        // LAST-resort: never throw past the stream boundary
        controller.enqueue(enc.encode(`event: agent_error\ndata: ${JSON.stringify({ error: String(err?.message || err) })}\n\n`));
        controller.enqueue(enc.encode(`event: done\ndata: {"ok":false}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

// ===================================================================
// POST: non-stream JSON (authoritative tokens/cost); same flow but simpler
// ===================================================================
const PROMPT_RATE = Number(process.env.MODEL_PROMPT_PER_1K ?? "0");
const COMPLETION_RATE = Number(process.env.MODEL_COMPLETION_PER_1K ?? "0");

export async function POST(req: Request) {
  const t0 = Date.now();
  try {
    const { message } = (await req.json()) as { message: string };

    const planner = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: message },
      ],
    });
    let plan: any = {};
    try { plan = JSON.parse(planner.choices[0]?.message?.content ?? "{}"); } catch {}

    let toolNote = "";
    let toolUsed: string | null = null;
    if (plan?.action === "use_currency") {
      try {
        const fx = await convertCurrency(plan.args ?? {});
        toolUsed = "currency";
        toolNote = `Tool[currency]: ${fx.amount} ${fx.from} ≈ ${fx.value} ${fx.to} on ${fx.date ?? "latest"} (rate ${fx.rate.toFixed(6)}).`;
      } catch (e: any) {
        toolNote = `Tool[currency] failed: ${String(e?.message || e)}.`;
      }
    }
    if (plan?.action === "clarify") {
      const result = normalizeResult({
        summary: "Need clarification to proceed.",
        plan: [],
        assumptions: [],
        nextSteps: plan?.question || "Please provide destination and dates/days.",
        citations: [],
      });
      const meta = { ms: Date.now() - t0, tokens: { prompt: 0, completion: 0, total: 0 }, costUSD: 0 };
      return NextResponse.json({ result, meta });
    }

    const qEmb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: message,
    });

    const K0 = Number(process.env.RERANK_CANDIDATES ?? "12");
    const finalK = Number(process.env.RERANK_FINAL_K ?? "4");
    const items = await loadEmbeddings();
    const firstHits = topK(items, qEmb.data[0].embedding, K0);
    let hits = firstHits;
    try {
      hits = await rerankWithLLM(message, firstHits, finalK, "gpt-4o-mini");
    } catch {}

    const sourcesCore = hits.map((h, i) => `Source [${i + 1}] (${h.file}): ${h.text}`).join("\n---\n");
    const sources = toolNote ? `${toolNote}\n---\n${sourcesCore}` : sourcesCore;

    const system =
      "You are TravelAgentTS: concise, practical, cost-aware. " +
      "Use ONLY the provided sources/tool notes to ground facts. " +
      "Return a valid JSON object ONLY with keys: summary, plan, assumptions, nextSteps, citations.";
    const user = `User question:\n${message}\n\nContext:\n${sources}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    let result: any;
    try { result = parseJsonLoose(raw); } catch { result = { summary: "Could not parse response", raw }; }
    result = normalizeResult(result);
    if (!Array.isArray(result.citations) || result.citations.length === 0) {
      result.citations = hits.map((_, i) => i + 1);
    }
    result.sourceMap = hits.map((h, i) => ({ n: i + 1, id: h.id, file: h.file }));
    if (toolUsed) result.tool_used = toolUsed;

    const u = completion.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const costUSD = (u.prompt_tokens / 1000) * PROMPT_RATE + (u.completion_tokens / 1000) * COMPLETION_RATE;

    const meta = {
      ms: Date.now() - t0,
      tokens: {
        prompt: u.prompt_tokens ?? 0,
        completion: u.completion_tokens ?? 0,
        total: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
      },
      costUSD: Number.isFinite(costUSD) ? Number(costUSD.toFixed(6)) : 0,
    };

    return NextResponse.json({ result, meta });
  } catch (err) {
    return NextResponse.json({ result: { summary: "Internal error", error: String(err) } }, { status: 500 });
  }
}
