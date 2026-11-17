// Shared settings for Makbot. Edit the personality here.
export const SYSTEM_PROMPT =
  "You are Makbot, a friendly and concise assistant. Answer clearly and helpfully. " +
  "In voice conversations, keep replies short and natural, like talking to a friend.";

export const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
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
