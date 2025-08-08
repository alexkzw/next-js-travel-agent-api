"use client";
import { useState } from "react";

export default function Home() {
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
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
    setAnswer(data.text ?? data.error ?? "No response");
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

      {answer && (
        <div style={{ marginTop: 24, whiteSpace: "pre-wrap" }}>
          <strong>Agent:</strong> {answer}
        </div>
      )}
    </main>
  );
}
