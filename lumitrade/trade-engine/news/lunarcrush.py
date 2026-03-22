"""
news/lunarcrush.py — LunarCrush social sentiment collector.

Fetches crypto social media sentiment (Twitter/Reddit/Telegram) from
LunarCrush API v4, writes results to PocketBase trade_news collection.

API v4 docs: https://github.com/lunarcrush/api
Base URL:    https://lunarcrush.com/api4
Auth:        Bearer token via Authorization header

To get a free API key:
  1. Sign up at https://lunarcrush.com
  2. Go to https://lunarcrush.com/developers/api
  3. Generate an API key (free tier available with rate limits)
  4. Set env var: TRADE_LUNARCRUSH_API_KEY=<your_key>

Endpoints used:
  GET /public/coins/list/v2  — all coins with galaxy_score, alt_rank, sentiment, etc.
  GET /public/coins/v1       — detailed metrics for specific coins (fallback)

Runs every 30 minutes as a background asyncio task.
"""

import asyncio
import logging
import time as _time
from datetime import datetime, timezone

import httpx

from config import settings

logger = logging.getLogger("lumitrade.news.lunarcrush")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LUNARCRUSH_BASE_URL = "https://lunarcrush.com/api4"

# Coins to track — base symbols (no /USDT suffix)
DEFAULT_COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA"]

# Collection interval in minutes
COLLECT_INTERVAL_MINUTES = 30

# Key metrics to extract and display
METRIC_KEYS = [
    "galaxy_score",
    "alt_rank",
    "sentiment",
    "social_dominance",
    "interactions_24h",
    "num_contributors",
    "num_posts",
    "market_cap",
    "close",               # current price
    "percent_change_24h",
]

# ---------------------------------------------------------------------------
# PocketBase helpers (same pattern as sentiment.py — avoid circular imports)
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
        logger.debug("PB auth failed in lunarcrush module: %s", exc)
    return ""


# ---------------------------------------------------------------------------
# LunarCrush API fetch
# ---------------------------------------------------------------------------

async def fetch_coin_metrics(
    http_client: httpx.AsyncClient,
    coins: list[str] | None = None,
) -> list[dict]:
    """
    Fetch social sentiment metrics from LunarCrush API v4 for the given coins.

    Uses GET /public/coins/list/v2 to get all coins in one request,
    then filters for the ones we care about.

    Args:
        http_client: Shared httpx.AsyncClient.
        coins:       List of coin symbols (e.g. ["BTC", "ETH"]). Defaults to DEFAULT_COINS.

    Returns:
        List of dicts, one per coin, with keys: symbol, galaxy_score, alt_rank,
        sentiment, social_dominance, interactions_24h, num_contributors, num_posts,
        market_cap, close, percent_change_24h.
        Empty list on failure.
    """
    api_key = settings.lunarcrush_api_key
    if not api_key:
        logger.info(
            "TRADE_LUNARCRUSH_API_KEY not set — LunarCrush collector disabled. "
            "Get a free key at https://lunarcrush.com/developers/api"
        )
        return []

    target_coins = {c.upper() for c in (coins or DEFAULT_COINS)}

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }

    try:
        resp = await http_client.get(
            f"{LUNARCRUSH_BASE_URL}/public/coins/list/v2",
            headers=headers,
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "LunarCrush API HTTP error %s: %s",
            exc.response.status_code,
            exc.response.text[:300],
        )
        return []
    except Exception as exc:
        logger.warning("LunarCrush API request failed: %s", exc)
        return []

    # v4 /public/coins/list/v2 returns {"data": [...]} or a top-level list
    items = data if isinstance(data, list) else data.get("data", [])
    if not items:
        logger.warning("LunarCrush returned empty coin list")
        return []

    results: list[dict] = []
    for coin in items:
        symbol = (coin.get("symbol") or coin.get("s") or "").upper()
        if symbol not in target_coins:
            continue

        metrics: dict = {"symbol": symbol}
        for key in METRIC_KEYS:
            # LunarCrush v4 sometimes uses abbreviated keys (s, gs, etc.)
            # Try full key first, then common abbreviations
            val = coin.get(key)
            if val is None:
                abbrev_map = {
                    "galaxy_score": "gs",
                    "alt_rank": "acr",
                    "sentiment": "sentiment",
                    "social_dominance": "sd",
                    "interactions_24h": "interactions_24h",
                    "num_contributors": "num_contributors",
                    "num_posts": "num_posts",
                    "market_cap": "mc",
                    "close": "close",
                    "percent_change_24h": "pch",
                }
                val = coin.get(abbrev_map.get(key, ""), None)
            metrics[key] = val

        results.append(metrics)

    # Log which coins were found vs missing
    found = {r["symbol"] for r in results}
    missing = target_coins - found
    if missing:
        logger.debug("LunarCrush: coins not found: %s", ", ".join(sorted(missing)))

    logger.info(
        "LunarCrush: fetched metrics for %d/%d coins",
        len(results),
        len(target_coins),
    )
    return results


# ---------------------------------------------------------------------------
# Format + write to PocketBase trade_news
# ---------------------------------------------------------------------------

def _format_content(metrics: dict) -> str:
    """Format coin metrics into a human-readable content string."""
    lines = [f"LunarCrush Social Metrics for {metrics['symbol']}"]
    lines.append(f"Collected: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append("")

    label_map = {
        "galaxy_score": "Galaxy Score",
        "alt_rank": "AltRank",
        "sentiment": "Sentiment",
        "social_dominance": "Social Dominance",
        "interactions_24h": "Social Interactions (24h)",
        "num_contributors": "Contributors",
        "num_posts": "Posts",
        "market_cap": "Market Cap",
        "close": "Price",
        "percent_change_24h": "24h Change",
    }

    for key in METRIC_KEYS:
        val = metrics.get(key)
        if val is None:
            continue
        label = label_map.get(key, key)

        # Format values
        if key == "market_cap" and isinstance(val, (int, float)):
            if val >= 1e12:
                formatted = f"${val / 1e12:.2f}T"
            elif val >= 1e9:
                formatted = f"${val / 1e9:.2f}B"
            elif val >= 1e6:
                formatted = f"${val / 1e6:.2f}M"
            else:
                formatted = f"${val:,.0f}"
        elif key == "close" and isinstance(val, (int, float)):
            formatted = f"${val:,.2f}"
        elif key == "percent_change_24h" and isinstance(val, (int, float)):
            formatted = f"{val:+.2f}%"
        elif key == "social_dominance" and isinstance(val, (int, float)):
            formatted = f"{val:.2f}%"
        elif key == "interactions_24h" and isinstance(val, (int, float)):
            if val >= 1e6:
                formatted = f"{val / 1e6:.1f}M"
            elif val >= 1e3:
                formatted = f"{val / 1e3:.1f}K"
            else:
                formatted = f"{val:,.0f}"
        elif isinstance(val, float):
            formatted = f"{val:.2f}"
        else:
            formatted = str(val)

        lines.append(f"{label}: {formatted}")

    return "\n".join(lines)


def _sentiment_to_score(sentiment_pct: float | None) -> float:
    """
    Convert LunarCrush sentiment (0-100 percentage) to -1..1 score
    compatible with trade_news.finnhub_sentiment field.
    50 = neutral (0.0), 100 = max bullish (1.0), 0 = max bearish (-1.0).
    """
    if sentiment_pct is None:
        return 0.0
    # Clamp to 0-100
    pct = max(0.0, min(100.0, float(sentiment_pct)))
    # Map: 0 -> -1, 50 -> 0, 100 -> 1
    return round((pct - 50.0) / 50.0, 4)


async def save_metrics_to_pb(
    metrics_list: list[dict],
    http_client: httpx.AsyncClient,
) -> int:
    """
    Save LunarCrush metrics to PB trade_news collection.

    Each coin gets one record per collection cycle. Dedup by headline + recent time
    to avoid flooding (only write if last record for this coin+source is >25 min old).

    Returns number of records written.
    """
    token = await _get_pb_token(http_client)
    if not token:
        logger.debug("PB token unavailable — skipping LunarCrush write")
        return 0

    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
    }
    base_url = f"{settings.pb_url}/api/collections/trade_news/records"
    written = 0

    for metrics in metrics_list:
        symbol = metrics["symbol"]
        headline = f"{symbol} Social Sentiment Update"
        content = _format_content(metrics)
        sentiment_score = _sentiment_to_score(metrics.get("sentiment"))

        # Dedup: check if a lunarcrush record for this symbol exists
        # within the last 25 minutes (avoid duplicate writes within one cycle)
        try:
            check_resp = await http_client.get(
                base_url,
                params={
                    "filter": (
                        f'symbol="{symbol}" && news_source="lunarcrush" '
                        f'&& created >= @todayStart'
                    ),
                    "perPage": 1,
                },
                headers={"Authorization": token},
                timeout=8,
            )
            if check_resp.is_success:
                existing = check_resp.json().get("items", [])
                if existing:
                    # Check if the most recent record is less than 25 min old
                    last_created = existing[0].get("created", "")
                    if last_created:
                        try:
                            # PB returns "2026-03-22 10:30:00.000Z" format
                            created_dt = datetime.fromisoformat(
                                last_created.replace("Z", "+00:00")
                            )
                            age_minutes = (
                                datetime.now(timezone.utc) - created_dt
                            ).total_seconds() / 60
                            if age_minutes < 25:
                                logger.debug(
                                    "LunarCrush: skipping %s — last record %d min ago",
                                    symbol,
                                    int(age_minutes),
                                )
                                continue
                        except (ValueError, TypeError):
                            pass  # can't parse, proceed to write
        except Exception as exc:
            logger.debug("LunarCrush dedup check failed for %s: %s", symbol, exc)

        # Build the payload
        # Store raw metrics as JSON in summary (compact) for programmatic access
        raw_json = {}
        for key in METRIC_KEYS:
            if metrics.get(key) is not None:
                raw_json[key] = metrics[key]

        payload = {
            "symbol": symbol,
            "headline": headline,
            "summary": content[:200],  # first 200 chars for quick preview
            "source": "LunarCrush",
            "url": f"https://lunarcrush.com/coins/{symbol.lower()}",
            "published_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "finnhub_sentiment": sentiment_score,
            "news_source": "lunarcrush",
            "category": "social_sentiment",
            # Store full content + raw metrics in impact field as JSON
            # (impact is a text field, we repurpose it for structured data)
            "impact": f'{{"metrics": {_safe_json(raw_json)}, "content": {_safe_json(content)}}}',
        }

        try:
            post_resp = await http_client.post(
                base_url,
                json=payload,
                headers=headers,
                timeout=8,
            )
            if post_resp.is_success:
                written += 1
            else:
                logger.debug(
                    "LunarCrush PB insert failed (%s) for %s: %s",
                    post_resp.status_code,
                    symbol,
                    post_resp.text[:200],
                )
        except Exception as exc:
            logger.debug("LunarCrush PB insert error for %s: %s", symbol, exc)

    if written:
        logger.info("LunarCrush: wrote %d/%d records to trade_news", written, len(metrics_list))

    return written


def _safe_json(obj) -> str:
    """JSON-encode an object, returning '""' on failure."""
    import json
    try:
        return json.dumps(obj, ensure_ascii=False)
    except Exception:
        return '""'


# ---------------------------------------------------------------------------
# One-shot fetch + save (for manual/API trigger)
# ---------------------------------------------------------------------------

async def collect_lunarcrush_sentiment(
    http_client: httpx.AsyncClient,
    coins: list[str] | None = None,
) -> dict:
    """
    One-shot: fetch LunarCrush metrics and write to PB.

    Args:
        http_client: Shared httpx.AsyncClient.
        coins:       Optional list of coin symbols. Defaults to DEFAULT_COINS.

    Returns:
        {"coins_fetched": int, "records_written": int, "metrics": list[dict]}
    """
    metrics = await fetch_coin_metrics(http_client, coins)
    if not metrics:
        return {"coins_fetched": 0, "records_written": 0, "metrics": []}

    written = await save_metrics_to_pb(metrics, http_client)
    return {
        "coins_fetched": len(metrics),
        "records_written": written,
        "metrics": metrics,
    }


# ---------------------------------------------------------------------------
# Periodic background task
# ---------------------------------------------------------------------------

_lunarcrush_task: asyncio.Task | None = None


async def _lunarcrush_periodic_loop(http_client: httpx.AsyncClient):
    """Background loop: fetch LunarCrush sentiment every COLLECT_INTERVAL_MINUTES."""
    interval = COLLECT_INTERVAL_MINUTES * 60  # seconds

    # Wait 45s on startup so PB and other services can initialise
    await asyncio.sleep(45)

    while True:
        try:
            result = await collect_lunarcrush_sentiment(http_client)
            logger.info(
                "LunarCrush periodic: fetched %d coins, wrote %d records",
                result["coins_fetched"],
                result["records_written"],
            )
        except asyncio.CancelledError:
            logger.info("LunarCrush periodic loop cancelled")
            return
        except Exception as exc:
            logger.warning("LunarCrush periodic loop error: %s", exc)

        await asyncio.sleep(interval)


def start_lunarcrush_periodic_task(http_client: httpx.AsyncClient) -> asyncio.Task | None:
    """
    Start the LunarCrush periodic sentiment collection background task.
    Safe to call multiple times — only one task will run.

    Returns the asyncio.Task, or None if API key is not configured.
    """
    global _lunarcrush_task

    if not settings.lunarcrush_api_key:
        logger.info(
            "TRADE_LUNARCRUSH_API_KEY not set — periodic collection disabled. "
            "Get a free key at https://lunarcrush.com/developers/api"
        )
        return None

    if _lunarcrush_task and not _lunarcrush_task.done():
        return _lunarcrush_task

    _lunarcrush_task = asyncio.create_task(
        _lunarcrush_periodic_loop(http_client),
        name="lunarcrush-sentiment",
    )
    logger.info(
        "LunarCrush periodic sentiment collection started (every %d min)",
        COLLECT_INTERVAL_MINUTES,
    )
    return _lunarcrush_task


def stop_lunarcrush_periodic_task():
    """Cancel the LunarCrush periodic task if running."""
    global _lunarcrush_task
    if _lunarcrush_task and not _lunarcrush_task.done():
        _lunarcrush_task.cancel()
        logger.info("LunarCrush periodic task cancelled")
    _lunarcrush_task = None
