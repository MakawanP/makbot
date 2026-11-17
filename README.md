# Makbot

A chat assistant powered by Google Gemini, built with Next.js and hosted on Vercel.

**Live:** https://makbot-six.vercel.app

## Features

- **Text chat**: streamed replies with formatting (lists, code blocks, tables, links)
- **Voice chat**: talk and Makbot talks back in real time (`gemini-3.8-live`), with a live transcript
- **Image analysis**: attach, paste or drag in up to 4 images per message and ask about them
- **Humanizer**: a switch that makes replies plain, direct and conversational (no fluff,
  no jargon, no dashes or emojis). Works in text and voice
- **Chat history**: conversations are saved in each visitor's browser, listed in a sidebar
  grouped by date, and reopen when they come back
- **Reply tools**: Stop while generating, Copy and Regenerate under each reply
- **Starter suggestions** on the empty screen
- **Automatic model fallback**: if a model is busy or rate-limited, text chat moves to the next one
- **Optional password** to keep strangers from using your API credits

## How it works

| File | What it does |
|---|---|
| `app/page.js` | The chat interface |
| `app/api/chat/route.js` | Text chat. Runs on the server and calls Gemini with your key, trying fallback models in order |
| `app/api/live-token/route.js` | Voice chat. Gives the browser a short-lived, single-use token locked to the Live model, so the browser connects straight to Gemini Live. Your real key never leaves the server |
| `lib/config.js` | Makbot's personality (`SYSTEM_PROMPT`), the Humanizer rules (`HUMANIZER_PROMPT`), model list and password check |
| `lib/voice.js` | Microphone capture, audio playback and the Live connection |
| `lib/images.js` | Resizes images in the browser before upload |
| `lib/history.js` | Saves and loads chat history in the browser |

## Run locally

```bash
npm install
cp .env.example .env.local   # then paste your Gemini key into .env.local
npm run dev
```

Open http://localhost:3000. Voice mode needs microphone permission. Browsers allow the
mic on `localhost` and on HTTPS sites, so it works on Vercel.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project**, then import the repo.
3. Under **Environment Variables**, add:
   - `GEMINI_API_KEY`: your key from Google AI Studio (required)
   - `MAKBOT_PASSWORD`: optional; visitors must enter it to chat
   - `GEMINI_TEXT_MODEL`: optional; the text model to try first
   - `GEMINI_TEXT_MODELS`: optional comma-separated fallback list for text chat
   - `GEMINI_LIVE_MODEL`: optional; overrides the voice model
4. Click **Deploy**.

After that, every push to `main` redeploys automatically. If you change environment
variables, redeploy so they take effect.

## Models

| Use | Default |
|---|---|
| Text (tried in order) | `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3.5-flash-lite` |
| Voice | `gemini-3.8-live` |

## Notes

- Chat history lives in each visitor's browser only. It doesn't sync across devices, and
  clearing browser data removes it.
- Voice sessions last up to 30 minutes per tap. Tap the mic again to start a new one.
- Use headphones for voice; speakers can cause echo.
- Set a budget alert in Google AI Studio or Google Cloud billing.
