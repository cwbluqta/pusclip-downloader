function isTranscriptEmpty(payload) {
  if (!payload) return true;

  const tObj = payload.transcript && typeof payload.transcript === "object"
    ? payload.transcript
    : null;

  const textB = tObj ? (tObj.text ?? "") : "";
  const segB = tObj ? (tObj.segments ?? []) : null;

  const textA = typeof payload.transcript === "string" ? payload.transcript : "";
  const segA = Array.isArray(payload.segments) ? payload.segments : null;

  const text = (textB || textA || "");
  const segs = (Array.isArray(segB) ? segB : (Array.isArray(segA) ? segA : []));

  const textEmpty = text.trim().length === 0;
  const segsEmpty = !Array.isArray(segs) || segs.length === 0 || segs.every((s) => {
    const st = typeof s === "string" ? s : (s?.text ?? "");
    return String(st).trim().length === 0;
  });

  return textEmpty && segsEmpty;
}

const cases = [
  {
    payload: { transcript: { text: "", segments: [] } },
    expected: true,
    label: "stored shape empty transcript",
  },
  {
    payload: { transcript: { text: "hello", segments: [] } },
    expected: false,
    label: "stored shape text present",
  },
  {
    payload: { transcript: { text: "", segments: [{ text: "hi" }] } },
    expected: false,
    label: "stored shape segment text present",
  },
];

for (const testCase of cases) {
  const actual = isTranscriptEmpty(testCase.payload);
  if (actual !== testCase.expected) {
    throw new Error(`${testCase.label}: expected ${testCase.expected}, got ${actual}`);
  }
}

console.log("transcript emptiness checks passed");
