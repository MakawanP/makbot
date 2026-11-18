// Your own model server (e.g. Gemma 4 26B A4B on vLLM, Ollama, llama.cpp or
// LM Studio), reached through its OpenAI-compatible API. Server-side only.

export const SELF = {
  baseUrl: (process.env.SELF_HOSTED_BASE_URL || "").trim().replace(/\/+$/, ""),
  apiKey: (process.env.SELF_HOSTED_API_KEY || "").trim(),
  model: (process.env.SELF_HOSTED_MODEL || "gemma-4-26b-a4b").trim(),
  label: (process.env.SELF_HOSTED_LABEL || "Gemma 4 (self-hosted)").trim(),
  // How long your server gets to start answering before Makbot falls back to Gemini
  firstChunkMs: Number(process.env.SELF_HOSTED_TIMEOUT_MS) || 60_000,
  // "first" (default): your model answers, Gemini is the backup. "last": the reverse.
  priority: (process.env.SELF_HOSTED_PRIORITY || "first").toLowerCase() === "last" ? "last" : "first",
  maxTokens: Number(process.env.SELF_HOSTED_MAX_TOKENS) || 4096,
};

export const SELF_ENABLED = Boolean(SELF.baseUrl);
export const SELF_ID = "self-hosted";

// Gemini-style contents -> OpenAI-style messages
export function toOpenAIMessages(systemPrompt, contents) {
  const messages = [{ role: "system", content: systemPrompt }];
  for (const c of contents) {
    const role = c.role === "model" ? "assistant" : "user";
    const images = c.parts.filter((p) => p.inlineData);
    const text = c.parts
      .filter((p) => p.text)
      .map((p) => p.text)
      .join("\n");
    if (role === "user" && images.length) {
      messages.push({
        role,
        content: [
          ...images.map((p) => ({
            type: "image_url",
            image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
          })),
          { type: "text", text: text || "Describe this image." },
        ],
      });
    } else {
      messages.push({ role, content: text });
    }
  }
  return messages;
}

// Streams a reply. Yields objects shaped like Gemini chunks ({ text }) so the
// chat route can treat both providers the same way.
export async function* streamSelfHosted({ systemPrompt, contents, signal }) {
  const res = await fetch(`${SELF.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SELF.apiKey ? { Authorization: `Bearer ${SELF.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: SELF.model,
      messages: toOpenAIMessages(systemPrompt, contents),
      stream: true,
      max_tokens: SELF.maxTokens,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    const err = new Error(detail.slice(0, 500) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let inThink = false; // hide <think>…</think> reasoning some servers send as text

  const visible = (text) => {
    let out = "";
    let rest = text;
    while (rest) {
      if (inThink) {
        const end = rest.indexOf("</think>");
        if (end === -1) return out;
        inThink = false;
        rest = rest.slice(end + 8);
      } else {
        const start = rest.indexOf("<think>");
        if (start === -1) return out + rest;
        out += rest.slice(0, start);
        inThink = true;
        rest = rest.slice(start + 7);
      }
    }
    return out;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) {
        const err = new Error(json.error.message || JSON.stringify(json.error));
        err.status = json.error.code || 500;
        throw err;
      }
      // delta.content = the answer; delta.reasoning_content (if any) is skipped
      const text = visible(json.choices?.[0]?.delta?.content || "");
      if (text) yield { text };
    }
  }
}
