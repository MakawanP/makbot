// Image creation and editing with Gemini's image models ("Nano Banana").
// Runs on the server so your key stays private. Image models are paid-only.
import { GoogleGenAI } from "@google/genai";
import { IMAGE_MODELS, IMAGES_ENABLED, checkPassword, getApiKey } from "@/lib/config";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes

const MAX_PROMPT = 4000;
const MAX_INPUT_IMAGES = 4;
const MAX_IMAGE_CHARS = 2_500_000;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const PER_MODEL_MS = 120_000;

export async function POST(req) {
  if (!IMAGES_ENABLED) {
    return new Response("Image creation is turned off on this site.", { status: 403 });
  }
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

  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT) : "";
  const inputImages = (Array.isArray(body.images) ? body.images : [])
    .slice(0, MAX_INPUT_IMAGES)
    .filter(
      (img) =>
        img &&
        ALLOWED_IMAGE_TYPES.includes(img.mimeType) &&
        typeof img.data === "string" &&
        img.data.length <= MAX_IMAGE_CHARS
    );

  if (!prompt) {
    return new Response("Describe the image you want.", { status: 400 });
  }

  const parts = [
    ...inputImages.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
    { text: prompt },
  ];

  const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
  const failures = [];

  for (const model of IMAGE_MODELS) {
    const abort = new AbortController();
    const onClientGone = () => abort.abort();
    req.signal?.addEventListener("abort", onClientGone);
    const timer = setTimeout(() => abort.abort(), PER_MODEL_MS);
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: { responseModalities: ["TEXT", "IMAGE"], abortSignal: abort.signal },
      });
      clearTimeout(timer);

      const outParts = res.candidates?.[0]?.content?.parts || [];
      const images = outParts
        .filter((p) => p.inlineData?.data && p.inlineData.mimeType?.startsWith("image/"))
        .map((p) => `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`);
      const text = outParts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("")
        .trim();

      if (!images.length) {
        // Usually a safety refusal or the model answered in words only
        const reason = res.candidates?.[0]?.finishReason;
        return Response.json({
          text: text || `I couldn't create that image${reason ? ` (${reason})` : ""}. Try rewording it.`,
          images: [],
          model,
        });
      }
      return Response.json({ text, images, model });
    } catch (err) {
      clearTimeout(timer);
      if (req.signal?.aborted) return new Response(null, { status: 499 });
      const status = Number(err?.status);
      const msg = String(err?.message || err);
      failures.push(`${model}: ${status || ""} ${msg.slice(0, 200)}`);
      console.warn(`[makbot] image ${model} failed:`, status, msg.slice(0, 300));

      // Free-tier keys can't use image models
      if (/free.?tier|billing|not available|PERMISSION_DENIED/i.test(msg) || status === 403) {
        return new Response(
          "Image creation needs billing turned on for your Gemini API key (image models aren't on the free tier).",
          { status: 402 }
        );
      }
      if (abort.signal.aborted || [404, 429, 500, 502, 503, 504].includes(status)) continue;
      break;
    } finally {
      req.signal?.removeEventListener("abort", onClientGone);
    }
  }

  console.error("[makbot] all image models failed:", failures);
  return new Response("Couldn't create the image right now. Please try again in a minute.", {
    status: 503,
  });
}
