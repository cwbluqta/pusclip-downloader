import fs from "fs/promises";
import path from "path";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || "";
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "whisper-1";

export function isTranscriptionProviderConfigured() {
  return OPENAI_API_KEY.length > 0;
}

export function getTranscriptionProviderName() {
  return isTranscriptionProviderConfigured() ? "openai" : null;
}

export async function transcribeAudioFile(filePath) {
  if (!isTranscriptionProviderConfigured()) {
    const err = new Error("Transcription provider is not configured");
    err.code = "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath) || ".mp3";
  const file = new Blob([buffer], { type: "application/octet-stream" });

  const form = new FormData();
  form.set("model", OPENAI_TRANSCRIPTION_MODEL);
  form.set("response_format", "verbose_json");
  form.set("timestamp_granularities[]", "segment");
  form.set("file", file, `audio${ext}`);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`OpenAI transcription failed (${response.status}): ${body.slice(0, 500)}`);
    err.code = "TRANSCRIPTION_PROVIDER_ERROR";
    throw err;
  }

  const payload = await response.json();
  const text = typeof payload?.text === "string" ? payload.text : "";
  const language = typeof payload?.language === "string" ? payload.language : null;
  const segments = Array.isArray(payload?.segments)
    ? payload.segments.map((segment) => ({
      start: Number(segment?.start ?? 0),
      end: Number(segment?.end ?? 0),
      text: typeof segment?.text === "string" ? segment.text : "",
    }))
    : [];

  return {
    text,
    segments,
    language,
  };
}
