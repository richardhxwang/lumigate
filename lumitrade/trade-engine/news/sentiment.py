"""
news/sentiment.py — News collection and multi-layer sentiment analysis.

Three analysis layers:
  1. Finnhub API — aggregate news sentiment for a symbol
  2. FinBERT — transformer-based financial sentiment (local container)
  3. LumiGate LLM — deep contextual trading sentiment analysis

All external calls are wrapped in try/except; failures return neutral scores.

PocketBase integration:
  - save_news_to_pb()           — write Finnhub articles to trade_news, dedup by URL
  - update_news_pb_sentiments() — PATCH an existing record with finbert/llm/final fields
"""

import json
import logging
import os
import time as _time
from datetime import datetime, timedelta, timezone

import httpx

from config import settings

logger = logging.getLogger("lumitrade.news.sentiment")

# ---------------------------------------------------------------------------
# PocketBase helpers (local to this module — no circular import with main.py)
# ---------------------------------------------------------------------------

_pb_token: str = ""
_pb_token_exp: float = 0.0


async def _get_pb_token(http_client: httpx.AsyncClient) -> str:
    """Get PB admin token, cached for 30 min."""
    global _pb_token, _pb_token_exp
    if _pb_token and _time.time() < _pb_token_exp:
        return _pb_token
    if not settings.pb_admin_email or not settings.pb_admin_password:
        return ""
    try:
        resp = await http_client.post(
            f"{settings.pb_url}/api/collections/_superusers/auth-with-password",
            json={
                "identity": settings.pb_admin_email,
                "password": settings.pb_admin_password,
            },
            timeout=10,
        )
        if resp.is_success:
            _pb_token = resp.json().get("token", "")
            _pb_token_exp = _time.time() + 1800
            return _pb_token
    except Exception as exc:
        logger.debug("PB auth failed in sentiment module: %s", exc)
    return ""


async def save_news_to_pb(
    symbol: str,
    articles: list[dict],
    http_client: httpx.AsyncClient,
) -> dict[str, str]:
    """
    Persist Finnhub articles to the trade_news PocketBase collection.

    Deduplicates by URL — if a record with the same URL already exists it is
    skipped (not overwritten).  Only the first 20 articles are written to
    avoid flooding the collection.

    Args:
        symbol:      Ticker symbol (e.g. "AAPL", "BTC/USDT").
        articles:    Raw article dicts from Finnhub (fields: headline, summary,
                     source, url, datetime, sentiment).
        http_client: Shared httpx.AsyncClient.

    Returns:
        Mapping of {url: pb_record_id} for every article that was saved or
        already existed.  Articles that failed to save are omitted.
    """
    if not articles:
        return {}

    token = await _get_pb_token(http_client)
    if not token:
        logger.debug("PB token unavailable — skipping trade_news write")
        return {}

    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
    }
    base_url = f"{settings.pb_url}/api/collections/trade_news/records"
    saved: dict[str, str] = {}

    for article in articles[:20]:
        url = article.get("url", "").strip()
        if not url:
            continue  # cannot deduplicate without a URL — skip

        # --- deduplication: check if URL already exists ---
        try:
            check_resp = await http_client.get(
                base_url,
                params={"filter": f'url="{url}"', "perPage": 1},
                headers={"Authorization": token},
                timeout=8,
            )
            if check_resp.is_success:
                existing = check_resp.json().get("items", [])
                if existing:
                    saved[url] = existing[0]["id"]
                    continue  # already in PB
        except Exception as exc:
            logger.debug("PB dedup check failed for %s: %s", url, exc)
            # fall through and attempt insert anyway

        # --- map Finnhub fields to collection schema ---
        headline = article.get("headline", "")
        raw_summary = article.get("summary", "") or ""
        summary = raw_summary[:200]
        source = article.get("source", "")
        finnhub_ts = article.get("datetime")  # unix seconds or None
        published_at = ""
        if finnhub_ts:
            try:
                published_at = datetime.fromtimestamp(
                    int(finnhub_ts), tz=timezone.utc
                ).strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                published_at = ""

        finnhub_sent = article.get("sentiment")
        finnhub_sentiment = round(float(finnhub_sent), 4) if finnhub_sent is not None else 0.0

        payload = {
            "symbol": symbol.upper(),
            "headline": headline,
            "summary": summary,
            "source": source,
            "url": url,
            "published_at": published_at,
            "finnhub_sentiment": finnhub_sentiment,
            # finbert_sentiment / llm_sentiment / final_sentiment / impact /
            # category / processed are left at their PB defaults (0 / "" / false)
            # and updated later via update_news_pb_sentiments()
        }

        try:
            post_resp = await http_client.post(
                base_url,
                json=payload,
                headers=headers,
                timeout=8,
            )
            if post_resp.is_success:
                record_id = post_resp.json().get("id", "")
                if record_id:
                    saved[url] = record_id
            else:
                logger.debug(
                    "PB trade_news insert failed (%s): %s",
                    post_resp.status_code,
                    post_resp.text[:200],
                )
        except Exception as exc:
            logger.debug("PB trade_news insert error for %s: %s", url, exc)

    if saved:
        logger.info("trade_news: saved %d/%d articles for %s", len(saved), min(len(articles), 20), symbol)

    return saved


async def update_news_pb_sentiments(
    record_id: str,
    http_client: httpx.AsyncClient,
    *,
    finbert_sentiment: float | None = None,
    llm_sentiment: float | None = None,
    final_sentiment: float | None = None,
    impact: str | None = None,
    category: str | None = None,
    processed: bool | None = None,
) -> bool:
    """
    PATCH an existing trade_news record with updated sentiment fields.

    Only the provided (non-None) keyword arguments are included in the PATCH
    body — unspecified fields are left unchanged.

    Returns True on success, False on any failure.
    """
    if not record_id:
        return False

    token = await _get_pb_token(http_client)
    if not token:
        return False

    patch: dict = {}
    if finbert_sentiment is not None:
        patch["finbert_sentiment"] = round(float(finbert_sentiment), 4)
    if llm_sentiment is not None:
        patch["llm_sentiment"] = round(float(llm_sentiment), 4)
    if final_sentiment is not None:
        patch["final_sentiment"] = round(float(final_sentiment), 4)
    if impact is not None:
        patch["impact"] = impact
    if category is not None:
        patch["category"] = category
    if processed is not None:
        patch["processed"] = processed

    if not patch:
        return True  # nothing to update

    try:
        resp = await http_client.patch(
            f"{settings.pb_url}/api/collections/trade_news/records/{record_id}",
            json=patch,
            headers={"Authorization": token, "Content-Type": "application/json"},
            timeout=8,
        )
        if resp.is_success:
            return True
        logger.debug(
            "PB trade_news PATCH failed (%s) for record %s: %s",
            resp.status_code,
            record_id,
            resp.text[:200],
        )
        return False
    except Exception as exc:
        logger.debug("PB trade_news PATCH error for %s: %s", record_id, exc)
        return False


# ---------------------------------------------------------------------------
# Finnhub news sentiment
# ---------------------------------------------------------------------------

async def get_sentiment_score(symbol: str, http_client: httpx.AsyncClient) -> dict:
    """
    Fetch recent news for *symbol* from Finnhub and calculate aggregate sentiment.
    Articles are persisted to the trade_news PocketBase collection (dedup by URL).

    Returns:
        {
            "score": float (-1 to 1),
            "articles_count": int,
            "top_headlines": list[str],
            "source": "finnhub",
            "pb_record_ids": dict[str, str]  # {url: record_id} for saved articles
        }
    """
    api_key = settings.finnhub_api_key
    if not api_key:
        return {
            "score": 0.0,
            "articles_count": 0,
            "top_headlines": [],
            "source": "finnhub",
            "pb_record_ids": {},
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
                "pb_record_ids": {},
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

        # Persist articles to PocketBase trade_news (fire-and-forget style:
        # failures are logged at DEBUG level and do not affect the return value).
        pb_record_ids = await save_news_to_pb(symbol, articles[:50], http_client)

        return {
            "score": round(avg_score, 4),
            "articles_count": len(articles),
            "top_headlines": headlines[:5],
            "source": "finnhub",
            "pb_record_ids": pb_record_ids,
        }

    except Exception as exc:
        logger.warning("finnhub sentiment fetch failed for %s: %s", symbol, exc)
        return {
            "score": 0.0,
            "articles_count": 0,
            "top_headlines": [],
            "source": "finnhub",
            "pb_record_ids": {},
            "error": str(exc),
        }


# ---------------------------------------------------------------------------
# FinBERT sentiment (local container)
# ---------------------------------------------------------------------------

FINBERT_URL = os.getenv("FINBERT_URL", "http://finbert:5000")


async def analyze_with_finbert(
    text: str,
    http_client: httpx.AsyncClient,
    *,
    pb_record_id: str | None = None,
) -> float:
    """
    Send *text* to FinBERT container for financial sentiment classification.

    Args:
        text:          Text to classify.
        http_client:   Shared httpx.AsyncClient.
        pb_record_id:  If provided, the matching trade_news PB record is updated
                       with the resulting finbert_sentiment score.

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

        result = max(-1.0, min(1.0, float(score)))

        # Persist finbert_sentiment back to PB if a record ID was supplied
        if pb_record_id:
            await update_news_pb_sentiments(
                pb_record_id,
                http_client,
                finbert_sentiment=result,
            )

        return result

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
    *,
    pb_record_id: str | None = None,
) -> dict:
    """
    Send news text to LumiGate for deep LLM-based trading sentiment analysis.

    Args:
        text:          News text to analyze.
        symbol:        Ticker symbol for context in the system prompt.
        http_client:   Shared httpx.AsyncClient.
        pb_record_id:  If provided, the matching trade_news PB record is updated
                       with llm_sentiment, final_sentiment, impact, and processed=True.

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

        llm_score = max(-1.0, min(1.0, float(result.get("score", 0.0))))
        impact_level = result.get("impact_level", "low")

        # Persist llm_sentiment + impact to PB if a record ID was supplied.
        # Mark as fully processed (all three layers complete).
        if pb_record_id:
            await update_news_pb_sentiments(
                pb_record_id,
                http_client,
                llm_sentiment=llm_score,
                final_sentiment=llm_score,
                impact=impact_level,
                processed=True,
            )

        return {
            "score": llm_score,
            "reasoning": result.get("reasoning", ""),
            "impact_level": impact_level,
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
