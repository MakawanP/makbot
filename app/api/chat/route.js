// Text chat: runs on the server, so your Gemini key never reaches the browser.
import { GoogleGenAI } from "@google/genai";
import { buildSystemPrompt, MODES, TEXT_MODELS, checkPassword, getApiKey } from "@/lib/config";

// Marks the end of the reply text; source info follows as JSON
const META_MARKER = "\u001eMAKBOT_META";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes; Vercel stops the function after this

// Time limits (milliseconds)
const DEADLINE_MS = 290_000; // finish the reply cleanly before Vercel's 5-minute limit
const FIRST_CHUNK_MS = 30_000; // each model gets this long to start answering
const LAST_FIRST_CHUNK_MS = 90_000; // the final fallback gets longer (big prompts, images)
const IDLE_MS = 60_000; // give up if a reply stops mid-way for this long

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
    httpOptions: { retryOptions: { attempts: 2, initialDelay: 1, maxDelay: 2 } },
  });

  const startedAt = Date.now();
  const timeLeft = () => DEADLINE_MS - (Date.now() - startedAt);

  const humanize = body.humanize === true;
  const mode = MODES[body.mode] ? body.mode : "default";
  const wantSearch = body.search === true;

  // Each attempt is a model + whether web search is on. With search on, the last
  // resort is answering without search, so a search problem never blocks a reply.
  const attempts = TEXT_MODELS.map((model) => ({ model, search: wantSearch }));
  if (wantSearch) attempts.push({ model: TEXT_MODELS[TEXT_MODELS.length > 1 ? 1 : 0], search: false });

  // Try each attempt in order until one starts answering.
  let iterator = null;
  let first = null;
  let usedModel = null;
  let usedSearch = false;
  let modelAbort = null;
  const failures = [];

  for (const [i, { model, search }] of attempts.entries()) {
    const isLast = i === attempts.length - 1;
    const ai = isLast ? lastClient : fastClient;
    // Give each model a limited time to start answering. Gemini sometimes hangs
    // without returning an error when it's overloaded.
    const wait = Math.min(isLast ? LAST_FIRST_CHUNK_MS : FIRST_CHUNK_MS, timeLeft() - 5_000);
    if (wait < 3_000) {
      failures.push(`${model}: skipped (out of time)`);
      break;
    }
    const abort = new AbortController();
    const onClientGone = () => abort.abort();
    req.signal?.addEventListener("abort", onClientGone);
    const timer = setTimeout(() => abort.abort(new Error("timeout")), wait);
    try {
      const result = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: buildSystemPrompt(humanize, mode, search),
          ...(search ? { tools: [{ googleSearch: {} }] } : {}),
          abortSignal: abort.signal,
        },
      });
      iterator = result[Symbol.asyncIterator]();
      // Wait for the first chunk: "busy" errors often arrive here, not on the call
      first = await iterator.next();
      clearTimeout(timer);
      usedModel = model;
      usedSearch = search;
      modelAbort = abort;
      break;
    } catch (err) {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onClientGone);
      iterator = null;
      if (req.signal?.aborted) return new Response(null, { status: 499 }); // user hit Stop
      const timedOut = abort.signal.aborted;
      const reason = timedOut ? `no response after ${Math.round(wait / 1000)}s` : shortError(err);
      const label = `${model}${search ? " +search" : ""}`;
      failures.push(`${label}: ${reason}`);
      console.warn(`[makbot] ${label} failed, trying next:`, reason);
      // A 400 with search on may just mean "search not available": keep going.
      const searchProblem = search && Number(err?.status) === 400;
      if (!timedOut && !searchProblem && !isRetryable(err)) break; // e.g. bad API key
    }
  }

  if (!iterator) {
    console.error("[makbot] All Gemini models failed:", failures);
    const allBusy = failures.length === attempts.length;
    return new Response(
      allBusy
        ? "Gemini is very busy right now. Please try again in a minute."
        : `Gemini error: ${failures[failures.length - 1]}`,
      { status: 503 }
    );
  }

  if (failures.length) console.warn(`[makbot] answered by ${usedModel} after:`, failures);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let idleTimer = null;
      let deadlineTimer = null;
      let stopReason = null;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          stopReason = "idle";
          modelAbort.abort();
        }, IDLE_MS);
      };
      // Finish cleanly before Vercel's hard limit instead of erroring
      deadlineTimer = setTimeout(() => {
        stopReason = "deadline";
        modelAbort.abort();
      }, Math.max(1_000, timeLeft()));

      let grounding = null;
      const collect = (chunk) => {
        const g = chunk?.candidates?.[0]?.groundingMetadata;
        if (g && (g.groundingChunks?.length || g.searchEntryPoint || g.webSearchQueries?.length)) {
          grounding = g;
        }
      };

      try {
        if (!first.done) {
          collect(first.value);
          if (first.value?.text) controller.enqueue(encoder.encode(first.value.text));
        }
        resetIdle();
        while (!first.done) {
          const next = await iterator.next();
          if (next.done) break;
          resetIdle();
          collect(next.value);
          const text = next.value?.text;
          if (text) controller.enqueue(encoder.encode(text));
        }
        // Send sources after the text
        if (usedSearch && grounding) {
          const seen = new Set();
          const sources = (grounding.groundingChunks || [])
            .map((c) => c.web)
            .filter((w) => w?.uri && !seen.has(w.uri) && seen.add(w.uri))
            .slice(0, 8)
            .map((w) => ({ title: w.title || w.uri, uri: w.uri }));
          const meta = {
            sources,
            queries: grounding.webSearchQueries || [],
            searchHtml: grounding.searchEntryPoint?.renderedContent || "",
          };
          controller.enqueue(encoder.encode(META_MARKER + JSON.stringify(meta)));
        }
      } catch (err) {
        if (stopReason === "deadline") {
          controller.enqueue(encoder.encode("\n\n[Reply cut short: it took too long. Ask me to continue.]"));
        } else if (stopReason === "idle") {
          console.warn(`[makbot] ${usedModel} stalled mid-reply`);
          controller.enqueue(encoder.encode("\n\n[Reply stalled. Try Regenerate.]"));
        } else if (!req.signal?.aborted) {
          console.warn(`[makbot] stream error from ${usedModel}:`, shortError(err));
          controller.enqueue(encoder.encode("\n\n[Stream interrupted]"));
        }
      } finally {
        clearTimeout(idleTimer);
        clearTimeout(deadlineTimer);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      modelAbort?.abort(); // browser went away or user hit Stop
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Makbot-Model": usedModel, // which model answered (visible in dev tools)
      "X-Makbot-Search": usedSearch ? "on" : "off",
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
