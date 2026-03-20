"""FinBERT sentiment analysis microservice."""

from flask import Flask, request, jsonify
from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline

app = Flask(__name__)

model_name = "ProsusAI/finbert"
tokenizer = AutoTokenizer.from_pretrained(model_name)
model = AutoModelForSequenceClassification.from_pretrained(model_name)
sentiment_pipeline = pipeline("sentiment-analysis", model=model, tokenizer=tokenizer)

LABEL_MAP = {"positive": 1.0, "negative": -1.0, "neutral": 0.0}


@app.route("/health")
def health():
    return jsonify({"status": "ok", "model": model_name})


@app.route("/predict", methods=["POST"])
def predict():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "text field required"}), 400

    texts = [text] if isinstance(text, str) else text
    results = sentiment_pipeline(texts, truncation=True, max_length=512)

    output = []
    for r in results:
        label = r["label"].lower()
        score = r["score"]
        sentiment_score = LABEL_MAP.get(label, 0.0) * score
        output.append({"label": label, "score": score, "sentiment_score": sentiment_score})

    if isinstance(data.get("text"), str):
        return jsonify(output[0])
    return jsonify(output)
