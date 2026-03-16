'use strict';

const express = require('express');
const multer = require('multer');
const { validateExternalUrl } = require('../security/url-validator');

const router = express.Router();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const VISION_MODEL = process.env.VISION_MODEL || 'qwen2.5-vl:3b';
const DEFAULT_PROMPT = 'Describe this image in detail.';
const OLLAMA_TIMEOUT_MS = 30_000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

/**
 * Fetch an image URL and return its base64 string.
 */
async function fetchImageAsBase64(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Failed to fetch image: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

/**
 * POST /analyze
 *
 * Accepts:
 *   - multipart/form-data with field "image" (file) and optional "prompt"
 *   - application/json with { image_url, prompt } or { image_base64, prompt }
 */
router.post('/analyze', upload.single('image'), async (req, res) => {
  const start = Date.now();

  try {
    let base64Image;
    let prompt;

    // --- Resolve image source ---
    if (req.file) {
      // Multipart upload
      base64Image = req.file.buffer.toString('base64');
      prompt = req.body?.prompt;
    } else if (req.body?.image_base64) {
      base64Image = req.body.image_base64;
      prompt = req.body.prompt;
    } else if (req.body?.image_url) {
      const urlCheck = await validateExternalUrl(req.body.image_url);
      if (!urlCheck.ok) {
        return res.status(400).json({ ok: false, error: `Blocked image_url: ${urlCheck.error}` });
      }
      try {
        base64Image = await fetchImageAsBase64(req.body.image_url);
      } catch (err) {
        console.error('[vision] Could not fetch image_url:', err);
        return res.status(400).json({ ok: false, error: 'Could not fetch the provided image URL' });
      }
      prompt = req.body.prompt;
    } else {
      return res.status(400).json({
        ok: false,
        error: 'Provide an image via file upload (field "image"), image_base64, or image_url.',
      });
    }

    prompt = prompt || DEFAULT_PROMPT;

    // --- Call Ollama vision API ---
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    let ollamaRes;
    try {
      ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: VISION_MODEL,
          prompt,
          images: [base64Image],
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        return res.status(504).json({ ok: false, error: 'Ollama request timed out (30s).' });
      }
      console.error('[vision] Ollama unreachable:', err);
      return res.status(502).json({ ok: false, error: 'Vision analysis failed: service unreachable' });
    } finally {
      clearTimeout(timeout);
    }

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text().catch(() => '');
      console.error(`[vision] Ollama returned HTTP ${ollamaRes.status}: ${text}`);
      return res.status(502).json({
        ok: false,
        error: 'Vision analysis failed',
      });
    }

    const data = await ollamaRes.json();
    const duration = Date.now() - start;

    return res.json({
      ok: true,
      description: data.response || '',
      model: VISION_MODEL,
      duration,
    });
  } catch (err) {
    // Multer file-size error
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: 'Image exceeds 20MB limit.' });
    }
    console.error('[vision] error:', err);
    return res.status(500).json({ ok: false, error: 'Vision analysis failed' });
  }
});

module.exports = router;
