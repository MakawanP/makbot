// Voice chat: hands the browser a short-lived, single-use token for the
// Gemini Live API. Your real key stays on the server.
import { GoogleGenAI, Modality } from "@google/genai";
import { SYSTEM_PROMPT, LIVE_MODEL, checkPassword, getApiKey } from "@/lib/config";

export const runtime = "nodejs";

export async function POST(req) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return new Response("Server is missing GEMINI_API_KEY.", { status: 500 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch {}

  const denied = checkPassword(body.password);
  if (denied) return denied;

  const ai = new GoogleGenAI({ apiKey });
  const now = Date.now();

  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 1, // one voice session per token
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(), // session can last up to 30 min
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(), // must connect within 1 min
        // Lock the model and settings so the token can't be reused for anything else
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: SYSTEM_PROMPT,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        },
      },
    });

    return Response.json({ token: token.name, model: LIVE_MODEL });
  } catch (err) {
    return new Response(`Could not start voice session: ${err.message}`, {
      status: 502,
    });
  }
}
