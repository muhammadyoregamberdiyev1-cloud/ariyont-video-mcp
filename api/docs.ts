import type { IncomingMessage, ServerResponse } from "node:http";

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "YOUR-APP.vercel.app");
  const proto = String(req.headers["x-forwarded-proto"] ?? (host.startsWith("localhost") ? "http" : "https")).split(",")[0];
  const base = `${proto}://${host}`;
  const url = `${base}/mcp`;
  const authOn = !!process.env.MCP_API_KEY;

  const html = `<!doctype html>
<html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ariyont-video-mcp — ulanish qo'llanmasi</title>
<style>
:root{--bg:#fff;--fg:#14171f;--mut:#5b6472;--card:#f4f6fa;--bd:#dde2ea;--acc:#2b59ff;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#0e1118;--fg:#e8ecf4;--mut:#9aa4b5;--card:#171b25;--bd:#2a3140;--acc:#7c9bff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 80px}
h1{margin:0 0 4px}h2{margin-top:40px;border-bottom:1px solid var(--bd);padding-bottom:6px}
p.s{color:var(--mut);margin-top:0}
pre{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:14px}
code{background:var(--card);padding:1px 5px;border-radius:4px}pre code{background:none;padding:0}
.warn{border-left:4px solid #e0a100;background:var(--card);padding:10px 14px;border-radius:4px}
.ok{border-left:4px solid #1fa971;background:var(--card);padding:10px 14px;border-radius:4px}
li{margin:4px 0}table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--bd);padding:6px 10px;text-align:left;font-size:14px}
</style></head><body><main>
<h1>ariyont-video-mcp</h1>
<p class="s">Claude, Mistral yoki boshqa MCP mijoz yuborgan HTML/JS canvas animatsiyani MP4 videoga aylantiradigan MCP server.</p>

<h2>1. Server manzili</h2>
<pre><code>${esc(url)}</code></pre>
<p>Transport: <b>Streamable HTTP</b> (stateless). Autentifikatsiya: <b>${authOn ? "yoqilgan — Bearer token kerak" : "O'CHIRILGAN"}</b>.</p>
${authOn ? "" : `<p class="warn">Diqqat: <code>MCP_API_KEY</code> sozlanmagan, endpoint hamma uchun ochiq. Vercel → Settings → Environment Variables'ga <code>MCP_API_KEY</code> qo'shing va qayta deploy qiling.</p>`}

<h2>2. Mistral Le Chat'ga ulash</h2>
<ol>
<li>Le Chat'da <b>Connectors</b> sahifasini oching → <b>+ Add Connector</b> → <b>Custom MCP Connector</b> tabi.</li>
<li><b>Connector name</b>: <code>ariyont_video</code> (probel va maxsus belgilarsiz).</li>
<li><b>Server URL</b>: <code>${esc(url)}</code></li>
<li>Autentifikatsiya so'ralsa: <b>API Token Authentication</b> → header nomi <code>Authorization</code>, qiymat <code>Bearer SIZNING_MCP_API_KEY</code> (agar turi alohida tanlansa — <b>Bearer</b>).</li>
<li><b>Connect</b> ni bosing. Yangi chatda tools menyusidan connector'ni yoqing.</li>
<li>Sinash: <i>"ariyont_video health tool'ini chaqir"</i>.</li>
</ol>
<p class="ok">Le Chat faqat remote Streamable HTTP serverlar bilan ishlaydi — bu server aynan shunday.</p>

<h2>3. Mistral Vibe (CLI) ga ulash</h2>
<p><code>~/.vibe/config.toml</code> (yoki loyiha ichida <code>./.vibe/config.toml</code>) fayliga qo'shing:</p>
<pre><code>[[mcp_servers]]
name = "ariyont_video"
transport = "streamable-http"
url = "${esc(url)}"
headers = { "Authorization" = "Bearer SIZNING_MCP_API_KEY" }</code></pre>
<p>Vibe'ni qayta ishga tushiring va <code>/mcp</code> bilan tekshiring. Tool nomlari <code>ariyont_video_render_video</code>, <code>ariyont_video_health</code>, <code>ariyont_video_animation_guide</code> ko'rinishida bo'ladi. Vibe hozircha OAuth talab qiladigan MCP serverlarni qo'llamaydi — shu sabab statik Bearer token ishlatiladi.</p>

<h2>4. Claude'ga ulash</h2>
<p><b>claude.ai / Claude Desktop:</b> Settings → Connectors → Add custom connector → URL: <code>${esc(url)}</code>.
Agar Bearer token yoqilgan bo'lsa va UI header kiritishga ruxsat bermasa, Claude Code ishlating:</p>
<pre><code>claude mcp add --transport http ariyont-video ${esc(url)} \\
  --header "Authorization: Bearer SIZNING_MCP_API_KEY"</code></pre>

<h2>5. Boshqa mijozlar (Codex, Cursor, MCP Inspector)</h2>
<pre><code># Codex  (~/.codex/config.toml)
[mcp_servers.ariyont_video]
url = "${esc(url)}"
http_headers = { "Authorization" = "Bearer SIZNING_MCP_API_KEY" }

# Qo'lda tekshirish
curl -X POST ${esc(url)} \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer SIZNING_MCP_API_KEY" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></pre>

<h2>6. Tool'lar</h2>
<table>
<tr><th>Tool</th><th>Vazifasi</th></tr>
<tr><td><code>animation_guide</code></td><td>HTML shartnomasi va ishlaydigan namuna. Modelga birinchi chaqirtiring.</td></tr>
<tr><td><code>render_video</code></td><td>html, duration, width, height, fps, filename, voiceover_text, voice_id, model_id, audio_url → MP4 havolasi.</td></tr>
<tr><td><code>health</code></td><td>Chromium, ffmpeg, Blob, ElevenLabs holati.</td></tr>
</table>
<p>Limitlar: 60 soniya, 1920×1080, 60 fps. Uzoq/katta videolar sekin renderlanadi — avval 1280×720, 30 fps bilan sinang.</p>

<h2>7. Animatsiya shartnomasi</h2>
<ul>
<li>Sahifada <code>&lt;canvas id="stage"&gt;</code> bo'lishi shart.</li>
<li><code>window.setup(ctx, w, h)</code> — ixtiyoriy, bir marta.</li>
<li><code>window.drawFrame(ctx, frameIndex, totalFrames)</code> — har kadr; vaqtni <code>frameIndex / (totalFrames-1)</code> bilan hisoblang.</li>
<li>Muqobil: <code>window.getFrame(dtMs)</code>. Hech biri bo'lmasa — real-time yozib olish (aniq emas).</li>
</ul>
<pre><code>&lt;canvas id="stage"&gt;&lt;/canvas&gt;
&lt;script&gt;
window.drawFrame = (ctx, i, n) =&gt; {
  const w = ctx.canvas.width, h = ctx.canvas.height, t = i / (n - 1);
  ctx.fillStyle = '#0b1020'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#4cc9f0';
  ctx.beginPath(); ctx.arc(w * (0.1 + 0.8 * t), h / 2, h * 0.06, 0, Math.PI * 2); ctx.fill();
};
&lt;/script&gt;</code></pre>

<h2>8. Mistral'ga namunaviy so'rov</h2>
<pre><code>ariyont_video connector'idan avval animation_guide ni o'qi, so'ng
"Mistral AI bilan suhbat" nomli 10 soniyalik, 1280x720,
chat uslubidagi animatsiya yasa (xabarlar birin-ketin chiqadi) va MP4 havolasini ber.</code></pre>

<h2>9. Ovoz (ElevenLabs)</h2>
<p><code>render_video</code>'ga <code>voiceover_text</code> bering — server ElevenLabs orqali ovoz yaratib, videoga qo'shadi. Serverda <code>ELEVENLABS_API_KEY</code> va (ixtiyoriy) <code>ELEVENLABS_VOICE_ID</code>, <code>ELEVENLABS_MODEL</code> o'rnatilgan bo'lishi kerak. Tayyor audio uchun <code>audio_url</code> (https) ishlating.</p>

<h2>10. Muammolar</h2>
<table>
<tr><th>Alomat</th><th>Yechim</th></tr>
<tr><td>401 Unauthorized</td><td>Header: <code>Authorization: Bearer ...</code> to'g'ri ekanini tekshiring.</td></tr>
<tr><td>Video havolasi o'rniga "Blob ulang" xatosi</td><td>Vercel → Storage → Blob yarating va loyihaga ulang (BLOB_READ_WRITE_TOKEN).</td></tr>
<tr><td>"Vaqt chegarasi tugadi"</td><td>duration/fps/o'lchamni kamaytiring.</td></tr>
<tr><td>Kadrlar qotib qolgan</td><td>Animatsiya <code>drawFrame</code>'da frameIndex'ga bog'lanmagan (Date.now ishlatilgan).</td></tr>
</table>
</main></body></html>`;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.end(html);
}
