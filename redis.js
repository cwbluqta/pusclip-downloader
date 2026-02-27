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

export async function patchJob(jobId, patch) {
  const current = await getJob(jobId);
  if (!current) return null;

  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };

  if (patch.progress) {
    next.progress = { ...(current.progress ?? {}), ...patch.progress };
  }

  if (patch.result) {
    next.result = { ...(current.result ?? {}), ...patch.result };
  }

  if (patch.error !== undefined) {
    next.error = patch.error;
  }

  await setJob(jobId, next);
  return next;
}
