import { GoogleGenAI } from "@google/genai";

export const dynamic = "force-dynamic";

export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return Response.json(
      {
        success: false,
        response: null,
        error: "Gemini is not configured on the server.",
      },
      { status: 500 },
    );
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents:
        "Return exactly this text and nothing else: Gemini connectivity works.",
    });
    const response = result.text?.trim();

    if (!response) {
      throw new Error("Gemini returned an empty response.");
    }

    return Response.json({ success: true, response });
  } catch {
    return Response.json(
      {
        success: false,
        response: null,
        error: "Gemini connectivity test failed.",
      },
      { status: 500 },
    );
  }
}
