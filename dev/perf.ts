import { renderVideo } from "../tools/render.js";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
const html = readFileSync("dev/perf.html", "utf8");
spawnSync("node_modules/ffmpeg-static/ffmpeg", ["-y","-f","lavfi","-i","sine=frequency=440:duration=3","-c:a","libmp3lame","out/tone.mp3"]);
const t0 = Date.now();
const r = await renderVideo({ html, duration: 10, width: 1920, height: 1080, fps: 30, audio: readFileSync("out/tone.mp3"), targetBytes: 2_800_000, deadline: Date.now() + 255000 });
writeFileSync("out/perf.mp4", r.mp4);
console.log({ total_s: (Date.now()-t0)/1000, bytes: r.mp4.length, frames: r.frames, renderMs: r.renderMs, encodeMs: r.encodeMs, mode: r.mode });
