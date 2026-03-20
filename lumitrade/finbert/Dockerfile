FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    flask==3.1.0 \
    transformers==4.47.1 \
    torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu \
    gunicorn==23.0.0

COPY server.py .

RUN python -c "from transformers import AutoModelForSequenceClassification, AutoTokenizer; \
    AutoModelForSequenceClassification.from_pretrained('ProsusAI/finbert'); \
    AutoTokenizer.from_pretrained('ProsusAI/finbert')"

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
    CMD curl -sf http://127.0.0.1:5000/health || exit 1

CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:5000", "--timeout", "120", "server:app"]
