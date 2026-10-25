import { createServer } from "node:http";
import mcp from "../api/index.js";
import docs from "../api/docs.js";

const port = Number(process.env.PORT ?? 3000);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const r = req as typeof req & { body?: unknown };
  if (raw && (req.headers["content-type"] ?? "").includes("json")) {
    try { r.body = JSON.parse(raw); } catch { /* ignore */ }
  }
  if (req.url?.startsWith("/mcp")) return mcp(r, res);
  return docs(req, res);
}).listen(port, () => console.log(`dev server http://localhost:${port}  (MCP: /mcp)`));
