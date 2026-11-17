// Shared settings for Makbot. Edit the personality here.
export const SYSTEM_PROMPT =
  "You are Makbot, a friendly and concise assistant. Answer clearly and helpfully. " +
  "In voice conversations, keep replies short and natural, like talking to a friend.";

// Text models, tried in order. If one is busy or rate-limited, Makbot
// automatically moves on to the next. GEMINI_TEXT_MODEL (if set) goes first.
const DEFAULT_TEXT_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];

export const TEXT_MODELS = [
  ...new Set(
    [
      process.env.GEMINI_TEXT_MODEL,
      ...(process.env.GEMINI_TEXT_MODELS || "").split(","),
      ...DEFAULT_TEXT_MODELS,
    ]
      .map((m) => (m || "").trim())
      .filter(Boolean)
  ),
];
export const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";

// Returns an error Response if the password is wrong, otherwise null.
export function checkPassword(password) {
  const required = process.env.MAKBOT_PASSWORD;
  if (required && password !== required) {
    return new Response("Wrong or missing password.", { status: 401 });
  }
  return null;
}

export function getApiKey() {
  return process.env.GEMINI_API_KEY;
}
