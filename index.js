import express from "express";
import cors from "cors";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { generateVideoClip, getMediaDurationMs } from "./ffmpeg.js";
import { appendJobLog, createJob, failJob, getJob, patchJob, redis, setJob, updateJob } from "./redis.js";
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

const WINDOWS_DENO_PATH = "C:\\Users\\rhosa\\AppData\\Local\\Microsoft\\WinGet\\Links\\deno.exe";
const TEMP_ROOT = os.tmpdir();
const COOKIES_PATH = path.resolve(process.cwd(), "cookies.txt");
const JOB_OUTPUT_ROOT = path.join(TEMP_ROOT, "pusclip-jobs");
const UPLOAD_VIDEO_ROOT = path.join(JOB_OUTPUT_ROOT, "uploads");
const CLIP_JOB_MIN_COUNT = 1;
const CLIP_JOB_MAX_COUNT = 10;
const CLIP_MIN_DURATION_MS = 3000;
const CLIP_MAX_DURATION_MS = 120000;
const MAX_UPLOAD_VIDEO_BYTES = Number(process.env.MAX_UPLOAD_VIDEO_BYTES ?? 250 * 1024 * 1024);

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

function getJsRuntimeValue() {
  const isWin = process.platform === "win32";
  const exists = fs.existsSync(WINDOWS_DENO_PATH);

  console.log("[runtime] process.platform =", process.platform);
  console.log("[runtime] WINDOWS_DENO_PATH =", WINDOWS_DENO_PATH);
  console.log("[runtime] existsSync =", exists);

  const value = isWin && exists ? WINDOWS_DENO_PATH : "deno";

  console.log("[runtime] resolved --js-runtimes value =", value);

  return value;
}

function withResolvedJsRuntime(args) {
  const jsRuntime = getJsRuntimeValue();
  const normalizedArgs = [];

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--js-runtimes") {
      i += 1;
      continue;
    }

    normalizedArgs.push(args[i]);
  }

  return ["--js-runtimes", jsRuntime, ...normalizedArgs];
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

function summarizePathForLogs(pathValue) {
  if (!pathValue) return "<empty>";
  const parts = pathValue.split(path.delimiter);
  const head = parts.slice(0, 6);
  const suffix = parts.length > head.length ? ` ... (+${parts.length - head.length} more)` : "";
  return `${head.join(path.delimiter)}${suffix}`;
}

function buildYtDlpLogContext(args, spawnOptions = {}) {
  const env = spawnOptions.env || process.env;
  const cwd = spawnOptions.cwd || process.cwd();

  return {
    cwd,
    jsRuntimes: (() => {
      const index = args.indexOf("--js-runtimes");
      return index >= 0 ? args[index + 1] || "<missing>" : "<not-set>";
    })(),
    cookiesPath: (() => {
      const index = args.indexOf("--cookies");
      return index >= 0 ? args[index + 1] || "<missing>" : "<not-set>";
    })(),
    outputTemplate: (() => {
      const index = args.indexOf("-o");
      return index >= 0 ? args[index + 1] || "<missing>" : "<not-set>";
    })(),
    pathHead: summarizePathForLogs(env.PATH || ""),
    nodeEnv: env.NODE_ENV || "<unset>",
    tempDir: env.TMPDIR || env.TMP || env.TEMP || "<unset>",
  };
}

function runYtDlp(args, onClose, spawnOptions = {}) {
  const resolvedArgs = withResolvedJsRuntime(args);
  const sanitized = sanitizeYtDlpArgsForLogs(resolvedArgs);
  console.log(`[yt-dlp] command: yt-dlp ${sanitized.join(" ")}`);
  const ctx = buildYtDlpLogContext(resolvedArgs, spawnOptions);
  console.log(
    `[yt-dlp] context cwd=${ctx.cwd} js_runtime=${ctx.jsRuntimes} cookies=${ctx.cookiesPath} output=${ctx.outputTemplate} temp=${ctx.tempDir} node_env=${ctx.nodeEnv}`,
  );
  console.log(`[yt-dlp] context PATH(head)=${ctx.pathHead}`);

  const proc = spawn("yt-dlp", resolvedArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnOptions.env || buildYtDlpSpawnEnv(),
    cwd: spawnOptions.cwd || process.cwd(),
  });
  let stdout = "";
  let stderr = "";
  let finished = false;

  const finalize = (code) => {
    if (finished) return;
    finished = true;
    onClose(code, stdout, stderr);
  };

  proc.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  proc.on("error", (err) => {
    stderr += `spawn error: ${err.message}\n`;
    finalize(127);
  });
  proc.on("close", (code) => finalize(code ?? 1));
}

function maskTokenForLogs(token) {
  const raw = String(token || "").trim();
  if (!raw) return "<missing>";
  if (raw.length <= 8) return `${raw[0]}***${raw.at(-1)}`;
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

function runYtDlpAsync(args, spawnOptions = {}) {
  return new Promise((resolve) => {
    runYtDlp(args, (code, stdout, stderr) => resolve({ code, stdout, stderr }), spawnOptions);
  });
}

function getRuntimeDependenciesStatus() {
  const ytDlpVersionCheck = spawnSync("yt-dlp", ["--version"], { stdio: "ignore" });
  const hasYtDlp = ytDlpVersionCheck.status === 0;

  const hasFfmpegBinary = typeof ffmpegPath === "string" && ffmpegPath.length > 0 && fs.existsSync(ffmpegPath);

  return { hasYtDlp, hasFfmpegBinary, ffmpegBinaryPath: ffmpegPath || null };
}

function buildYtDlpSpawnEnv() {
  const env = { ...process.env };

  if (typeof ffmpegPath === "string" && ffmpegPath) {
    const ffmpegDir = path.dirname(ffmpegPath);
    const currentPath = env.PATH || "";
    if (!currentPath.split(path.delimiter).includes(ffmpegDir)) {
      env.PATH = currentPath ? `${ffmpegDir}${path.delimiter}${currentPath}` : ffmpegDir;
    }
  }

  return env;
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

function uploadVideoJsonError(res, status, code, details) {
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

function removeFileIfExists(filePath) {
  if (!filePath) return;

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function removeDirIfExists(dirPath) {
  if (!dirPath) return;

  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {}
}

function getClipJobOutputDir(jobId) {
  return path.join(JOB_OUTPUT_ROOT, jobId);
}

function getUploadVideoOutputDir(jobId) {
  return path.join(UPLOAD_VIDEO_ROOT, jobId);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeClipId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function sanitizeUploadedFileName(fileName) {
  const baseName = path.basename(String(fileName || "upload.mp4")).replace(/[^A-Za-z0-9._-]+/g, "_");
  return baseName.toLowerCase().endsWith(".mp4") ? baseName : `${baseName}.mp4`;
}

function parseDispositionParameters(headerValue) {
  const params = {};
  const parts = String(headerValue || "").split(";").slice(1);

  for (const rawPart of parts) {
    const [rawKey, ...rawValueParts] = rawPart.split("=");
    const key = rawKey?.trim()?.toLowerCase();
    if (!key) continue;

    const rawValue = rawValueParts.join("=").trim();
    params[key] = rawValue.replace(/^"|"$/g, "");
  }

  return params;
}

function getMultipartBoundary(contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] || match?.[2] || null;
}

function parseMultipartFormData(bodyBuffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const closingDelimiter = Buffer.from(`--${boundary}--`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  const parts = [];
  let cursor = bodyBuffer.indexOf(delimiter);

  if (cursor === -1) {
    const err = new Error("Multipart boundary was not found in request body");
    err.code = "INVALID_MULTIPART_BODY";
    throw err;
  }

  cursor += delimiter.length;

  while (cursor < bodyBuffer.length) {
    if (bodyBuffer[cursor] === 45 && bodyBuffer[cursor + 1] === 45) {
      break;
    }

    if (bodyBuffer[cursor] === 13 && bodyBuffer[cursor + 1] === 10) {
      cursor += 2;
    }

    const nextDelimiterIndex = bodyBuffer.indexOf(delimiter, cursor);
    const nextClosingIndex = bodyBuffer.indexOf(closingDelimiter, cursor);
    const partEnd = nextDelimiterIndex === -1 ? nextClosingIndex : nextDelimiterIndex;

    if (partEnd === -1) {
      const err = new Error("Multipart body terminated unexpectedly");
      err.code = "INVALID_MULTIPART_BODY";
      throw err;
    }

    let partBuffer = bodyBuffer.subarray(cursor, partEnd);
    if (partBuffer.length >= 2 && partBuffer[partBuffer.length - 2] === 13 && partBuffer[partBuffer.length - 1] === 10) {
      partBuffer = partBuffer.subarray(0, partBuffer.length - 2);
    }

    const headerEndIndex = partBuffer.indexOf(headerSeparator);
    if (headerEndIndex === -1) {
      const err = new Error("Multipart part is missing headers");
      err.code = "INVALID_MULTIPART_BODY";
      throw err;
    }

    const rawHeaders = partBuffer.subarray(0, headerEndIndex).toString("utf8");
    const content = partBuffer.subarray(headerEndIndex + headerSeparator.length);
    const headers = {};

    for (const headerLine of rawHeaders.split("\r\n")) {
      const separatorIndex = headerLine.indexOf(":");
      if (separatorIndex === -1) continue;
      const key = headerLine.slice(0, separatorIndex).trim().toLowerCase();
      const value = headerLine.slice(separatorIndex + 1).trim();
      headers[key] = value;
    }

    parts.push({ headers, content });
    cursor = partEnd + delimiter.length;
  }

  return parts;
}

async function readMultipartRequest(req, maxBytes = MAX_UPLOAD_VIDEO_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const finalizeReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const finalizeResolve = (buffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };

    req.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > maxBytes) {
        const err = new Error(`Uploaded file exceeds ${maxBytes} bytes`);
        err.code = "UPLOAD_TOO_LARGE";
        req.destroy(err);
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => finalizeResolve(Buffer.concat(chunks)));
    req.on("error", (error) => finalizeReject(error));
    req.on("aborted", () => {
      const err = new Error("Request was aborted before upload completed");
      err.code = "UPLOAD_ABORTED";
      finalizeReject(err);
    });
  });
}

async function parseSingleMp4Upload(req) {
  const boundary = getMultipartBoundary(req.headers["content-type"]);
  if (!boundary) {
    const err = new Error("Content-Type must be multipart/form-data with a boundary");
    err.code = "INVALID_CONTENT_TYPE";
    throw err;
  }

  const bodyBuffer = await readMultipartRequest(req);
  const parts = parseMultipartFormData(bodyBuffer, boundary);
  const fileParts = parts
    .map((part) => {
      const disposition = part.headers["content-disposition"];
      const dispositionParams = parseDispositionParameters(disposition);

      return {
        headers: part.headers,
        content: part.content,
        name: dispositionParams.name ?? null,
        fileName: dispositionParams.filename ?? null,
      };
    })
    .filter((part) => part.name === "file" && typeof part.fileName === "string" && part.fileName.length > 0);

  if (!fileParts.length) {
    const err = new Error('Missing uploaded file field "file"');
    err.code = "MISSING_FILE";
    throw err;
  }

  if (fileParts.length > 1) {
    const err = new Error('Only one uploaded file is allowed for field "file"');
    err.code = "TOO_MANY_FILES";
    throw err;
  }

  const [filePart] = fileParts;
  const mimeType = String(filePart.headers["content-type"] || "").trim().toLowerCase();

  if (mimeType !== "video/mp4") {
    const err = new Error('Only "video/mp4" uploads are supported');
    err.code = "UNSUPPORTED_MEDIA_TYPE";
    throw err;
  }

  if (!filePart.content.length) {
    const err = new Error("Uploaded file is empty");
    err.code = "EMPTY_FILE";
    throw err;
  }

  return {
    buffer: filePart.content,
    fileName: sanitizeUploadedFileName(filePart.fileName),
    mimeType,
    originalFileName: filePart.fileName,
  };
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
  const outDir = TEMP_ROOT;
  const outTemplate = path.join(outDir, `pusclip-transcribe-${outputId}.%(ext)s`);
  const commonArgs = [
    "--no-playlist",
    "--remote-components",
    "--user-agent",
    "Mozilla/5.0 (Linux; Android 11; Mobile)",
    "--add-header",
    "Referer: https://www.youtube.com/",
    "--cookies",
    "cookies.txt",
  ];

  const baseArgs = [...getYtDlpBaseArgs(), ...commonArgs, "-f", "bestaudio/best", "-x", "--audio-format", "mp3", "-o", outTemplate, url];
  const { code, stdout, stderr } = await runYtDlpAsync(baseArgs);

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

const MIN_TRANSCRIPT_CHARS = Number(process.env.MIN_TRANSCRIPT_CHARS ?? 10);

function validateTranscriptOrThrow(transcript) {
  if (!transcript || typeof transcript !== "object") {
    const err = new Error("Empty transcription: transcript is missing");
    err.code = "TRANSCRIPT_EMPTY";
    throw err;
  }

  const text = typeof transcript.text === "string" ? transcript.text : "";
  if (text.trim().length === 0) {
    const err = new Error("Empty transcription: transcript text is blank");
    err.code = "TRANSCRIPT_EMPTY";
    throw err;
  }

  if (text.length < MIN_TRANSCRIPT_CHARS) {
    const err = new Error(`Empty transcription: transcript is below minimum length (${MIN_TRANSCRIPT_CHARS})`);
    err.code = "TRANSCRIPT_EMPTY";
    throw err;
  }

  if (!Array.isArray(transcript.segments) || transcript.segments.length === 0) {
    const err = new Error("Empty transcription: segments are missing");
    err.code = "TRANSCRIPT_EMPTY";
    throw err;
  }

  let previousEnd = null;
  for (const [index, segment] of transcript.segments.entries()) {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const segmentText = typeof segment?.text === "string" ? segment.text : "";

    const invalidSegment = !Number.isFinite(start)
      || !Number.isFinite(end)
      || end <= start
      || segmentText.trim().length === 0;

    if (invalidSegment) {
      const err = new Error(`Empty transcription: invalid segment at index ${index}`);
      err.code = "TRANSCRIPT_EMPTY";
      throw err;
    }

    if (previousEnd !== null && start < previousEnd) {
      const err = new Error(`Empty transcription: inconsistent segment timeline at index ${index}`);
      err.code = "TRANSCRIPT_EMPTY";
      throw err;
    }

    previousEnd = end;
  }

  if (Number.isFinite(transcript.durationSeconds) && previousEnd !== null && previousEnd > transcript.durationSeconds + 1) {
    const err = new Error("Empty transcription: inconsistent duration");
    err.code = "TRANSCRIPT_EMPTY";
    throw err;
  }
}

async function processTranscriptionJob(jobId, url) {
  let downloadedFilePath = null;

  try {
    if (!isTranscriptionProviderConfigured()) {
      await failJob(jobId, "OPENAI_API_KEY is not configured", "transcribing");
      return;
    }

    const downloading = await updateJob(jobId, {
      status: "downloading",
      step: "download",
      progress: 10,
      error: null,
    });

    if (!downloading) return;

    downloadedFilePath = await downloadMediaForTranscription(url, jobId);

    const extracting = await updateJob(jobId, {
      status: "processing",
      step: "extract_audio",
      progress: 25,
    });

    if (!extracting) return;

    const transcribing = await updateJob(jobId, {
      status: "processing",
      step: "transcribing",
      progress: 50,
    });

    if (!transcribing) return;

    const transcript = await transcribeAudioFile(downloadedFilePath);
    validateTranscriptOrThrow(transcript);

    await updateJob(jobId, {
      status: "done",
      step: "transcribing",
      progress: 100,
      result: { transcript },
      error: null,
    });
  } catch (err) {
    const message = String(err?.message ?? err);
    await failJob(jobId, message, "transcribing");
    console.error("job failed", jobId, message);
  } finally {
    if (downloadedFilePath) {
      try {
        fs.unlinkSync(downloadedFilePath);
      } catch {}
    }
  }
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
  const hasAuthHeader = Boolean(authHeader);
  const isBearer = /^Bearer\s+/i.test(authHeader);
  const gotToken = isBearer ? authHeader.replace(/^Bearer\s+/i, "").trim() : "";
  const matches = Boolean(expected && authHeader === expected);

  console.info(
    `[auth] ${req.path} authorization_present=${hasAuthHeader} bearer_format=${isBearer} token_match=${matches} provided_token=${maskTokenForLogs(gotToken)}`,
  );

  if (!expected || !matches) {
    console.warn("[auth] unauthorized request rejected");
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

function extractFirstJsonObject(rawText) {
  const text = String(rawText || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function pickBestAvailableAudioFormat(formats) {
  const audioOnly = formats
    .filter((fmt) => fmt && fmt.acodec && fmt.acodec !== "none" && (!fmt.vcodec || fmt.vcodec === "none") && fmt.format_id)
    .sort((a, b) => Number(b.abr || 0) - Number(a.abr || 0));

  if (audioOnly.length) return audioOnly[0].format_id;

  const withAudio = formats
    .filter((fmt) => fmt && fmt.acodec && fmt.acodec !== "none" && fmt.format_id)
    .sort((a, b) => Number(b.tbr || b.abr || 0) - Number(a.tbr || a.abr || 0));

  return withAudio.length ? withAudio[0].format_id : null;
}

function buildDownloadAttempts({ url, format, outTemplate, commonArgs }) {
  const want = format === "mp4" ? "mp4" : "mp3";
  const cookieArgs = getYtDlpBaseArgs();
  const manualEquivalentPrefix = [...cookieArgs];

  if (want === "mp4") {
    return {
      want,
      attempts: [
        {
          label: "mp4-manual-equivalent",
          args: [...manualEquivalentPrefix, "-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", outTemplate, url],
        },
      ],
    };
  }

  return {
    want,
    attempts: [
      {
        label: "mp3-bestaudio-best",
        args: [...manualEquivalentPrefix, ...commonArgs, "-f", "bestaudio/best", "-x", "--audio-format", "mp3", "-o", outTemplate, url],
      },
      {
        label: "mp3-no-format-fallback",
        args: [...manualEquivalentPrefix, ...commonArgs, "-x", "--audio-format", "mp3", "-o", outTemplate, url],
      },
    ],
  };
}

async function fetchAvailableAudioFormat(url, commonArgs) {
  const listArgs = [...getYtDlpBaseArgs(), ...commonArgs, "-J", url];
  console.info(`[download] listing available formats before mp3 conversion`);
  console.info(`[download] format list command: yt-dlp ${sanitizeYtDlpArgsForLogs(listArgs).join(" ")}`);

  const { code, stdout, stderr } = await runYtDlpAsync(listArgs);
  console.log(`[yt-dlp] format list exit code: ${code}`);
  if (stdout) console.log(`[yt-dlp] format list stdout:\n${stdout}`);
  if (stderr) console.error(`[yt-dlp] format list stderr:\n${stderr}`);
  if (code !== 0) return null;

  const jsonText = extractFirstJsonObject(stdout);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText);
    const formats = Array.isArray(parsed?.formats) ? parsed.formats : [];
    const selected = pickBestAvailableAudioFormat(formats);
    if (selected) {
      console.info(`[download] selected available audio format_id=${selected}`);
    } else {
      console.warn("[download] no specific audio format_id found from listing");
    }
    return selected;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[download] could not parse format listing JSON: ${message}`);
    return null;
  }
}

// Download real com yt-dlp (mp3 padrão, mp4 opcional)
app.post("/download", async (req, res) => {
  if (!requireAuth(req, res)) return;

  const { url, format } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url required" });
  }

  const isYoutube = /youtube\.com|youtu\.be/.test(url);
  if (!isYoutube) {
    return res.status(400).json({ error: "Only YouTube URLs supported for now" });
  }

  const envStatus = {
    hasDownloaderToken: Boolean(DOWNLOADER_TOKEN),
    hasCookiesEnv: Boolean(process.env.YTDLP_COOKIES),
    hasCookiesFile: fs.existsSync(COOKIES_PATH),
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasRedisUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL),
    hasRedisToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
  };
  console.info(
    `[download] env status token=${envStatus.hasDownloaderToken} cookies_env=${envStatus.hasCookiesEnv} cookies_file=${envStatus.hasCookiesFile} openai=${envStatus.hasOpenAiKey} redis_url=${envStatus.hasRedisUrl} redis_token=${envStatus.hasRedisToken}`,
  );

  const runtime = getRuntimeDependenciesStatus();
  if (!runtime.hasYtDlp || !runtime.hasFfmpegBinary) {
    const missing = [
      !runtime.hasYtDlp ? "yt-dlp" : null,
      !runtime.hasFfmpegBinary ? "ffmpeg" : null,
    ].filter(Boolean);

    const details = `Missing runtime dependencies: ${missing.join(", ")}. ffmpegPath=${runtime.ffmpegBinaryPath || "null"}`;
    console.error(`[download] dependency check failed: ${details}`);

    return res.status(500).json({
      error: details,
      details,
    });
  }

  const id = crypto.randomBytes(12).toString("hex");
  const outDir = TEMP_ROOT;
  const outTemplate = path.join(outDir, `pusclip-${id}.%(ext)s`);

  // Args yt-dlp
  const commonArgs = [
    "--no-playlist",
    "--extractor-retries", "3",
    "--sleep-interval", "1",
    "--max-sleep-interval", "5",
  ];
  let attempts = [];
  let want = "mp3";
  try {
    const built = buildDownloadAttempts({ url, format, outTemplate, commonArgs });
    want = built.want;
    attempts = built.attempts;

    if (want !== "mp4") {
      const selectedAudioFormat = await fetchAvailableAudioFormat(url, commonArgs);
      if (selectedAudioFormat) {
        attempts.unshift({
          label: "mp3-selected-audio-format",
          args: [
            ...getYtDlpBaseArgs(),
            ...commonArgs,
            "-f",
            selectedAudioFormat,
            "-x",
            "--audio-format",
            "mp3",
            "-o",
            outTemplate,
            url,
          ],
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[download] failed to build yt-dlp args: ${message}`);
    return res.status(500).json({
      ok: false,
      error: {
        code: "DOWNLOADER_ENV_INVALID",
        message,
      },
    });
  }

  console.info(`[download] requested format=${want}`);

  let lastResult = null;
  for (const attempt of attempts) {
    console.info(`[download] running attempt=${attempt.label}`);
    console.info(`[download] final command: yt-dlp ${sanitizeYtDlpArgsForLogs(attempt.args).join(" ")}`);

    const result = await runYtDlpAsync(attempt.args);
    lastResult = result;
    console.log(`[yt-dlp] attempt=${attempt.label} exit code: ${result.code}`);
    if (result.stdout) console.log(`[yt-dlp] attempt=${attempt.label} stdout:\n${result.stdout}`);
    if (result.stderr) console.error(`[yt-dlp] attempt=${attempt.label} stderr:\n${result.stderr}`);

    if (result.code === 0) break;
  }

  if (!lastResult || lastResult.code !== 0) {
    const stderr = lastResult?.stderr || "";
    const classified = classifyDownloadError(stderr);
    const details = String(stderr).trim().slice(-3000) || `yt-dlp exited with code ${lastResult?.code ?? 1}`;
    console.error("[yt-dlp] execution failed after all attempts");
    return res.status(500).json({
      ok: false,
      error: {
        code: classified.code,
        message: classified.message,
      },
      details,
      exitCode: lastResult?.code ?? 1,
    });
  }

  // Acha o arquivo gerado
  const mp3Path = path.join(outDir, `pusclip-${id}.mp3`);
  const mp4Path = path.join(outDir, `pusclip-${id}.mp4`);
  const filePath = fs.existsSync(mp3Path) ? mp3Path : fs.existsSync(mp4Path) ? mp4Path : null;

  if (!filePath) {
    return res.status(500).json({
      ok: false,
      error: {
        code: "DOWNLOAD_OUTPUT_NOT_FOUND",
        message: "download finished but file not found",
      },
    });
  }

  const filename = path.basename(filePath);
  const mime = filename.endsWith(".mp3") ? "audio/mpeg" : "video/mp4";
  console.info(`[download] output generated asset_id=${id} filename=${filename} mime=${mime}`);

  files.set(id, { filePath, createdAt: Date.now(), mime, filename });

  return res.status(200).json({
    ok: true,
    assetId: id,
    filename,
  });
});

app.post("/transcribe", async (req, res) => {
  const payload = req.body || {};
  const { url } = payload;

  if (!url || typeof url !== "string") {
    return res.status(400).json({
      ok: false,
      error: { code: "BAD_REQUEST", message: "url must be a non-empty string" },
    });
  }

  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return res.status(400).json({
      ok: false,
      error: { code: "BAD_REQUEST", message: "url must be a non-empty string" },
    });
  }

  const jobId = crypto.randomUUID();
  await createJob({ jobId, input: { url: normalizedUrl } });

  processTranscriptionJob(jobId, normalizedUrl).catch((err) => {
    console.error("transcribe processor failed", jobId, err);
  });

  return res.status(202).json({
    jobId,
    status: "queued",
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

app.post("/upload-video", async (req, res) => {
  let uploadDir = null;
  let filePath = null;

  try {
    const upload = await parseSingleMp4Upload(req);
    const now = Date.now();
    const jobId = createJobId("job_upload_video");

    uploadDir = ensureDirSync(getUploadVideoOutputDir(jobId));
    filePath = path.join(uploadDir, upload.fileName);

    fs.writeFileSync(filePath, upload.buffer);

    let durationMs = null;
    try {
      durationMs = await getMediaDurationMs(filePath);
    } catch (err) {
      console.warn(`[upload-video] duration probe failed for ${filePath}:`, String(err?.message ?? err));
    }

    const job = {
      jobId,
      type: "upload-video",
      status: "done",
      createdAt: now,
      updatedAt: now,
      input: {
        source: "local-upload",
      },
      result: {
        video: {
          filePath,
          fileName: upload.originalFileName || upload.fileName,
          mimeType: upload.mimeType,
          durationMs,
        },
      },
      error: null,
    };

    await setJob(jobId, job);

    return res.status(200).json({
      ok: true,
      jobId,
      status: "done",
    });
  } catch (err) {
    removeFileIfExists(filePath);
    removeDirIfExists(uploadDir);

    const errorCode = typeof err?.code === "string" ? err.code : "UPLOAD_VIDEO_FAILED";
    const details = String(err?.message ?? "Failed to ingest uploaded video");
    const statusByCode = {
      INVALID_CONTENT_TYPE: 400,
      INVALID_MULTIPART_BODY: 400,
      MISSING_FILE: 400,
      TOO_MANY_FILES: 400,
      EMPTY_FILE: 400,
      UNSUPPORTED_MEDIA_TYPE: 415,
      UPLOAD_TOO_LARGE: 413,
      UPLOAD_ABORTED: 499,
    };

    return uploadVideoJsonError(res, statusByCode[errorCode] ?? 500, errorCode, details);
  }
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
    jobId: job.jobId,
    status: job.status,
    step: job.step,
    progress: job.progress,
    result: job.result,
    error: job.error,
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
  runYtDlp([...getYtDlpBaseArgs(), "--version"], (code, stdout, stderr) => {});
});
