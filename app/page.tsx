"use client";
import { useState } from "react";

export default function Home() {
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState<{ result: any } | null>(null);
  const [loading, setLoading] = useState(false);

  async function askAgent() {
    setLoading(true);
    setAnswer(null);
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: input })
    });
    const data = await res.json();
    setAnswer(data);
    setLoading(false);
  }

  return (
    <main style={{ maxWidth: 720, margin: "48px auto", padding: 16 }}>
      <h1>TravelAgentTS (Day 1)</h1>
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
      <div style={{ marginTop: 12 }}>
        <button onClick={askAgent} disabled={loading || !input}>
          {loading ? "Thinking..." : "Ask"}
        </button>
      </div>

      {answer && answer.result && (
        <div style={{ marginTop: 24, whiteSpace: "pre-wrap" }}>
          <h2>Summary:</h2>
          <p>{answer.result.summary}</p>

          <h2>Plan:</h2>
          <pre>{typeof answer.result.plan === "string" ? answer.result.plan : JSON.stringify(answer.result.plan, null, 2)}</pre>

          <h2>Assumptions:</h2>
          <ul>
            {(answer.result.assumptions ?? []).map((a: string, i: number) => <li key={i}>{a}</li>)}
          </ul>

          <h2>Next Steps:</h2>
          <p>{answer.result.nextSteps}</p>

          {answer.result.raw && (
            <>
              <h3>Raw output (fallback)</h3>
              <pre>{answer.result.raw}</pre>
            </>
          )}
        </div>
      )}
    </main>
  );
}

