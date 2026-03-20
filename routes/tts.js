"use strict";

const { Router } = require("express");
const { execFile } = require("child_process");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const MAX_TEXT_LENGTH = 5000;

// Edge TTS voices — high quality, free, no API key needed
const VOICES = {
  "zh-female-xiaoxiao": "zh-CN-XiaoxiaoNeural",
  "zh-female-xiaoyi":   "zh-CN-XiaoyiNeural",
  "zh-male-yunxi":      "zh-CN-YunxiNeural",
  "zh-male-yunjian":    "zh-CN-YunjianNeural",
  "zh-hk-female":       "zh-HK-HiuMaanNeural",
  "zh-hk-male":         "zh-HK-WanLungNeural",
  "zh-tw-female":       "zh-TW-HsiaoChenNeural",
  "en-female-jenny":    "en-US-JennyNeural",
  "en-female-aria":     "en-US-AriaNeural",
  "en-male-guy":        "en-US-GuyNeural",
  "en-male-davis":      "en-US-DavisNeural",
  "en-gb-female":       "en-GB-SoniaNeural",
  "en-gb-male":         "en-GB-RyanNeural",
  "ja-female":          "ja-JP-NanamiNeural",
  "ko-female":          "ko-KR-SunHiNeural",
};

const DEFAULT_VOICE_ZH = "zh-CN-XiaoxiaoNeural";
const DEFAULT_VOICE_EN = "en-US-JennyNeural";

const router = Router();

/**
 * POST /tts
 * Body: { text: string, voice?: string, speed?: string, lang?: string }
 * Returns: audio/mpeg binary
 */
router.post("/tts", async (req, res) => {
  const { text, voice, speed, lang } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ ok: false, error: "text is required" });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ ok: false, error: `Text too long (max ${MAX_TEXT_LENGTH})` });
  }

  // Resolve voice
  let edgeVoice = VOICES[voice] || voice;
  if (!edgeVoice || !edgeVoice.includes("Neural")) {
    // Auto-detect language
    const isZh = lang === "zh" || /[\u4e00-\u9fff]/.test(text.slice(0, 100));
    edgeVoice = isZh ? DEFAULT_VOICE_ZH : DEFAULT_VOICE_EN;
  }

  const rateStr = speed ? `+${Math.round((Number(speed) - 1) * 100)}%` : "+0%";
  const tmpFile = path.join(os.tmpdir(), `tts-${crypto.randomUUID()}.mp3`);

  try {
    await new Promise((resolve, reject) => {
      const args = ["-m", "edge_tts", "--voice", edgeVoice, "--rate", rateStr, "--text", text, "--write-media", tmpFile];
      execFile("python3", args, { timeout: 20000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });

    if (!fs.existsSync(tmpFile)) {
      return res.status(500).json({ ok: false, error: "TTS output file not created" });
    }

    const audio = fs.readFileSync(tmpFile);
    fs.unlink(tmpFile, () => {});

    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Length", String(audio.length));
    res.set("Cache-Control", "no-store");
    res.send(audio);
  } catch (err) {
    fs.unlink(tmpFile, () => {});
    if (err.message?.includes("No module named")) {
      return res.status(500).json({ ok: false, error: "edge-tts not installed. Run: pip install edge-tts" });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /tts/voices
 */
router.get("/tts/voices", (_req, res) => {
  const voices = Object.entries(VOICES).map(([id, edgeId]) => {
    const parts = id.split("-");
    return { id, edgeVoice: edgeId, lang: parts[0] + (parts[1]?.length === 2 ? "-" + parts[1] : ""), gender: parts.find(p => ["female", "male"].includes(p)) || "unknown" };
  });
  res.json({ ok: true, voices });
});

module.exports = router;
