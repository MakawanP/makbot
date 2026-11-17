"use client";

// Browser-side voice session for the Gemini Live API.
// Mic audio -> 16 kHz 16-bit PCM -> Gemini. Gemini audio (24 kHz PCM) -> speakers.
import { GoogleGenAI, Modality } from "@google/genai";

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

// Audio worklet: downsamples the mic to 16 kHz and emits Int16 chunks (~100 ms).
const WORKLET_CODE = `
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${INPUT_RATE};
    this.pos = 0;
    this.out = [];
    this.chunk = ${INPUT_RATE / 10};
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    while (this.pos < input.length) {
      const s = Math.max(-1, Math.min(1, input[Math.floor(this.pos)]));
      this.out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    if (this.out.length >= this.chunk) {
      this.port.postMessage(Int16Array.from(this.out).buffer, []);
      this.out = [];
    }
    return true;
  }
}
registerProcessor("mic-processor", MicProcessor);
`;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class VoiceSession {
  /**
   * callbacks: {
   *   onStatus(status)            "connecting" | "listening" | "speaking" | "idle"
   *   onUserText(text)            partial transcript of what you said
   *   onBotText(text)             partial transcript of Makbot's reply
   *   onTurnComplete()
   *   onError(message)
   * }
   */
  constructor(callbacks) {
    this.cb = callbacks;
    this.session = null;
    this.micStream = null;
    this.micCtx = null;
    this.playCtx = null;
    this.nextPlayTime = 0;
    this.sources = new Set();
    this.closed = false;
  }

  async start(password, { humanize = false, mode = "default", search = false } = {}) {
    this.cb.onStatus?.("connecting");

    // 1. Ask our server for a short-lived token
    const res = await fetch("/api/live-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, humanize, mode, search }),
    });
    if (!res.ok) {
      const err = new Error(await res.text());
      err.status = res.status;
      throw err;
    }
    const { token, model } = await res.json();

    // 2. Microphone + audio playback (must happen after a user click)
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    this.micCtx = new AudioContext();
    this.playCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
    await this.playCtx.resume();

    const workletUrl = URL.createObjectURL(
      new Blob([WORKLET_CODE], { type: "application/javascript" })
    );
    await this.micCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    // 3. Connect to Gemini Live using the token
    const ai = new GoogleGenAI({
      apiKey: token,
      httpOptions: { apiVersion: "v1beta" },
    });

    this.session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {},
        onmessage: (msg) => this.handleMessage(msg),
        onerror: (e) => this.cb.onError?.(e?.message || "Voice connection error."),
        onclose: (e) => {
          if (!this.closed) {
            this.cb.onError?.(
              e?.reason ? `Voice session ended: ${e.reason}` : "Voice session ended."
            );
            this.stop();
          }
        },
      },
    });

    // 4. Stream mic audio to Gemini
    const source = this.micCtx.createMediaStreamSource(this.micStream);
    this.worklet = new AudioWorkletNode(this.micCtx, "mic-processor");
    this.worklet.port.onmessage = (e) => {
      if (!this.session || this.closed) return;
      this.session.sendRealtimeInput({
        audio: { data: toBase64(e.data), mimeType: `audio/pcm;rate=${INPUT_RATE}` },
      });
    };
    source.connect(this.worklet);
    // Keep the graph running without echoing the mic to the speakers
    const mute = this.micCtx.createGain();
    mute.gain.value = 0;
    this.worklet.connect(mute).connect(this.micCtx.destination);

    this.cb.onStatus?.("listening");
  }

  handleMessage(msg) {
    const content = msg.serverContent;
    if (!content) return;

    if (content.interrupted) this.stopPlayback();

    if (content.inputTranscription?.text) {
      this.cb.onUserText?.(content.inputTranscription.text);
    }
    if (content.outputTranscription?.text) {
      this.cb.onBotText?.(content.outputTranscription.text);
    }

    const parts = content.modelTurn?.parts || [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (data && part.inlineData.mimeType?.startsWith("audio/")) {
        this.playChunk(data);
      }
    }

    if (content.turnComplete) this.cb.onTurnComplete?.();
  }

  playChunk(b64) {
    const ctx = this.playCtx;
    if (!ctx) return;
    const pcm = new Int16Array(fromBase64(b64));
    const buffer = ctx.createBuffer(1, pcm.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.nextPlayTime);
    src.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;

    this.sources.add(src);
    this.cb.onStatus?.("speaking");
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0 && !this.closed) this.cb.onStatus?.("listening");
    };
  }

  stopPlayback() {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {}
    }
    this.sources.clear();
    this.nextPlayTime = 0;
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.stopPlayback();
    try {
      this.session?.close();
    } catch {}
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micCtx?.close().catch(() => {});
    this.playCtx?.close().catch(() => {});
    this.session = null;
    this.cb.onStatus?.("idle");
  }
}
