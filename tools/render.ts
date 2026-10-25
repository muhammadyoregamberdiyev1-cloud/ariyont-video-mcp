import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import ffmpegStatic from "ffmpeg-static";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

export const LIMITS = {
  maxDuration: 60,
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 60,
  // Vercel serverless response limit is ~4.5 MB; base64 adds 33%.
  maxInlineBytes: 3_000_000,
};

export type RenderMode = "drawFrame" | "getFrame" | "realtime";

export interface RenderOptions {
  html: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  audio?: Buffer;
  /** If set, encode to fit roughly this many bytes (used when no blob storage). */
  targetBytes?: number;
  /** Absolute epoch ms after which rendering must stop. */
  deadline: number;
}

export interface RenderResult {
  mp4: Buffer;
  mode: RenderMode;
  frames: number;
  renderMs: number;
  encodeMs: number;
  warnings: string[];
}

export class RenderError extends Error {}

/** PNG is lossless but ~5x slower to encode at 1080p; JPEG q0.95 is visually identical after yuv420p. */
const FRAME_FORMAT: "png" | "jpeg" = process.env.FRAME_FORMAT === "png" ? "png" : "jpeg";

export function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const bundled = ffmpegStatic as unknown as string | null;
  if (bundled && existsSync(bundled)) return bundled;
  return "ffmpeg"; // system fallback
}

export async function getChromiumPath(): Promise<string> {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return chromium.executablePath();
}

export async function launchBrowser(width: number, height: number): Promise<Browser> {
  chromium.setGraphicsMode = false; // canvas 2D only; saves ~1s and memory
  const executablePath = await getChromiumPath();
  return puppeteer.launch({
    executablePath,
    args: [
      ...chromium.args,
      "--autoplay-policy=no-user-gesture-required",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
    ],
    defaultViewport: { width, height, deviceScaleFactor: 1 },
    headless: "shell",
  });
}

/** Block requests to localhost / private networks (SSRF protection). Public CDNs are allowed. */
export function isBlockedUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (["data:", "blob:", "about:"].includes(url.protocol)) return false;
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) {
      if (h.includes(":")) return true;
    }
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a === 0 || a === 10 || a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function checkDeadline(deadline: number, done: number, total: number) {
  if (Date.now() > deadline) {
    throw new RenderError(
      `Vaqt chegarasi tugadi (${done}/${total} kadr tayyor edi). duration, fps yoki o'lchamni kamaytiring ` +
        `(masalan 1280x720, 30fps) yoki animatsiyani yengillashtiring.`
    );
  }
}

function startFfmpeg(args: string[]) {
  const proc = spawn(getFfmpegPath(), args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-3000);
  });
  const exited = new Promise<void>((resolve, reject) => {
    proc.on("error", (e) => reject(new RenderError(`ffmpeg ishga tushmadi: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new RenderError(`ffmpeg xatosi (kod ${code}): ${stderr.trim().split("\n").slice(-6).join("\n")}`));
    });
  });
  // avoid unhandled rejection if we fail before awaiting
  exited.catch(() => {});
  return { proc, exited };
}

function encodeArgs(opts: RenderOptions, inputArgs: string[], outFile: string, audioFile?: string): string[] {
  const args = ["-y", "-hide_banner", "-loglevel", "error", ...inputArgs];
  if (audioFile) args.push("-i", audioFile);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
  if (opts.targetBytes) {
    const audioBits = audioFile ? 96_000 * opts.duration : 0;
    const videoKbps = Math.max(
      150,
      Math.floor(((opts.targetBytes * 8 * 0.9 - audioBits) / opts.duration) / 1000)
    );
    args.push("-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`);
  } else {
    args.push("-crf", "20");
  }
  args.push("-r", String(opts.fps), "-movflags", "+faststart");
  if (audioFile) {
    args.push("-c:a", "aac", "-b:a", "128k", "-af", "apad", "-map", "0:v:0", "-map", "1:a:0");
  } else {
    args.push("-an");
  }
  args.push("-t", String(opts.duration), outFile);
  return args;
}

async function writeFrame(stdin: NodeJS.WritableStream, buf: Buffer) {
  if (!stdin.write(buf)) await once(stdin, "drain");
}

export async function renderVideo(opts: RenderOptions): Promise<RenderResult> {
  const { width, height, fps, duration } = opts;
  const totalFrames = Math.round(duration * fps);
  const dir = await mkdtemp(path.join(tmpdir(), "render-"));
  const outFile = path.join(dir, "out.mp4");
  const warnings: string[] = [];
  let browser: Browser | undefined;

  try {
    let audioFile: string | undefined;
    if (opts.audio) {
      audioFile = path.join(dir, "audio.mp3");
      await writeFile(audioFile, opts.audio);
    }

    const t0 = Date.now();
    browser = await launchBrowser(width, height);
    const page: Page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (isBlockedUrl(req.url())) req.abort("blockedbyclient").catch(() => {});
      else req.continue().catch(() => {});
    });
    page.on("pageerror", (e) => {
      if (warnings.length < 10) warnings.push(`sahifa xatosi: ${(e as Error).message ?? String(e)}`);
    });
    page.on("console", (m) => {
      if (m.type() === "error" && warnings.length < 10) warnings.push(`console.error: ${m.text()}`);
    });

    await page.setContent(opts.html, { waitUntil: "load", timeout: 20_000 });
    await page.addStyleTag({
      content: "html,body{margin:0!important;padding:0!important;overflow:hidden!important}canvas#stage{display:block}",
    });

    // Prepare canvas and detect mode.
    const info = await page.evaluate(
      async (w: number, h: number) => {
        const win = window as any;
        const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
        const mode: string =
          typeof win.drawFrame === "function" ? "drawFrame" : typeof win.getFrame === "function" ? "getFrame" : "realtime";
        if (canvas) {
          canvas.width = w;
          canvas.height = h;
          canvas.style.width = w + "px";
          canvas.style.height = h + "px";
          const ctx = canvas.getContext("2d") ?? canvas.getContext("webgl2") ?? canvas.getContext("webgl");
          win.__ctx = ctx;
          if (typeof win.setup === "function") await win.setup(ctx, w, h);
        }
        return { mode, hasCanvas: !!canvas };
      },
      width,
      height
    );

    const mode = info.mode as RenderMode;
    if (mode !== "realtime" && !info.hasCanvas) {
      throw new RenderError('HTML ichida <canvas id="stage"> topilmadi (drawFrame/getFrame uchun shart).');
    }

    let encodeStart = Date.now();
    let frames = 0;

    if (mode === "realtime") {
      // Fallback: capture the page in real time, then encode with measured fps.
      warnings.push(
        "drawFrame/getFrame topilmadi — real-time yozib olish rejimi ishlatildi (kadrlar tushib qolishi mumkin). Aniq natija uchun window.drawFrame(ctx, frameIndex, totalFrames) yozing."
      );
      const files: string[] = [];
      const start = Date.now();
      while (Date.now() - start < duration * 1000) {
        checkDeadline(opts.deadline, files.length, totalFrames);
        const buf = (await page.screenshot({ type: "jpeg", quality: 90 })) as Uint8Array;
        const f = path.join(dir, `f${String(files.length).padStart(6, "0")}.jpg`);
        await writeFile(f, buf);
        files.push(f);
      }
      const elapsed = (Date.now() - start) / 1000;
      const effFps = Math.max(1, files.length / elapsed);
      frames = files.length;
      const renderMs = Date.now() - t0;
      encodeStart = Date.now();
      const args = encodeArgs(
        opts,
        ["-framerate", effFps.toFixed(3), "-i", path.join(dir, "f%06d.jpg")],
        outFile,
        audioFile
      );
      // fps filter resamples measured fps -> target fps
      args.splice(args.indexOf("-c:v"), 0, "-vf", `fps=${fps}`);
      const { exited } = startFfmpeg(args);
      await exited;
      const mp4 = await readFile(outFile);
      await browser.close().catch(() => {});
      browser = undefined;
      return { mp4, mode, frames, renderMs, encodeMs: Date.now() - encodeStart, warnings };
    }

    // Deterministic modes: pipe PNG frames straight into ffmpeg.
    const args = encodeArgs(opts, ["-f", "image2pipe", "-framerate", String(fps), "-c:v", FRAME_FORMAT === "png" ? "png" : "mjpeg", "-i", "pipe:0"], outFile, audioFile);
    const { proc, exited } = startFfmpeg(args);
    const frameDt = 1000 / fps;
    try {
      for (let i = 0; i < totalFrames; i++) {
        checkDeadline(opts.deadline, i, totalFrames);
        let b64: string;
        try {
          b64 = await page.evaluate(
            async (idx: number, total: number, dt: number, m: string, fmt: string) => {
              const win = window as any;
              const canvas = document.getElementById("stage") as HTMLCanvasElement;
              if (m === "drawFrame") await win.drawFrame(win.__ctx, idx, total);
              else await win.getFrame(idx === 0 ? 0 : dt);
              return (fmt === "png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.95)).split(",")[1];
            },
            i,
            totalFrames,
            frameDt,
            mode,
            FRAME_FORMAT
          );
        } catch (e) {
          throw new RenderError(`Kadr ${i} chizishda xato: ${(e as Error).message}`);
        }
        await writeFrame(proc.stdin, Buffer.from(b64, "base64"));
        frames++;
      }
    } catch (e) {
      proc.stdin.destroy();
      proc.kill("SIGKILL");
      throw e;
    }
    const renderMs = Date.now() - t0;
    encodeStart = Date.now();
    proc.stdin.end();
    await exited;
    const mp4 = await readFile(outFile);
    await browser.close().catch(() => {});
    browser = undefined;
    return { mp4, mode, frames, renderMs, encodeMs: Date.now() - encodeStart, warnings };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Text-to-speech via ElevenLabs; returns MP3 bytes. */
export async function elevenLabsTts(opts: {
  text: string;
  voiceId: string;
  modelId: string;
  apiKey: string;
}): Promise<Buffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": opts.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text: opts.text, model_id: opts.modelId }),
    }
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new RenderError(`ElevenLabs xatosi ${res.status}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Download audio from a public URL (https only, no private hosts, 15 MB cap). */
export async function fetchAudio(url: string): Promise<Buffer> {
  if (!/^https:\/\//i.test(url) || isBlockedUrl(url)) throw new RenderError("audio_url faqat ochiq https manzil bo'lishi kerak.");
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new RenderError(`audio_url yuklanmadi: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 15_000_000) throw new RenderError("audio fayl 15 MB dan katta.");
  return buf;
}
