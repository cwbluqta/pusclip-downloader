import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { getJob, patchJob, redis, setJob } from "./redis.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const { PORT = 3000, DOWNLOADER_TOKEN } = process.env;

const RENDER_NODE_PATH = "/usr/bin/node";
const hasRenderNodePath = fs.existsSync(RENDER_NODE_PATH);

function sanitizeUrlForLogs(raw) {
  try {
    const parsed = new URL(raw);
    const sensitiveParams = ["token", "sig", "signature", "auth", "key", "api_key"];
    for (const name of sensitiveParams) {
      if (parsed.searchParams.has(name)) parsed.searchParams.set(name, "REDACTED");
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function sanitizeYtDlpArgsForLogs(args) {
  return args.map((arg) => (typeof arg === "string" && /^https?:\/\//.test(arg) ? sanitizeUrlForLogs(arg) : arg));
}

function runYtDlp(args, onClose) {
  const sanitized = sanitizeYtDlpArgsForLogs(args);
  console.log(`[yt-dlp] command: yt-dlp ${sanitized.join(" ")}`);

  const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let finished = false;

  const finalize = (code) => {
    if (finished) return;
    finished = true;
    onClose(code, stderr);
  };

  proc.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  proc.on("error", (err) => {
    stderr += `spawn error: ${err.message}`;
    finalize(127);
  });
  proc.on("close", (code) => finalize(code ?? 1));
}

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
  const commonArgs = [
    "--no-playlist",
    "--user-agent",
    "Mozilla/5.0 (Linux; Android 11; Mobile)",
    "--add-header",
    "Referer: https://www.youtube.com/",
    "--extractor-args",
    "youtube:player_client=android",
  ];

  const baseArgs =
    want === "mp4"
      ? [...commonArgs, "-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", outTemplate, url]
      : [...commonArgs, "-f", "bestaudio/best", "-x", "--audio-format", "mp3", "-o", outTemplate, url];

  const firstAttemptArgs = ["--js-runtimes", "node", ...baseArgs];
  const fallbackRuntime = hasRenderNodePath ? `node:${RENDER_NODE_PATH}` : "node";
  const shouldRetryWithFallback = fallbackRuntime !== "node";

  const handleResult = (code, stderr) => {
    if (code !== 0) {
      console.error("[yt-dlp] stderr (full):\n" + stderr);
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
  };

  runYtDlp(firstAttemptArgs, (code, stderr) => {
    if (code === 0) return handleResult(code, stderr);

    if (shouldRetryWithFallback && /No supported JavaScript runtime could be found/i.test(stderr)) {
      console.warn(`[yt-dlp] retrying with fallback runtime: ${fallbackRuntime}`);
      const fallbackArgs = ["--js-runtimes", fallbackRuntime, ...baseArgs];
      return runYtDlp(fallbackArgs, handleResult);
    }

    return handleResult(code, stderr);
  });
});

app.post("/transcribe", async (req, res) => {
  const payload = req.body || {};
  const { url } = payload;

  if (!url || typeof url !== "string") {
    return res.status(400).json({
      ok: false,
      error: { code: "BAD_REQUEST", message: "Invalid JSON body" },
    });
  }

  const now = Date.now();
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    type: "transcribe",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    input: payload,
    progress: { stage: "queued", pct: 0 },
    result: {
      transcript: { text: null, segments: null, language: null },
    },
    error: null,
  };

  await setJob(jobId, job);
  console.log("created job", jobId, "status=queued");

  setTimeout(async () => {
    try {
      const updated = await patchJob(jobId, {
        status: "processing",
        progress: { stage: "transcribing", pct: 10 },
      });
      if (updated) console.log("job status transition", jobId, "-> processing");
    } catch (err) {
      const message = String(err?.message ?? err);
      await patchJob(jobId, {
        status: "error",
        error: { code: "TRANSCRIBE_FAILED", message },
      });
      console.error("job failed", jobId, message);
    }
  }, 400);

  setTimeout(async () => {
    try {
      const updated = await patchJob(jobId, {
        status: "done",
        progress: { stage: "done", pct: 100 },
        result: {
          transcript: {
            text: "",
            segments: [],
            language: null,
          },
        },
        error: null,
      });
      if (updated) console.log("job status transition", jobId, "-> done");
    } catch (err) {
      const message = String(err?.message ?? err);
      await patchJob(jobId, {
        status: "error",
        error: { code: "TRANSCRIBE_FAILED", message },
      });
      console.error("job failed", jobId, message);
    }
  }, 1800);

  return res.status(202).json({
    ok: true,
    jobId,
  });
});

app.get("/jobs/:jobId", async (req, res) => {
  const { jobId } = req.params;
  const job = await getJob(jobId);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: { code: "JOB_NOT_FOUND", message: "Job not found" },
    });
  }

  return res.status(200).json({
    ok: true,
    job,
  });
});

app.get("/health/redis", async (_req, res) => {
  try {
    await redis.ping();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: { message: String(err?.message ?? err) },
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: { code: "NOT_FOUND", message: "Route not found" },
  });
});

app.use((err, _req, res, _next) => {
  console.error("[express] unhandled error:", err);
  if (res.headersSent) return;

  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      ok: false,
      error: { code: "BAD_REQUEST", message: "Invalid JSON body" },
    });
  }

  return res.status(500).json({
    ok: false,
    error: { code: "INTERNAL", message: "Internal server error" },
  });
});

app.listen(PORT, () => {
  console.log(`Downloader API listening on port ${PORT}`);
  console.log(`[runtime] node: ${process.version}`);
  runYtDlp(["--version"], () => {});
});
