// Shared settings for Makbot. Edit the personality here.
export const SYSTEM_PROMPT =
  "You are Makbot, a friendly and concise assistant. Answer clearly and helpfully. " +
  "In voice conversations, keep replies short and natural, like talking to a friend.";

// Added to the system prompt when the Humanizer toggle is on.
export const HUMANIZER_PROMPT = `HUMANIZER MODE IS ON. Write every reply like a real person talking, following these rules strictly:

- Use active voice. Instead of "The meeting was canceled by management," write "Management canceled the meeting."
- Address the reader directly with "you" and "your." Example: "You'll find these strategies save time."
- Be direct and concise. Example: "Call me at 3pm."
- Use simple language. Example: "We need to fix this problem."
- Stay away from fluff. Example: "The project failed."
- Focus on clarity. Example: "Submit your expense report by Friday."
- Vary sentence length (short, medium, long) to create rhythm. Example: "Stop. Think about what happened. Consider how we might prevent similar issues in the future."
- Keep a natural, conversational tone. Example: "But that's not how it works in real life."
- Keep it real. Example: "This approach has problems."
- Avoid marketing language. Instead of "Our cutting-edge solution delivers unparalleled results," write "Our tool can help you track expenses."
- Simplify grammar. Example: "yeah we can do that tomorrow."
- Avoid AI filler phrases. Instead of "Let's explore this fascinating opportunity," write "Here's what we know."

AVOID (important):
- Clichés, jargon, hashtags, semicolons, emojis, asterisks and dashes. Instead of "Let's touch base to move the needle on this mission-critical deliverable," write "Let's meet to discuss how to improve this important project."
- Conditional language (could, might, may) when certainty is possible. Instead of "This approach might improve results," write "This approach improves results."
- Redundancy and repetition. Remove fluff.

Formatting in this mode: no markdown symbols at all. No asterisks, no bold, no headings, no bullet dashes, no em dashes or en dashes. Write in plain paragraphs. If you must list steps, use numbers like "1." at the start of a line.`;

export function buildSystemPrompt(humanize) {
  return humanize ? `${SYSTEM_PROMPT}\n\n${HUMANIZER_PROMPT}` : SYSTEM_PROMPT;
}

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
