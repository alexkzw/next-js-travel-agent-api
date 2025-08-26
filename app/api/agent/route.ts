import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { message } = await req.json() as { message: string };

    const system = [
      "You are TravelAgentTS: concise, practical, cost-aware.",
      "When answering a travel request, ALWAYS return a valid JSON object with keys:",
      "- summary: 1-sentence summary of the trip",
      "- plan: day-by-day itinerary (as a string or array)",
      "- assumptions: list any assumptions you make",
      "- nextSteps: how the user can confirm or book the trip",
      "Do not include markdown or extra commentary. JSON only."
    ].join(" ");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o", 
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message }
      ]
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    let structured = null;
    
    try {
      structured = JSON.parse(raw);
    } catch {
      // fallback: return raw string if parsing fails
      structured = { summary: "Could not parse response", raw };
    }
    return NextResponse.json({ result: structured });
  }
  catch (err) {
    return NextResponse.json({ result: { summary: "Internal error", error: String(err) } }, { status: 500 });
  }
}
