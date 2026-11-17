# Makbot

A chat assistant with two modes, powered by Google Gemini and ready for Vercel:

- **Text**: type and get streamed replies (`gemini-3.8-flash`)
- **Voice**: talk and Makbot talks back in real time (`gemini-3.8-live`), with a live transcript in the chat

## How it works

- `app/api/chat/route.js`: text chat. Runs on the server and calls Gemini with your key.
- `app/api/live-token/route.js`: voice chat. Gives the browser a short-lived, single-use token
  (locked to the Live model) so the browser can connect directly to Gemini Live.
  Your real key never leaves the server.
- `lib/voice.js`: microphone capture, audio playback and the Live connection.
- `lib/config.js`: Makbot's personality (`SYSTEM_PROMPT`), model names and password check.

## Run locally

```bash
npm install
cp .env.example .env.local   # then paste your Gemini key into .env.local
npm run dev
```

Open http://localhost:3000. Voice mode needs microphone permission. Browsers allow the
mic on `localhost` and on HTTPS sites, so it works on Vercel.

## Deploy to Vercel

1. Push this folder to a new GitHub repo.
2. In Vercel: **Add New → Project**, then import the repo.
3. Under **Environment Variables**, add:
   - `GEMINI_API_KEY`: your key (required)
   - `MAKBOT_PASSWORD`: optional; set it to keep strangers from using your credits
   - `GEMINI_TEXT_MODEL` / `GEMINI_LIVE_MODEL`: optional; override the default models
4. Click **Deploy**.

If you change environment variables later, redeploy so they take effect.

## Notes

- Voice sessions last up to 30 minutes per tap. Tap the mic again to start a new one.
- Use headphones for the best voice experience; speakers can cause echo.
- Set a budget alert in Google AI Studio / Google Cloud billing.
