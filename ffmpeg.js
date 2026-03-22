import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

function ensureFfmpegPath() {
  if (!ffmpegPath) {
    const err = new Error("ffmpeg binary is not available");
    err.code = "FFMPEG_NOT_AVAILABLE";
    throw err;
  }

  return ffmpegPath;
}

function runFfmpeg(args) {
  const binary = ensureFfmpegPath();

  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finalizeResolve = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };

    const finalizeReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      const err = new Error(`ffmpeg spawn error: ${error.message}`);
      err.code = "FFMPEG_SPAWN_ERROR";
      finalizeReject(err);
    });

    proc.on("close", (code) => {
      finalizeResolve(code ?? 1);
    });
  });
}

function parseDurationToMs(stderr) {
  const match = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) return null;

  const [, hours, minutes, seconds] = match;
  const totalSeconds = (Number(hours) * 3600) + (Number(minutes) * 60) + Number(seconds);

  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
  return Math.round(totalSeconds * 1000);
}

function formatSecondsFromMs(ms) {
  return (ms / 1000).toFixed(3);
}

export async function getMediaDurationMs(inputPath) {
  const { code, stderr } = await runFfmpeg(["-i", inputPath, "-f", "null", "-"]);
  const durationMs = parseDurationToMs(stderr);

  if (durationMs !== null) {
    return durationMs;
  }

  const err = new Error(`Could not determine media duration (ffmpeg exit code ${code})`);
  err.code = "MEDIA_DURATION_UNAVAILABLE";
  throw err;
}

export async function generateVideoClip({ inputPath, outputPath, startMs, endMs }) {
  const args = [
    "-y",
    "-ss",
    formatSecondsFromMs(startMs),
    "-to",
    formatSecondsFromMs(endMs),
    "-i",
    inputPath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  const { code, stderr } = await runFfmpeg(args);

  if (code !== 0) {
    const err = new Error(`ffmpeg clip generation failed: ${String(stderr).slice(-1500) || `exit code ${code}`}`);
    err.code = "FFMPEG_CLIP_FAILED";
    throw err;
  }

  return { outputPath };
}
