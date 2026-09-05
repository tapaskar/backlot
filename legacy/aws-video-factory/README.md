# legacy/aws-video-factory — "Prime Speaks" daily YouTube pipeline (AWS / TypeScript)

This is the **original AWS + TypeScript** implementation of the daily "Prime Speaks"
market-analysis video pipeline, kept here as the **reference to port into backlot's
GCP-native build**.

## What it does (daily, NSE trading days)
`factory/pipeline.ts` runs 8 stages at ~16:05 IST: fetch market + OHLC (Yahoo) →
generate + validate script (**Gemini 2.5 Flash** primary; Bedrock Claude/Nova fallback) →
TTS (Amazon Polly, voice Kajal, + speech marks) → chart screenshots (Puppeteer +
TradingView) → compose MP4 + thumbnails (FFmpeg) → upload to YouTube (Data API v3,
@AalsitraderYT) → set thumbnail → publish podcast MP3/RSS + homepage feed.
Triggered today by macOS launchd; health-monitored by an AWS Lambda.

Full architecture + the Google Cloud / Gemini migration mapping:
`trading-dashboard/docs/prime-speaks-youtube-pipeline.md`.

## Secrets — NOT included, provide your own
- The previously **hardcoded Gemini API key was removed** from `factory/llm.ts`
  (now `process.env.GEMINI_API_KEY || ''`). **Rotate that key** and supply it via
  env / Secret Manager.
- `.youtube-token.json` and `.client_secret.json` (YouTube OAuth) are **excluded**.
  Provide your own and keep them out of git.
- Run `npm install` to restore `node_modules/` (excluded).
