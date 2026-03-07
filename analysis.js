function toFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [];

  return segments
    .map((segment) => {
      const start = toFiniteNumber(segment?.start);
      const end = toFiniteNumber(segment?.end);
      const text = String(segment?.text ?? "").trim();

      if (start === null || end === null || end <= start || text.length === 0) {
        return null;
      }

      return { start, end, text };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function scoreWindow(windowSegments, durationSeconds) {
  const totalChars = windowSegments.reduce((sum, segment) => sum + segment.text.length, 0);
  const speechDensity = totalChars / durationSeconds;
  const segmentCount = windowSegments.length;

  const densityScore = clamp01(speechDensity / 20) * 50;
  const durationScore = clamp01(1 - Math.abs(durationSeconds - 30) / 15) * 25;
  const consecutiveScore = clamp01(segmentCount / 6) * 25;

  const score = Number((densityScore + durationScore + consecutiveScore).toFixed(3));

  const reasonCandidates = [
    { key: "high_speech_density", value: densityScore },
    { key: "good_duration_balance", value: durationScore },
    { key: "dense_consecutive_segments", value: consecutiveScore },
  ].sort((a, b) => b.value - a.value);

  return { score, reason: reasonCandidates[0].key };
}

export function buildClipCandidates(segments, options = {}) {
  const {
    minDurationSeconds = 20,
    maxDurationSeconds = 45,
    maxClips = 3,
  } = options;

  const normalizedSegments = normalizeSegments(segments);
  const candidates = [];

  for (let startIndex = 0; startIndex < normalizedSegments.length; startIndex += 1) {
    for (let endIndex = startIndex; endIndex < normalizedSegments.length; endIndex += 1) {
      const windowSegments = normalizedSegments.slice(startIndex, endIndex + 1);
      const startSeconds = windowSegments[0].start;
      const endSeconds = windowSegments[windowSegments.length - 1].end;
      const durationSeconds = endSeconds - startSeconds;

      if (durationSeconds < minDurationSeconds) continue;
      if (durationSeconds > maxDurationSeconds) break;

      const { score, reason } = scoreWindow(windowSegments, durationSeconds);

      candidates.push({
        startMs: Math.round(startSeconds * 1000),
        endMs: Math.round(endSeconds * 1000),
        durationMs: Math.round(durationSeconds * 1000),
        score,
        reason,
      });
    }
  }

  const deduped = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const key = `${candidate.startMs}-${candidate.endMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped
    .sort((a, b) => b.score - a.score || a.startMs - b.startMs)
    .slice(0, maxClips)
    .map((candidate, index) => ({
      clipId: `clip_${index + 1}`,
      ...candidate,
    }));
}

export function getSourceTranscriptSegments(job) {
  return job?.result?.transcript?.segments;
}

