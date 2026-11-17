// Text chat: runs on the server, so your Gemini key never reaches the browser.
import { GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPT, TEXT_MODEL, checkPassword, getApiKey } from "@/lib/config";

export const runtime = "nodejs";
export const maxDuration = 60; // seconds; streaming keeps long replies alive

const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;

export async function POST(req) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return new Response("Server is missing GEMINI_API_KEY.", { status: 500 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid request.", { status: 400 });
  }

  const denied = checkPassword(body.password);
  if (denied) return denied;

  // Basic input limits to keep costs predictable.
  // Gemini uses the roles "user" and "model".
  const contents = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.slice(0, MAX_CHARS) }],
    }));

  if (contents.length === 0 || contents[contents.length - 1].role !== "user") {
    return new Response("No message to answer.", { status: 400 });
  }

  const ai = new GoogleGenAI({ apiKey });

  let result;
  try {
    result = await ai.models.generateContentStream({
      model: TEXT_MODEL,
      contents,
      config: { systemInstruction: SYSTEM_PROMPT },
    });
  } catch (err) {
    return new Response(`Gemini error: ${err.message}`, { status: 502 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result) {
          const text = chunk.text;
          if (text) controller.enqueue(encoder.encode(text));
        }
      } catch {
        controller.enqueue(encoder.encode("\n\n[Stream interrupted]"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
