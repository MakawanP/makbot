// Text chat: runs on the server, so your Gemini key never reaches the browser.
import { GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPT, TEXT_MODELS, checkPassword, getApiKey } from "@/lib/config";

export const runtime = "nodejs";
export const maxDuration = 60; // seconds; streaming keeps long replies alive

const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;
const MAX_IMAGES = 4; // per message
const MAX_IMAGE_CHARS = 2_500_000; // ~1.8 MB per image after base64
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

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
  // Gemini uses the roles "user" and "model". User messages may carry images.
  const contents = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_MESSAGES)
    .map((m) => {
      const parts = [];
      if (m.role === "user" && Array.isArray(m.images)) {
        for (const img of m.images.slice(0, MAX_IMAGES)) {
          if (
            img &&
            ALLOWED_IMAGE_TYPES.includes(img.mimeType) &&
            typeof img.data === "string" &&
            img.data.length <= MAX_IMAGE_CHARS
          ) {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
          }
        }
      }
      const text = typeof m.content === "string" ? m.content.trim().slice(0, MAX_CHARS) : "";
      if (text) parts.push({ text });
      else if (parts.length) parts.push({ text: "Describe this image." });
      return { role: m.role === "assistant" ? "model" : "user", parts };
    })
    .filter((c) => c.parts.length);

  if (contents.length === 0 || contents[contents.length - 1].role !== "user") {
    return new Response("No message to answer.", { status: 400 });
  }

  // Don't let the SDK retry a busy model with long waits: move straight to the
  // next model instead. Only the last model in the list gets a couple of retries.
  const fastClient = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
  const lastClient = new GoogleGenAI({
    apiKey,
    httpOptions: { retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 4 } },
  });

  // Try each model in order until one starts answering.
  let iterator = null;
  let first = null;
  let usedModel = null;
  const failures = [];

  for (const [i, model] of TEXT_MODELS.entries()) {
    const ai = i === TEXT_MODELS.length - 1 ? lastClient : fastClient;
    try {
      const result = await ai.models.generateContentStream({
        model,
        contents,
        config: { systemInstruction: SYSTEM_PROMPT },
      });
      iterator = result[Symbol.asyncIterator]();
      // Wait for the first chunk: "busy" errors often arrive here, not on the call
      first = await iterator.next();
      usedModel = model;
      break;
    } catch (err) {
      failures.push(`${model}: ${shortError(err)}`);
      if (!isRetryable(err)) break; // e.g. bad API key: no point trying others
    }
  }

  if (!iterator) {
    console.error("All Gemini models failed:", failures);
    const allBusy = failures.length === TEXT_MODELS.length;
    return new Response(
      allBusy
        ? "Gemini is very busy right now. Please try again in a minute."
        : `Gemini error: ${failures[failures.length - 1]}`,
      { status: 503 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (!first.done && first.value?.text) {
          controller.enqueue(encoder.encode(first.value.text));
        }
        while (!first.done) {
          const next = await iterator.next();
          if (next.done) break;
          const text = next.value?.text;
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
      "X-Makbot-Model": usedModel, // which model answered (visible in dev tools)
    },
  });
}

// Busy, rate-limited, temporarily broken, or model not found -> try the next model.
function isRetryable(err) {
  const status = Number(err?.status);
  if ([404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  return /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|NOT_FOUND|fetch failed/i.test(
    String(err?.message || "")
  );
}

function shortError(err) {
  const msg = String(err?.message || err);
  const match = msg.match(/"message":\s*"([^"]+)"/);
  return (err?.status ? `${err.status} ` : "") + (match ? match[1] : msg).slice(0, 200);
}
