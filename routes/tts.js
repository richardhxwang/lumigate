"use strict";

const { Router } = require("express");
const crypto = require("node:crypto");

const VOLCENGINE_TTS_URL = process.env.VOLCENGINE_TTS_URL || "https://openspeech.bytedance.com/api/v1/tts";
const VOLCENGINE_APP_ID = process.env.VOLCENGINE_TTS_APP_ID || "wxk-tts";
const VOLCENGINE_TOKEN = process.env.VOLCENGINE_TTS_TOKEN || "OrKH2_RUyb-u3OfUPiWGvMqdwS-PYxyW";
const VOLCENGINE_CLUSTER = process.env.VOLCENGINE_TTS_CLUSTER || "volcano_tts";

// Text length limit per request
const MAX_TEXT_LENGTH = 5000;

// Voice presets — id → Volcengine voice_type
const VOICES = {
  // Chinese female
  "zh-female-sisi":       "zh_female_shuangkuaisisi_moon_bigtts",
  "zh-female-qingxin":    "zh_female_qingxin",
  // Chinese male
  "zh-male-chunhou":      "zh_male_chunhou_moon_bigtts",
  "zh-male-jingqiang":    "zh_male_jingqiang",
  // English female
  "en-female-sarah":      "en_female_sarah_moon_bigtts",
  // English male
  "en-male-caleb":        "en_male_caleb_moon_bigtts",
};

const DEFAULT_VOICE = "zh-female-sisi";

const router = Router();

/**
 * POST /tts
 * Body: { text: string, voice?: string, speed?: number }
 * Returns: audio/mpeg binary
 */
router.post("/tts", async (req, res) => {
  const { text, voice = DEFAULT_VOICE, speed = 1.0 } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ ok: false, error: "text is required (string)" });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ ok: false, error: `Text too long (max ${MAX_TEXT_LENGTH} chars, got ${text.length})` });
  }

  const speedRatio = Math.max(0.5, Math.min(2.0, Number(speed) || 1.0));
  const voiceType = VOICES[voice] || voice; // allow passing raw voice_type directly
  const reqid = crypto.randomUUID();

  try {
    const ttsRes = await fetch(VOLCENGINE_TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer;${VOLCENGINE_TOKEN}`,
      },
      body: JSON.stringify({
        app: { appid: VOLCENGINE_APP_ID, token: "access_token", cluster: VOLCENGINE_CLUSTER },
        user: { uid: req._lcUserId || "lumichat" },
        audio: { voice_type: voiceType, encoding: "mp3", speed_ratio: speedRatio },
        request: { reqid, text, operation: "query" },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await ttsRes.json();

    // Volcengine success code is 3000
    if (data.code !== 3000 || !data.data) {
      console.error("[tts] Volcengine error:", data.code, data.message);
      return res.status(502).json({ ok: false, error: data.message || "TTS synthesis failed", code: data.code });
    }

    const audioBuffer = Buffer.from(data.data, "base64");
    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Length", String(audioBuffer.length));
    res.set("Cache-Control", "no-store");
    res.send(audioBuffer);
  } catch (err) {
    console.error("[tts] error:", err);
    if (err.name === "TimeoutError") {
      return res.status(504).json({ ok: false, error: "TTS request timed out" });
    }
    return res.status(500).json({ ok: false, error: err.message || "Internal TTS error" });
  }
});

/**
 * GET /tts/voices
 * Returns list of available voice presets
 */
router.get("/tts/voices", (_req, res) => {
  const voices = Object.entries(VOICES).map(([id, type]) => {
    const [lang, gender] = id.split("-");
    return { id, voiceType: type, lang, gender };
  });
  res.json({ ok: true, voices });
});

module.exports = router;
