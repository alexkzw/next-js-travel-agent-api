import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const { message } = await req.json() as { message: string };

    const system = [
      "You are TravelAgentTS: concise, practical, cost-aware.",
      "When uncertain, ask one clarifying question.",
      "If giving an itinerary, include times, transit hints, and rough costs.",
    ].join(" ");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // or "gpt-3.5-turbo" if needed
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message }
      ]
    });

    const text = completion.choices[0]?.message?.content ?? "";
    return NextResponse.json({ text });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: "Agent failed." }, { status: 500 });
  }
}
