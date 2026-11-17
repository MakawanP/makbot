"use client";

// Saved conversations live in each visitor's own browser (localStorage).
// Nothing is stored on the server, so chats stay private to that device.

const KEY = "makbot-conversations-v1";
const MAX_CONVERSATIONS = 50;

export function loadConversations() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    // Drop empty replies left behind if the page was closed mid-answer
    return list
      .map((c) => ({
        ...c,
        messages: (c.messages || []).filter(
          (m) => m.role !== "assistant" || (m.content && m.content.trim()) || m.genImages?.length
        ),
      }))
      .filter((c) => c.messages.length);
  } catch {
    return [];
  }
}

export function saveConversations(list) {
  let trimmed = [...list]
    .filter((c) => c.messages?.length)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);

  // Browsers allow ~5 MB here. If it's full, drop pictures from the oldest
  // chats first (keeping the text), then drop the oldest chats.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      localStorage.setItem(KEY, JSON.stringify(trimmed));
      return;
    } catch {
      const idx = findOldestWithImages(trimmed);
      if (idx !== -1) {
        trimmed[idx] = stripImages(trimmed[idx]);
      } else if (trimmed.length > 1) {
        trimmed = trimmed.slice(0, -1);
      } else {
        return; // storage blocked (e.g. private mode): history just won't persist
      }
    }
  }
}

function findOldestWithImages(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].messages.some((m) => m.images?.length || m.genImages?.length)) return i;
  }
  return -1;
}

function stripImages(conv) {
  return {
    ...conv,
    messages: conv.messages.map((m) => {
      if (!m.images?.length && !m.genImages?.length) return m;
      const { images, genImages, ...rest } = m;
      return { ...rest, imagesRemoved: (images?.length || 0) + (genImages?.length || 0) };
    }),
  };
}

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function titleFrom(messages) {
  const first = messages.find((m) => m.role === "user" && m.content?.trim());
  if (!first) return "New chat";
  const text = first.content.trim().replace(/\s+/g, " ");
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
}

// "Today", "Yesterday", "Previous 7 days", "Older"
export function groupLabel(ts) {
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - day) return "Yesterday";
  if (ts >= startOfToday - 7 * day) return "Previous 7 days";
  return "Older";
}
