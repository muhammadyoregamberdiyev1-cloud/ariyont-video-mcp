import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync, mkdirSync } from "node:fs";

const url = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const headers: Record<string, string> = process.env.MCP_API_KEY ? { Authorization: `Bearer ${process.env.MCP_API_KEY}` } : {};
mkdirSync("out", { recursive: true });

const client = new Client({ name: "test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

const show = (r: any) => (r.content as any[]).map((c) => (c.type === "text" ? c.text : `[${c.type} ${c.resource?.mimeType} ${c.resource?.blob?.length ?? 0} b64 chars]`)).join("\n");

console.log("\n--- health ---\n" + show(await client.callTool({ name: "health", arguments: {} })));

const drawFrameHtml = `<!doctype html><body><canvas id="stage"></canvas><script>
window.drawFrame=(ctx,i,n)=>{const w=ctx.canvas.width,h=ctx.canvas.height,t=i/(n-1);
ctx.fillStyle='#0b1020';ctx.fillRect(0,0,w,h);ctx.fillStyle='#4cc9f0';
ctx.beginPath();ctx.arc(w*(0.1+0.8*t),h/2,h*0.06,0,Math.PI*2);ctx.fill();
ctx.fillStyle='#fff';ctx.font=(h*0.07)+'px sans-serif';ctx.fillText('frame '+i,20,h*0.1);};
</script></body>`;

async function render(name: string, args: Record<string, unknown>) {
  const t0 = Date.now();
  const r: any = await client.callTool({ name: "render_video", arguments: args });
  console.log(`\n--- ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) isError=${!!r.isError} ---\n` + show(r));
  const res = (r.content as any[]).find((c) => c.type === "resource");
  if (res) writeFileSync(`out/${name}.mp4`, Buffer.from(res.resource.blob, "base64"));
}

await render("drawframe", { html: drawFrameHtml, duration: 2, width: 640, height: 360, fps: 24, filename: "drawframe" });
await render("getframe", {
  html: `<canvas id="stage"></canvas><script>let t=0;window.getFrame=(dt)=>{t+=dt;const c=document.getElementById('stage'),x=c.getContext('2d');x.fillStyle='#222';x.fillRect(0,0,c.width,c.height);x.fillStyle='#f72585';x.fillRect((t/2000)*c.width,50,60,60);};</script>`,
  duration: 1, width: 320, height: 180, fps: 15, filename: "getframe",
});
await render("realtime", { html: `<body style="background:#103"><canvas id="stage"></canvas><script>const c=document.getElementById('stage'),x=c.getContext('2d');function f(){x.fillStyle='#103';x.fillRect(0,0,c.width,c.height);x.fillStyle='#fb0';x.fillRect((performance.now()/20)%c.width,40,40,40);requestAnimationFrame(f)}f()</script>`, duration: 1.5, width: 320, height: 180, fps: 15, filename: "realtime" });
await render("nocanvas", { html: "<html><body>hello no canvas here</body><script>window.drawFrame=()=>{}</script></html>", duration: 1, width: 320, height: 180, fps: 10 });
await render("jserror", { html: `<canvas id="stage"></canvas><script>window.drawFrame=(ctx,i)=>{ if(i===3) throw new Error('boom'); }</script>`, duration: 1, width: 320, height: 180, fps: 10 });
await render("ssrf", { html: `<canvas id="stage"></canvas><script>fetch('http://127.0.0.1:9/x').catch(e=>window.__e=String(e));window.drawFrame=()=>{}</script>`, duration: 0.5, width: 320, height: 180, fps: 10 });
await client.close();
