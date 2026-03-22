"""
news/lunarcrush.py — Crypto social sentiment collector.

Primary:  LunarCrush API v4 (requires paid Individual+ subscription).
Fallback: CoinGecko (free, no key) + Alternative.me Fear & Greed Index (free).

If TRADE_LUNARCRUSH_API_KEY is set AND the subscription is active, uses LunarCrush.
Otherwise, automatically falls back to CoinGecko + Fear & Greed — no config needed.

Runs every 60 minutes as a background asyncio task.
"""

import asyncio
import logging
import time as _time
from datetime import datetime, timezone

import httpx

from config import settings, pb_api

logger = logging.getLogger("lumitrade.news.lunarcrush")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LUNARCRUSH_BASE_URL = "https://lunarcrush.com/api4"

# Coins to track — base symbols (no /USDT suffix)
DEFAULT_COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA"]

# CoinGecko symbol -> id mapping (free API, no key needed)
COINGECKO_ID_MAP = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "BNB": "binancecoin",
    "XRP": "ripple",
    "ADA": "cardano",
    "DOGE": "dogecoin",
    "DOT": "polkadot",
    "AVAX": "avalanche-2",
    "MATIC": "matic-network",
    "LINK": "chainlink",
    "UNI": "uniswap",
    "ATOM": "cosmos",
    "LTC": "litecoin",
    "NEAR": "near",
    "APT": "aptos",
    "ARB": "arbitrum",
    "OP": "optimism",
    "SUI": "sui",
    "SEI": "sei-network",
}

# Collection interval in minutes (60 min to stay well within CoinGecko free-tier
# rate limits, especially since freqtrade also calls CoinGecko for fiat_convert)
COLLECT_INTERVAL_MINUTES = 60

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

# Metrics from CoinGecko fallback (superset that maps to METRIC_KEYS)
COINGECKO_METRIC_KEYS = [
    "sentiment",           # derived from sentiment_votes_up_percentage
    "fear_greed",          # from Alternative.me
    "watchlist_users",     # social interest proxy
    "market_cap",
    "close",
    "percent_change_24h",
    "percent_change_7d",
    "percent_change_30d",
]

# Track which source is active (for logging / status)
_active_source: str = "none"

# ---------------------------------------------------------------------------
# PocketBase helpers (same pattern as sentiment.py)
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
# LunarCrush API fetch (paid subscription required)
# ---------------------------------------------------------------------------

async def _fetch_lunarcrush(
    http_client: httpx.AsyncClient,
    coins: list[str],
) -> list[dict]:
    """
    Fetch from LunarCrush v4 API. Returns [] if key missing or subscription inactive.
    """
    api_key = settings.lunarcrush_api_key
    if not api_key:
        return []

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
        # 402 = subscription required (free key, no paid plan)
        if resp.status_code == 402:
            logger.info(
                "LunarCrush API returned 402 (subscription required) — "
                "falling back to CoinGecko + Fear & Greed Index"
            )
            return []
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

    # v4 returns {"data": [...]} or a top-level list
    items = data if isinstance(data, list) else data.get("data", [])
    if not items:
        logger.warning("LunarCrush returned empty coin list")
        return []

    target_set = {c.upper() for c in coins}
    results: list[dict] = []

    for coin in items:
        symbol = (coin.get("symbol") or coin.get("s") or "").upper()
        if symbol not in target_set:
            continue

        metrics: dict = {"symbol": symbol, "_source": "lunarcrush"}
        for key in METRIC_KEYS:
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

    return results


# ---------------------------------------------------------------------------
# CoinGecko + Fear & Greed fallback (free, no API key)
# ---------------------------------------------------------------------------

async def _fetch_fear_greed(http_client: httpx.AsyncClient) -> dict:
    """
    Fetch the current Fear & Greed Index from alternative.me (free, no key).
    Returns {"value": int 0-100, "classification": str} or empty dict on failure.
    """
    try:
        resp = await http_client.get(
            "https://api.alternative.me/fng/?limit=1",
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        item = data.get("data", [{}])[0]
        return {
            "value": int(item.get("value", 0)),
            "classification": item.get("value_classification", "Unknown"),
        }
    except Exception as exc:
        logger.debug("Fear & Greed Index fetch failed: %s", exc)
        return {}


async def _fetch_coingecko(
    http_client: httpx.AsyncClient,
    coins: list[str],
) -> list[dict]:
    """
    Fetch sentiment + market data from CoinGecko (free, no API key).

    Uses two endpoints:
    1. /coins/markets — bulk market data (one request for all coins)
    2. /coins/{id} — individual coin sentiment (one request per coin, rate-limited)

    Plus Alternative.me Fear & Greed Index (one request).
    """
    target_coins = [c.upper() for c in coins]

    # Resolve CoinGecko IDs
    cg_ids = []
    symbol_to_cgid = {}
    for sym in target_coins:
        cgid = COINGECKO_ID_MAP.get(sym)
        if cgid:
            cg_ids.append(cgid)
            symbol_to_cgid[sym] = cgid
        else:
            logger.debug("CoinGecko: no ID mapping for %s — skipping", sym)

    if not cg_ids:
        return []

    # Step 1: Bulk market data
    market_data: dict[str, dict] = {}  # symbol -> market fields
    try:
        resp = await http_client.get(
            "https://api.coingecko.com/api/v3/coins/markets",
            params={
                "vs_currency": "usd",
                "ids": ",".join(cg_ids),
                "order": "market_cap_desc",
                "per_page": len(cg_ids),
                "sparkline": "false",
            },
            timeout=15,
        )
        # 429 retry: wait 60s then retry once
        if resp.status_code == 429:
            logger.info("CoinGecko markets 429 — waiting 60s then retrying")
            await asyncio.sleep(60)
            resp = await http_client.get(
                "https://api.coingecko.com/api/v3/coins/markets",
                params={
                    "vs_currency": "usd",
                    "ids": ",".join(cg_ids),
                    "order": "market_cap_desc",
                    "per_page": len(cg_ids),
                    "sparkline": "false",
                },
                timeout=15,
            )
        resp.raise_for_status()
        for coin in resp.json():
            sym = coin.get("symbol", "").upper()
            market_data[sym] = {
                "market_cap": coin.get("market_cap"),
                "close": coin.get("current_price"),
                "percent_change_24h": coin.get("price_change_percentage_24h"),
            }
    except Exception as exc:
        logger.warning("CoinGecko markets fetch failed: %s", exc)
        # Continue — we can still get individual coin data

    # Step 2: Fear & Greed Index (one call)
    fng = await _fetch_fear_greed(http_client)

    # Step 3: Individual coin sentiment (CoinGecko rate limit: ~10-30 req/min free)
    # Fetch only for target coins, with generous delay between requests.
    # freqtrade also calls CoinGecko (fiat_convert), so we must be conservative.
    sentiment_data: dict[str, dict] = {}  # symbol -> sentiment fields
    for sym in target_coins:
        cgid = symbol_to_cgid.get(sym)
        if not cgid:
            continue
        try:
            resp = await http_client.get(
                f"https://api.coingecko.com/api/v3/coins/{cgid}",
                params={
                    "localization": "false",
                    "tickers": "false",
                    "market_data": "true",
                    "community_data": "true",
                    "developer_data": "false",
                    "sparkline": "false",
                },
                timeout=15,
            )
            if resp.status_code == 429:
                # Retry once after 60s backoff
                logger.info("CoinGecko 429 for %s — waiting 60s then retrying", sym)
                await asyncio.sleep(60)
                resp = await http_client.get(
                    f"https://api.coingecko.com/api/v3/coins/{cgid}",
                    params={
                        "localization": "false",
                        "tickers": "false",
                        "market_data": "true",
                        "community_data": "true",
                        "developer_data": "false",
                        "sparkline": "false",
                    },
                    timeout=15,
                )
                if resp.status_code == 429:
                    logger.warning(
                        "CoinGecko still rate-limited after retry — "
                        "stopping individual fetches"
                    )
                    break
            resp.raise_for_status()
            d = resp.json()
            md = d.get("market_data", {})
            sentiment_data[sym] = {
                "sentiment_up": d.get("sentiment_votes_up_percentage"),
                "sentiment_down": d.get("sentiment_votes_down_percentage"),
                "watchlist_users": d.get("watchlist_portfolio_users"),
                "percent_change_7d": md.get("price_change_percentage_7d"),
                "percent_change_30d": md.get("price_change_percentage_30d"),
            }
            # Respect CoinGecko free-tier rate limit (~10 req/min)
            await asyncio.sleep(7)
        except httpx.HTTPStatusError as exc:
            logger.debug("CoinGecko coin fetch failed for %s: %s", sym, exc)
        except Exception as exc:
            logger.debug("CoinGecko coin fetch error for %s: %s", sym, exc)

    # Step 4: Combine into results
    results: list[dict] = []
    for sym in target_coins:
        if sym not in symbol_to_cgid:
            continue

        mkt = market_data.get(sym, {})
        sent = sentiment_data.get(sym, {})

        # Derive a sentiment score (0-100) from CoinGecko's up-vote percentage
        # This is analogous to LunarCrush's sentiment field
        sentiment_pct = sent.get("sentiment_up")  # already 0-100

        metrics: dict = {
            "symbol": sym,
            "_source": "coingecko",
            "sentiment": sentiment_pct,
            "fear_greed": fng.get("value"),
            "fear_greed_label": fng.get("classification"),
            "watchlist_users": sent.get("watchlist_users"),
            "market_cap": mkt.get("market_cap"),
            "close": mkt.get("close"),
            "percent_change_24h": mkt.get("percent_change_24h"),
            "percent_change_7d": sent.get("percent_change_7d"),
            "percent_change_30d": sent.get("percent_change_30d"),
            # Map to LunarCrush-compatible fields for downstream compatibility
            "galaxy_score": None,  # no equivalent
            "alt_rank": None,      # no equivalent
            "social_dominance": None,
            "interactions_24h": None,
            "num_contributors": None,
            "num_posts": None,
        }
        results.append(metrics)

    return results


# ---------------------------------------------------------------------------
# Unified fetch: try LunarCrush, fall back to CoinGecko
# ---------------------------------------------------------------------------

async def fetch_coin_metrics(
    http_client: httpx.AsyncClient,
    coins: list[str] | None = None,
) -> list[dict]:
    """
    Fetch social sentiment metrics for the given coins.

    Strategy:
    1. If TRADE_LUNARCRUSH_API_KEY is set, try LunarCrush first.
    2. If LunarCrush fails (402 subscription required, network error, etc.),
       fall back to CoinGecko + Fear & Greed Index (free, no key needed).
    3. If neither works, return [].

    Returns list of dicts with metrics per coin.
    """
    global _active_source
    target_coins = [c.upper() for c in (coins or DEFAULT_COINS)]

    # Try LunarCrush first (if key is configured)
    if settings.lunarcrush_api_key:
        results = await _fetch_lunarcrush(http_client, target_coins)
        if results:
            _active_source = "lunarcrush"
            found = {r["symbol"] for r in results}
            missing = set(target_coins) - found
            if missing:
                logger.debug("LunarCrush: coins not found: %s", ", ".join(sorted(missing)))
            logger.info(
                "LunarCrush: fetched metrics for %d/%d coins",
                len(results), len(target_coins),
            )
            return results
        # LunarCrush returned [] — fall through to CoinGecko

    # Fallback: CoinGecko + Fear & Greed (free)
    logger.info("Using CoinGecko + Fear & Greed Index (free fallback)")
    results = await _fetch_coingecko(http_client, target_coins)
    if results:
        _active_source = "coingecko"
        logger.info(
            "CoinGecko: fetched metrics for %d/%d coins",
            len(results), len(target_coins),
        )
        return results

    _active_source = "none"
    logger.warning("All sentiment sources failed — no metrics collected")
    return []


def get_active_source() -> str:
    """Return which data source is currently active."""
    return _active_source


# ---------------------------------------------------------------------------
# Format + write to PocketBase trade_news
# ---------------------------------------------------------------------------

def _format_content(metrics: dict) -> str:
    """Format coin metrics into a human-readable content string."""
    source = metrics.get("_source", "unknown")
    source_label = "LunarCrush" if source == "lunarcrush" else "CoinGecko + Fear & Greed"

    lines = [f"Social Sentiment for {metrics['symbol']} (via {source_label})"]
    lines.append(f"Collected: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append("")

    if source == "coingecko":
        # CoinGecko-specific formatting
        label_map = {
            "sentiment": "Sentiment (bullish %)",
            "fear_greed": "Fear & Greed Index",
            "fear_greed_label": "Market Mood",
            "watchlist_users": "Watchlist Users",
            "market_cap": "Market Cap",
            "close": "Price",
            "percent_change_24h": "24h Change",
            "percent_change_7d": "7d Change",
            "percent_change_30d": "30d Change",
        }
        for key in COINGECKO_METRIC_KEYS + ["fear_greed_label", "percent_change_7d", "percent_change_30d", "watchlist_users"]:
            val = metrics.get(key)
            if val is None:
                continue
            label = label_map.get(key, key)

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
            elif key in ("percent_change_24h", "percent_change_7d", "percent_change_30d") and isinstance(val, (int, float)):
                formatted = f"{val:+.2f}%"
            elif key == "watchlist_users" and isinstance(val, (int, float)):
                if val >= 1e6:
                    formatted = f"{val / 1e6:.1f}M"
                elif val >= 1e3:
                    formatted = f"{val / 1e3:.1f}K"
                else:
                    formatted = f"{val:,.0f}"
            elif key == "sentiment" and isinstance(val, (int, float)):
                formatted = f"{val:.1f}%"
            elif key == "fear_greed" and isinstance(val, (int, float)):
                formatted = f"{int(val)}/100"
            elif key == "fear_greed_label":
                formatted = str(val)
            elif isinstance(val, float):
                formatted = f"{val:.2f}"
            else:
                formatted = str(val)

            lines.append(f"{label}: {formatted}")
    else:
        # LunarCrush formatting (original)
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
    Convert sentiment percentage (0-100) to -1..1 score
    compatible with trade_news.finnhub_sentiment field.
    50 = neutral (0.0), 100 = max bullish (1.0), 0 = max bearish (-1.0).
    """
    if sentiment_pct is None:
        return 0.0
    pct = max(0.0, min(100.0, float(sentiment_pct)))
    return round((pct - 50.0) / 50.0, 4)


async def save_metrics_to_pb(
    metrics_list: list[dict],
    http_client: httpx.AsyncClient,
) -> int:
    """
    Save sentiment metrics to PB trade_news collection.
    Dedup by headline + recent time (only write if last record >25 min old).
    Returns number of records written.
    """
    token = await _get_pb_token(http_client)
    if not token:
        logger.debug("PB token unavailable — skipping sentiment write")
        return 0

    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
    }
    base_url = f"{settings.pb_url}{pb_api('/api/collections/trade_news/records')}"
    written = 0
    source_name = metrics_list[0].get("_source", "unknown") if metrics_list else "unknown"

    for metrics in metrics_list:
        symbol = metrics["symbol"]
        headline = f"{symbol} Social Sentiment Update"
        content = _format_content(metrics)
        sentiment_score = _sentiment_to_score(metrics.get("sentiment"))

        # Dedup: check if a record for this symbol+source exists within last 55 min
        try:
            check_resp = await http_client.get(
                base_url,
                params={
                    "filter": (
                        f'symbol="{symbol}" && news_source="{source_name}" '
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
                    last_created = existing[0].get("created", "")
                    if last_created:
                        try:
                            created_dt = datetime.fromisoformat(
                                last_created.replace("Z", "+00:00")
                            )
                            age_minutes = (
                                datetime.now(timezone.utc) - created_dt
                            ).total_seconds() / 60
                            if age_minutes < 55:
                                logger.debug(
                                    "Sentiment: skipping %s — last record %d min ago",
                                    symbol, int(age_minutes),
                                )
                                continue
                        except (ValueError, TypeError):
                            pass
        except Exception as exc:
            logger.debug("Sentiment dedup check failed for %s: %s", symbol, exc)

        # Build raw metrics JSON (exclude internal keys)
        raw_json = {}
        for key, val in metrics.items():
            if not key.startswith("_") and val is not None:
                raw_json[key] = val

        payload = {
            "symbol": symbol,
            "headline": headline,
            "summary": content[:200],
            "source": "LunarCrush" if source_name == "lunarcrush" else "CoinGecko",
            "url": (
                f"https://lunarcrush.com/coins/{symbol.lower()}"
                if source_name == "lunarcrush"
                else f"https://www.coingecko.com/en/coins/{COINGECKO_ID_MAP.get(symbol, symbol.lower())}"
            ),
            "published_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "finnhub_sentiment": sentiment_score,
            "news_source": source_name,
            "category": "social_sentiment",
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
                    "Sentiment PB insert failed (%s) for %s: %s",
                    post_resp.status_code, symbol, post_resp.text[:200],
                )
        except Exception as exc:
            logger.debug("Sentiment PB insert error for %s: %s", symbol, exc)

    if written:
        logger.info(
            "Sentiment (%s): wrote %d/%d records to trade_news",
            source_name, written, len(metrics_list),
        )

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
    One-shot: fetch sentiment metrics and write to PB.
    Tries LunarCrush first, falls back to CoinGecko + Fear & Greed.

    Returns:
        {"coins_fetched": int, "records_written": int, "source": str, "metrics": list[dict]}
    """
    metrics = await fetch_coin_metrics(http_client, coins)
    if not metrics:
        return {"coins_fetched": 0, "records_written": 0, "source": "none", "metrics": []}

    written = await save_metrics_to_pb(metrics, http_client)
    source = metrics[0].get("_source", "unknown") if metrics else "none"
    return {
        "coins_fetched": len(metrics),
        "records_written": written,
        "source": source,
        "metrics": metrics,
    }


# ---------------------------------------------------------------------------
# Periodic background task
# ---------------------------------------------------------------------------

_lunarcrush_task: asyncio.Task | None = None


async def _lunarcrush_periodic_loop(http_client: httpx.AsyncClient):
    """Background loop: fetch sentiment every COLLECT_INTERVAL_MINUTES."""
    interval = COLLECT_INTERVAL_MINUTES * 60

    # Wait 45s on startup so PB and other services can initialise
    await asyncio.sleep(45)

    while True:
        try:
            result = await collect_lunarcrush_sentiment(http_client)
            logger.info(
                "Sentiment periodic (%s): fetched %d coins, wrote %d records",
                result["source"],
                result["coins_fetched"],
                result["records_written"],
            )
        except asyncio.CancelledError:
            logger.info("Sentiment periodic loop cancelled")
            return
        except Exception as exc:
            logger.warning("Sentiment periodic loop error: %s", exc)

        await asyncio.sleep(interval)


def start_lunarcrush_periodic_task(http_client: httpx.AsyncClient) -> asyncio.Task | None:
    """
    Start the periodic sentiment collection background task.
    Always starts — uses LunarCrush if key is set and subscription active,
    otherwise falls back to CoinGecko + Fear & Greed (free).
    """
    global _lunarcrush_task

    if _lunarcrush_task and not _lunarcrush_task.done():
        return _lunarcrush_task

    if settings.lunarcrush_api_key:
        logger.info(
            "Sentiment collector starting (LunarCrush key set — will try LunarCrush first, "
            "CoinGecko fallback if subscription inactive)"
        )
    else:
        logger.info(
            "Sentiment collector starting (no LunarCrush key — using CoinGecko + Fear & Greed Index)"
        )

    _lunarcrush_task = asyncio.create_task(
        _lunarcrush_periodic_loop(http_client),
        name="sentiment-collector",
    )
    logger.info(
        "Sentiment periodic collection started (every %d min)",
        COLLECT_INTERVAL_MINUTES,
    )
    return _lunarcrush_task


def stop_lunarcrush_periodic_task():
    """Cancel the periodic sentiment task if running."""
    global _lunarcrush_task
    if _lunarcrush_task and not _lunarcrush_task.done():
        _lunarcrush_task.cancel()
        logger.info("Sentiment periodic task cancelled")
    _lunarcrush_task = None
