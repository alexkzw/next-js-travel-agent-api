"use client";
import { useEffect, useRef, useState } from "react";

interface AgentResult {
  summary: string;
  plan: string | string[];
  assumptions?: string[];
  nextSteps?: string | string[];
  raw?: string;
  error?: string;
  citations?: number[];
  sourceMap?: { n: number; id: string; file: string }[];
  tool_used?: string;
}
interface AgentMeta { ms?: number }
interface AgentResponse { result: AgentResult; meta?: AgentMeta }

export default function Home() {
  const toArray = (v: unknown): string[] =>
    Array.isArray(v) ? (v as string[])
    : typeof v === "string" ? [v]
    : [];

  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState<AgentResponse | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState(""); // live stream text
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => { if (esRef.current) esRef.current.close(); };
  }, []);

  function stopStream() {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setStreaming(false);
  }

  function askAgentStream() {
    stopStream();
    setAnswer(null);
    setPartial("");
    setStreaming(true);

    const url = `/api/agent?message=${encodeURIComponent(input)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("token", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { token?: string };
        if (data?.token) setPartial(prev => prev + data.token);
      } catch {}
    });

    es.addEventListener("result", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as AgentResponse;
        setAnswer(data);
      } catch {}
    });

    // Planner clarify request
    es.addEventListener("clarify", (e: MessageEvent) => {
      try {
        const { question } = JSON.parse(e.data);
        setPartial(`Clarification needed: ${question}`);
      } catch { setPartial("Clarification needed."); }
      stopStream();
    });

    // Server-side JSON errors (NOT the reserved transport 'error')
    es.addEventListener("agent_error", (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data);
        console.error("Agent error:", d);
        setPartial(prev =>
          prev
            ? `${prev}\n\n[Agent error] ${d?.error ?? "Unknown agent error"}`
            : `[Agent error] ${d?.error ?? "Unknown agent error"}`
        );
      } catch {
        console.error("Agent error (non-JSON):", e);
      }
      stopStream();
    });

    // Real transport failures (bad headers, server crashed before streaming, etc.)
    es.onerror = (ev) => {
      console.error("SSE transport error", ev);
      stopStream();
    };

    es.addEventListener("done", () => stopStream());
  }

  return (
    <main style={{ maxWidth: 720, margin: "48px auto", padding: 16 }}>
      <h1>TravelAgentTS (Streaming)</h1>
      <p style={{ opacity: 0.8 }}>
        Ask for a quick plan (e.g., “2 days in Kyoto under $300 each”).
      </p>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={5}
        style={{ width: "100%", marginTop: 12 }}
        placeholder="Where do you want to go?"
      />
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button onClick={askAgentStream} disabled={!input || streaming}>
          {streaming ? "Streaming..." : "Ask (SSE)"}
        </button>
        {streaming && <button onClick={stopStream}>Stop</button>}
      </div>

      {/* Live stream */}
      {partial && (
        <div style={{ marginTop: 24 }}>
          <h2>Streaming…</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{partial}</pre>
        </div>
      )}

      {/* Final structured */}
      {answer && answer.result && (
        <div style={{ marginTop: 24, whiteSpace: "pre-wrap" }}>
          <h2>Summary:</h2>
          <p>{answer.result.summary}</p>

          <h2>Plan:</h2>
          <pre>
            {typeof answer.result.plan === "string"
              ? answer.result.plan
              : JSON.stringify(answer.result.plan, null, 2)}
          </pre>

          <h2>Assumptions:</h2>
          <ul>
            {toArray(answer.result.assumptions).map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>

          <h2>Next Steps:</h2>
          <p>
            {Array.isArray(answer.result.nextSteps)
              ? (answer.result.nextSteps as string[]).join("\n")
              : (answer.result.nextSteps as string)}
          </p>

          {Array.isArray(answer.result.citations) &&
            answer.result.citations.length > 0 && (
              <>
                <h2>Sources:</h2>
                <ul>
                  {answer.result.citations.map((n, i) => {
                    const m = answer.result.sourceMap?.find(s => s.n === n);
                    return <li key={i}>[{n}] {m?.file ?? "unknown source"}</li>;
                  })}
                </ul>
              </>
            )}
        </div>
      )}
    </main>
  );
}
