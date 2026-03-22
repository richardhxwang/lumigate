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

import asyncio
import json
import logging
import os
import time as _time
from datetime import datetime, timedelta, timezone
import httpx

from config import settings, pb_api

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
    *,
    news_source: str = "finnhub",
) -> dict[str, str]:
    """
    Persist news articles to the trade_news PocketBase collection.

    Deduplicates by URL (for articles with URLs) or by headline (for articles
    without URLs, e.g. SearXNG results).  Only the first 20 articles are
    written to avoid flooding the collection.

    Args:
        symbol:      Ticker symbol (e.g. "AAPL", "BTC/USDT").
        articles:    Article dicts. Expected fields: headline, summary,
                     source, url, datetime/published_at, sentiment.
        http_client: Shared httpx.AsyncClient.
        news_source: Pipeline origin — "finnhub" or "searxng".

    Returns:
        Mapping of {url_or_headline: pb_record_id} for every article that was
        saved or already existed.  Articles that failed to save are omitted.
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
    base_url = f"{settings.pb_url}{pb_api('/api/collections/trade_news/records')}"
    saved: dict[str, str] = {}

    for article in articles[:20]:
        url = article.get("url", "").strip()
        headline = article.get("headline", "").strip()

        # Need at least a URL or headline for deduplication
        if not url and not headline:
            continue

        # --- deduplication: check if URL or headline already exists ---
        dedup_key = url or headline
        try:
            if url:
                filter_expr = f'url="{url}"'
            else:
                # Escape double quotes in headline for PB filter syntax
                safe_headline = headline.replace('"', '\\"')
                filter_expr = f'headline="{safe_headline}"'

            check_resp = await http_client.get(
                base_url,
                params={"filter": filter_expr, "perPage": 1},
                headers={"Authorization": token},
                timeout=8,
            )
            if check_resp.is_success:
                existing = check_resp.json().get("items", [])
                if existing:
                    saved[dedup_key] = existing[0]["id"]
                    continue  # already in PB
        except Exception as exc:
            logger.debug("PB dedup check failed for %s: %s", dedup_key[:80], exc)
            # fall through and attempt insert anyway

        # --- map article fields to collection schema ---
        raw_summary = article.get("summary", "") or ""
        summary = raw_summary[:200]
        source = article.get("source", "")

        # Resolve published_at — accept unix timestamp (Finnhub) or ISO string (SearXNG)
        published_at = ""
        raw_ts = article.get("datetime") or article.get("published_at") or ""
        if raw_ts:
            try:
                if isinstance(raw_ts, (int, float)):
                    published_at = datetime.fromtimestamp(
                        int(raw_ts), tz=timezone.utc
                    ).strftime("%Y-%m-%d %H:%M:%S")
                elif isinstance(raw_ts, str) and raw_ts.strip():
                    published_at = raw_ts.strip()[:19]  # trim to "YYYY-MM-DD HH:MM:SS"
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
            "news_source": news_source,
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
                    saved[dedup_key] = record_id
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
            f"{settings.pb_url}{pb_api(f'/api/collections/trade_news/records/{record_id}')}",
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
            summary = article.get("summary", "")
            if headline:
                # For FinBERT: combine headline + summary for better accuracy
                full_text = headline + (". " + summary if summary else "")
                headlines.append(full_text)

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


# ---------------------------------------------------------------------------
# SearXNG news search (Chinese + social media supplement)
# ---------------------------------------------------------------------------

# Default broad queries — run every cycle regardless of open positions
_SEARXNG_BASE_QUERIES = [
    "Bitcoin crypto news",
    "加密货币 新闻",
]


async def search_searxng(
    query: str,
    http_client: httpx.AsyncClient,
    *,
    categories: str = "news",
    time_range: str = "day",
    max_results: int = 20,
) -> list[dict]:
    """
    Search SearXNG and return normalised article dicts compatible with
    save_news_to_pb().

    Args:
        query:       Search query string.
        http_client: Shared httpx.AsyncClient.
        categories:  SearXNG categories (default "news").
        time_range:  SearXNG time_range (default "day").
        max_results: Max results to return.

    Returns:
        List of dicts with keys: headline, summary, source, url,
        published_at.  Empty list on any failure.
    """
    searxng_url = settings.searxng_url
    if not searxng_url:
        return []

    try:
        resp = await http_client.get(
            f"{searxng_url}/search",
            params={
                "q": query,
                "format": "json",
                "categories": categories,
                "time_range": time_range,
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("SearXNG search failed for '%s': %s", query, exc)
        return []

    results = data.get("results", [])
    articles: list[dict] = []

    for item in results[:max_results]:
        title = (item.get("title") or "").strip()
        if not title:
            continue

        # SearXNG result fields vary by engine; normalise to our schema
        content = (item.get("content") or "").strip()
        url = (item.get("url") or "").strip()
        engine = (item.get("engine") or "").strip()
        # publishedDate may be ISO string or missing
        published = (item.get("publishedDate") or "").strip()

        articles.append({
            "headline": title,
            "summary": content[:200] if content else "",
            "source": engine or "searxng",
            "url": url,
            "published_at": published,
        })

    return articles


async def fetch_searxng_news(
    http_client: httpx.AsyncClient,
    extra_pairs: list[str] | None = None,
) -> dict:
    """
    Run SearXNG searches for base crypto queries + per-pair queries.
    Saves all results to PB trade_news with news_source="searxng".

    Args:
        http_client: Shared httpx.AsyncClient.
        extra_pairs: Optional list of trading pairs (e.g. ["BTC/USDT", "ETH/USDT"])
                     to search for pair-specific news.

    Returns:
        {"total_saved": int, "queries_run": int}
    """
    all_queries: list[tuple[str, str]] = []  # (query, symbol)

    # Base queries — symbol is generic "CRYPTO"
    for q in _SEARXNG_BASE_QUERIES:
        all_queries.append((q, "CRYPTO"))

    # Per-pair queries
    if extra_pairs:
        for pair in extra_pairs:
            # "BTC/USDT" → search "BTC" and "BTC 加密 新闻"
            base_symbol = pair.split("/")[0].upper()
            all_queries.append((f"{base_symbol} crypto news", base_symbol))
            all_queries.append((f"{base_symbol} 加密 新闻", base_symbol))

    total_saved = 0
    queries_run = 0

    for query, symbol in all_queries:
        articles = await search_searxng(query, http_client)
        if articles:
            saved = await save_news_to_pb(
                symbol, articles, http_client, news_source="searxng"
            )
            total_saved += len(saved)
        queries_run += 1

        # Small delay between queries to be polite to SearXNG
        await asyncio.sleep(1.0)

    logger.info(
        "SearXNG news fetch: %d queries, %d articles saved",
        queries_run, total_saved,
    )
    return {"total_saved": total_saved, "queries_run": queries_run}


# ---------------------------------------------------------------------------
# Periodic background task — SearXNG news fetcher
# ---------------------------------------------------------------------------

_searxng_task: asyncio.Task | None = None


async def _searxng_periodic_loop(http_client: httpx.AsyncClient):
    """
    Background loop: every N minutes, fetch SearXNG news for base queries
    and for each currently open trading pair (from freqtrade).
    """
    interval = settings.searxng_interval_minutes * 60  # seconds

    # Wait a bit on startup so other services can initialise
    await asyncio.sleep(30)

    while True:
        try:
            # Try to get open pairs from freqtrade
            open_pairs: list[str] = []
            try:
                ft_resp = await http_client.get(
                    f"{settings.freqtrade_url}/api/v1/status",
                    auth=(settings.freqtrade_username, settings.freqtrade_password),
                    timeout=10,
                )
                if ft_resp.is_success:
                    trades = ft_resp.json()
                    open_pairs = list({t.get("pair", "") for t in trades if t.get("pair")})
            except Exception as exc:
                logger.debug("SearXNG loop: could not fetch open pairs: %s", exc)

            # Also include default crypto pairs from config
            all_pairs = list(set(open_pairs + settings.default_crypto_pairs))

            await fetch_searxng_news(http_client, extra_pairs=all_pairs)

        except asyncio.CancelledError:
            logger.info("SearXNG periodic loop cancelled")
            return
        except Exception as exc:
            logger.warning("SearXNG periodic loop error: %s", exc)

        await asyncio.sleep(interval)


def start_searxng_periodic_task(http_client: httpx.AsyncClient) -> asyncio.Task | None:
    """
    Start the SearXNG periodic news fetch background task.
    Safe to call multiple times — only one task will run.

    Returns the asyncio.Task, or None if SearXNG URL is not configured.
    """
    global _searxng_task

    if not settings.searxng_url:
        logger.info("SearXNG URL not configured — periodic news fetch disabled")
        return None

    if _searxng_task and not _searxng_task.done():
        return _searxng_task

    _searxng_task = asyncio.create_task(
        _searxng_periodic_loop(http_client),
        name="searxng-news-fetch",
    )
    logger.info(
        "SearXNG periodic news fetch started (every %d min)",
        settings.searxng_interval_minutes,
    )
    return _searxng_task


def stop_searxng_periodic_task():
    """Cancel the SearXNG periodic task if running."""
    global _searxng_task
    if _searxng_task and not _searxng_task.done():
        _searxng_task.cancel()
        logger.info("SearXNG periodic task cancelled")
    _searxng_task = None


# ---------------------------------------------------------------------------
# Fear & Greed Index (Alternative.me — free, no API key)
# ---------------------------------------------------------------------------

_FNG_API_URL = "https://api.alternative.me/fng/"

_fng_task: asyncio.Task | None = None


async def fetch_fear_greed(http_client: httpx.AsyncClient) -> dict | None:
    """
    Fetch the current Crypto Fear & Greed Index from Alternative.me
    and persist it as a trade_news record (source="fear_greed", symbol="GENERAL").

    Value range: 0 (Extreme Fear) → 100 (Extreme Greed).
    Normalised to -1 … +1 for finnhub_sentiment / final_sentiment fields.

    Returns the API data dict on success, None on failure.
    """
    try:
        resp = await http_client.get(_FNG_API_URL, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("Fear & Greed fetch failed: %s", exc)
        return None

    items = data.get("data")
    if not items:
        return None

    entry = items[0]
    value = int(entry.get("value", 50))
    classification = entry.get("value_classification", "Neutral")
    ts = entry.get("timestamp", "")

    # Normalise 0-100 → -1 to +1  (0=Extreme Fear→-1, 50=Neutral→0, 100=Extreme Greed→+1)
    normalised = round((value - 50) / 50, 4)

    # Impact: high if extreme zones (<25 or >75), else medium
    impact = "high" if value > 75 or value < 25 else "medium"

    # Resolve timestamp
    published_at = ""
    if ts:
        try:
            published_at = datetime.fromtimestamp(
                int(ts), tz=timezone.utc
            ).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass

    headline = f"Fear & Greed Index: {value} ({classification})"

    # Write to PB trade_news via save_news_to_pb (dedup by headline)
    article = {
        "headline": headline,
        "summary": f"Crypto Fear & Greed Index is {value} — {classification}",
        "source": "fear_greed",
        "url": "",
        "published_at": published_at,
        "sentiment": normalised,
    }
    saved = await save_news_to_pb(
        "GENERAL", [article], http_client, news_source="fear_greed"
    )

    # Also PATCH final_sentiment + impact on the saved record
    for _key, record_id in saved.items():
        await update_news_pb_sentiments(
            record_id,
            http_client,
            final_sentiment=normalised,
            impact=impact,
            processed=True,
        )

    logger.info(
        "Fear & Greed Index: %d (%s) → normalised %.4f, impact=%s",
        value, classification, normalised, impact,
    )
    return {"value": value, "classification": classification, "normalised": normalised}


async def _fng_periodic_loop(http_client: httpx.AsyncClient):
    """Background loop: fetch Fear & Greed Index every hour."""
    # Initial delay — let other services start first
    await asyncio.sleep(15)

    while True:
        try:
            await fetch_fear_greed(http_client)
        except asyncio.CancelledError:
            logger.info("Fear & Greed periodic loop cancelled")
            return
        except Exception as exc:
            logger.warning("Fear & Greed periodic loop error: %s", exc)

        await asyncio.sleep(3600)  # 1 hour


def start_fng_periodic_task(http_client: httpx.AsyncClient) -> asyncio.Task:
    """
    Start the Fear & Greed Index periodic fetch background task.
    Safe to call multiple times — only one task will run.
    """
    global _fng_task

    if _fng_task and not _fng_task.done():
        return _fng_task

    _fng_task = asyncio.create_task(
        _fng_periodic_loop(http_client),
        name="fear-greed-fetch",
    )
    logger.info("Fear & Greed periodic fetch started (every 1h)")
    return _fng_task


def stop_fng_periodic_task():
    """Cancel the Fear & Greed periodic task if running."""
    global _fng_task
    if _fng_task and not _fng_task.done():
        _fng_task.cancel()
        logger.info("Fear & Greed periodic task cancelled")
    _fng_task = None


# ---------------------------------------------------------------------------
# Economic Calendar (Finnhub) — news blackout risk rule
# ---------------------------------------------------------------------------

# In-memory cache: list of high-impact events with their scheduled times
_econ_calendar_cache: list[dict] = []
_econ_calendar_updated: float = 0.0  # last fetch timestamp
_ECON_CACHE_TTL = 3600  # refresh every hour

_econ_task: asyncio.Task | None = None


async def fetch_economic_calendar(
    http_client: httpx.AsyncClient,
    *,
    force: bool = False,
) -> list[dict]:
    """
    Fetch high-impact economic events from Finnhub economic calendar.

    Caches results in memory for 1 hour. Returns a list of dicts:
        {
            "event": str,       # e.g. "FOMC Meeting", "CPI", "Non-Farm Payrolls"
            "country": str,     # e.g. "US"
            "time": str,        # ISO datetime or "TBD"
            "impact": str,      # "high"
            "actual": str,
            "estimate": str,
            "prev": str,
        }
    """
    global _econ_calendar_cache, _econ_calendar_updated

    now = _time.time()
    if not force and _econ_calendar_cache and (now - _econ_calendar_updated) < _ECON_CACHE_TTL:
        return _econ_calendar_cache

    api_key = settings.finnhub_api_key
    if not api_key:
        logger.debug("Finnhub API key not configured — economic calendar unavailable")
        return []

    today = datetime.now(timezone.utc)
    # Fetch today + tomorrow to cover overnight events
    date_from = today.strftime("%Y-%m-%d")
    date_to = (today + timedelta(days=1)).strftime("%Y-%m-%d")

    try:
        resp = await http_client.get(
            "https://finnhub.io/api/v1/calendar/economic",
            params={
                "from": date_from,
                "to": date_to,
                "token": api_key,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("Finnhub economic calendar fetch failed: %s", exc)
        return _econ_calendar_cache  # return stale cache on failure

    raw_events = data.get("economicCalendar", [])
    if not raw_events:
        # Finnhub may nest under different keys
        raw_events = data.get("result", [])

    high_impact: list[dict] = []
    for ev in raw_events:
        impact = (ev.get("impact") or "").lower()
        if impact != "high":
            continue

        event_name = ev.get("event", "Unknown Event")
        country = ev.get("country", "")
        event_time = ev.get("time", "TBD")  # "HH:MM:SS" or empty
        event_date = ev.get("date", date_from)  # "YYYY-MM-DD"

        # Build full ISO datetime if time is available
        if event_time and event_time != "TBD" and ":" in event_time:
            full_time = f"{event_date}T{event_time}+00:00"
        else:
            full_time = f"{event_date}T00:00:00+00:00"

        high_impact.append({
            "event": event_name,
            "country": country,
            "time": full_time,
            "impact": "high",
            "actual": str(ev.get("actual", "")),
            "estimate": str(ev.get("estimate", "")),
            "prev": str(ev.get("prev", "")),
        })

    _econ_calendar_cache = high_impact
    _econ_calendar_updated = now
    logger.info(
        "Economic calendar updated: %d high-impact events for %s to %s",
        len(high_impact), date_from, date_to,
    )
    return high_impact


def get_upcoming_events(minutes_ahead: int = 30) -> list[dict]:
    """
    Return high-impact events within the next *minutes_ahead* minutes.

    Each returned dict has an extra "minutes_until" field.
    Uses the in-memory cache — does not make API calls.
    """
    if not _econ_calendar_cache:
        return []

    now = datetime.now(timezone.utc)
    window = timedelta(minutes=minutes_ahead)
    upcoming: list[dict] = []

    for ev in _econ_calendar_cache:
        try:
            ev_time = datetime.fromisoformat(ev["time"])
            delta = ev_time - now
            # Event is in the future and within the blackout window
            if timedelta(0) <= delta <= window:
                upcoming.append({
                    **ev,
                    "minutes_until": round(delta.total_seconds() / 60, 1),
                })
        except (ValueError, KeyError):
            continue

    # Sort by soonest first
    upcoming.sort(key=lambda e: e["minutes_until"])
    return upcoming


def check_news_blackout(blackout_minutes: int = 30) -> tuple[bool, str]:
    """
    Check if a news blackout is active (high-impact event within blackout window).

    Returns:
        (ok, detail) — ok=True means no blackout (safe to trade),
                        ok=False means blackout active.
    """
    upcoming = get_upcoming_events(blackout_minutes)
    if not upcoming:
        return True, f"No high-impact events in next {blackout_minutes} minutes"

    # Blackout active — build descriptive message
    event_strs = []
    for ev in upcoming[:3]:
        event_strs.append(
            f"{ev['event']} ({ev.get('country', '?')}) in {ev['minutes_until']:.0f}min"
        )
    detail = f"NEWS BLACKOUT: {', '.join(event_strs)} — trading paused"
    return False, detail


async def _econ_calendar_periodic_loop(http_client: httpx.AsyncClient):
    """Background loop: refresh economic calendar every hour."""
    # Initial fetch after short delay
    await asyncio.sleep(5)

    while True:
        try:
            await fetch_economic_calendar(http_client, force=True)
        except asyncio.CancelledError:
            logger.info("Economic calendar periodic loop cancelled")
            return
        except Exception as exc:
            logger.warning("Economic calendar periodic loop error: %s", exc)

        await asyncio.sleep(_ECON_CACHE_TTL)


def start_econ_calendar_task(http_client: httpx.AsyncClient) -> asyncio.Task:
    """
    Start the economic calendar periodic fetch background task.
    Safe to call multiple times — only one task will run.
    """
    global _econ_task

    if _econ_task and not _econ_task.done():
        return _econ_task

    _econ_task = asyncio.create_task(
        _econ_calendar_periodic_loop(http_client),
        name="econ-calendar-fetch",
    )
    logger.info("Economic calendar periodic fetch started (every %ds)", _ECON_CACHE_TTL)
    return _econ_task


def stop_econ_calendar_task():
    """Cancel the economic calendar periodic task if running."""
    global _econ_task
    if _econ_task and not _econ_task.done():
        _econ_task.cancel()
        logger.info("Economic calendar periodic task cancelled")
    _econ_task = None
