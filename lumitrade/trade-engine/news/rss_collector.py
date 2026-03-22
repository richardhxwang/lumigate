"""
news/rss_collector.py — Chinese crypto media RSS feed collector.

Periodically fetches RSS feeds from major Chinese crypto news outlets and
persists articles to the PocketBase trade_news collection.

Supported sources:
  1. PANews          — panewslab.com
  2. BlockBeats      — theblockbeats.info (API v2)
  3. Odaily          — odaily.news
  4. ChainCatcher    — via RSSHub (chaincatcher.com has no native RSS)
  5. Foresight News  — via RSSHub (foresightnews.pro has no native RSS)
  6. Wu Blockchain   — wublock.substack.com (no native RSS; Substack provides one)

Sentiment fields are left null — Chinese text is not suitable for FinBERT
(English-only). LumiGate LLM deep analysis fills them later.
"""

import asyncio
import logging
import time as _time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import feedparser
import httpx

from config import settings, pb_api

logger = logging.getLogger("lumitrade.news.rss_collector")

# ---------------------------------------------------------------------------
# RSS feed definitions
# ---------------------------------------------------------------------------

RSS_FEEDS: list[dict] = [
    {
        "name": "rss_panews",
        "label": "PANews",
        "url": "https://www.panewslab.com/rss.xml?lang=zh&type=NEWS",
    },
    {
        "name": "rss_blockbeats",
        "label": "BlockBeats",
        "url": "https://api.theblockbeats.news/v2/rss/article",
    },
    {
        "name": "rss_odaily",
        "label": "Odaily",
        "url": "https://rss.odaily.news/rss/post",
    },
    {
        "name": "rss_chaincatcher",
        "label": "ChainCatcher",
        # ChainCatcher has no native RSS — use self-hosted RSSHub instance.
        "url": "http://lumigate-rsshub:1200/chaincatcher/news",
    },
    {
        "name": "rss_foresightnews",
        "label": "Foresight News",
        # Foresight News has no native RSS — use self-hosted RSSHub instance.
        "url": "http://lumigate-rsshub:1200/foresightnews/news",
    },
    {
        "name": "rss_wublockchain",
        "label": "吴说区块链",
        # Wu Blockchain publishes on Substack which provides native RSS.
        "url": "https://wublock.substack.com/feed",
    },
]

# ---------------------------------------------------------------------------
# PocketBase helpers — reuse the token cache from sentiment.py
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
        logger.debug("PB auth failed in rss_collector: %s", exc)
    return ""


def _parse_published(entry: dict) -> str:
    """
    Extract a PB-compatible datetime string from a feedparser entry.
    Tries published_parsed, updated_parsed, then raw strings.
    Returns "" on failure.
    """
    # feedparser pre-parses dates into time.struct_time
    for key in ("published_parsed", "updated_parsed"):
        st = entry.get(key)
        if st:
            try:
                dt = datetime(*st[:6], tzinfo=timezone.utc)
                return dt.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pass

    # Fallback: parse raw date strings
    for key in ("published", "updated"):
        raw = entry.get(key, "")
        if raw:
            try:
                dt = parsedate_to_datetime(raw)
                return dt.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pass
            # Try ISO format
            try:
                return raw.strip()[:19]
            except Exception:
                pass

    return ""


def _clean_html(text: str) -> str:
    """Strip common HTML tags from summary text (lightweight, no lxml needed)."""
    import re
    if not text:
        return ""
    # Remove HTML tags
    clean = re.sub(r"<[^>]+>", "", text)
    # Collapse whitespace
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean


async def _article_exists(
    headline: str,
    news_source: str,
    http_client: httpx.AsyncClient,
    token: str,
) -> bool:
    """Check if an article with this headline+source already exists in PB."""
    base_url = f"{settings.pb_url}{pb_api('/api/collections/trade_news/records')}"
    # Escape double quotes in headline for PB filter syntax
    safe_headline = headline.replace('"', '\\"').replace("'", "\\'")
    filter_expr = f'headline="{safe_headline}" && news_source="{news_source}"'
    try:
        resp = await http_client.get(
            base_url,
            params={"filter": filter_expr, "perPage": 1},
            headers={"Authorization": token},
            timeout=8,
        )
        if resp.is_success:
            items = resp.json().get("items", [])
            return len(items) > 0
    except Exception as exc:
        logger.debug("Dedup check failed for [%s] %s: %s", news_source, headline[:60], exc)
    return False


async def fetch_single_feed(
    feed_cfg: dict,
    http_client: httpx.AsyncClient,
) -> dict:
    """
    Fetch and parse a single RSS feed, save new articles to PB.

    Args:
        feed_cfg: Dict with keys: name, label, url.
        http_client: Shared httpx.AsyncClient.

    Returns:
        {"source": str, "fetched": int, "saved": int, "errors": int}
    """
    name = feed_cfg["name"]
    label = feed_cfg["label"]
    url = feed_cfg["url"]

    result = {"source": name, "label": label, "fetched": 0, "saved": 0, "errors": 0}

    # Fetch RSS XML — use browser-like UA for RSSHub (blocks bot UAs)
    fetch_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
    }
    try:
        resp = await http_client.get(
            url,
            headers=fetch_headers,
            timeout=20,
            follow_redirects=True,
        )
        if not resp.is_success:
            logger.warning("RSS fetch failed for %s: HTTP %d", label, resp.status_code)
            result["errors"] = 1
            return result
        raw_xml = resp.text
    except Exception as exc:
        logger.warning("RSS fetch error for %s: %s", label, exc)
        result["errors"] = 1
        return result

    # Parse with feedparser
    feed = feedparser.parse(raw_xml)
    entries = feed.get("entries", [])
    result["fetched"] = len(entries)

    if not entries:
        logger.debug("RSS %s: no entries found", label)
        return result

    # Get PB token for writes
    token = await _get_pb_token(http_client)
    if not token:
        logger.debug("PB token unavailable — skipping RSS write for %s", label)
        return result

    headers = {"Authorization": token, "Content-Type": "application/json"}
    base_url = f"{settings.pb_url}{pb_api('/api/collections/trade_news/records')}"

    saved_count = 0
    for entry in entries[:30]:  # cap per feed to avoid flooding
        title = (entry.get("title") or "").strip()
        if not title:
            continue

        # Dedup by headline + news_source
        if await _article_exists(title, name, http_client, token):
            continue

        # Extract fields
        link = (entry.get("link") or "").strip()
        summary_raw = entry.get("summary") or entry.get("description") or ""
        summary = _clean_html(summary_raw)[:500]
        published_at = _parse_published(entry)

        # Extract source/author from feed entry if available
        source = ""
        if entry.get("source"):
            source = (entry["source"].get("title") or "").strip()
        if not source:
            source = (entry.get("author") or label)

        payload = {
            "symbol": "CRYPTO",  # general crypto news, not symbol-specific
            "headline": title,
            "summary": summary,
            "source": source,
            "url": link,
            "published_at": published_at,
            "news_source": name,
            # Sentiment fields left at defaults — Chinese text not suitable
            # for FinBERT. LumiGate LLM analysis fills these later.
            "finnhub_sentiment": 0,
            "finbert_sentiment": 0,
            "processed": False,
        }

        try:
            post_resp = await http_client.post(
                base_url,
                json=payload,
                headers=headers,
                timeout=8,
            )
            if post_resp.is_success:
                saved_count += 1
            else:
                logger.debug(
                    "PB insert failed for RSS [%s] %s: %s %s",
                    name, title[:60], post_resp.status_code, post_resp.text[:200],
                )
        except Exception as exc:
            logger.debug("PB insert error for RSS [%s] %s: %s", name, title[:60], exc)

    result["saved"] = saved_count
    if saved_count:
        logger.info("RSS %s: saved %d/%d articles", label, saved_count, len(entries))

    return result


async def fetch_all_rss_feeds(
    http_client: httpx.AsyncClient,
    feeds: list[dict] | None = None,
) -> list[dict]:
    """
    Fetch all configured RSS feeds sequentially (with small delays).

    Args:
        http_client: Shared httpx.AsyncClient.
        feeds: Optional override list; defaults to RSS_FEEDS.

    Returns:
        List of per-feed result dicts.
    """
    target_feeds = feeds or RSS_FEEDS
    results: list[dict] = []

    for feed_cfg in target_feeds:
        try:
            result = await fetch_single_feed(feed_cfg, http_client)
            results.append(result)
        except Exception as exc:
            logger.warning("RSS feed %s unexpected error: %s", feed_cfg["name"], exc)
            results.append({
                "source": feed_cfg["name"],
                "label": feed_cfg["label"],
                "fetched": 0,
                "saved": 0,
                "errors": 1,
            })

        # Small delay between feeds to be polite
        await asyncio.sleep(2.0)

    total_saved = sum(r["saved"] for r in results)
    total_fetched = sum(r["fetched"] for r in results)
    logger.info(
        "RSS collector: %d feeds, %d articles fetched, %d saved",
        len(results), total_fetched, total_saved,
    )
    return results


# ---------------------------------------------------------------------------
# Periodic background task
# ---------------------------------------------------------------------------

_rss_task: asyncio.Task | None = None

RSS_INTERVAL_MINUTES = 15


async def _rss_periodic_loop(http_client: httpx.AsyncClient):
    """Background loop: fetch all RSS feeds every RSS_INTERVAL_MINUTES."""
    interval = RSS_INTERVAL_MINUTES * 60

    # Wait a bit on startup so other services can initialise
    await asyncio.sleep(45)

    while True:
        try:
            await fetch_all_rss_feeds(http_client)
        except asyncio.CancelledError:
            logger.info("RSS periodic loop cancelled")
            return
        except Exception as exc:
            logger.warning("RSS periodic loop error: %s", exc)

        await asyncio.sleep(interval)


def start_rss_periodic_task(http_client: httpx.AsyncClient) -> asyncio.Task | None:
    """
    Start the RSS periodic news fetch background task.
    Safe to call multiple times — only one task will run.
    """
    global _rss_task

    if _rss_task and not _rss_task.done():
        return _rss_task

    _rss_task = asyncio.create_task(
        _rss_periodic_loop(http_client),
        name="rss-news-collector",
    )
    logger.info(
        "RSS periodic collector started (every %d min, %d feeds)",
        RSS_INTERVAL_MINUTES,
        len(RSS_FEEDS),
    )
    return _rss_task


def stop_rss_periodic_task():
    """Cancel the RSS periodic task if running."""
    global _rss_task
    if _rss_task and not _rss_task.done():
        _rss_task.cancel()
        logger.info("RSS periodic task cancelled")
    _rss_task = None
