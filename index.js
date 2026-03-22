import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { generateVideoClip, getMediaDurationMs } from "./ffmpeg.js";
import { appendJobLog, getJob, patchJob, redis, setJob } from "./redis.js";
import { buildClipCandidates, getSourceTranscriptSegments } from "./analysis.js";
import {
  getTranscriptionProviderName,
  isTranscriptionProviderConfigured,
  transcribeAudioFile,
} from "./transcribe.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const { PORT = 3000, DOWNLOADER_TOKEN } = process.env;

const RENDER_NODE_PATH = "/usr/bin/node";
const COOKIES_PATH = path.resolve(process.cwd(), "cookies.txt");
const JOB_OUTPUT_ROOT = path.join("/tmp", "pusclip-jobs");
const hasRenderNodePath = fs.existsSync(RENDER_NODE_PATH);
const CLIP_JOB_MIN_COUNT = 1;
const CLIP_JOB_MAX_COUNT = 10;
const CLIP_MIN_DURATION_MS = 3000;
const CLIP_MAX_DURATION_MS = 120000;

function ensureCookiesFile() {
  if (fs.existsSync(COOKIES_PATH)) {
    return COOKIES_PATH;
  }

  const envCookies = process.env.YTDLP_COOKIES;
  if (envCookies) {
    fs.writeFileSync(COOKIES_PATH, envCookies, "utf8");
    return COOKIES_PATH;
  }

  throw new Error(`YTDLP_COOKIES not configured and cookies.txt not found at ${COOKIES_PATH}`);
}

function getYtDlpBaseArgs() {
  const cookiePath = ensureCookiesFile();
  return ["--cookies", cookiePath];
}

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

function runYtDlpAsync(args) {
  return new Promise((resolve) => {
    runYtDlp(args, (code, stderr) => resolve({ code, stderr }));
  });
}

function classifyDownloadError(stderr) {
  const normalized = String(stderr || "").toLowerCase();
  const authRequiredPatterns = [
    "sign in to confirm you're not a bot",
    "--cookies-from-browser",
    "--cookies",
    "unable to extract yt initial data",
  ];

  const isAuthRequired = authRequiredPatterns.some((pattern) => normalized.includes(pattern));

  if (isAuthRequired) {
    return {
      code: "YOUTUBE_AUTH_REQUIRED",
      message: "YouTube blocked automated download for this video",
    };
  }

  return {
    code: "DOWNLOAD_FAILED",
    message: (String(stderr || "").slice(-1500) || "yt-dlp failed"),
  };
}



function jsonError(res, status, code, message) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
  });
}

function clipsJsonError(res, status, code, details) {
  return res.status(status).json({
    ok: false,
    error: code,
    details,
  });
}

function createJobId(prefix = "job") {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getClipJobOutputDir(jobId) {
  return path.join(JOB_OUTPUT_ROOT, jobId);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeClipId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function findSourceVideoFilePath(job) {
  const candidatePaths = [
    job?.result?.video?.filePath,
    job?.result?.sourceVideo?.filePath,
    job?.result?.filePath,
    job?.filePath,
  ];

  return candidatePaths.find((candidatePath) => typeof candidatePath === "string" && candidatePath.trim().length > 0) ?? null;
}

async function addJobLog(jobId, message, level = "info") {
  return appendJobLog(jobId, {
    at: Date.now(),
    level,
    message,
  });
}

function buildClipJobResult(sourceJobId, outputDir, manifestPath) {
  return {
    sourceJobId,
    outputDir,
    manifestPath,
    clips: [],
  };
}

function validateClipRequestBody(body) {
  const { sourceJobId, clips } = body || {};

  if (!sourceJobId || typeof sourceJobId !== "string") {
    return { ok: false, status: 400, error: "INVALID_SOURCE_JOB_ID", details: "sourceJobId is required" };
  }

  if (!Array.isArray(clips)) {
    return { ok: false, status: 400, error: "INVALID_CLIPS", details: "clips is required and must be an array" };
  }

  if (clips.length < CLIP_JOB_MIN_COUNT || clips.length > CLIP_JOB_MAX_COUNT) {
    return {
      ok: false,
      status: 400,
      error: "INVALID_CLIP_COUNT",
      details: `clips must contain between ${CLIP_JOB_MIN_COUNT} and ${CLIP_JOB_MAX_COUNT} items`,
    };
  }

  const seenClipIds = new Set();

  for (const [index, clip] of clips.entries()) {
    if (!clip || typeof clip !== "object") {
      return { ok: false, status: 400, error: "INVALID_CLIP", details: `clips[${index}] must be an object` };
    }

    if (!clip.clipId || typeof clip.clipId !== "string") {
      return { ok: false, status: 400, error: "INVALID_CLIP_ID", details: `clips[${index}].clipId is required` };
    }

    if (!isSafeClipId(clip.clipId)) {
      return {
        ok: false,
        status: 400,
        error: "INVALID_CLIP_ID",
        details: `clips[${index}].clipId must match /^[A-Za-z0-9_-]+$/`,
      };
    }

    if (seenClipIds.has(clip.clipId)) {
      return { ok: false, status: 400, error: "DUPLICATE_CLIP_ID", details: `clips[${index}].clipId must be unique` };
    }

    seenClipIds.add(clip.clipId);

    if (!isFiniteNumber(clip.startMs) || clip.startMs < 0) {
      return { ok: false, status: 400, error: "INVALID_CLIP_START", details: `clips[${index}].startMs must be a number >= 0` };
    }

    if (!isFiniteNumber(clip.endMs) || clip.endMs <= clip.startMs) {
      return { ok: false, status: 400, error: "INVALID_CLIP_END", details: `clips[${index}].endMs must be greater than startMs` };
    }

    const durationMs = clip.endMs - clip.startMs;

    if (durationMs < CLIP_MIN_DURATION_MS) {
      return {
        ok: false,
        status: 400,
        error: "CLIP_DURATION_TOO_SHORT",
        details: `clips[${index}] duration must be at least ${CLIP_MIN_DURATION_MS} ms`,
      };
    }

    if (durationMs > CLIP_MAX_DURATION_MS) {
      return {
        ok: false,
        status: 400,
        error: "CLIP_DURATION_TOO_LONG",
        details: `clips[${index}] duration must be at most ${CLIP_MAX_DURATION_MS} ms`,
      };
    }
  }

  return { ok: true, value: { sourceJobId, clips } };
}

async function downloadMediaForTranscription(url, outputId) {
  const outDir = "/tmp";
  const outTemplate = path.join(outDir, `pusclip-transcribe-${outputId}.%(ext)s`);
  const commonArgs = [
    "--no-playlist",
    "--user-agent",
    "Mozilla/5.0 (Linux; Android 11; Mobile)",
    "--add-header",
    "Referer: https://www.youtube.com/",
    "--extractor-args",
    "youtube:player_client=android",
  ];

  const baseArgs = [...getYtDlpBaseArgs(), ...commonArgs, "-f", "bestaudio/best", "-x", "--audio-format", "mp3", "-o", outTemplate, url];
  const firstAttemptArgs = ["--js-runtimes", "node", ...baseArgs];
  const fallbackRuntime = hasRenderNodePath ? `node:${RENDER_NODE_PATH}` : "node";

  let { code, stderr } = await runYtDlpAsync(firstAttemptArgs);

  if (code !== 0 && fallbackRuntime !== "node" && /No supported JavaScript runtime could be found/i.test(stderr)) {
    console.warn(`[yt-dlp] retrying with fallback runtime: ${fallbackRuntime}`);
    ({ code, stderr } = await runYtDlpAsync(["--js-runtimes", fallbackRuntime, ...baseArgs]));
  }

  if (code !== 0) {
    const classifiedError = classifyDownloadError(stderr);
    const err = new Error(classifiedError.message);
    err.code = classifiedError.code;
    throw err;
  }

  const candidates = ["mp3", "m4a", "webm", "mp4"];
  const filePath = candidates
    .map((ext) => path.join(outDir, `pusclip-transcribe-${outputId}.${ext}`))
    .find((candidatePath) => fs.existsSync(candidatePath));

  if (!filePath) {
    const err = new Error("download finished but file not found");
    err.code = "DOWNLOAD_OUTPUT_NOT_FOUND";
    throw err;
  }

  return filePath;
}

async function processAnalyzeJob(jobId) {
  try {
    const processing = await patchJob(jobId, {
      status: "processing",
      progress: { stage: "analyzing", pct: 15 },
    });

    if (!processing) return;

    const sourceJobId = processing?.input?.sourceJobId;
    const sourceJob = await getJob(sourceJobId);

    if (!sourceJob || sourceJob.type !== "transcribe" || sourceJob.status !== "done") {
      await patchJob(jobId, {
        status: "error",
        progress: { stage: "error", pct: 100 },
        error: {
          code: "SOURCE_JOB_NOT_READY",
          message: "Source transcription job is not completed",
        },
      });
      return;
    }

    const sourceSegments = getSourceTranscriptSegments(sourceJob);
    const clips = buildClipCandidates(sourceSegments);

    if (!clips.length) {
      await patchJob(jobId, {
        status: "error",
        progress: { stage: "error", pct: 100 },
        error: { code: "NO_CLIPS_FOUND", message: "No valid clip candidates found" },
      });
      return;
    }

    await patchJob(jobId, {
      status: "done",
      progress: { stage: "done", pct: 100 },
      result: { clips },
      error: null,
    });
  } catch (err) {
    const message = String(err?.message ?? err);
    await patchJob(jobId, {
      status: "error",
      progress: { stage: "error", pct: 100 },
      error: { code: "ANALYZE_FAILED", message },
    });
  }
}

async function processClipJob(jobId) {
  let outputDir = null;
  let manifestPath = null;

  try {
    const queuedJob = await getJob(jobId);
    if (!queuedJob) return;

    const sourceJobId = queuedJob?.input?.sourceJobId;
    const requestedClips = Array.isArray(queuedJob?.input?.clips) ? queuedJob.input.clips : [];
    const sourceJob = await getJob(sourceJobId);

    if (!sourceJob) {
      await addJobLog(jobId, `source job ${sourceJobId} was not found`, "error");
      await patchJob(jobId, {
        status: "error",
        progress: {
          total: requestedClips.length,
          completed: 0,
          currentClipId: null,
        },
        error: {
          code: "SOURCE_JOB_NOT_FOUND",
          message: "Source video job does not exist",
        },
      });
      return;
    }

    if (sourceJob.status !== "done") {
      await addJobLog(jobId, `source job ${sourceJobId} is not available in done state`, "error");
      await patchJob(jobId, {
        status: "error",
        progress: {
          total: requestedClips.length,
          completed: 0,
          currentClipId: null,
        },
        error: {
          code: "SOURCE_JOB_NOT_READY",
          message: "Source video job does not exist or is not completed",
        },
      });
      return;
    }

    const sourceVideoPath = findSourceVideoFilePath(sourceJob);

    if (!sourceVideoPath || !fs.existsSync(sourceVideoPath)) {
      await addJobLog(jobId, `source job ${sourceJobId} is missing a usable video file path`, "error");
      await patchJob(jobId, {
        status: "error",
        progress: {
          total: requestedClips.length,
          completed: 0,
          currentClipId: null,
        },
        error: {
          code: "SOURCE_VIDEO_FILE_MISSING",
          message: "Source video file path is missing",
        },
      });
      return;
    }

    const sourceDurationMs = await getMediaDurationMs(sourceVideoPath);

    const clipExceedingDuration = requestedClips.find((clip) => clip.endMs > sourceDurationMs);
    if (clipExceedingDuration) {
      await addJobLog(jobId, `clip ${clipExceedingDuration.clipId} exceeds source duration ${sourceDurationMs} ms`, "error");
      await patchJob(jobId, {
        status: "error",
        progress: {
          total: requestedClips.length,
          completed: 0,
          currentClipId: null,
        },
        error: {
          code: "CLIP_EXCEEDS_SOURCE_DURATION",
          message: "One or more clips exceed the source video duration",
        },
      });
      return;
    }

    outputDir = ensureDirSync(getClipJobOutputDir(jobId));
    manifestPath = path.join(outputDir, "manifest.json");

    const updated = await patchJob(jobId, {
      status: "processing",
      progress: {
        total: requestedClips.length,
        completed: 0,
        currentClipId: null,
      },
      result: buildClipJobResult(sourceJobId, outputDir, manifestPath),
      error: null,
    });

    if (!updated) return;

    await addJobLog(jobId, `clip job started with ${requestedClips.length} clip(s) from source job ${sourceJobId}`);

    const generatedClips = [];

    for (const [index, clip] of requestedClips.entries()) {
      const fileName = `${clip.clipId}.mp4`;
      const outputPath = path.join(outputDir, fileName);

      await patchJob(jobId, {
        progress: {
          total: requestedClips.length,
          completed: generatedClips.length,
          currentClipId: clip.clipId,
        },
      });

      await addJobLog(
        jobId,
        `generating clip ${clip.clipId} (${index + 1}/${requestedClips.length}) from ${clip.startMs}ms to ${clip.endMs}ms`,
      );

      await generateVideoClip({
        inputPath: sourceVideoPath,
        outputPath,
        startMs: clip.startMs,
        endMs: clip.endMs,
      });

      const clipResult = {
        clipId: clip.clipId,
        status: "done",
        fileName,
        durationMs: clip.endMs - clip.startMs,
      };

      generatedClips.push(clipResult);

      await patchJob(jobId, {
        progress: {
          total: requestedClips.length,
          completed: generatedClips.length,
          currentClipId: clip.clipId,
        },
        result: {
          sourceJobId,
          outputDir,
          manifestPath,
          clips: generatedClips,
        },
      });

      await addJobLog(jobId, `clip ${clip.clipId} completed`);
    }

    const manifest = {
      sourceJobId,
      generatedAt: Date.now(),
      clips: generatedClips,
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    await patchJob(jobId, {
      status: "done",
      progress: {
        total: requestedClips.length,
        completed: generatedClips.length,
        currentClipId: null,
      },
      result: {
        sourceJobId,
        outputDir,
        manifestPath,
        clips: generatedClips,
      },
      error: null,
    });

    await addJobLog(jobId, `clip job completed successfully with ${generatedClips.length} clip(s)`);
  } catch (err) {
    const message = String(err?.message ?? err);
    await addJobLog(jobId, `clip job failed: ${message}`, "error");
    await patchJob(jobId, {
      status: "error",
      progress: {
        ...(await getJob(jobId))?.progress,
        currentClipId: null,
      },
      error: {
        code: typeof err?.code === "string" ? err.code : "CLIP_JOB_FAILED",
        message,
      },
    });

    if (manifestPath && outputDir) {
      const currentJob = await getJob(jobId);
      const generatedClips = Array.isArray(currentJob?.result?.clips) ? currentJob.result.clips : [];
      fs.writeFileSync(manifestPath, JSON.stringify({
        sourceJobId: currentJob?.input?.sourceJobId ?? null,
        generatedAt: Date.now(),
        clips: generatedClips,
        error: {
          code: typeof err?.code === "string" ? err.code : "CLIP_JOB_FAILED",
          message,
        },
      }, null, 2));
    }
  }
}

function isTranscriptEmpty(payload) {
  if (!payload) return true;

  // shape B (stored)
  const tObj = payload.transcript && typeof payload.transcript === "object"
    ? payload.transcript
    : null;

  const textB = tObj ? (tObj.text ?? "") : "";
  const segB = tObj ? (tObj.segments ?? []) : null;

  // shape A (raw)
  const textA = typeof payload.transcript === "string" ? payload.transcript : "";
  const segA = Array.isArray(payload.segments) ? payload.segments : null;

  const text = (textB || textA || "");
  const segs = (Array.isArray(segB) ? segB : (Array.isArray(segA) ? segA : []));

  const textEmpty = text.trim().length === 0;
  const segsEmpty = !Array.isArray(segs) || segs.length === 0 || segs.every((s) => {
    const st = typeof s === "string" ? s : (s?.text ?? "");
    return String(st).trim().length === 0;
  });

  // treat as empty if BOTH text and segs are empty
  return textEmpty && segsEmpty;
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
      ? [...getYtDlpBaseArgs(), ...commonArgs, "-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", outTemplate, url]
      : [...getYtDlpBaseArgs(), ...commonArgs, "-f", "bestaudio/best", "-x", "--audio-format", "mp3", "-o", outTemplate, url];

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

  if (!isTranscriptionProviderConfigured()) {
    await patchJob(jobId, {
      status: "error",
      progress: { stage: "error", pct: 100 },
      error: {
        code: "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED",
        message: "Transcription provider is not configured",
      },
    });
  }

  setTimeout(async () => {
    try {
      const updated = await patchJob(jobId, {
        status: "processing",
        progress: { stage: "transcribing", pct: 10 },
      });
      if (updated) console.log("job status transition", jobId, "-> processing");
    } catch (err) {
      const message = String(err?.message ?? err);
      const errorCode = typeof err?.code === "string" ? err.code : "TRANSCRIBE_FAILED";
      await patchJob(jobId, {
        status: "error",
        progress: { stage: "error", pct: 100 },
        error: { code: errorCode, message },
      });
      console.error("job failed", jobId, message);
    }
  }, 400);

  setTimeout(async () => {
    let downloadedFilePath = null;

    try {
      downloadedFilePath = await downloadMediaForTranscription(url, jobId);
      const transcript = await transcribeAudioFile(downloadedFilePath);

      const finalResult = {
        transcript,
      };

      if (isTranscriptEmpty(finalResult)) {
        await patchJob(jobId, {
          status: "error",
          error: {
            code: "TRANSCRIPT_EMPTY",
            message: "Transcription returned empty content",
          },
          progress: { stage: "error", pct: 100 },
        });
        console.warn("job status transition", jobId, "-> error (TRANSCRIPT_EMPTY)");
        return;
      }

      const updated = await patchJob(jobId, {
        status: "done",
        progress: { stage: "done", pct: 100 },
        result: finalResult,
        error: null,
      });
      if (updated) console.log("job status transition", jobId, "-> done");
    } catch (err) {
      const message = String(err?.message ?? err);
      const errorCode = typeof err?.code === "string" ? err.code : "TRANSCRIBE_FAILED";
      await patchJob(jobId, {
        status: "error",
        progress: { stage: "error", pct: 100 },
        error: { code: errorCode, message },
      });
      console.error("job failed", jobId, message);
    } finally {
      if (downloadedFilePath) {
        try {
          fs.unlinkSync(downloadedFilePath);
        } catch {}
      }
    }
  }, 1800);

  return res.status(202).json({
    ok: true,
    jobId,
  });
});


app.post("/analyze", async (req, res) => {
  const { sourceJobId } = req.body || {};

  if (!sourceJobId || typeof sourceJobId !== "string") {
    return jsonError(res, 400, "INVALID_INPUT", "sourceJobId is required");
  }

  const sourceJob = await getJob(sourceJobId);

  if (!sourceJob) {
    return jsonError(res, 404, "SOURCE_JOB_NOT_FOUND", "Source transcription job not found");
  }

  if (sourceJob.type !== "transcribe" || sourceJob.status !== "done") {
    return jsonError(res, 409, "SOURCE_JOB_NOT_READY", "Source transcription job is not completed");
  }

  const sourceSegments = getSourceTranscriptSegments(sourceJob);
  const hasUsableSegments = Array.isArray(sourceSegments)
    && sourceSegments.some((segment) => String(segment?.text ?? "").trim().length > 0);

  if (!hasUsableSegments) {
    return jsonError(res, 422, "SOURCE_TRANSCRIPT_EMPTY", "Source transcription has no usable segments");
  }

  const now = Date.now();
  const jobId = crypto.randomUUID();
  const analyzeJob = {
    jobId,
    type: "analyze",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    input: { sourceJobId },
    progress: { stage: "queued", pct: 0 },
    result: null,
    error: null,
  };

  await setJob(jobId, analyzeJob);

  setTimeout(() => {
    processAnalyzeJob(jobId).catch((err) => {
      console.error("analyze processor failed", jobId, err);
    });
  }, 0);

  return res.status(202).json({
    ok: true,
    jobId,
  });
});

app.post("/clips", async (req, res) => {
  const validation = validateClipRequestBody(req.body);
  if (!validation.ok) {
    return clipsJsonError(res, validation.status, validation.error, validation.details);
  }

  const { sourceJobId, clips } = validation.value;
  const sourceJob = await getJob(sourceJobId);

  if (!sourceJob) {
    return clipsJsonError(res, 404, "SOURCE_JOB_NOT_FOUND", "Source video job does not exist");
  }

  if (sourceJob.status !== "done") {
    return clipsJsonError(res, 409, "SOURCE_JOB_NOT_READY", "Source video job does not exist or is not completed");
  }

  const sourceVideoPath = findSourceVideoFilePath(sourceJob);
  if (!sourceVideoPath || !fs.existsSync(sourceVideoPath)) {
    return clipsJsonError(res, 422, "SOURCE_VIDEO_FILE_MISSING", "Source video file path is missing");
  }

  let sourceDurationMs;
  try {
    sourceDurationMs = await getMediaDurationMs(sourceVideoPath);
  } catch (err) {
    return clipsJsonError(
      res,
      422,
      typeof err?.code === "string" ? err.code : "MEDIA_DURATION_UNAVAILABLE",
      "Could not determine source video duration",
    );
  }

  const clipExceedingDuration = clips.find((clip) => clip.endMs > sourceDurationMs);
  if (clipExceedingDuration) {
    return clipsJsonError(res, 422, "CLIP_EXCEEDS_SOURCE_DURATION", "One or more clips exceed the source video duration");
  }

  const now = Date.now();
  const jobId = createJobId("job_clips");
  const outputDir = ensureDirSync(getClipJobOutputDir(jobId));
  const manifestPath = path.join(outputDir, "manifest.json");
  const job = {
    jobId,
    type: "clips",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    input: { sourceJobId, clips },
    progress: {
      total: clips.length,
      completed: 0,
      currentClipId: null,
    },
    result: buildClipJobResult(sourceJobId, outputDir, manifestPath),
    error: null,
    logs: [
      {
        at: now,
        level: "info",
        message: `clip job queued with ${clips.length} clip(s) from source job ${sourceJobId}`,
      },
    ],
  };

  fs.writeFileSync(manifestPath, JSON.stringify({
    sourceJobId,
    generatedAt: null,
    clips: [],
  }, null, 2));

  await setJob(jobId, job);

  setTimeout(() => {
    processClipJob(jobId).catch((err) => {
      console.error("clip processor failed", jobId, err);
    });
  }, 0);

  return res.status(202).json({
    ok: true,
    jobId,
    status: "queued",
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
  if (!getTranscriptionProviderName()) {
    console.warn("[transcribe] OPENAI_API_KEY is not set. /transcribe jobs will fail with TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
  }
  runYtDlp([...getYtDlpBaseArgs(), "--version"], () => {});
});
