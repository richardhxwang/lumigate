"""
Whisper STT Server — 轻量 HTTP wrapper for faster-whisper
可在 Mac Mini 本地运行，NAS/Docker 通过 HTTP 调用

启动: python3 server.py
端口: 17863 (与 LumiGate WHISPER_URL 一致)

安装: pip3 install faster-whisper flask
"""

import os
import sys
import time
import tempfile
from flask import Flask, request, jsonify

app = Flask(__name__)

# Lazy load model (first request triggers download)
_model = None
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")  # tiny/base/small/medium/large-v3

def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        device = "cpu"
        compute_type = "int8"
        # Mac M-series: use Metal if available
        if sys.platform == "darwin":
            try:
                import torch
                if torch.backends.mps.is_available():
                    device = "auto"
                    compute_type = "float16"
            except ImportError:
                pass
        print(f"[whisper] Loading model '{MODEL_SIZE}' on {device}...")
        _model = WhisperModel(MODEL_SIZE, device=device, compute_type=compute_type)
        print(f"[whisper] Model loaded.")
    return _model


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE, "service": "whisper-server"})


@app.route("/asr", methods=["POST"])
@app.route("/inference", methods=["POST"])
@app.route("/v1/audio/transcriptions", methods=["POST"])
def transcribe():
    """Accept audio file, return transcription. Compatible with OpenAI Whisper API format."""
    start = time.time()

    # Get audio file
    if "file" not in request.files:
        return jsonify({"error": "No 'file' field in upload"}), 400

    audio_file = request.files["file"]
    if not audio_file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Save to temp file
    suffix = os.path.splitext(audio_file.filename)[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        model = get_model()
        segments, info = model.transcribe(tmp_path, beam_size=5)
        text = " ".join(segment.text for segment in segments).strip()
        duration = round(time.time() - start, 2)

        # OpenAI-compatible response
        return jsonify({
            "text": text,
            "language": info.language,
            "duration": info.duration,
            "processing_time": duration,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(tmp_path)


@app.route("/v1/audio/translations", methods=["POST"])
def translate():
    """Translate audio to English text."""
    start = time.time()

    if "file" not in request.files:
        return jsonify({"error": "No 'file' field"}), 400

    audio_file = request.files["file"]
    suffix = os.path.splitext(audio_file.filename)[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        model = get_model()
        segments, info = model.transcribe(tmp_path, beam_size=5, task="translate")
        text = " ".join(segment.text for segment in segments).strip()
        return jsonify({"text": text, "language": info.language, "duration": round(time.time() - start, 2)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "17863"))
    print(f"[whisper] Starting on 0.0.0.0:{port} (model: {MODEL_SIZE})")
    print(f"[whisper] Endpoints: /asr, /inference, /v1/audio/transcriptions, /health")
    app.run(host="0.0.0.0", port=port, threaded=True)
