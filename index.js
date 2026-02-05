import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

const { PORT = 3000, DOWNLOADER_TOKEN } = process.env;

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.post("/download", (req, res) => {
  const authHeader = req.get("authorization") || "";
  const expected = DOWNLOADER_TOKEN ? `Bearer ${DOWNLOADER_TOKEN}` : null;

  if (!expected || authHeader !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.status(200).json({
    status: "pending",
    message: "Download placeholder. Implement yt-dlp integration later.",
  });
});

app.listen(PORT, () => {
  console.log(`Downloader API listening on port ${PORT}`);
});
