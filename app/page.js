"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { VoiceSession } from "@/lib/voice";
import {
  loadConversations,
  saveConversations,
  newId,
  titleFrom,
  groupLabel,
} from "@/lib/history";
import { prepareImage, dataUrlToPart, MAX_IMAGES } from "@/lib/images";

const STATUS_LABEL = {
  idle: "Tap to talk",
  connecting: "Connecting…",
  listening: "Listening…",
  speaking: "Makbot is speaking…",
};

export default function Home() {
  const [mode, setMode] = useState("text"); // "text" | "voice"
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null); // null = fresh, unsaved chat
  const [hydrated, setHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile only
  const [armedDelete, setArmedDelete] = useState(null);

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState([]); // images waiting to be sent
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("idle");

  const voiceRef = useRef(null);
  const voiceConvRef = useRef(null); // conversation the voice session writes to
  const turnRef = useRef({ user: null, bot: null }); // ids of the live voice bubbles
  const bottomRef = useRef(null);

  const active = conversations.find((c) => c.id === activeId) || null;
  const messages = active?.messages || [];
  const voiceActive = voiceStatus !== "idle";
  const busy = loading || voiceActive;

  // ---------- Load / save ----------
  useEffect(() => {
    const saved = loadConversations();
    setConversations(saved);
    if (saved.length) setActiveId(saved[0].id); // reopen the most recent chat
    try {
      const pw = localStorage.getItem("makbot-password");
      if (pw) setPassword(pw);
    } catch {}
    setHydrated(true);
    return () => voiceRef.current?.stop();
  }, []);

  useEffect(() => {
    if (hydrated) saveConversations(conversations);
  }, [conversations, hydrated]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ---------- Conversation helpers ----------
  // Returns the active conversation id, creating a new conversation if needed.
  function ensureConversation() {
    if (activeId && conversations.some((c) => c.id === activeId)) return activeId;
    const id = newId();
    const now = Date.now();
    setConversations((prev) => [
      { id, title: "New chat", messages: [], createdAt: now, updatedAt: now },
      ...prev,
    ]);
    setActiveId(id);
    return id;
  }

  // Update the messages of one specific conversation (safe while streaming).
  function updateMessages(convId, updater) {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        const next = typeof updater === "function" ? updater(c.messages) : updater;
        return { ...c, messages: next, title: titleFrom(next), updatedAt: Date.now() };
      })
    );
  }

  function newChat() {
    if (busy) return;
    setActiveId(null);
    setInput("");
    setError("");
    setSidebarOpen(false);
  }

  function openChat(id) {
    if (busy) return;
    setActiveId(id);
    setError("");
    setArmedDelete(null);
    setSidebarOpen(false);
  }

  function deleteChat(id) {
    if (armedDelete !== id) {
      setArmedDelete(id); // first click arms, second click deletes
      return;
    }
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
    setArmedDelete(null);
  }

  const grouped = useMemo(() => {
    const sorted = [...conversations]
      .filter((c) => c.messages.length)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const groups = [];
    for (const c of sorted) {
      const label = groupLabel(c.updatedAt);
      let g = groups.find((x) => x.label === label);
      if (!g) groups.push((g = { label, items: [] }));
      g.items.push(c);
    }
    return groups;
  }, [conversations]);

  // ---------- Password ----------
  function rememberPassword() {
    try {
      if (password) localStorage.setItem("makbot-password", password);
    } catch {}
    setNeedsPassword(false);
  }

  function askForPassword() {
    setNeedsPassword(true);
    setError("Enter the password to chat.");
  }

  // ---------- Text mode ----------
  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if ((!text && attachments.length === 0) || loading) return;

    const sentImages = attachments;
    const convId = ensureConversation();
    const userMsg = { id: newId(), role: "user", content: text };
    if (sentImages.length) userMsg.images = sentImages.map((a) => a.thumb);
    const history = [...messages, userMsg];
    const replyId = newId();
    updateMessages(convId, [...history, { id: replyId, role: "assistant", content: "" }]);
    setInput("");
    setAttachments([]);
    setLoading(true);
    setError("");

    // Full-size images for this message; small thumbnails for earlier ones
    const payload = history.map((m, i) => {
      const out = { role: m.role, content: m.content };
      const imgs = i === history.length - 1 ? sentImages.map((a) => a.full) : m.images;
      if (imgs?.length) out.images = imgs.map(dataUrlToPart);
      return out;
    });

    try {
      const bodyText = JSON.stringify({ messages: payload, password });
      if (bodyText.length > 4_000_000) {
        throw new Error("Those images are too large to send together. Try fewer images.");
      }
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyText,
      });

      if (res.status === 401) {
        updateMessages(convId, history.slice(0, -1));
        setInput(text);
        setAttachments(sentImages);
        askForPassword();
        return;
      }
      if (!res.ok || !res.body) throw new Error(await res.text());
      rememberPassword();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let reply = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        reply += decoder.decode(value, { stream: true });
        updateMessages(convId, [...history, { id: replyId, role: "assistant", content: reply }]);
      }
    } catch (err) {
      updateMessages(convId, history);
      if (!text && sentImages.length) setAttachments(sentImages);
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  // ---------- Images ----------
  async function addFiles(fileList) {
    const files = [...(fileList || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) {
      setError(`You can attach up to ${MAX_IMAGES} images per message.`);
      return;
    }
    if (files.length > room) setError(`Only the first ${room} image(s) were added (max ${MAX_IMAGES}).`);
    else setError("");
    try {
      const prepared = await Promise.all(files.slice(0, room).map(prepareImage));
      setAttachments((prev) => [...prev, ...prepared].slice(0, MAX_IMAGES));
    } catch (err) {
      setError(err.message);
    }
  }

  function onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      addFiles(files);
    }
  }

  // ---------- Voice mode ----------
  // Appends live transcript text to the current voice bubble for that speaker.
  function appendVoice(role, text) {
    const convId = voiceConvRef.current;
    if (!convId) return;
    const key = role === "user" ? "user" : "bot";
    const other = key === "user" ? "bot" : "user";
    let id = turnRef.current[key];
    if (!id) {
      // start a new bubble; the other speaker's bubble is now finished
      id = newId();
      turnRef.current[key] = id;
      turnRef.current[other] = null;
      updateMessages(convId, (prev) => [...prev, { id, role, content: text, voice: true }]);
      return;
    }
    updateMessages(convId, (prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: m.content + text } : m))
    );
  }

  async function startVoice() {
    setError("");
    turnRef.current = { user: null, bot: null };
    voiceConvRef.current = ensureConversation();
    const v = new VoiceSession({
      onStatus: setVoiceStatus,
      onUserText: (t) => appendVoice("user", t),
      onBotText: (t) => appendVoice("assistant", t),
      onTurnComplete: () => {
        turnRef.current = { user: null, bot: null };
      },
      onError: (msg) => setError(msg),
    });
    voiceRef.current = v;
    try {
      await v.start(password);
      rememberPassword();
    } catch (err) {
      v.stop();
      voiceRef.current = null;
      if (err.status === 401) askForPassword();
      else if (err.name === "NotAllowedError")
        setError("Microphone access was blocked. Allow it in your browser and try again.");
      else setError(err.message || "Could not start voice.");
    }
  }

  function stopVoice() {
    voiceRef.current?.stop();
    voiceRef.current = null;
  }

  function switchMode(next) {
    if (next === mode) return;
    if (next === "text") stopVoice();
    setError("");
    setMode(next);
  }

  return (
    <div className="app">
      {/* ---------- Sidebar ---------- */}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <button className="newchat" onClick={newChat} disabled={busy}>
          + New chat
        </button>
        <nav className="history">
          {hydrated && grouped.length === 0 && (
            <p className="muted small pad">Your chats will appear here.</p>
          )}
          {grouped.map((g) => (
            <div key={g.label} className="group">
              <div className="grouplabel">{g.label}</div>
              {g.items.map((c) => (
                <div
                  key={c.id}
                  className={`item ${c.id === activeId ? "active" : ""} ${busy ? "locked" : ""}`}
                  onClick={() => openChat(c.id)}
                  onMouseLeave={() => armedDelete === c.id && setArmedDelete(null)}
                  title={c.title}
                >
                  <span className="itemtitle">{c.title}</span>
                  <button
                    className={`del ${armedDelete === c.id ? "armed" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteChat(c.id);
                    }}
                    aria-label="Delete chat"
                    title={armedDelete === c.id ? "Click again to delete" : "Delete chat"}
                  >
                    {armedDelete === c.id ? "Delete?" : "×"}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </nav>
        <p className="muted small pad note">Chats are saved in this browser only.</p>
      </aside>
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

      {/* ---------- Main ---------- */}
      <main className="shell">
        <header className="top">
          <button
            className="ghost menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open chat history"
          >
            ☰
          </button>
          <div className="logo">M</div>
          <h1>Makbot</h1>
          <div className="toggle" role="tablist">
            <button className={mode === "text" ? "on" : ""} onClick={() => switchMode("text")}>
              Text
            </button>
            <button className={mode === "voice" ? "on" : ""} onClick={() => switchMode("voice")}>
              Voice
            </button>
          </div>
        </header>

        <section className="chat">
          {messages.length === 0 && (
            <div className="empty">
              <h2>Hi, I&apos;m Makbot.</h2>
              <p>
                {mode === "text" ? "Type a message to start." : "Tap the mic and start talking."}
              </p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={m.id || i} className={`msg ${m.role}`}>
              <div className="bubble">
                {m.images?.length > 0 && (
                  <div className="imgs">
                    {m.images.map((src, j) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={j} src={src} alt="Attached image" />
                    ))}
                  </div>
                )}
                {m.voice && <span className="tag">🎙</span>}
                {m.content || (loading && i === messages.length - 1 ? "…" : "")}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </section>

        {error && <div className="error">{error}</div>}

        {needsPassword && (
          <div className="pwrow">
            <input
              type="password"
              className="pw"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}

        {mode === "text" ? (
          <form
            className={`composer ${dragging ? "dragging" : ""}`}
            onSubmit={send}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            {attachments.length > 0 && (
              <div className="attachments">
                {attachments.map((a) => (
                  <div key={a.id} className="chip">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.thumb} alt="Attachment preview" />
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      aria-label="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/heic"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="attach"
              onClick={() => fileRef.current?.click()}
              disabled={loading || attachments.length >= MAX_IMAGES}
              aria-label="Attach image"
              title="Attach image (or paste / drag one in)"
            >
              📎
            </button>
            <textarea
              onPaste={onPaste}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) send(e);
              }}
              placeholder={attachments.length ? "Ask about the image…" : "Message Makbot…"}
              rows={1}
            />
            <button type="submit" disabled={loading || (!input.trim() && !attachments.length)}>
              {loading ? "…" : "Send"}
            </button>
          </form>
        ) : (
          <div className="voicebar">
            <button
              className={`mic ${voiceStatus}`}
              onClick={voiceActive ? stopVoice : startVoice}
              disabled={voiceStatus === "connecting"}
              aria-label={voiceActive ? "Stop voice chat" : "Start voice chat"}
            >
              {voiceActive ? "■" : "🎙"}
            </button>
            <div className="voicestatus">
              {STATUS_LABEL[voiceStatus]}
              {voiceActive && <span className="hint">Tap to end</span>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
