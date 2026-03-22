"""
pb_collections.py — PocketBase collection definitions for LumiTrade.

Mirrors the schema format used by services/pb-schema.js in LumiGate.
Each collection is a dict with name, type, fields (list of field dicts).
PB 0.23+ requires "fields" key (not "schema") in collection API payloads.
"""

import httpx
import logging

from config import pb_api

logger = logging.getLogger("lumitrade.pb_collections")

# ---------------------------------------------------------------------------
# Collection definitions
# ---------------------------------------------------------------------------

TRADE_COLLECTIONS = [
    {
        "name": "trade_signals",
        "type": "base",
        "fields": [
            {"name": "symbol", "type": "text", "required": True},
            {"name": "direction", "type": "text"},          # long / short
            {"name": "entry_price", "type": "number"},
            {"name": "stop_loss", "type": "number"},
            {"name": "take_profit", "type": "number"},
            {"name": "risk_reward", "type": "number"},
            {"name": "confidence", "type": "number"},
            {"name": "timeframe", "type": "text"},
            {"name": "indicators", "type": "json"},
            {"name": "source", "type": "text"},             # smc / webhook / manual
            {"name": "status", "type": "text"},              # pending / active / executed / expired
            {"name": "news_sentiment", "type": "number"},
            {"name": "broker", "type": "text"},
            {"name": "user_id", "type": "text"},
        ],
    },
    {
        "name": "trade_positions",
        "type": "base",
        "fields": [
            {"name": "symbol", "type": "text", "required": True},
            {"name": "broker", "type": "text"},
            {"name": "direction", "type": "text"},
            {"name": "quantity", "type": "number"},
            {"name": "entry_price", "type": "number"},
            {"name": "current_price", "type": "number"},
            {"name": "stop_loss", "type": "number"},
            {"name": "take_profit", "type": "number"},
            {"name": "unrealized_pnl", "type": "number"},
            {"name": "realized_pnl", "type": "number"},
            {"name": "status", "type": "text"},              # open / closed / pending
            {"name": "opened_at", "type": "text"},
            {"name": "closed_at", "type": "text"},
            {"name": "user_id", "type": "text"},
        ],
    },
    {
        "name": "trade_history",
        "type": "base",
        "fields": [
            {"name": "symbol", "type": "text"},
            {"name": "broker", "type": "text"},
            {"name": "direction", "type": "text"},
            {"name": "entry_price", "type": "number"},
            {"name": "exit_price", "type": "number"},
            {"name": "quantity", "type": "number"},
            {"name": "pnl", "type": "number"},
            {"name": "pnl_pct", "type": "number"},
            {"name": "duration_minutes", "type": "number"},
            {"name": "entry_time", "type": "text"},
            {"name": "exit_time", "type": "text"},
            {"name": "strategy", "type": "text"},
            {"name": "signal_id", "type": "text"},
            {"name": "user_id", "type": "text"},
        ],
    },
    {
        "name": "trade_pnl",
        "type": "base",
        "fields": [
            {"name": "date", "type": "text", "required": True},
            {"name": "daily_pnl", "type": "number"},
            {"name": "cumulative_pnl", "type": "number"},
            {"name": "win_count", "type": "number"},
            {"name": "loss_count", "type": "number"},
            {"name": "win_rate", "type": "number"},
            {"name": "portfolio_value", "type": "number"},
            {"name": "max_drawdown", "type": "number"},
            {"name": "user_id", "type": "text"},
        ],
    },
    {
        "name": "trade_news",
        "type": "base",
        "fields": [
            {"name": "symbol", "type": "text"},
            {"name": "headline", "type": "text"},
            {"name": "summary", "type": "text"},
            {"name": "source", "type": "text"},
            {"name": "url", "type": "text"},
            {"name": "published_at", "type": "text"},
            {"name": "finnhub_sentiment", "type": "number"},
            {"name": "finbert_sentiment", "type": "number"},
            {"name": "llm_sentiment", "type": "number"},
            {"name": "final_sentiment", "type": "number"},
            {"name": "impact", "type": "text"},              # high / medium / low
            {"name": "processed", "type": "bool"},
            {"name": "news_source", "type": "text"},   # pipeline origin: finnhub / searxng
            {"name": "category", "type": "text"},       # article category tag
        ],
    },
    {
        "name": "trade_strategies",
        "type": "base",
        "fields": [
            {"name": "name", "type": "text", "required": True},
            {"name": "description", "type": "text"},
            {"name": "config", "type": "json"},
            {"name": "is_active", "type": "bool"},
            {"name": "symbols", "type": "json"},
            {"name": "timeframes", "type": "json"},
            {"name": "backtest_results", "type": "json"},
            {"name": "user_id", "type": "text"},
        ],
    },
]


# ---------------------------------------------------------------------------
# Auto-provisioning
# ---------------------------------------------------------------------------

async def ensure_trade_collections(pb_url: str, admin_token: str) -> dict:
    """
    Ensure all TRADE_COLLECTIONS exist in PocketBase.
    Creates missing ones, skips existing. Safe to call multiple times.

    Args:
        pb_url:       PocketBase base URL (e.g. http://pocketbase:8090)
        admin_token:  PB admin auth token

    Returns:
        {"created": [...], "skipped": [...], "errors": [...]}
    """
    created: list[str] = []
    skipped: list[str] = []
    errors: list[str] = []

    if not pb_url or not admin_token:
        reason = "no pb_url" if not pb_url else "no admin_token"
        logger.warning("pb_collections: skipping provisioning — %s", reason)
        return {"created": created, "skipped": skipped, "errors": errors}

    headers = {"Authorization": admin_token}

    # Fetch existing collection names
    existing_names: set[str] = set()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{pb_url}{pb_api('/api/collections')}",
                params={"perPage": 500},
                headers=headers,
            )
            if resp.status_code == 200:
                data = resp.json()
                existing_names = {c["name"] for c in data.get("items", [])}
            else:
                errors.append(f"Failed to list collections: HTTP {resp.status_code}")
                return {"created": created, "skipped": skipped, "errors": errors}
    except Exception as exc:
        errors.append(f"Failed to fetch existing collections: {exc}")
        logger.error("pb_collections: fetch failed — %s", exc)
        return {"created": created, "skipped": skipped, "errors": errors}

    # Create missing collections
    async with httpx.AsyncClient(timeout=10) as client:
        for collection in TRADE_COLLECTIONS:
            name = collection["name"]

            if name in existing_names:
                skipped.append(name)
                continue

            body = {
                "name": name,
                "type": collection.get("type", "base"),
                "fields": [
                    {
                        "name": field["name"],
                        "type": field["type"],
                        "required": field.get("required", False),
                    }
                    for field in collection["fields"]
                ],
            }

            try:
                resp = await client.post(
                    f"{pb_url}{pb_api('/api/collections')}",
                    json=body,
                    headers={
                        **headers,
                        "Content-Type": "application/json",
                    },
                )
                if resp.status_code in (200, 201):
                    created.append(name)
                    logger.info("pb_collections: created %s", name)
                else:
                    err_text = resp.text[:200]
                    # Handle race condition: 400 "already exists"
                    if resp.status_code == 400 and "already exists" in err_text:
                        skipped.append(name)
                    else:
                        errors.append(f"{name}: {resp.status_code} {err_text}")
                        logger.warning(
                            "pb_collections: failed to create %s — %s %s",
                            name, resp.status_code, err_text,
                        )
            except Exception as exc:
                errors.append(f"{name}: {exc}")
                logger.error("pb_collections: error creating %s — %s", name, exc)

    logger.info(
        "pb_collections: provisioned — created=%d skipped=%d errors=%d",
        len(created), len(skipped), len(errors),
    )
    return {"created": created, "skipped": skipped, "errors": errors}
