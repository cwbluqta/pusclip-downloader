import { Redis } from "@upstash/redis";

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const redis = new Redis({
  url: requiredEnv("UPSTASH_REDIS_REST_URL"),
  token: requiredEnv("UPSTASH_REDIS_REST_TOKEN"),
});

const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS ?? 259200); // 72h

export function jobKey(jobId) {
  return `job:${jobId}`;
}

export async function getJob(jobId) {
  const val = await redis.get(jobKey(jobId));
  return val ?? null;
}

export async function setJob(jobId, job) {
  await redis.set(jobKey(jobId), job, { ex: JOB_TTL_SECONDS });
  return job;
}

export async function createJob({ jobId, input }) {
  const now = Date.now();
  const job = {
    jobId,
    status: "queued",
    step: "init",
    progress: 0,
    input,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  await setJob(jobId, job);
  return job;
}

export async function updateJob(jobId, patch) {
  const current = await getJob(jobId);
  if (!current) return null;

  if (current.status === "done" || current.status === "error") {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };

  await setJob(jobId, next);
  return next;
}

export async function failJob(jobId, error, step = "transcribing") {
  const errorMessage = typeof error === "string" ? error : String(error?.message ?? "Job failed");
  return updateJob(jobId, {
    status: "error",
    step,
    error: errorMessage,
  });
}

export async function appendJobLog(jobId, entry) {
  const current = await getJob(jobId);
  if (!current) return null;

  const next = {
    ...current,
    logs: [...(Array.isArray(current.logs) ? current.logs : []), entry],
    updatedAt: Date.now(),
  };

  await setJob(jobId, next);
  return next;
}

export async function patchJob(jobId, patch) {
  const current = await getJob(jobId);
  if (!current) return null;

  const currentStatus = current.status;
  if (currentStatus === "done" || currentStatus === "error") {
    return null;
  }

  const nextStatus = patch?.status ?? currentStatus;
  const allowedTransitions = {
    queued: new Set(["queued", "processing", "error"]),
    processing: new Set(["processing", "done", "error"]),
    downloading: new Set(["downloading", "processing", "done", "error"]),
  };

  if (
    currentStatus &&
    nextStatus &&
    allowedTransitions[currentStatus] &&
    !allowedTransitions[currentStatus].has(nextStatus)
  ) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };

  if (patch.progress && typeof patch.progress === "object" && !Array.isArray(patch.progress)) {
    next.progress = { ...(current.progress ?? {}), ...patch.progress };
  }

  if (patch.result && typeof patch.result === "object" && !Array.isArray(patch.result)) {
    next.result = { ...(current.result ?? {}), ...patch.result };
  }

  if (patch.error !== undefined) {
    next.error = patch.error;
  }

  await setJob(jobId, next);
  return next;
}
