"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { VoiceSession } from "@/lib/voice";
import {
  loadConversations,
  saveConversations,
  newId,
  titleFrom,
  groupLabel,
} from "@/lib/history";
import { prepareImage, dataUrlToPart, compressDataUrl, MAX_IMAGES } from "@/lib/images";

const SUGGESTIONS = [
  { label: "📰 What's in the news today?", text: "What are the top news stories today?", search: true },
  { label: "🎨 Create an image", create: true },
  { label: "📷 Analyze an image", image: true },
  { label: "✉️ Write an email", text: "Help me write a short, polite email asking for a deadline extension." },
];

const MODE_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "fun", label: "😄 Fun" },
  { value: "expert", label: "🎓 Expert" },
  { value: "brief", label: "⚡ Brief" },
];

const META_MARKER = "\u001eMAKBOT_META";

// Links in replies open in a new tab
const MD_COMPONENTS = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

const STATUS_LABEL = {
  idle: "Tap to talk",
  connecting: "Connecting…",
  listening: "Listening…",
  speaking: "Makbot is speaking…",
};

export default function Home() {
  const [chatMode, setChatMode] = useState("text"); // "text" | "voice"
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null); // null = fresh, unsaved chat
  const [hydrated, setHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile only
  const [armedDelete, setArmedDelete] = useState(null);

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState([]); // images waiting to be sent
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const abortRef = useRef(null);
  const [humanize, setHumanize] = useState(false);
  const [mode, setPersona] = useState("default"); // personality mode
  const [search, setSearch] = useState(true); // web search on/off
  const [imageMode, setImageMode] = useState(false); // next message creates an image
  const inputRef = useRef(null);
  const [copiedId, setCopiedId] = useState(null);
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
      setHumanize(localStorage.getItem("makbot-humanize") === "1");
      const savedMode = localStorage.getItem("makbot-mode");
      if (savedMode && MODE_OPTIONS.some((m) => m.value === savedMode)) setPersona(savedMode);
      setSearch(localStorage.getItem("makbot-search") !== "0");
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
  // Streams a reply for `history` (which must end with a user message).
  // fullImages: full-size data URLs for the last user message, if any.
  async function runChat(convId, history, fullImages = null) {
    const replyId = newId();
    const humanized = humanize;
    const replyMsg = (content, extra = {}) => ({
      id: replyId,
      role: "assistant",
      content,
      humanized,
      mode: mode !== "default" ? mode : undefined,
      ...extra,
    });
    updateMessages(convId, [...history, replyMsg("")]);
    setLoading(true);
    setError("");

    // Full-size images for the newest message; small thumbnails for earlier ones
    const payload = history.map((m, i) => {
      const out = {
        role: m.role,
        content: m.content || (m.genImages?.length ? "[Makbot created an image here]" : ""),
      };
      const imgs = i === history.length - 1 && fullImages ? fullImages : m.images;
      if (imgs?.length) out.images = imgs.map(dataUrlToPart);
      return out;
    });

    const controller = new AbortController();
    abortRef.current = controller;
    let reply = "";

    try {
      const bodyText = JSON.stringify({ messages: payload, password, humanize: humanized, mode, search });
      if (bodyText.length > 4_000_000) {
        throw new Error("Those images are too large to send together. Try fewer images.");
      }
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyText,
        signal: controller.signal,
      });

      if (res.status === 401) {
        updateMessages(convId, history);
        askForPassword();
        return { unauthorized: true };
      }
      if (!res.ok || !res.body) throw new Error(await res.text());
      rememberPassword();
      const answeredBy = res.headers.get("x-makbot-model") || "";
      const selfHosted = answeredBy.startsWith("self:") ? answeredBy.slice(5) : undefined;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        reply = raw.split(META_MARKER)[0];
        updateMessages(convId, [...history, replyMsg(reply, { selfHosted })]);
      }
      // Sources from web search arrive after the text
      const metaAt = raw.indexOf(META_MARKER);
      if (metaAt !== -1) {
        try {
          const meta = JSON.parse(raw.slice(metaAt + META_MARKER.length));
          updateMessages(convId, [
            ...history,
            replyMsg(reply, {
              selfHosted,
              sources: meta.sources?.length ? meta.sources : undefined,
              searchHtml: meta.searchHtml || undefined,
              searchSkipped: meta.searchSkipped || undefined,
            }),
          ]);
        } catch {}
      }
      return { ok: true };
    } catch (err) {
      if (err.name === "AbortError") {
        // Stopped by the user: keep whatever arrived so far
        updateMessages(convId, reply.trim() ? [...history, replyMsg(reply)] : history);
        return { stopped: true };
      }
      updateMessages(convId, history);
      setError(err.message || "Something went wrong.");
      return { failed: true };
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  // Creates (or edits) an image for the last user message in `history`.
  async function runImage(convId, history, prompt, inputImages = []) {
    const replyId = newId();
    updateMessages(convId, [
      ...history,
      { id: replyId, role: "assistant", content: "", generating: true },
    ]);
    setLoading(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, images: inputImages.map(dataUrlToPart), password }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        updateMessages(convId, history);
        askForPassword();
        return { unauthorized: true };
      }
      if (!res.ok) throw new Error(await res.text());
      rememberPassword();
      const data = await res.json();
      const genImages = await Promise.all(
        (data.images || []).map((d) => compressDataUrl(d).catch(() => d))
      );
      updateMessages(convId, [
        ...history,
        {
          id: replyId,
          role: "assistant",
          content: data.text || (genImages.length ? "" : "No image was created."),
          genImages: genImages.length ? genImages : undefined,
        },
      ]);
      return { ok: true };
    } catch (err) {
      updateMessages(convId, history);
      if (err.name !== "AbortError") setError(err.message || "Couldn't create the image.");
      return { failed: true };
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  async function sendMessage(text, images = [], opts = {}) {
    text = (text || "").trim();
    if ((!text && images.length === 0) || loading) return;
    const creating = opts.create ?? imageMode;
    if (creating && !text) {
      setError("Describe the image you want to create.");
      return;
    }

    const convId = ensureConversation();
    const userMsg = { id: newId(), role: "user", content: text };
    if (images.length) userMsg.images = images.map((a) => a.thumb);
    if (creating) userMsg.kind = "image";
    const history = [...messages, userMsg];
    setInput("");
    setAttachments([]);

    const result = creating
      ? await runImage(convId, history, text, images.map((a) => a.full))
      : await runChat(convId, history, images.length ? images.map((a) => a.full) : null);
    if (result?.unauthorized || (result?.failed && !text && images.length)) {
      // put the message back so they can resend it
      updateMessages(convId, messages);
      setInput(text);
      setAttachments(images);
    }
  }

  function send(e) {
    e.preventDefault();
    sendMessage(input, attachments);
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Re-answer the last user message
  function regenerate() {
    if (busy || !active) return;
    let lastUser = -1;
    messages.forEach((m, i) => {
      if (m.role === "user") lastUser = i;
    });
    if (lastUser === -1) return;
    const u = messages[lastUser];
    const history = messages.slice(0, lastUser + 1);
    if (u.kind === "image") runImage(active.id, history, u.content, u.images || []);
    else runChat(active.id, history);
  }

  async function copyText(id, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      setError("Couldn't copy. Select the text and copy it manually.");
    }
  }

  function changeMode(next) {
    setPersona(next);
    try {
      localStorage.setItem("makbot-mode", next);
    } catch {}
  }

  function toggleSearch() {
    const next = !search;
    setSearch(next);
    try {
      localStorage.setItem("makbot-search", next ? "1" : "0");
    } catch {}
  }

  function toggleHumanize() {
    const next = !humanize;
    setHumanize(next);
    try {
      localStorage.setItem("makbot-humanize", next ? "1" : "0");
    } catch {}
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
      await v.start(password, { humanize, mode, search });
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
    if (next === chatMode) return;
    if (next === "text") stopVoice();
    setError("");
    setChatMode(next);
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
          <select
            className="modepick"
            value={mode}
            onChange={(e) => changeMode(e.target.value)}
            disabled={busy}
            aria-label="Personality mode"
            title="Personality mode"
          >
            {MODE_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            className={`humanize ${humanize ? "on" : ""}`}
            onClick={toggleHumanize}
            disabled={busy}
            role="switch"
            aria-checked={humanize}
            title="Humanizer: plain, direct, conversational replies"
          >
            <span className="knob" />
            Humanizer
          </button>
          <div className="toggle" role="tablist">
            <button className={chatMode === "text" ? "on" : ""} onClick={() => switchMode("text")}>
              Text
            </button>
            <button className={chatMode === "voice" ? "on" : ""} onClick={() => switchMode("voice")}>
              Voice
            </button>
          </div>
        </header>

        <section className="chat">
          {messages.length === 0 && (
            <div className="empty">
              <h2>Hi, I&apos;m Makbot.</h2>
              <p>
                {chatMode === "text" ? "Type a message to start." : "Tap the mic and start talking."}
              </p>
              {chatMode === "text" && (
                <div className="suggestions">
                  {SUGGESTIONS.map((sug) => (
                    <button
                      key={sug.label}
                      className="suggestion"
                      onClick={() => {
                        if (sug.image) {
                          setImageMode(false);
                          fileRef.current?.click();
                        } else if (sug.create) {
                          setImageMode(true);
                          inputRef.current?.focus();
                        } else {
                          if (sug.search && !search) toggleSearch();
                          sendMessage(sug.text, [], { create: false });
                        }
                      }}
                      disabled={loading}
                    >
                      {sug.label}
                    </button>
                  ))}
                </div>
              )}
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
                {m.kind === "image" && <span className="tag">🎨</span>}
                {m.generating && <span className="dots">Creating image… this can take 10 to 30 seconds</span>}
                {m.genImages?.length > 0 && (
                  <div className="genimgs">
                    {m.genImages.map((src, j) => (
                      <a key={j} href={src} download={`makbot-image-${j + 1}.jpg`} title="Click to download">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt="Image created by Makbot" />
                      </a>
                    ))}
                  </div>
                )}
                {m.imagesRemoved > 0 && (
                  <div className="muted small">[{m.imagesRemoved} image(s) removed to free up storage]</div>
                )}
                {m.role === "assistant" && m.content ? (
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                      {m.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  m.content ||
                  (loading && i === messages.length - 1 && !m.generating ? (
                    <span className="dots">{search && !m.genImages ? "Thinking… (may search the web)" : "…"}</span>
                  ) : (
                    ""
                  ))
                )}
              </div>
              {m.sources?.length > 0 && (
                <div className="sources">
                  <span className="srclabel">Sources</span>
                  {m.sources.map((src, j) => (
                    <a key={j} href={src.uri} target="_blank" rel="noopener noreferrer" title={src.title}>
                      {j + 1}. {src.title}
                    </a>
                  ))}
                </div>
              )}
              {m.searchSkipped && (
                <div className="muted small searchnote">
                  🌐 Web search wasn't available for this reply (Gemini quota), so it answered without it.
                </div>
              )}
              {m.searchHtml && (
                <iframe
                  className="searchchips"
                  title="Google Search suggestions"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  srcDoc={`<base target="_blank"><style>body{margin:0;background:transparent}</style>${m.searchHtml}`}
                />
              )}
              {m.role === "assistant" && (m.content || m.genImages?.length) && !(loading && i === messages.length - 1) && (
                <div className="actions">
                  {m.content && (
                    <button onClick={() => copyText(m.id, m.content)} title="Copy reply">
                      {copiedId === m.id ? "✓ Copied" : "Copy"}
                    </button>
                  )}
                  {i === messages.length - 1 && !m.voice && (
                    <button onClick={regenerate} disabled={busy} title="Get a new answer">
                      ↻ Regenerate
                    </button>
                  )}
                  {m.humanized && <span className="badge">Humanized</span>}
                  {m.selfHosted && (
                    <span className="badge self" title={`Answered by your own server (${m.selfHosted})`}>
                      Self-hosted
                    </span>
                  )}
                  {m.mode && <span className="badge alt">{MODE_OPTIONS.find((o) => o.value === m.mode)?.label}</span>}
                </div>
              )}
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

        {chatMode === "text" ? (
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
            <button
              type="button"
              className={`tool ${search ? "on" : ""}`}
              onClick={toggleSearch}
              aria-pressed={search}
              title={search ? "Web search is on" : "Web search is off"}
            >
              🌐
            </button>
            <button
              type="button"
              className={`tool ${imageMode ? "on create" : ""}`}
              onClick={() => setImageMode((v) => !v)}
              aria-pressed={imageMode}
              title={imageMode ? "Image mode: your next message creates an image" : "Create an image"}
            >
              🎨
            </button>
            <textarea
              ref={inputRef}
              onPaste={onPaste}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) send(e);
              }}
              placeholder={
                imageMode
                  ? attachments.length
                    ? "Describe how to change the image…"
                    : "Describe the image to create…"
                  : attachments.length
                    ? "Ask about the image…"
                    : "Message Makbot…"
              }
              rows={1}
            />
            {loading ? (
              <button type="button" className="stop" onClick={stop} title="Stop generating">
                ■ Stop
              </button>
            ) : (
              <button type="submit" disabled={!input.trim() && !attachments.length}>
                {imageMode ? "Create" : "Send"}
              </button>
            )}
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
