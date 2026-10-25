# ariyont-video-mcp

HTML/JS canvas animatsiyani MP4 videoga aylantiradigan MCP server (Vercel serverless, Streamable HTTP, stateless).
Claude, Mistral Le Chat, Mistral Vibe, Codex va boshqa MCP mijozlar bilan ishlaydi.

- Endpoint: `POST /mcp` (→ `/api/index`), qo'llanma sahifasi: `/` (→ `/api/docs`)
- Tool'lar: `animation_guide`, `render_video`, `health`
- Quvur: `@sparticuz/chromium` + `puppeteer-core` → kadrlar (JPEG q0.95; `FRAME_FORMAT=png` bilan PNG) → `ffmpeg-static` (libx264, yuv420p, +faststart) → MP4
- Natija: Vercel Blob havolasi (tavsiya) yoki base64 resource (≤ ~3 MB, Blob bo'lmasa bitrate avtomatik moslanadi)

## Environment o'zgaruvchilari

| Nomi | Majburiy | Izoh |
|---|---|---|
| `MCP_API_KEY` | ha (tavsiya) | `Authorization: Bearer <key>`. Bo'sh bo'lsa endpoint ochiq |
| `BLOB_READ_WRITE_TOKEN` | tavsiya | Vercel → Storage → Blob ulanganda avtomatik qo'shiladi |
| `ELEVENLABS_API_KEY` | ovoz uchun | `voiceover_text` ishlashi uchun |
| `ELEVENLABS_VOICE_ID` | ixtiyoriy | `voice_id` berilmasa shu ishlatiladi |
| `ELEVENLABS_MODEL` | ixtiyoriy | default `eleven_v3` |
| `RENDER_BUDGET_MS` | ixtiyoriy | render vaqt byudjeti, default 255000 |

## Lokal ishga tushirish

```bash
npm install
npm run build        # tsc --noEmit
npm run dev          # http://localhost:3000  (MCP: /mcp, docs: /)
npm test             # end-to-end test (dev serverga qarshi)
```

## Deploy

1. `git init && git add . && git commit -m "init" && git remote add origin <repo> && git push -u origin main`
2. Vercel → Add New Project → repo'ni tanlang → **Framework Preset: Other** → Deploy.
3. Settings → Environment Variables: yuqoridagilarni qo'shing → Redeploy.
4. Pro rejada Fluid Compute yoqilgan bo'lsin (Settings → Functions); `maxDuration: 300` uchun kerak.
5. `https://<app>.vercel.app/` — ulanish qo'llanmasi; MCP manzili: `https://<app>.vercel.app/mcp`.
