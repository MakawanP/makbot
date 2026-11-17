"use client";

// Saved conversations live in each visitor's own browser (localStorage).
// Nothing is stored on the server, so chats stay private to that device.

const KEY = "makbot-conversations-v1";
const MAX_CONVERSATIONS = 50;

export function loadConversations() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveConversations(list) {
  try {
    const trimmed = [...list]
      .filter((c) => c.messages?.length)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS);
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // storage full or blocked (e.g. private mode): history just won't persist
  }
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
