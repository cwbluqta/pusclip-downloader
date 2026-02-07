import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const { PORT = 3000, DOWNLOADER_TOKEN } = process.env;

// Guarda arquivos gerados em memória (id -> meta)
const files = new Map(); // id -> { filePath, createdAt, mime, filename }

// Limpa arquivos antigos (Render usa /tmp; não deixe acumular)
setInterval(() => {
  const now = Date.now();
  for (const [id, meta] of files.entries()) {
    if (now - meta.createdAt > 30 * 60 * 1000) { // 30 min
      try { fs.unlinkSync(meta.filePath); } catch {}
      files.delete(id);
    }
  }
}, 10 * 60 * 1000);

function requireAuth(req, res) {
  const authHeader = req.get("authorization") || "";
  const expected = DOWNLOADER_TOKEN ? `Bearer ${DOWNLOADER_TOKEN}` : null;

  if (!expected || authHeader !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

// Baixar o arquivo pronto (pro seu Next.js pegar depois)
app.get("/files/:id", (req, res) => {
  if (!requireAuth(req, res)) return;

  const meta = files.get(req.params.id);
  if (!meta) return res.status(404).json({ error: "Not found" });

  res.setHeader("Content-Type", meta.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${meta.filename}"`);
  return res.sendFile(meta.filePath);
});

// Download real com yt-dlp (mp3 padrão, mp4 opcional)
app.post("/download", (req, res) => {
  if (!requireAuth(req, res)) return;

  const { url, format } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url required" });
  }

  const isYoutube = /youtube\.com|youtu\.be/.test(url);
  if (!isYoutube) {
    return res.status(400).json({ error: "Only YouTube URLs supported for now" });
  }

  const id = crypto.randomBytes(12).toString("hex");
  const outDir = "/tmp"; // Render OK
  const want = format === "mp4" ? "mp4" : "mp3";
  const outTemplate = path.join(outDir, `pusclip-${id}.%(ext)s`);

  // Args yt-dlp
  const args =
    want === "mp4"
      ? ["-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", outTemplate, url]
      : ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "-o", outTemplate, url];

  const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  proc.on("close", (code) => {
    if (code !== 0) {
      return res.status(500).json({
        error: "yt-dlp failed",
        code,
        details: stderr.slice(-1500),
      });
    }

    // Acha o arquivo gerado
    const mp3Path = path.join(outDir, `pusclip-${id}.mp3`);
    const mp4Path = path.join(outDir, `pusclip-${id}.mp4`);
    const filePath = fs.existsSync(mp3Path) ? mp3Path : fs.existsSync(mp4Path) ? mp4Path : null;

    if (!filePath) {
      return res.status(500).json({ error: "download finished but file not found" });
    }

    const filename = path.basename(filePath);
    const mime = filename.endsWith(".mp3") ? "audio/mpeg" : "video/mp4";

    files.set(id, { filePath, createdAt: Date.now(), mime, filename });

    return res.status(200).json({
      ok: true,
      id,
      filename,
      downloadUrl: `/files/${id}`,
    });
  });
});

app.listen(PORT, () => {
  console.log(`Downloader API listening on port ${PORT}`);
});
