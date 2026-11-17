"use client";

import { useEffect, useRef, useState } from "react";
import { VoiceSession } from "@/lib/voice";

const STATUS_LABEL = {
  idle: "Tap to talk",
  connecting: "Connecting…",
  listening: "Listening…",
  speaking: "Makbot is speaking…",
};

export default function Home() {
  const [mode, setMode] = useState("text"); // "text" | "voice"
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("idle");

  const voiceRef = useRef(null);
  const turnRef = useRef({ user: null, bot: null }); // ids of the live voice bubbles
  const bottomRef = useRef(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("makbot-password");
      if (saved) setPassword(saved);
    } catch {}
    return () => voiceRef.current?.stop();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
    if (!text || loading) return;

    const history = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, password }),
      });

      if (res.status === 401) {
        setMessages(history.slice(0, -1));
        setInput(text);
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
        setMessages([...history, { role: "assistant", content: reply }]);
      }
    } catch (err) {
      setMessages(history);
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  // ---------- Voice mode ----------
  // Appends live transcript text to the current voice bubble for that speaker.
  function appendVoice(role, text) {
    const key = role === "user" ? "user" : "bot";
    const other = key === "user" ? "bot" : "user";
    let id = turnRef.current[key];
    if (!id) {
      // start a new bubble; the other speaker's bubble is now finished
      id = `${Date.now()}-${Math.random()}`;
      turnRef.current[key] = id;
      turnRef.current[other] = null;
      setMessages((prev) => [...prev, { id, role, content: text, voice: true }]);
      return;
    }
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: m.content + text } : m))
    );
  }

  async function startVoice() {
    setError("");
    turnRef.current = { user: null, bot: null };
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

  const voiceActive = voiceStatus !== "idle";

  return (
    <main className="shell">
      <header className="top">
        <div className="logo">M</div>
        <h1>Makbot</h1>
        <div className="toggle" role="tablist">
          <button
            className={mode === "text" ? "on" : ""}
            onClick={() => switchMode("text")}
          >
            Text
          </button>
          <button
            className={mode === "voice" ? "on" : ""}
            onClick={() => switchMode("voice")}
          >
            Voice
          </button>
        </div>
        {messages.length > 0 && !voiceActive && (
          <button className="ghost" onClick={() => setMessages([])}>
            New chat
          </button>
        )}
      </header>

      <section className="chat">
        {messages.length === 0 && (
          <div className="empty">
            <h2>Hi, I&apos;m Makbot.</h2>
            <p>
              {mode === "text"
                ? "Type a message to start."
                : "Tap the mic and start talking."}
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">
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
        <form className="composer" onSubmit={send}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) send(e);
            }}
            placeholder="Message Makbot…"
            rows={1}
          />
          <button type="submit" disabled={loading || !input.trim()}>
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
  );
}
