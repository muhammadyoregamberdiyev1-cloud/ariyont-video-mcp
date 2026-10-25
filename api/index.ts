import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { put } from "@vercel/blob";
import { z } from "zod";
import {
  LIMITS,
  RenderError,
  elevenLabsTts,
  fetchAudio,
  getChromiumPath,
  getFfmpegPath,
  launchBrowser,
  renderVideo,
} from "../tools/render.js";
import { spawnSync } from "node:child_process";

const VERSION = "1.0.0";

const CONTRACT = `ANIMATSIYA SHARTNOMASI (render_video uchun HTML)
1. Sahifada <canvas id="stage"></canvas> bo'lishi shart. Canvas o'lchami avtomatik width x height qilib qo'yiladi (CSS bilan o'lcham bermang).
2. Tavsiya etilgan deterministik interfeys (eng aniq natija):
   window.setup = (ctx, w, h) => { ... }            // ixtiyoriy, bir marta chaqiriladi
   window.drawFrame = (ctx, frameIndex, totalFrames) => { ... }   // har kadr uchun chaqiriladi
   Vaqtni Date.now()/requestAnimationFrame bilan EMAS, t = frameIndex / (totalFrames - 1) yoki frameIndex / fps bilan hisoblang.
3. Muqobil: window.getFrame(dtMs) — har kadrda chaqiriladi, o'zi canvas'ga chizadi.
4. Hech biri bo'lmasa — sahifa real-time yozib olinadi (kadrlar tushishi mumkin, tavsiya etilmaydi).
5. Tashqi kutubxonalar (three.js, gsap...) ochiq https CDN orqali ulanishi mumkin; localhost/ichki tarmoq bloklanadi.
6. Matn uchun tizim shriftlari (sans-serif) ishlating; Google Fonts yuklanishini kutish kerak bo'lsa setup ichida await document.fonts.load(...) qiling.`;

const EXAMPLE = `<!doctype html><html><body><canvas id="stage"></canvas><script>
window.drawFrame = (ctx, i, n) => {
  const w = ctx.canvas.width, h = ctx.canvas.height, t = i / (n - 1);
  ctx.fillStyle = '#0b1020'; ctx.fillRect(0, 0, w, h);
  const x = w * (0.1 + 0.8 * t), y = h / 2 + Math.sin(t * Math.PI * 4) * h * 0.2;
  ctx.fillStyle = '#4cc9f0'; ctx.beginPath(); ctx.arc(x, y, h * 0.06, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = (h * 0.07) + 'px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('Salom, MCP!', w / 2, h * 0.15);
};
</script></body></html>`;

function safeFilename(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "") || "video";
  return base.toLowerCase().endsWith(".mp4") ? base : `${base}.mp4`;
}

function even(n: number): number {
  return n - (n % 2);
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errorResult(t: string) {
  return { isError: true, content: [{ type: "text" as const, text: t }] };
}

function buildServer(startedAt: number) {
  const server = new McpServer(
    { name: "ariyont-video-mcp", version: VERSION },
    {
      instructions:
        "HTML/JS canvas animatsiyasini MP4 videoga aylantiradi. Avval animation_guide tool'ini o'qing, so'ng render_video'ga to'liq HTML yuboring.",
    }
  );

  server.registerTool(
    "animation_guide",
    {
      title: "Animatsiya shartnomasi",
      description:
        "render_video uchun HTML qanday yozilishi kerakligi (shartnoma) va ishlaydigan namuna HTML qaytaradi. Birinchi marta video yasashdan oldin chaqiring.",
      inputSchema: {},
    },
    async () => text(`${CONTRACT}\n\nLimitlar: maks ${LIMITS.maxDuration}s, ${LIMITS.maxWidth}x${LIMITS.maxHeight}, ${LIMITS.maxFps}fps.\n\nNAMUNA HTML:\n${EXAMPLE}`)
  );

  server.registerTool(
    "render_video",
    {
      title: "HTML canvas -> MP4",
      description:
        `HTML/JS canvas animatsiyani headless brauzerda kadrma-kadr render qilib MP4 (H.264, yuv420p) qiladi va video havolasini qaytaradi. ` +
        `HTML ichida <canvas id="stage"> va window.drawFrame(ctx, frameIndex, totalFrames) bo'lishi kerak (batafsil: animation_guide). ` +
        `Limitlar: ${LIMITS.maxDuration}s, ${LIMITS.maxWidth}x${LIMITS.maxHeight}, ${LIMITS.maxFps}fps. Ovoz: voiceover_text (ElevenLabs) yoki audio_url. ` +
        `Uzoq/katta videolar sekin: avval qisqa va 1280x720 30fps bilan sinang.`,
      inputSchema: {
        html: z.string().min(20).max(800_000).describe("To'liq HTML hujjat (canvas#stage + drawFrame)"),
        duration: z.number().min(0.5).max(LIMITS.maxDuration).default(5).describe("Davomiylik, soniya"),
        width: z.number().int().min(64).max(LIMITS.maxWidth).default(1280),
        height: z.number().int().min(64).max(LIMITS.maxHeight).default(720),
        fps: z.number().int().min(1).max(LIMITS.maxFps).default(30),
        filename: z.string().max(100).default("video.mp4"),
        voiceover_text: z.string().max(5000).optional().describe("ElevenLabs orqali ovozga aylantiriladigan matn (ixtiyoriy)"),
        voice_id: z.string().max(100).optional().describe("ElevenLabs voice ID (default: ELEVENLABS_VOICE_ID env)"),
        model_id: z.string().max(60).optional().describe("ElevenLabs model (default: ELEVENLABS_MODEL env yoki eleven_v3)"),
        audio_url: z.string().url().max(2000).optional().describe("Tayyor audio (https mp3/wav/m4a) — voiceover_text o'rniga"),
      },
    },
    async (args) => {
      const width = even(args.width);
      const height = even(args.height);
      const budget = Number(process.env.RENDER_BUDGET_MS ?? 255_000);
      const deadline = startedAt + budget;
      const blobEnabled = !!process.env.BLOB_READ_WRITE_TOKEN;

      try {
        let audio: Buffer | undefined;
        if (args.audio_url) {
          audio = await fetchAudio(args.audio_url);
        } else if (args.voiceover_text) {
          const apiKey = process.env.ELEVENLABS_API_KEY;
          const voiceId = args.voice_id ?? process.env.ELEVENLABS_VOICE_ID;
          if (!apiKey) return errorResult("ELEVENLABS_API_KEY serverda sozlanmagan. Vercel env'ga qo'shing yoki audio_url bering.");
          if (!voiceId) return errorResult("voice_id berilmadi va ELEVENLABS_VOICE_ID env ham yo'q.");
          audio = await elevenLabsTts({
            text: args.voiceover_text,
            voiceId,
            modelId: args.model_id ?? process.env.ELEVENLABS_MODEL ?? "eleven_v3",
            apiKey,
          });
        }

        const result = await renderVideo({
          html: args.html,
          duration: args.duration,
          width,
          height,
          fps: args.fps,
          audio,
          targetBytes: blobEnabled ? undefined : LIMITS.maxInlineBytes - 200_000,
          deadline,
        });

        const filename = safeFilename(args.filename);
        const meta = {
          filename,
          size_bytes: result.mp4.length,
          width,
          height,
          fps: args.fps,
          duration: args.duration,
          frames: result.frames,
          mode: result.mode,
          audio: !!audio,
          render_ms: result.renderMs,
          encode_ms: result.encodeMs,
          warnings: result.warnings,
        };

        if (blobEnabled) {
          const blob = await put(`videos/${filename}`, result.mp4, {
            access: "public",
            addRandomSuffix: true,
            contentType: "video/mp4",
          });
          return text(`Video tayyor: ${blob.url}\n\n${JSON.stringify(meta, null, 2)}`);
        }

        if (result.mp4.length > LIMITS.maxInlineBytes) {
          return errorResult(
            `Video ${(result.mp4.length / 1e6).toFixed(1)} MB — Vercel javob limiti (~4.5 MB) dan oshdi. ` +
              `Vercel Blob ulang (BLOB_READ_WRITE_TOKEN) yoki duration/o'lchamni kamaytiring.`
          );
        }
        return {
          content: [
            { type: "text" as const, text: `Video tayyor (base64 resource sifatida).\n\n${JSON.stringify(meta, null, 2)}` },
            {
              type: "resource" as const,
              resource: { uri: `video://${filename}`, mimeType: "video/mp4", blob: result.mp4.toString("base64") },
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof RenderError ? e.message : `Kutilmagan xato: ${(e as Error).message}`;
        return errorResult(msg);
      }
    }
  );

  server.registerTool(
    "health",
    {
      title: "Render muhiti tekshiruvi",
      description: "Chromium, ffmpeg, Blob, ElevenLabs va autentifikatsiya holatini tekshiradi. deep=true brauzerni haqiqatda ishga tushirib ko'radi.",
      inputSchema: { deep: z.boolean().default(true) },
    },
    async ({ deep }) => {
      const out: Record<string, unknown> = {
        version: VERSION,
        node: process.version,
        memory_mb: Math.round(process.memoryUsage().rss / 1e6),
        limits: LIMITS,
        auth_enabled: !!process.env.MCP_API_KEY,
        blob_configured: !!process.env.BLOB_READ_WRITE_TOKEN,
        elevenlabs_configured: !!process.env.ELEVENLABS_API_KEY,
        elevenlabs_default_voice: !!process.env.ELEVENLABS_VOICE_ID,
      };
      try {
        const ff = spawnSync(getFfmpegPath(), ["-version"], { encoding: "utf8" });
        out.ffmpeg = ff.status === 0 ? ff.stdout.split("\n")[0] : `XATO: ${ff.error?.message ?? ff.stderr}`;
      } catch (e) {
        out.ffmpeg = `XATO: ${(e as Error).message}`;
      }
      try {
        out.chromium_path = await getChromiumPath();
        if (deep) {
          const t0 = Date.now();
          const b = await launchBrowser(320, 180);
          const p = await b.newPage();
          await p.setContent('<canvas id="stage" width="10" height="10"></canvas>');
          out.browser_version = await b.version();
          out.canvas_ok = await p.evaluate(() => !!(document.getElementById("stage") as HTMLCanvasElement).getContext("2d"));
          await b.close();
          out.browser_launch_ms = Date.now() - t0;
        }
        out.ok = true;
      } catch (e) {
        out.ok = false;
        out.error = (e as Error).message;
      }
      return text(JSON.stringify(out, null, 2));
    }
  );

  return server;
}

function authorized(req: IncomingMessage): boolean {
  const key = process.env.MCP_API_KEY;
  if (!key) return true; // open mode (not recommended) — docs page warns about it
  const header = req.headers.authorization ?? "";
  const given = header.replace(/^Bearer\s+/i, "") || String(req.headers["x-api-key"] ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-api-key, mcp-protocol-version, mcp-session-id, accept");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  const startedAt = Date.now();
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: Bearer token kerak" }, id: null }, {
      "WWW-Authenticate": 'Bearer realm="ariyont-video-mcp"',
    });
    return;
  }
  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server, POST ishlating)" }, id: null }, { Allow: "POST" });
    return;
  }

  const server = buildServer(startedAt);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: `Internal error: ${(e as Error).message}` }, id: null });
    }
  }
}
