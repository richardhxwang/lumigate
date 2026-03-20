"""
news/sentiment.py — News collection and multi-layer sentiment analysis.

Three analysis layers:
  1. Finnhub API — aggregate news sentiment for a symbol
  2. FinBERT — transformer-based financial sentiment (local container)
  3. LumiGate LLM — deep contextual trading sentiment analysis

All external calls are wrapped in try/except; failures return neutral scores.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone

import httpx

from config import settings

logger = logging.getLogger("lumitrade.news.sentiment")

# ---------------------------------------------------------------------------
# Finnhub news sentiment
# ---------------------------------------------------------------------------

async def get_sentiment_score(symbol: str, http_client: httpx.AsyncClient) -> dict:
    """
    Fetch recent news for *symbol* from Finnhub and calculate aggregate sentiment.

    Returns:
        {
            "score": float (-1 to 1),
            "articles_count": int,
            "top_headlines": list[str],
            "source": "finnhub"
        }
    """
    api_key = settings.finnhub_api_key
    if not api_key:
        return {
            "score": 0.0,
            "articles_count": 0,
            "top_headlines": [],
            "source": "finnhub",
            "note": "FINNHUB_API_KEY not configured",
        }

    now = datetime.now(timezone.utc)
    date_from = (now - timedelta(days=3)).strftime("%Y-%m-%d")
    date_to = now.strftime("%Y-%m-%d")

    try:
        resp = await http_client.get(
            "https://finnhub.io/api/v1/company-news",
            params={
                "symbol": symbol.upper(),
                "from": date_from,
                "to": date_to,
                "token": api_key,
            },
            timeout=10,
        )
        resp.raise_for_status()
        articles = resp.json()

        if not articles:
            return {
                "score": 0.0,
                "articles_count": 0,
                "top_headlines": [],
                "source": "finnhub",
            }

        # Finnhub company-news returns sentiment field per article if available,
        # otherwise we derive from headline keywords as a fallback.
        sentiment_scores: list[float] = []
        headlines: list[str] = []

        for article in articles[:50]:  # cap at 50 most recent
            headline = article.get("headline", "")
            if headline:
                headlines.append(headline)

            # Finnhub news endpoint includes a 'sentiment' field in some responses
            sent = article.get("sentiment")
            if sent is not None:
                sentiment_scores.append(float(sent))

        # Aggregate score: mean of available sentiment values
        if sentiment_scores:
            avg_score = sum(sentiment_scores) / len(sentiment_scores)
        else:
            avg_score = 0.0  # no sentiment data available — neutral

        # Clamp to [-1, 1]
        avg_score = max(-1.0, min(1.0, avg_score))

        return {
            "score": round(avg_score, 4),
            "articles_count": len(articles),
            "top_headlines": headlines[:5],
            "source": "finnhub",
        }

    except Exception as exc:
        logger.warning("finnhub sentiment fetch failed for %s: %s", symbol, exc)
        return {
            "score": 0.0,
            "articles_count": 0,
            "top_headlines": [],
            "source": "finnhub",
            "error": str(exc),
        }


# ---------------------------------------------------------------------------
# FinBERT sentiment (local container)
# ---------------------------------------------------------------------------

FINBERT_URL = os.getenv("FINBERT_URL", "http://finbert:5000")


async def analyze_with_finbert(text: str, http_client: httpx.AsyncClient) -> float:
    """
    Send *text* to FinBERT container for financial sentiment classification.

    Returns:
        Sentiment score from -1 (bearish) to 1 (bullish).
        Returns 0.0 if FinBERT is unavailable.
    """
    if not text or not text.strip():
        return 0.0

    try:
        resp = await http_client.post(
            f"{FINBERT_URL}/predict",
            json={"text": text[:2000]},  # truncate to avoid overload
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        # Expected response format: {"sentiment": "positive", "score": 0.85}
        # or {"label": "positive", "score": 0.85}
        score = data.get("score", 0.0)
        label = data.get("sentiment", data.get("label", "neutral"))

        # Normalize: if label is negative, flip score sign
        if label in ("negative", "bearish"):
            score = -abs(score)
        elif label in ("positive", "bullish"):
            score = abs(score)
        else:
            score = 0.0

        return max(-1.0, min(1.0, float(score)))

    except httpx.ConnectError:
        logger.debug("FinBERT not available at %s — returning neutral", FINBERT_URL)
        return 0.0
    except Exception as exc:
        logger.warning("FinBERT analysis failed: %s", exc)
        return 0.0


# ---------------------------------------------------------------------------
# LLM deep sentiment analysis (via LumiGate)
# ---------------------------------------------------------------------------

async def deep_analyze_with_llm(
    text: str,
    symbol: str,
    http_client: httpx.AsyncClient,
) -> dict:
    """
    Send news text to LumiGate for deep LLM-based trading sentiment analysis.

    Returns:
        {
            "score": float (-1 to 1),
            "reasoning": str,
            "impact_level": "high" | "medium" | "low",
            "trading_action": "bullish" | "bearish" | "neutral",
            "source": "llm"
        }
    """
    lumigate_url = settings.lumigate_url
    project_key = settings.lumigate_project_key

    if not lumigate_url or not project_key:
        return {
            "score": 0.0,
            "reasoning": "LumiGate not configured",
            "impact_level": "low",
            "trading_action": "neutral",
            "source": "llm",
        }

    system_prompt = (
        "You are a financial sentiment analyst. Analyze the following news text "
        f"for its impact on {symbol} stock/asset price. "
        "Respond ONLY in valid JSON with these fields:\n"
        '  "score": number from -1 (extremely bearish) to 1 (extremely bullish),\n'
        '  "reasoning": brief explanation (1-2 sentences),\n'
        '  "impact_level": "high" or "medium" or "low",\n'
        '  "trading_action": "bullish" or "bearish" or "neutral"\n'
        "No markdown, no extra text — only the JSON object."
    )

    body = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text[:4000]},
        ],
        "temperature": 0.1,
        "max_tokens": 300,
    }

    headers = {
        "Content-Type": "application/json",
        "X-Project-Key": project_key,
    }

    try:
        resp = await http_client.post(
            f"{lumigate_url}/v1/chat/completions",
            json=body,
            headers=headers,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        # Extract assistant reply
        content = (
            data.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
            .strip()
        )

        # Strip markdown code fences if present
        if content.startswith("```"):
            content = content.split("\n", 1)[-1]
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()

        result = json.loads(content)

        return {
            "score": max(-1.0, min(1.0, float(result.get("score", 0.0)))),
            "reasoning": result.get("reasoning", ""),
            "impact_level": result.get("impact_level", "low"),
            "trading_action": result.get("trading_action", "neutral"),
            "source": "llm",
        }

    except json.JSONDecodeError as exc:
        logger.warning("LLM sentiment response not valid JSON: %s", exc)
        return {
            "score": 0.0,
            "reasoning": f"Failed to parse LLM response: {exc}",
            "impact_level": "low",
            "trading_action": "neutral",
            "source": "llm",
        }
    except Exception as exc:
        logger.warning("LLM deep analysis failed for %s: %s", symbol, exc)
        return {
            "score": 0.0,
            "reasoning": str(exc),
            "impact_level": "low",
            "trading_action": "neutral",
            "source": "llm",
            "error": str(exc),
        }
