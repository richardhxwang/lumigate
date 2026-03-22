"""
LumiTrade Engine — FastAPI service for SMC analysis, risk management, and trade orchestration.
Runs as a Docker container, communicates with LumiGate (Node.js) via HTTP.
"""

from contextlib import asynccontextmanager
from datetime import datetime, timezone

import asyncio
import json
import logging
import math
import random

import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class _SafeEncoder(json.JSONEncoder):
    """JSON encoder that converts NaN/Inf to null instead of raising."""

    def default(self, o):
        return str(o)

    def encode(self, o):
        return super().encode(self._sanitize(o))

    def _sanitize(self, obj):
        if isinstance(obj, float):
            if math.isnan(obj) or math.isinf(obj):
                return None
            return obj
        if isinstance(obj, dict):
            return {k: self._sanitize(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self._sanitize(v) for v in obj]
        return obj


class SafeJSONResponse(JSONResponse):
    """JSONResponse that replaces NaN/Inf with null for JSON compliance."""

    def render(self, content) -> bytes:
        return json.dumps(
            content,
            cls=_SafeEncoder,
            ensure_ascii=False,
        ).encode("utf-8")

from config import settings, pb_api
from connectors.ibkr import IBKRConnector
from connectors.freqtrade import FreqtradeConnector, MultiBotConnector
from risk.manager import RiskManager
from notifications.telegram import TelegramNotifier
from notifications.alerts import AlertManager
from analytics.sessions import SessionAnalyzer
from analytics.reports import generate_performance_report, generate_html_report
from analytics.mood_correlator import MoodCorrelator
from analytics.trading_rag import TradingRAG
from strategies.smc_strategy import SMCAnalyzer
from connectors.okx_manual import OKXManualConnector
from manual.risk import ManualRiskManager
from manual.executor import ManualTradeExecutor
from manual.models import ProposeTradeRequest, CloseTradeRequest, MoodRequest, ReviewRequest

logger = logging.getLogger("lumitrade")

risk_manager = RiskManager(settings)
smc_analyzer = SMCAnalyzer()
session_analyzer = SessionAnalyzer()
mood_correlator = MoodCorrelator()
trading_rag = TradingRAG()
http_client: httpx.AsyncClient | None = None
ibkr_connector: IBKRConnector | None = None
ft_connector = FreqtradeConnector()
multi_bot = MultiBotConnector()
telegram = TelegramNotifier()
alert_manager = AlertManager()

# Manual trading components (initialized in lifespan after http_client is ready)
manual_okx: OKXManualConnector | None = None
manual_risk: ManualRiskManager | None = None
manual_executor: ManualTradeExecutor | None = None

# Background task handle for bot risk monitor
_risk_monitor_task: asyncio.Task | None = None
# Background task handle for trade sync (freqtrade → PB)
_trade_sync_task: asyncio.Task | None = None
# Background task handle for IBKR trade sync (executions → PB)
_ibkr_sync_task: asyncio.Task | None = None
# Background task handle for weekly hyperopt
_hyperopt_task: asyncio.Task | None = None

BOT_POLL_INTERVAL = 30  # seconds
TRADE_SYNC_INTERVAL = 5 * 60  # 5 minutes
IBKR_SYNC_INTERVAL = 60  # 1 minute

# Previous open trades snapshot for detecting new opens/closes
# Key: "{bot_label}_{trade_id}", Value: trade dict
_prev_open_trades: dict[str, dict] = {}


async def _bot_risk_monitor_loop():
    """
    Periodic task: poll all freqtrade bots every 30s,
    sync state into RiskManager, and trigger circuit breaker if needed.
    """
    logger.info("Bot risk monitor started (interval=%ds)", BOT_POLL_INTERVAL)
    while True:
        try:
            await asyncio.sleep(BOT_POLL_INTERVAL)
            await _poll_bots_and_check_risk()
        except asyncio.CancelledError:
            logger.info("Bot risk monitor stopped")
            break
        except Exception as e:
            logger.warning("Bot risk monitor error (will retry): %s", e)


async def _poll_bots_and_check_risk():
    """Single poll cycle: fetch all bot data, sync risk state, run alerts, act if needed."""
    global _prev_open_trades

    # Skip if circuit breaker already tripped today
    if risk_manager._circuit_breaker_tripped:
        return

    # Gather data from all bots in parallel
    open_trades, profit_summaries, balances, bot_pings = await asyncio.gather(
        multi_bot.get_all_open_trades(),
        multi_bot.get_all_profit(),
        multi_bot.get_all_balance(),
        multi_bot.ping_all(),
    )

    # --- Detect new opens / closes by comparing with previous snapshot ---
    current_open: dict[str, dict] = {}
    for t in open_trades:
        bot_label = t.get("_bot", "unknown")
        trade_id = str(t.get("trade_id", t.get("id", "")))
        if trade_id:
            key = f"{bot_label}_{trade_id}"
            current_open[key] = t

    # New trades: in current but not in previous
    new_keys = set(current_open.keys()) - set(_prev_open_trades.keys())
    for key in new_keys:
        trade = current_open[key]
        pair = trade.get("pair", "")
        bot_label = trade.get("_bot", "")
        direction = "short" if trade.get("is_short") else "long"
        enter_tag = trade.get("enter_tag", "")

        logger.info("Trade opened: %s %s %s on %s", direction, pair, enter_tag, bot_label)

        # Broadcast signal_detected (entry signal fired)
        await notify_clients("signal_detected", {
            "pair": pair,
            "direction": direction,
            "enter_tag": enter_tag,
            "bot": bot_label,
            "open_rate": trade.get("open_rate", 0),
            "stake_amount": trade.get("stake_amount", 0),
            "trade_id": trade.get("trade_id"),
        })

        # Broadcast trade_opened
        await notify_clients("trade_opened", {
            "pair": pair,
            "direction": direction,
            "enter_tag": enter_tag,
            "bot": bot_label,
            "open_rate": trade.get("open_rate", 0),
            "stake_amount": trade.get("stake_amount", 0),
            "amount": trade.get("amount", 0),
            "trade_id": trade.get("trade_id"),
            "is_short": trade.get("is_short", False),
            "open_date": trade.get("open_date", ""),
        })

    # Closed trades: in previous but not in current
    closed_keys = set(_prev_open_trades.keys()) - set(current_open.keys())
    for key in closed_keys:
        trade = _prev_open_trades[key]
        pair = trade.get("pair", "")
        bot_label = trade.get("_bot", "")
        direction = "short" if trade.get("is_short") else "long"

        logger.info("Trade closed: %s %s on %s", direction, pair, bot_label)

        await notify_clients("trade_closed", {
            "pair": pair,
            "direction": direction,
            "bot": bot_label,
            "trade_id": trade.get("trade_id"),
            "open_rate": trade.get("open_rate", 0),
            "current_rate": trade.get("current_rate", 0),
            "profit_abs": trade.get("profit_abs", 0),
            "profit_pct": trade.get("profit_pct", 0),
            "open_date": trade.get("open_date", ""),
        })

    # Update snapshot for next cycle
    _prev_open_trades = current_open

    # Sum total balance across all bots
    total_balance = 0.0
    for b in balances:
        # freqtrade /api/v1/balance returns "total" (float) for total value
        total_balance += b.get("total", 0.0)

    # Sync into RiskManager
    sync_result = risk_manager.sync_from_bots(open_trades, profit_summaries, total_balance)

    logger.info(
        "Bot sync: %d positions, daily PnL=$%.2f (%.2f%% of $%.2f), breaker=%s",
        sync_result["open_positions"],
        sync_result["daily_pnl"],
        sync_result["loss_pct"],
        sync_result["total_balance"],
        sync_result["circuit_breaker_should_trip"],
    )

    # Broadcast risk update to WebSocket clients
    await notify_clients("risk_update", sync_result)

    # --- Proactive Alerts ---
    await _run_alert_checks(sync_result, bot_pings)

    # --- Circuit Breaker ---
    if sync_result["circuit_breaker_should_trip"]:
        await _execute_circuit_breaker(sync_result)


async def _run_alert_checks(sync_result: dict, bot_pings: dict[str, bool]):
    """Run all proactive alert checks and send Telegram for any that fire."""
    alerts_to_send: list[str] = []

    # 1. Daily loss warning (>= 2%, before 3% circuit breaker)
    loss_pct = sync_result.get("loss_pct", 0.0)
    daily_pnl = sync_result.get("daily_pnl", 0.0)
    total_balance = sync_result.get("total_balance", 0.0)
    msg = alert_manager.check_daily_loss(loss_pct, daily_pnl, total_balance)
    if msg:
        alerts_to_send.append(msg)

    # 2. Bot offline alerts
    for bot_name, is_online in bot_pings.items():
        msg = alert_manager.check_bot_offline(bot_name, is_online)
        if msg:
            alerts_to_send.append(msg)

    # 3. Losing streak (fetch recent closed trades)
    try:
        recent_trades = await multi_bot.get_all_trades(limit=20)
        closed = [t for t in recent_trades if t.get("close_date")]
        msg = alert_manager.check_losing_streak(closed)
        if msg:
            alerts_to_send.append(msg)
    except Exception as e:
        logger.debug("Failed to check losing streak: %s", e)

    # 4. Drawdown vs backtest max drawdown
    try:
        await _check_drawdown_alert(alerts_to_send, total_balance)
    except Exception as e:
        logger.debug("Failed to check drawdown alert: %s", e)

    # 5. FreqAI training failure (scan logs)
    try:
        all_logs = await multi_bot.get_all_logs(limit=30)
        for bot_name, log_entries in all_logs.items():
            msg = alert_manager.check_freqai_failure(bot_name, log_entries)
            if msg:
                alerts_to_send.append(msg)
    except Exception as e:
        logger.debug("Failed to check FreqAI logs: %s", e)

    # Send all fired alerts via Telegram
    for alert_msg in alerts_to_send:
        await telegram.send(alert_msg)


async def _check_drawdown_alert(alerts_to_send: list[str], total_balance: float):
    """
    Check if current drawdown exceeds backtest max drawdown.
    Reads backtest_max_drawdown_pct from PB lt_backtest_results collection.
    Falls back to profit API drawdown fields.
    """
    if total_balance <= 0:
        return

    # Get current drawdown from profit summaries
    profit_summaries = await multi_bot.get_all_profit()
    max_live_dd = 0.0
    for ps in profit_summaries:
        # freqtrade profit endpoint includes max_drawdown / max_drawdown_account
        dd = ps.get("max_drawdown", 0.0) or 0.0
        if dd > 0:
            max_live_dd = max(max_live_dd, dd * 100)  # ratio -> %
        dd_acct = ps.get("max_drawdown_account", 0.0) or 0.0
        if dd_acct > 0:
            max_live_dd = max(max_live_dd, dd_acct * 100)

    if max_live_dd <= 0:
        return

    # Try to read backtest baseline from PocketBase
    backtest_max_dd = 0.0
    try:
        resp = await pb_get(
            "/api/collections/lt_backtest_results/records",
            params={"perPage": 1, "fields": "max_drawdown_pct"},
        )
        if resp.is_success:
            items = resp.json().get("items", [])
            if items:
                backtest_max_dd = items[0].get("max_drawdown_pct", 0.0) or 0.0
    except Exception:
        pass

    # Fallback: conservative 5% default if no backtest data
    if backtest_max_dd <= 0:
        backtest_max_dd = 5.0

    msg = alert_manager.check_drawdown(max_live_dd, backtest_max_dd)
    if msg:
        alerts_to_send.append(msg)


async def _execute_circuit_breaker(sync_result: dict):
    """
    Circuit breaker execution:
    1. Stop all bots from opening new trades
    2. Force-exit all open positions
    3. Send Telegram notification
    4. Broadcast to WebSocket clients
    """
    risk_manager.mark_circuit_breaker_tripped()
    loss_pct = sync_result["loss_pct"]
    daily_pnl = sync_result["daily_pnl"]
    total_balance = sync_result["total_balance"]

    logger.critical(
        "CIRCUIT BREAKER EXECUTING: daily loss %.2f%% (PnL=$%.2f, balance=$%.2f)",
        loss_pct, daily_pnl, total_balance,
    )

    # Step 1: Pause new entries on all bots
    stop_results = await multi_bot.stop_buy_all_bots()
    logger.info("Stop-buy results: %s", stop_results)

    # Step 2: Force-exit all open positions
    exit_results = await multi_bot.forceexit_all_bots()
    logger.info("Force-exit results: %s", exit_results)

    # Step 3: Telegram notification
    msg = (
        "<b>CIRCUIT BREAKER TRIGGERED</b>\n\n"
        f"Daily loss: <b>{loss_pct:.2f}%</b> (limit: {risk_manager.settings.max_daily_loss_pct}%)\n"
        f"Daily PnL: <b>${daily_pnl:.2f}</b>\n"
        f"Total balance: ${total_balance:.2f}\n\n"
        "<b>Actions taken:</b>\n"
        "- All bots paused (no new entries)\n"
        "- All open positions force-exited\n\n"
        "Manual review required before resuming trading."
    )
    await telegram.send(msg)

    # Step 4: Broadcast to UI
    await notify_clients("circuit_breaker", {
        "triggered": True,
        "loss_pct": loss_pct,
        "daily_pnl": daily_pnl,
        "total_balance": total_balance,
        "stop_results": stop_results,
        "exit_results": exit_results,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# ---------------------------------------------------------------------------
# Trade sync: freqtrade closed trades → PocketBase (every 5 min)
# ---------------------------------------------------------------------------

async def _trade_sync_loop():
    """
    Periodic task: every 5 minutes, fetch closed trades from ALL bots,
    deduplicate against PB trade_history, and write new records.
    Also updates trade_pnl with daily/cumulative P&L.
    """
    logger.info("Trade sync started (interval=%ds)", TRADE_SYNC_INTERVAL)
    # Wait 60s on startup to let freqtrade containers fully boot
    await asyncio.sleep(60)
    while True:
        try:
            result = await _sync_all_bot_trades()
            if result["synced"] > 0 or result["errors"]:
                logger.info(
                    "Trade sync: synced=%d, skipped=%d, errors=%d",
                    result["synced"], result["skipped"], len(result["errors"]),
                )
                if result["errors"]:
                    for err in result["errors"][:5]:
                        logger.warning("Trade sync error: %s", err)
            # Update daily P&L summary
            await _update_trade_pnl()
        except asyncio.CancelledError:
            logger.info("Trade sync stopped")
            break
        except Exception as e:
            logger.warning("Trade sync error (will retry): %s", e)
        await asyncio.sleep(TRADE_SYNC_INTERVAL)


async def _ibkr_trade_sync_loop():
    """
    Periodic task: every 60s, check IBKR fills and sync completed trades to PB.
    Only runs when IBKR connector is connected.
    """
    logger.info("IBKR trade sync started (interval=%ds)", IBKR_SYNC_INTERVAL)
    _seen_exec_ids: set[str] = set()
    await asyncio.sleep(30)  # wait for IBKR to connect
    while True:
        try:
            if ibkr_connector and ibkr_connector.connected:
                fills = self._ib.fills() if hasattr(ibkr_connector, '_ib') else []
                fills = ibkr_connector._ib.fills()
                for fill in fills:
                    exec_id = fill.execution.execId
                    if exec_id in _seen_exec_ids:
                        continue
                    _seen_exec_ids.add(exec_id)

                    record = {
                        "symbol": fill.contract.symbol,
                        "broker": "ibkr",
                        "direction": "long" if fill.execution.side == "BOT" else "short",
                        "entry_price": fill.execution.price,
                        "exit_price": fill.execution.price,
                        "quantity": fill.execution.shares,
                        "pnl": fill.commissionReport.realizedPNL if fill.commissionReport else 0,
                        "pnl_pct": 0,
                        "duration": "",
                        "entry_time": fill.execution.time.isoformat() if fill.execution.time else "",
                        "exit_time": fill.execution.time.isoformat() if fill.execution.time else "",
                        "strategy": "smc_ibkr",
                        "signal_id": f"ibkr_{exec_id}",
                    }
                    try:
                        await pb_post("/api/collections/trade_history/records", record)
                        logger.info("IBKR trade synced: %s %s %.0f @ %.2f",
                                    record["direction"], record["symbol"],
                                    record["quantity"], record["entry_price"])
                    except Exception as e:
                        logger.warning("IBKR trade sync PB write failed: %s", e)
        except asyncio.CancelledError:
            logger.info("IBKR trade sync stopped")
            break
        except Exception as e:
            logger.warning("IBKR trade sync error (will retry): %s", e)
        await asyncio.sleep(IBKR_SYNC_INTERVAL)


async def _sync_all_bot_trades() -> dict:
    """
    Fetch closed trades from all bots via MultiBotConnector,
    deduplicate against PB trade_history (by signal_id = ft_{bot}_{trade_id}),
    and insert new records.
    """
    results = {"synced": 0, "skipped": 0, "errors": []}

    # Fetch trades from all bots in parallel
    all_bot_trades = await asyncio.gather(
        *[multi_bot._safe_call(i, "get_trades", 200) for i in range(len(multi_bot.bots))]
    )

    for label, _group, data in all_bot_trades:
        if data is None:
            continue
        trades = data.get("trades", []) if isinstance(data, dict) else []

        # Only closed trades
        closed = [t for t in trades if t.get("is_open") is False]

        for trade in closed:
            trade_id = str(trade.get("trade_id", trade.get("id", "")))
            if not trade_id:
                results["errors"].append(f"{label}: trade missing trade_id")
                continue

            # Dedup key: ft_{bot_name}_{trade_id}
            signal_id = f"ft_{label}_{trade_id}"

            try:
                # Check if already in PB
                check_resp = await pb_get(
                    "/api/collections/trade_history/records",
                    params={"filter": f'signal_id="{signal_id}"', "perPage": "1"},
                )
                if check_resp.is_success:
                    items = check_resp.json().get("items", [])
                    if len(items) > 0:
                        results["skipped"] += 1
                        continue

                # Compute duration
                duration_minutes = None
                if trade.get("open_date") and trade.get("close_date"):
                    try:
                        open_dt = datetime.fromisoformat(trade["open_date"].replace("Z", "+00:00"))
                        close_dt = datetime.fromisoformat(trade["close_date"].replace("Z", "+00:00"))
                        duration_minutes = int((close_dt - open_dt).total_seconds() / 60)
                    except Exception:
                        pass

                # Parse entry hour/day for timing context
                hour_utc = None
                day_of_week = None
                if trade.get("open_date"):
                    try:
                        d = datetime.fromisoformat(trade["open_date"].replace("Z", "+00:00"))
                        hour_utc = d.hour
                        day_of_week = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d.weekday()]
                    except Exception:
                        pass

                fees = (trade.get("fee_open_cost") or 0) + (trade.get("fee_close_cost") or 0)

                record = {
                    "symbol":           trade.get("pair", ""),
                    "broker":           "freqtrade",
                    "exchange":         trade.get("exchange", ""),
                    "direction":        "short" if trade.get("is_short") else "long",
                    "entry_price":      trade.get("open_rate", 0),
                    "exit_price":       trade.get("close_rate", 0),
                    "quantity":         trade.get("amount", 0),
                    "pnl":              trade.get("close_profit_abs"),
                    "pnl_pct":          trade.get("close_profit"),
                    "duration_minutes": duration_minutes,
                    "entry_time":       trade.get("open_date", ""),
                    "exit_time":        trade.get("close_date", ""),
                    "strategy":         trade.get("strategy", ""),
                    "signal_id":        signal_id,
                    "risk_amount":      trade.get("stake_amount", 0),
                    "fees":             fees,
                    "exit_reason":      trade.get("exit_reason") or trade.get("sell_reason", ""),
                    "bot_name":         label,
                    "trading_mode":     "live",
                    "hour_utc":         hour_utc,
                    "day_of_week":      day_of_week,
                    "minutes_in_trade": duration_minutes,
                    "user_id":          "freqtrade_bot",
                    "notes":            f"exit: {trade.get('exit_reason', '')}" if trade.get("exit_reason") else "",
                }

                save_resp = await pb_post("/api/collections/trade_history/records", record)
                if save_resp.is_success:
                    results["synced"] += 1
                else:
                    err_text = ""
                    try:
                        err_text = save_resp.text[:200]
                    except Exception:
                        err_text = str(save_resp.status_code)
                    results["errors"].append(f"{label} trade_id={trade_id}: PB {save_resp.status_code} {err_text}")
            except Exception as e:
                results["errors"].append(f"{label} trade_id={trade_id}: {e}")

    return results


async def _update_trade_pnl():
    """
    Recalculate today's P&L from trade_history and upsert into trade_pnl.
    Also computes cumulative P&L across all dates.
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    try:
        # Fetch all trades closed today
        resp = await pb_get(
            "/api/collections/trade_history/records",
            params={
                "filter": f'exit_time>="{today}T00:00:00" && exit_time<="{today}T23:59:59"',
                "perPage": 500,
            },
        )
        if not resp.is_success:
            logger.debug("trade_pnl: failed to fetch today's trades")
            return

        trades = resp.json().get("items", [])
        daily_pnl = sum(t.get("pnl", 0) or 0 for t in trades)
        wins = sum(1 for t in trades if (t.get("pnl", 0) or 0) > 0)
        losses = sum(1 for t in trades if (t.get("pnl", 0) or 0) < 0)
        total = wins + losses
        win_rate = round(wins / total, 4) if total > 0 else 0

        # Get total balance from bots for portfolio_value
        balances = await multi_bot.get_all_balance()
        portfolio_value = sum(b.get("total", 0.0) for b in balances)

        # Compute cumulative P&L from existing trade_pnl records
        pnl_resp = await pb_get(
            "/api/collections/trade_pnl/records",
            params={"perPage": 500},
        )
        cumulative = 0.0
        existing_today_id = None
        if pnl_resp.is_success:
            for rec in pnl_resp.json().get("items", []):
                if rec.get("date") == today:
                    existing_today_id = rec.get("id")
                else:
                    cumulative += rec.get("daily_pnl", 0) or 0
        cumulative += daily_pnl

        pnl_record = {
            "date": today,
            "daily_pnl": round(daily_pnl, 4),
            "cumulative_pnl": round(cumulative, 4),
            "win_count": wins,
            "loss_count": losses,
            "win_rate": win_rate,
            "portfolio_value": round(portfolio_value, 2),
            "user_id": "freqtrade_bot",
        }

        if existing_today_id:
            await pb_patch(f"/api/collections/trade_pnl/records/{existing_today_id}", pnl_record)
        else:
            await pb_post("/api/collections/trade_pnl/records", pnl_record)

    except Exception as e:
        logger.debug("trade_pnl update error: %s", e)


# --- WebSocket Connection Manager ---

class ConnectionManager:
    """Manages active WebSocket connections. Thread-safe via asyncio."""

    def __init__(self):
        self._market_connections: list[WebSocket] = []
        self._signal_connections: list[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect_market(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self._market_connections.append(websocket)

    async def connect_signals(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self._signal_connections.append(websocket)

    async def disconnect_market(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self._market_connections:
                self._market_connections.remove(websocket)

    async def disconnect_signals(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self._signal_connections:
                self._signal_connections.remove(websocket)

    async def broadcast_market(self, message: dict):
        async with self._lock:
            stale: list[WebSocket] = []
            for ws in self._market_connections:
                try:
                    await ws.send_json(message)
                except Exception:
                    stale.append(ws)
            for ws in stale:
                self._market_connections.remove(ws)

    async def broadcast_signals(self, message: dict):
        async with self._lock:
            stale: list[WebSocket] = []
            for ws in self._signal_connections:
                try:
                    await ws.send_json(message)
                except Exception:
                    stale.append(ws)
            for ws in stale:
                self._signal_connections.remove(ws)

    async def broadcast(self, message: dict):
        """Broadcast to all connection pools."""
        await self.broadcast_market(message)
        await self.broadcast_signals(message)


ws_manager = ConnectionManager()


_pb_token: str = ""
_pb_token_exp: float = 0

async def get_pb_token() -> str:
    """Get PB admin token, cached for 30 min."""
    global _pb_token, _pb_token_exp
    import time
    if _pb_token and time.time() < _pb_token_exp:
        return _pb_token
    if not settings.pb_admin_email or not settings.pb_admin_password:
        return ""
    try:
        resp = await http_client.post(
            f"{settings.pb_url}/api/collections/_superusers/auth-with-password",
            json={"identity": settings.pb_admin_email, "password": settings.pb_admin_password},
        )
        if resp.is_success:
            _pb_token = resp.json().get("token", "")
            _pb_token_exp = time.time() + 1800
            return _pb_token
    except Exception:
        pass
    return ""

async def pb_get(path: str, params: dict = None) -> httpx.Response:
    """GET from PocketBase with admin auth (project-isolated)."""
    token = await get_pb_token()
    headers = {"Authorization": token} if token else {}
    return await http_client.get(f"{settings.pb_url}{pb_api(path)}", params=params, headers=headers)


async def pb_post(path: str, data: dict) -> httpx.Response:
    """POST JSON to PocketBase with admin auth (project-isolated)."""
    token = await get_pb_token()
    headers = {"Authorization": token, "Content-Type": "application/json"} if token else {"Content-Type": "application/json"}
    return await http_client.post(f"{settings.pb_url}{pb_api(path)}", json=data, headers=headers)


async def pb_patch(path: str, data: dict) -> httpx.Response:
    """PATCH JSON to PocketBase with admin auth (project-isolated)."""
    token = await get_pb_token()
    headers = {"Authorization": token, "Content-Type": "application/json"} if token else {"Content-Type": "application/json"}
    return await http_client.patch(f"{settings.pb_url}{pb_api(path)}", json=data, headers=headers)


async def notify_clients(event_type: str, data: dict):
    """Broadcast an event to all connected WebSocket clients."""
    message = {
        "type": event_type,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if event_type in ("signal_new", "signal", "signal_detected", "trade_opened", "trade_closed"):
        await ws_manager.broadcast_signals(message)
    await ws_manager.broadcast_market(message)


# ---------------------------------------------------------------------------
# Weekly Hyperopt: Sunday 02:00 UTC — run hyperopt on BT container,
# compare Sharpe improvement, notify via Telegram if worth updating.
# Does NOT auto-update parameters (requires human confirmation).
# ---------------------------------------------------------------------------

HYPEROPT_CONTAINER = "lumigate-freqtrade-bt"
HYPEROPT_EPOCHS = 200
HYPEROPT_SHARPE_THRESHOLD = 0.3  # minimum Sharpe improvement to recommend


async def _hyperopt_weekly_loop():
    """
    Wait until next Sunday 02:00 UTC, run hyperopt, compare results,
    send Telegram recommendation if Sharpe improved enough.
    """
    logger.info("Hyperopt weekly scheduler started (Sunday 02:00 UTC)")
    while True:
        try:
            # Sleep until next Sunday 02:00 UTC
            now = datetime.now(timezone.utc)
            days_until_sunday = (6 - now.weekday()) % 7
            if days_until_sunday == 0 and now.hour >= 2:
                days_until_sunday = 7  # already past Sunday 02:00, wait next week
            next_run = now.replace(hour=2, minute=0, second=0, microsecond=0)
            next_run = next_run + __import__("datetime").timedelta(days=days_until_sunday)
            wait_seconds = (next_run - now).total_seconds()
            logger.info(
                "Hyperopt next run: %s (in %.1f hours)",
                next_run.isoformat(), wait_seconds / 3600,
            )
            await asyncio.sleep(wait_seconds)

            # Run hyperopt
            await _run_hyperopt_cycle()

        except asyncio.CancelledError:
            logger.info("Hyperopt weekly loop cancelled")
            return
        except Exception as e:
            logger.warning("Hyperopt weekly loop error (will retry next week): %s", e)
            # Sleep 1h to avoid tight retry loops on persistent errors
            await asyncio.sleep(3600)


async def _run_hyperopt_cycle():
    """
    Execute one hyperopt cycle:
    1. Run baseline backtest with current params
    2. Run hyperopt to find new params
    3. Run backtest with new params
    4. Compare Sharpe / max drawdown
    5. Send Telegram if improvement is significant
    """
    logger.info("Hyperopt cycle starting...")

    # Step 1: Baseline backtest (current params)
    baseline = await _run_docker_backtest()
    if baseline is None:
        logger.warning("Hyperopt: baseline backtest failed, aborting cycle")
        return

    logger.info(
        "Hyperopt baseline: Sharpe=%.4f, MaxDD=%.2f%%, TotalProfit=%.2f%%",
        baseline.get("sharpe", 0), baseline.get("max_drawdown", 0),
        baseline.get("total_profit", 0),
    )

    # Step 2: Run hyperopt via docker exec
    hyperopt_result = await _run_docker_hyperopt()
    if hyperopt_result is None:
        logger.warning("Hyperopt: optimization failed, aborting cycle")
        return

    # Step 3: Backtest with new params (hyperopt writes to hyperopt_results/)
    new_backtest = await _run_docker_backtest(use_hyperopt_params=True)
    if new_backtest is None:
        logger.warning("Hyperopt: new-params backtest failed, aborting cycle")
        return

    logger.info(
        "Hyperopt new params: Sharpe=%.4f, MaxDD=%.2f%%, TotalProfit=%.2f%%",
        new_backtest.get("sharpe", 0), new_backtest.get("max_drawdown", 0),
        new_backtest.get("total_profit", 0),
    )

    # Step 4: Compare
    old_sharpe = baseline.get("sharpe", 0)
    new_sharpe = new_backtest.get("sharpe", 0)
    old_dd = baseline.get("max_drawdown", 0)
    new_dd = new_backtest.get("max_drawdown", 0)
    sharpe_delta = new_sharpe - old_sharpe

    improved = sharpe_delta >= HYPEROPT_SHARPE_THRESHOLD and new_dd <= old_dd * 1.05

    # Step 5: Send Telegram notification
    status = "RECOMMENDED" if improved else "NOT RECOMMENDED"
    msg = (
        f"<b>Weekly Hyperopt Report</b>\n\n"
        f"<b>Baseline:</b>\n"
        f"  Sharpe: {old_sharpe:.4f}\n"
        f"  Max DD: {old_dd:.2f}%\n"
        f"  Profit: {baseline.get('total_profit', 0):.2f}%\n\n"
        f"<b>New Params:</b>\n"
        f"  Sharpe: {new_sharpe:.4f}\n"
        f"  Max DD: {new_dd:.2f}%\n"
        f"  Profit: {new_backtest.get('total_profit', 0):.2f}%\n\n"
        f"<b>Delta Sharpe: {sharpe_delta:+.4f}</b>\n"
        f"<b>Update: {status}</b>\n\n"
    )
    if improved:
        msg += (
            "Hyperopt found better parameters. Review and apply manually:\n"
            f"<code>docker exec {HYPEROPT_CONTAINER} "
            "freqtrade hyperopt-show --best</code>"
        )
    else:
        reason = []
        if sharpe_delta < HYPEROPT_SHARPE_THRESHOLD:
            reason.append(f"Sharpe improvement {sharpe_delta:+.4f} < {HYPEROPT_SHARPE_THRESHOLD}")
        if new_dd > old_dd * 1.05:
            reason.append(f"Max DD worsened: {old_dd:.2f}% -> {new_dd:.2f}%")
        msg += "Reason: " + "; ".join(reason)

    await telegram.send(msg)
    logger.info("Hyperopt cycle complete: %s (Sharpe delta=%+.4f)", status, sharpe_delta)


async def _run_docker_backtest(use_hyperopt_params: bool = False) -> dict | None:
    """
    Run backtest via docker exec on the BT container.
    Returns {"sharpe": float, "max_drawdown": float, "total_profit": float} or None.
    """
    cmd = [
        "docker", "exec", HYPEROPT_CONTAINER,
        "freqtrade", "backtesting",
        "--config", "/freqtrade/config.json",
        "--strategy", "SMCStrategy",
        "--timerange", _get_backtest_timerange(),
    ]
    if use_hyperopt_params:
        cmd.extend(["--hyperopt-filename", "last"])

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)
        output = stdout.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            logger.warning("Backtest failed (rc=%d): %s", proc.returncode, stderr.decode()[:500])
            return None

        return _parse_backtest_output(output)
    except asyncio.TimeoutError:
        logger.warning("Backtest timed out (600s)")
        return None
    except Exception as e:
        logger.warning("Backtest exec error: %s", e)
        return None


async def _run_docker_hyperopt() -> dict | None:
    """Run hyperopt via docker exec. Returns raw output dict or None."""
    cmd = [
        "docker", "exec", HYPEROPT_CONTAINER,
        "freqtrade", "hyperopt",
        "--config", "/freqtrade/config.json",
        "--strategy", "SMCStrategy",
        "--hyperopt-loss", "SharpeHyperOptLoss",
        "--epochs", str(HYPEROPT_EPOCHS),
        "--timerange", _get_backtest_timerange(),
        "--spaces", "roi", "stoploss", "trailing", "buy",
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=1800)  # 30 min max

        if proc.returncode != 0:
            logger.warning("Hyperopt failed (rc=%d): %s", proc.returncode, stderr.decode()[:500])
            return None

        output = stdout.decode("utf-8", errors="replace")
        logger.info("Hyperopt completed (%d epochs)", HYPEROPT_EPOCHS)
        return {"output": output}
    except asyncio.TimeoutError:
        logger.warning("Hyperopt timed out (1800s)")
        return None
    except Exception as e:
        logger.warning("Hyperopt exec error: %s", e)
        return None


def _get_backtest_timerange() -> str:
    """Generate timerange for last ~6 months of data."""
    from datetime import timedelta
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=180)
    return f"{start.strftime('%Y%m%d')}-{end.strftime('%Y%m%d')}"


def _parse_backtest_output(output: str) -> dict | None:
    """
    Parse freqtrade backtest text output to extract key metrics.
    Looks for lines like:
      | Sharpe           |   1.234 |
      | Max Drawdown ... |  12.34% |
      | Total profit     |  45.67% |
    """
    import re
    result = {"sharpe": 0.0, "max_drawdown": 0.0, "total_profit": 0.0}

    # Sharpe ratio
    m = re.search(r"Sharpe\s*\|\s*([-\d.]+)", output)
    if m:
        try:
            result["sharpe"] = float(m.group(1))
        except ValueError:
            pass

    # Max drawdown (percentage)
    m = re.search(r"Max [Dd]rawdown.*?\|\s*([-\d.]+)%?", output)
    if m:
        try:
            result["max_drawdown"] = abs(float(m.group(1)))
        except ValueError:
            pass

    # Total profit percentage
    m = re.search(r"Total profit\s*\|\s*([-\d.]+)%?", output)
    if m:
        try:
            result["total_profit"] = float(m.group(1))
        except ValueError:
            pass

    # If we got nothing useful, return None
    if result["sharpe"] == 0 and result["max_drawdown"] == 0 and result["total_profit"] == 0:
        logger.debug("Could not parse backtest output (first 500 chars): %s", output[:500])
        return None

    return result


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client, ibkr_connector
    http_client = httpx.AsyncClient(timeout=30.0)

    # IBKR connector — non-blocking, log if TWS/Gateway is unavailable
    ibkr_connector = IBKRConnector(
        host=settings.ibkr_host,
        port=settings.ibkr_port,
        client_id=settings.ibkr_client_id,
    )
    try:
        connected = await ibkr_connector.connect()
        if connected:
            logger.info("IBKR connector ready")
        else:
            logger.warning("IBKR not available at startup — endpoints will return 503 until connected")
    except Exception as e:
        logger.warning("IBKR startup connection error (non-fatal): %s", e)

    # Ensure Qdrant RAG collection exists + load SMC knowledge
    try:
        await trading_rag.ensure_collection()
        logger.info("Trading RAG collection ready")
        # Load SMC knowledge docs on startup (idempotent — same content → same IDs)
        import pathlib
        knowledge_path = pathlib.Path(__file__).parent / "knowledge" / "smc_knowledge.json"
        if knowledge_path.exists():
            docs = json.loads(knowledge_path.read_text())
            await trading_rag.embed_knowledge(docs)
            logger.info("SMC knowledge loaded into RAG (%d docs)", len(docs))
    except Exception as e:
        logger.warning("Qdrant RAG init error (non-fatal): %s", e)

    # Start SearXNG periodic news fetcher (non-fatal if unavailable)
    from news.sentiment import start_searxng_periodic_task, stop_searxng_periodic_task
    searxng_task = start_searxng_periodic_task(http_client)

    # Start Fear & Greed Index periodic fetcher (every 1h, free API)
    from news.sentiment import start_fng_periodic_task, stop_fng_periodic_task
    fng_task = start_fng_periodic_task(http_client)

    # Start Chinese crypto media RSS collector (every 15 min)
    from news.rss_collector import start_rss_periodic_task, stop_rss_periodic_task
    rss_task = start_rss_periodic_task(http_client)

    # Start social sentiment collector (every 30 min, LunarCrush or CoinGecko fallback)
    from news.lunarcrush import start_lunarcrush_periodic_task, stop_lunarcrush_periodic_task
    lunarcrush_task = start_lunarcrush_periodic_task(http_client)

    # Start economic calendar fetcher (every 1h, Finnhub — powers news_blackout risk rule)
    from news.sentiment import start_econ_calendar_task, stop_econ_calendar_task
    econ_task = start_econ_calendar_task(http_client)

    # Start bot risk monitor (polls all freqtrade bots every 30s for circuit breaker)
    global _risk_monitor_task
    _risk_monitor_task = asyncio.create_task(_bot_risk_monitor_loop())
    logger.info("Bot risk monitor task created")

    # Start trade sync (all bots → PB every 5 min)
    global _trade_sync_task
    _trade_sync_task = asyncio.create_task(_trade_sync_loop())
    logger.info("Trade sync task created (interval=%ds)", TRADE_SYNC_INTERVAL)

    # Start IBKR trade sync (executions → PB every 60s)
    global _ibkr_sync_task
    _ibkr_sync_task = asyncio.create_task(_ibkr_trade_sync_loop())
    logger.info("IBKR trade sync task created (interval=%ds)", IBKR_SYNC_INTERVAL)

    # Start weekly hyperopt scheduler (Sunday 02:00 UTC)
    global _hyperopt_task
    _hyperopt_task = asyncio.create_task(_hyperopt_weekly_loop())
    logger.info("Hyperopt weekly scheduler task created")

    # Initialize manual trading system (OKX direct via ccxt)
    global manual_okx, manual_risk, manual_executor
    if settings.manual_okx_api_key:
        try:
            manual_okx = OKXManualConnector(
                api_key=settings.manual_okx_api_key,
                api_secret=settings.manual_okx_api_secret,
                passphrase=settings.manual_okx_passphrase,
            )
            manual_risk = ManualRiskManager(settings)
            manual_executor = ManualTradeExecutor(
                okx_connector=manual_okx,
                risk_manager=manual_risk,
                telegram_notifier=telegram,
                pb_post=pb_post,
                pb_patch=pb_patch,
                pb_get=pb_get,
            )
            logger.info("Manual trading system initialized (OKX direct)")
        except Exception as e:
            logger.warning("Manual trading init failed (non-fatal): %s", e)
    else:
        logger.info("Manual trading not configured (TRADE_MANUAL_OKX_API_KEY not set)")

    yield

    # Shutdown
    if _hyperopt_task and not _hyperopt_task.done():
        _hyperopt_task.cancel()
        try:
            await _hyperopt_task
        except asyncio.CancelledError:
            pass
    if _trade_sync_task and not _trade_sync_task.done():
        _trade_sync_task.cancel()
        try:
            await _trade_sync_task
        except asyncio.CancelledError:
            pass
    if _risk_monitor_task and not _risk_monitor_task.done():
        _risk_monitor_task.cancel()
        try:
            await _risk_monitor_task
        except asyncio.CancelledError:
            pass
    stop_econ_calendar_task()
    stop_lunarcrush_periodic_task()
    stop_rss_periodic_task()
    stop_fng_periodic_task()
    stop_searxng_periodic_task()
    if manual_okx:
        await manual_okx.close()
    if ibkr_connector:
        await ibkr_connector.disconnect()
    await http_client.aclose()


app = FastAPI(
    title="LumiTrade Engine",
    version="0.1.0",
    lifespan=lifespan,
    default_response_class=SafeJSONResponse,
)


# --- Health ---

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "trade-engine",
        "version": "0.1.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# --- SearXNG news (manual trigger) ---

@app.post("/news/searxng")
async def trigger_searxng_news(pairs: list[str] | None = None):
    """
    Manually trigger a SearXNG news fetch cycle.
    Optionally pass a list of trading pairs to include in the search.
    """
    from news.sentiment import fetch_searxng_news
    extra_pairs = pairs or settings.default_crypto_pairs
    result = await fetch_searxng_news(http_client, extra_pairs=extra_pairs)
    return result


# --- RSS news (manual trigger) ---

@app.post("/news/rss")
async def trigger_rss_fetch():
    """
    Manually trigger an RSS feed collection cycle for all configured
    Chinese crypto media sources.
    """
    from news.rss_collector import fetch_all_rss_feeds, RSS_FEEDS
    results = await fetch_all_rss_feeds(http_client)
    return {
        "feeds": len(RSS_FEEDS),
        "results": results,
        "total_fetched": sum(r["fetched"] for r in results),
        "total_saved": sum(r["saved"] for r in results),
    }


@app.get("/news/rss/sources")
async def list_rss_sources():
    """List all configured RSS feed sources."""
    from news.rss_collector import RSS_FEEDS
    return {
        "sources": [
            {"name": f["name"], "label": f["label"], "url": f["url"]}
            for f in RSS_FEEDS
        ]
    }


# --- LunarCrush social sentiment (manual trigger) ---

@app.post("/news/lunarcrush")
async def trigger_lunarcrush_fetch(coins: list[str] | None = None):
    """
    Manually trigger a social sentiment collection cycle.
    Uses LunarCrush if paid subscription active, otherwise CoinGecko + Fear & Greed.
    Optionally pass a list of coin symbols (e.g. ["BTC", "ETH"]).
    Defaults to BTC, ETH, SOL, BNB, XRP, ADA.
    """
    from news.lunarcrush import collect_lunarcrush_sentiment
    result = await collect_lunarcrush_sentiment(http_client, coins)
    return result


@app.get("/news/lunarcrush/status")
async def lunarcrush_status():
    """Check sentiment collector status and config."""
    from news.lunarcrush import (
        _lunarcrush_task, DEFAULT_COINS, COLLECT_INTERVAL_MINUTES,
        get_active_source,
    )
    return {
        "enabled": True,  # always enabled — CoinGecko fallback needs no key
        "active_source": get_active_source(),
        "task_running": _lunarcrush_task is not None and not _lunarcrush_task.done()
        if _lunarcrush_task else False,
        "interval_minutes": COLLECT_INTERVAL_MINUTES,
        "tracked_coins": DEFAULT_COINS,
        "lunarcrush_api_key_set": bool(settings.lunarcrush_api_key),
        "fallback": "coingecko + fear_greed_index (free, no key needed)",
    }


# --- Analysis ---

class AnalyzeRequest(BaseModel):
    symbol: str
    timeframes: list[str] | None = None
    include_news: bool = False


class Signal(BaseModel):
    symbol: str
    direction: str  # long / short
    entry: float
    stop_loss: float
    take_profit: float
    risk_reward: float
    confidence: float  # 0-1
    timeframe: str
    indicators: dict
    timestamp: str


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    """Run SMC analysis on a symbol across timeframes."""
    timeframes = req.timeframes or settings.default_timeframes
    try:
        result = await smc_analyzer.analyze(req.symbol, timeframes, ibkr_connector=ibkr_connector)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    signals = result.get("signals", [])

    if req.include_news and settings.finnhub_api_key:
        from news.sentiment import get_sentiment_score, analyze_with_finbert
        sentiment = await get_sentiment_score(req.symbol, http_client)
        for sig in signals:
            sig["news_sentiment"] = sentiment
        result["news_sentiment"] = sentiment

        # Run FinBERT on each saved article headline (best-effort)
        pb_ids = sentiment.get("pb_record_ids", {})
        headlines = sentiment.get("top_headlines", [])
        if pb_ids and headlines:
            record_ids = list(pb_ids.values())[:len(headlines)]
            for i, headline in enumerate(headlines[:len(record_ids)]):
                rid = record_ids[i] if i < len(record_ids) else None
                if headline and rid:
                    try:
                        await analyze_with_finbert(headline, http_client, pb_record_id=rid)
                    except Exception as fb_err:
                        logger.debug(f"FinBERT failed for {rid}: {fb_err}")

    return result


# --- Risk Check ---

class RiskCheckRequest(BaseModel):
    symbol: str
    direction: str
    entry: float
    stop_loss: float
    take_profit: float
    position_size_pct: float
    portfolio_value: float


@app.post("/risk-check")
async def risk_check(req: RiskCheckRequest):
    """Check if a trade passes risk management rules. Returns pass/fail + reasons."""
    result = risk_manager.check(
        symbol=req.symbol,
        direction=req.direction,
        entry=req.entry,
        stop_loss=req.stop_loss,
        take_profit=req.take_profit,
        position_size_pct=req.position_size_pct,
        portfolio_value=req.portfolio_value,
    )
    return result


@app.get("/risk-status")
async def risk_status():
    """Return current risk management state including bot sync info."""
    return risk_manager.get_status()


@app.post("/risk-reset-breaker")
async def risk_reset_breaker():
    """Manually reset the circuit breaker after review. Use with caution."""
    risk_manager.reset_circuit_breaker()
    risk_manager.reset_daily()
    return {"ok": True, "message": "Circuit breaker and daily PnL reset"}


@app.post("/risk-force-sync")
async def risk_force_sync():
    """Manually trigger an immediate bot risk sync cycle."""
    await _poll_bots_and_check_risk()
    return risk_manager.get_status()


@app.post("/trade-sync")
async def trade_sync_manual():
    """Manually trigger freqtrade → PB trade history sync for all bots."""
    result = await _sync_all_bot_trades()
    await _update_trade_pnl()
    return {"ok": True, **result}


@app.get("/economic-calendar")
async def economic_calendar(minutes_ahead: int = 60):
    """
    Return upcoming high-impact economic events from Finnhub.

    Query params:
        minutes_ahead: Look-ahead window in minutes (default 60).
                       Use 0 to return all cached events for today/tomorrow.
    """
    from news.sentiment import get_upcoming_events as _get_upcoming, _econ_calendar_cache

    if minutes_ahead <= 0:
        return {"events": _econ_calendar_cache, "total": len(_econ_calendar_cache)}

    upcoming = _get_upcoming(minutes_ahead)
    return {
        "events": upcoming,
        "total": len(upcoming),
        "blackout_active": any(
            e["minutes_until"] <= settings.news_blackout_minutes for e in upcoming
        ) if upcoming else False,
        "blackout_minutes": settings.news_blackout_minutes,
    }


# --- Signals ---

@app.get("/signals")
async def list_signals(symbol: str | None = None, limit: int = 50):
    """List recent signals. Tries PocketBase first, falls back to freqtrade live trades."""
    filter_q = f"symbol='{symbol}'" if symbol else ""
    # Try PocketBase
    try:
        resp = await pb_get(
            "/api/collections/trade_signals/records",
            params={"filter": filter_q, "perPage": limit},
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.warning("PB signals unavailable: %s — falling back to freqtrade", e)

    # Fallback: derive signals from freqtrade open trades (enter_tag as signal)
    try:
        open_trades = await multi_bot.get_all_open_trades()
        signals = []
        for t in open_trades:
            pair = t.get("pair", "")
            if symbol and symbol.upper() not in pair.upper():
                continue
            signals.append({
                "pair": pair,
                "direction": "short" if t.get("is_short", False) else "long",
                "tag": t.get("enter_tag", ""),
                "confidence": None,
                "source": "freqtrade_live",
                "_bot": t.get("_bot", ""),
            })
        return {"items": signals, "source": "freqtrade_live"}
    except Exception as e2:
        logger.warning("Freqtrade signals fallback also failed: %s", e2)

    return {"items": [], "source": "none"}


# --- Positions ---

@app.get("/positions")
async def list_positions(status: str = "open"):
    """List positions. Tries PocketBase first, falls back to freqtrade open trades."""
    # Try PocketBase
    try:
        resp = await pb_get(
            "/api/collections/trade_positions/records",
            params={"filter": f"status='{status}'", "perPage": 100},
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.warning("PB positions unavailable: %s — falling back to freqtrade", e)

    # Fallback: get live positions from freqtrade bots
    try:
        open_trades = await multi_bot.get_all_open_trades()
        positions = []
        for t in open_trades:
            positions.append({
                "pair": t.get("pair", ""),
                "direction": "short" if t.get("is_short", False) else "long",
                "amount": t.get("amount", 0),
                "stake_amount": t.get("stake_amount", 0),
                "open_rate": t.get("open_rate", 0),
                "current_rate": t.get("current_rate", 0),
                "profit_pct": t.get("profit_pct", 0),
                "profit_abs": t.get("profit_abs", 0),
                "open_date": t.get("open_date", ""),
                "enter_tag": t.get("enter_tag", ""),
                "trade_id": t.get("trade_id"),
                "status": "open",
                "source": "freqtrade_live",
                "_bot": t.get("_bot", ""),
            })
        return {"items": positions, "source": "freqtrade_live"}
    except Exception as e2:
        logger.warning("Freqtrade positions fallback also failed: %s", e2)

    return {"items": [], "source": "none"}


# --- Journal Analytics ---

@app.get("/journal/analytics")
async def journal_analytics(days: int = 30):
    """Analyze trading performance by session, killzone, and day of week."""
    try:
        resp = await pb_get(
            "/api/collections/trade_history/records",
            params={"perPage": 500},
        )
        if not resp.is_success:
            return {"error": "Failed to fetch trades from PB"}
        data = resp.json()
        trades = data.get("items", [])
        result = session_analyzer.analyze_trades(trades)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/journal/mood-analysis")
async def mood_analysis():
    """Analyze correlation between mood and trading performance."""
    try:
        trades_resp = await pb_get(
            "/api/collections/trade_history/records",
            params={"perPage": 500},
        )
        trades = trades_resp.json().get("items", []) if trades_resp.is_success else []

        mood_resp = await pb_get(
            "/api/collections/trade_mood_logs/records",
            params={"perPage": 500},
        )
        mood_logs = mood_resp.json().get("items", []) if mood_resp.is_success else []

        return mood_correlator.analyze(trades, mood_logs)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Performance Reports (QuantStats) ---

@app.get("/reports/performance")
async def performance_report():
    """Return QuantStats performance metrics from trade history."""
    try:
        resp = await pb_get(
            "/api/collections/trade_history/records",
            params={"perPage": 500},
        )
        trades = resp.json().get("items", []) if resp.is_success else []
        result = await generate_performance_report(trades)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/reports/tearsheet")
async def tearsheet_report():
    """Return full HTML tear sheet report."""
    from fastapi.responses import HTMLResponse
    try:
        resp = await pb_get(
            "/api/collections/trade_history/records",
            params={"perPage": 500},
        )
        trades = resp.json().get("items", []) if resp.is_success else []
        html = await generate_html_report(trades)
        return HTMLResponse(content=html)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- IBKR Endpoints ---

def _require_ibkr():
    """Raise 503 if IBKR connector is not connected."""
    if ibkr_connector is None or not ibkr_connector.connected:
        raise HTTPException(status_code=503, detail="IBKR not connected")


@app.get("/ibkr/status")
async def ibkr_status():
    """Return IBKR connection status."""
    if ibkr_connector is None:
        return {"connected": False, "detail": "Connector not initialized"}
    return ibkr_connector.status()


@app.get("/ibkr/positions")
async def ibkr_positions():
    """Return current IBKR positions."""
    _require_ibkr()
    try:
        positions = await ibkr_connector.positions()
        return {"positions": positions, "count": len(positions)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"IBKR error: {e}")


@app.get("/ibkr/account")
async def ibkr_account():
    """Return IBKR account summary."""
    _require_ibkr()
    try:
        summary = await ibkr_connector.account_summary()
        return summary
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"IBKR error: {e}")


@app.get("/ibkr/history/{symbol}")
async def ibkr_history(
    symbol: str,
    duration: str = Query(default="1 M", description="e.g. 1 D, 1 W, 1 M, 3 M, 1 Y"),
    bar_size: str = Query(default="1 hour", description="e.g. 1 min, 5 mins, 15 mins, 1 hour, 1 day"),
    sec_type: str = Query(default="STK"),
    exchange: str = Query(default="SMART"),
    currency: str = Query(default="USD"),
):
    """Return historical OHLCV bars from IBKR."""
    _require_ibkr()
    try:
        bars = await ibkr_connector.historical_bars(
            symbol=symbol,
            duration=duration,
            bar_size=bar_size,
            sec_type=sec_type,
            exchange=exchange,
            currency=currency,
        )
        return {"symbol": symbol, "bars": bars, "count": len(bars)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"IBKR error: {e}")


class IBKROrderRequest(BaseModel):
    symbol: str
    direction: str  # BUY / SELL
    quantity: float
    order_type: str = "MKT"  # MKT / LMT / STP
    limit_price: float | None = None
    stop_price: float | None = None
    sec_type: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    # Risk check fields
    entry: float
    stop_loss: float
    take_profit: float
    position_size_pct: float
    portfolio_value: float


@app.post("/ibkr/order")
async def ibkr_order(req: IBKROrderRequest):
    """Place an IBKR order after mandatory risk check."""
    _require_ibkr()

    # Mandatory risk check before any order
    risk_result = risk_manager.check(
        symbol=req.symbol,
        direction=req.direction.lower(),
        entry=req.entry,
        stop_loss=req.stop_loss,
        take_profit=req.take_profit,
        position_size_pct=req.position_size_pct,
        portfolio_value=req.portfolio_value,
    )
    if not risk_result["passed"]:
        return {"executed": False, "reason": "risk_check_failed", "details": risk_result}

    try:
        result = await ibkr_connector.place_order(
            symbol=req.symbol,
            direction=req.direction,
            quantity=req.quantity,
            order_type=req.order_type,
            limit_price=req.limit_price,
            stop_price=req.stop_price,
            sec_type=req.sec_type,
            exchange=req.exchange,
            currency=req.currency,
        )
        return {"executed": True, "broker": "ibkr", "result": result}
    except Exception as e:
        return {"executed": False, "broker": "ibkr", "error": str(e)}


# --- Freqtrade Endpoints ---

@app.get("/freqtrade/status")
async def ft_status():
    """Return freqtrade connection status, open trades, and profit summary."""
    try:
        is_alive = await ft_connector.ping()
        if not is_alive:
            return {"connected": False, "error": "Freqtrade not reachable"}
        status = await ft_connector.get_status()
        count = await ft_connector.get_count()
        profit = await ft_connector.get_profit()
        return {"connected": True, "open_trades": status, "count": count, "profit": profit}
    except Exception as e:
        return {"connected": False, "error": str(e)}


@app.get("/freqtrade/all-bots-status")
async def ft_all_bots_status():
    """Return status of ALL bot instances (online/offline, open trades, profit).
    Used by LumiTrader AI context to see every bot at once."""
    try:
        bots = await multi_bot.get_all_bots_status()
        online_count = sum(1 for b in bots if b["online"])
        total_trades = sum(b["trade_count"] for b in bots)
        return {"bots": bots, "online_count": online_count, "total_open_trades": total_trades}
    except Exception as e:
        logger.error("all-bots-status failed: %s", e)
        return {"bots": [], "online_count": 0, "total_open_trades": 0, "error": str(e)}


@app.get("/freqtrade/trades")
async def ft_trades(limit: int = 50):
    """Return completed trades from freqtrade."""
    try:
        return await ft_connector.get_trades(limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/freqtrade/performance")
async def ft_performance():
    """Return per-pair performance stats from freqtrade."""
    try:
        return await ft_connector.get_performance()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/freqtrade/balance")
async def ft_balance():
    """Return exchange balance from freqtrade."""
    try:
        return await ft_connector.get_balance()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/freqtrade/config")
async def ft_config():
    """Return freqtrade show_config (strategy, pairs, ROI, stoploss, etc.)."""
    try:
        return await ft_connector.get_config()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# --- FreqAI Training Status ---

import re as _re

def _parse_training_from_logs(log_entries: list) -> dict:
    """
    Parse FreqAI training progress from freqtrade log entries.
    Looks for patterns like:
      "Training 3/12 pairs" or "Training BTC/USDT 5m"
      "Training of model ... complete"
    Returns {training: bool, current_pair: str|None, progress: str|None, last_trained: str|None}
    """
    result = {"training": False, "current_pair": None, "progress": None, "last_trained": None}

    # Log entries are [timestamp, level, message] or similar structures
    for entry in reversed(log_entries):
        # Normalize: entry may be a list [ts, level, msg] or a dict
        if isinstance(entry, (list, tuple)) and len(entry) >= 3:
            ts_str = str(entry[0])
            msg = str(entry[2])
        elif isinstance(entry, dict):
            ts_str = str(entry.get("timestamp", entry.get("date", "")))
            msg = str(entry.get("message", entry.get("msg", "")))
        elif isinstance(entry, str):
            ts_str = ""
            msg = entry
        else:
            continue

        # Detect active training: "Training <pair> - <n>/<total> models"
        m = _re.search(r"[Tt]raining\s+(\S+/\S+)\s.*?(\d+)\s*/\s*(\d+)", msg)
        if m and not result["training"]:
            result["training"] = True
            result["current_pair"] = m.group(1)
            result["progress"] = f"{m.group(2)}/{m.group(3)}"
            continue

        # Detect training start: "Training models for ..." or "start training"
        if not result["training"] and _re.search(r"[Ss]tart.*[Tt]rain|[Tt]raining models? for", msg):
            result["training"] = True
            # Try to extract pair
            pm = _re.search(r"for\s+(\S+/\S+)", msg)
            if pm:
                result["current_pair"] = pm.group(1)
            continue

        # Detect training complete: "Training of ... complete" or "done training"
        if _re.search(r"[Tt]raining.*complete|done\s+[Tt]rain|[Ff]inished\s+[Tt]rain", msg):
            if not result["training"]:
                # Most recent event is completion => not currently training
                result["last_trained"] = ts_str or None
                break
            continue

    return result


@app.get("/freqai/training-status")
async def freqai_training_status():
    """
    Return FreqAI training status across all bots.
    Queries each bot's /api/v1/freqaimodels for model info and
    parses recent logs to detect active training progress.

    Returns:
        {
            training: bool,          # any bot currently training?
            current_pair: str|null,   # pair being trained right now
            progress: str|null,       # e.g. "3/12"
            last_trained: str|null,   # ISO timestamp of last completed training
            bots: {bot_name: {training, models_count, current_pair, progress, last_trained}}
        }
    """
    # Fetch models and logs from all bots in parallel
    all_models, all_logs = await asyncio.gather(
        multi_bot.get_all_freqai_models(),
        multi_bot.get_all_logs(limit=80),
    )

    bots_status = {}
    any_training = False
    global_pair = None
    global_progress = None
    global_last_trained = None

    for bot_name in multi_bot.bot_labels:
        models_data = all_models.get(bot_name)
        log_entries = all_logs.get(bot_name, [])

        # Parse training progress from logs
        train_info = _parse_training_from_logs(log_entries)

        models_count = 0
        if models_data and isinstance(models_data.get("freqaimodels"), list):
            models_count = len(models_data["freqaimodels"])

        bot_entry = {
            "training": train_info["training"],
            "models_count": models_count,
            "current_pair": train_info["current_pair"],
            "progress": train_info["progress"],
            "last_trained": train_info["last_trained"],
        }
        bots_status[bot_name] = bot_entry

        if train_info["training"]:
            any_training = True
            if global_pair is None:
                global_pair = train_info["current_pair"]
                global_progress = train_info["progress"]

        if train_info["last_trained"] and (
            global_last_trained is None or train_info["last_trained"] > global_last_trained
        ):
            global_last_trained = train_info["last_trained"]

    return {
        "training": any_training,
        "current_pair": global_pair,
        "progress": global_progress,
        "last_trained": global_last_trained,
        "bots": bots_status,
    }


class FreqtradeBacktestRequest(BaseModel):
    strategy: str = "SMCStrategy"
    timerange: str = ""
    wallet: float = 10000


@app.post("/freqtrade/backtest")
async def ft_backtest(req: FreqtradeBacktestRequest):
    """Trigger a freqtrade backtest via its REST API."""
    try:
        body = {
            "strategy": req.strategy,
            "timerange": req.timerange,
            "dry_run_wallet": req.wallet,
        }
        resp = await http_client.post(
            f"{settings.freqtrade_url}/api/v1/backtest",
            json=body,
            auth=(settings.freqtrade_username, settings.freqtrade_password),
            timeout=120.0,
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Freqtrade backtest error: {e}")


class DownloadDataRequest(BaseModel):
    pairs: str = "BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT"
    timerange: str
    timeframes: str = "15m,1h,4h"


@app.post("/freqtrade/download-data")
async def ft_download_data(req: DownloadDataRequest):
    """Download historical data via freqtrade for backtesting."""
    import subprocess
    pair_list = [p.strip() for p in req.pairs.split(",") if p.strip()]
    tf_list = [t.strip() for t in req.timeframes.split(",") if t.strip()]

    cmd = [
        "freqtrade", "download-data",
        "--timerange", req.timerange,
        "--timeframes", *tf_list,
        "-p", *pair_list,
        "--config", "/freqtrade/user_data/config.json",
    ]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        return {
            "ok": proc.returncode == 0,
            "command": " ".join(cmd),
            "stdout": proc.stdout[-2000:] if proc.stdout else "",
            "stderr": proc.stderr[-2000:] if proc.stderr else "",
            "pairs": pair_list,
            "timeframes": tf_list,
            "timerange": req.timerange,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Data download timed out after 5 minutes"}
    except FileNotFoundError:
        return {
            "ok": False,
            "error": "freqtrade binary not found in trade-engine container. Run download-data from the freqtrade container instead.",
            "suggestion": f"docker exec lumigate-freqtrade freqtrade download-data --timerange {req.timerange} --timeframes {' '.join(tf_list)} -p {' '.join(pair_list)}",
        }


# --- Unified Endpoints (cross-broker) ---

def detect_broker(symbol: str) -> str:
    """Auto-detect broker from symbol format."""
    return "freqtrade" if "/" in symbol else "ibkr"


@app.get("/unified/pairs")
async def unified_pairs():
    """Combined pair list from freqtrade (crypto) and IBKR (stocks)."""
    pairs = []
    # Crypto from freqtrade
    try:
        config = await ft_connector.get_config()
        for p in config.get("pair_whitelist", settings.default_crypto_pairs):
            pairs.append({"symbol": p, "broker": "freqtrade", "type": "crypto", "active": True})
    except Exception:
        for p in settings.default_crypto_pairs:
            pairs.append({"symbol": p, "broker": "freqtrade", "type": "crypto", "active": False})
    # Stocks from IBKR
    ibkr_connected = ibkr_connector is not None and ibkr_connector.connected
    for s in settings.default_symbols:
        pairs.append({"symbol": s, "broker": "ibkr", "type": "stock", "active": ibkr_connected})
    return {"pairs": pairs}


@app.get("/unified/positions")
async def unified_positions():
    """Merged positions from freqtrade and IBKR."""
    positions = []
    # Freqtrade open trades
    try:
        trades = await ft_connector.get_status()
        for t in (trades if isinstance(trades, list) else []):
            positions.append({
                "symbol": t.get("pair", ""),
                "broker": "freqtrade", "type": "crypto",
                "direction": "long" if t.get("is_short") is False else "short",
                "quantity": t.get("amount", 0),
                "entry_price": t.get("open_rate", 0),
                "current_price": t.get("current_rate", 0),
                "unrealized_pnl": t.get("profit_abs", 0),
                "unrealized_pnl_pct": t.get("profit_ratio", 0) * 100,
                "duration": t.get("trade_duration", ""),
            })
    except Exception:
        pass
    # IBKR positions
    if ibkr_connector is not None and ibkr_connector.connected:
        try:
            ibkr_pos = await ibkr_connector.positions()
            for p in ibkr_pos:
                positions.append({
                    "symbol": p.get("symbol", ""),
                    "broker": "ibkr", "type": "stock",
                    "direction": "long" if p.get("quantity", 0) > 0 else "short",
                    "quantity": abs(p.get("quantity", 0)),
                    "entry_price": p.get("avg_cost", 0),
                    "current_price": 0,
                    "unrealized_pnl": 0,
                    "unrealized_pnl_pct": 0,
                    "duration": "",
                })
        except Exception:
            pass
    return {"positions": positions, "count": len(positions)}


@app.get("/unified/history")
async def unified_history(limit: int = 50):
    """Merged trade history from freqtrade and PocketBase."""
    history = []
    # Freqtrade closed trades
    try:
        ft_trades = await ft_connector.get_trades(limit)
        for t in ft_trades.get("trades", []):
            history.append({
                "symbol": t.get("pair", ""),
                "broker": "freqtrade", "type": "crypto",
                "direction": "short" if t.get("is_short") else "long",
                "entry_price": t.get("open_rate", 0),
                "exit_price": t.get("close_rate", 0),
                "pnl": t.get("profit_abs", 0),
                "pnl_pct": round((t.get("profit_ratio", 0) or 0) * 100, 2),
                "entry_time": t.get("open_date", ""),
                "exit_time": t.get("close_date", ""),
                "duration": t.get("trade_duration", ""),
            })
    except Exception:
        pass
    # PB trade_history (includes IBKR trades)
    try:
        resp = await pb_get("/api/collections/trade_history/records", params={"perPage": limit})
        if resp.is_success:
            for t in resp.json().get("items", []):
                history.append({
                    "symbol": t.get("symbol", ""),
                    "broker": t.get("broker", "unknown"),
                    "type": "stock" if "/" not in t.get("symbol", "/") else "crypto",
                    "direction": t.get("direction", ""),
                    "entry_price": t.get("entry_price", 0),
                    "exit_price": t.get("exit_price", 0),
                    "pnl": t.get("pnl", 0),
                    "pnl_pct": t.get("pnl_pct", 0),
                    "entry_time": t.get("entry_time", ""),
                    "exit_time": t.get("exit_time", ""),
                    "duration": "",
                })
    except Exception:
        pass
    return {"history": history, "count": len(history)}


# --- Backtest ---

class BacktestRequest(BaseModel):
    symbol: str
    timeframe: str = "1h"
    start_date: str | None = None
    end_date: str | None = None
    initial_capital: float = 100000.0


@app.post("/backtest")
async def run_backtest(req: BacktestRequest):
    """Run SMC strategy backtest using vectorbt."""
    try:
        from strategies.backtester import run_smc_backtest
        result = await run_smc_backtest(
            symbol=req.symbol,
            timeframe=req.timeframe,
            start_date=req.start_date,
            end_date=req.end_date,
            initial_capital=req.initial_capital,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- RAG (Qdrant) ---

@app.get("/rag/search")
async def rag_search(q: str, limit: int = 5):
    """Search trading RAG for relevant context."""
    results = await trading_rag.search(q, limit)
    return {"query": q, "results": results}


@app.post("/rag/embed")
async def rag_embed(body: dict):
    """Embed arbitrary text into trading RAG."""
    text = body.get("text", "")
    metadata = body.get("metadata", {})
    if not text:
        raise HTTPException(400, "text required")
    await trading_rag.embed_text(text, metadata)
    return {"ok": True}


@app.post("/rag/knowledge")
async def rag_add_knowledge(body: dict):
    """Add knowledge documents to trading RAG.
    Body: {"docs": [{"title": str, "content": str, "category": str}]}
    """
    docs = body.get("docs", [])
    if not docs:
        raise HTTPException(400, "docs array required")
    await trading_rag.embed_knowledge(docs)
    return {"ok": True, "count": len(docs)}


# --- Execute Trade ---

class ExecuteRequest(BaseModel):
    symbol: str
    direction: str
    entry: float
    stop_loss: float
    take_profit: float
    position_size_pct: float
    portfolio_value: float
    broker: str | None = None  # ibkr / okx / freqtrade — auto-detected from symbol if omitted
    auto: bool = False


@app.post("/execute")
async def execute_trade(req: ExecuteRequest):
    """Execute a trade after risk check. Auto-executes only if position <= auto_exec_max_pct."""
    # Auto-detect broker from symbol format if not specified
    if not req.broker:
        req.broker = detect_broker(req.symbol)

    # Mandatory risk check
    risk_result = risk_manager.check(
        symbol=req.symbol,
        direction=req.direction,
        entry=req.entry,
        stop_loss=req.stop_loss,
        take_profit=req.take_profit,
        position_size_pct=req.position_size_pct,
        portfolio_value=req.portfolio_value,
    )

    if not risk_result["passed"]:
        return {"executed": False, "reason": "risk_check_failed", "details": risk_result}

    # Auto-execution gate
    if req.position_size_pct > settings.auto_exec_max_pct and req.auto:
        return {
            "executed": False,
            "reason": "requires_confirmation",
            "message": f"Position {req.position_size_pct}% exceeds auto-exec limit {settings.auto_exec_max_pct}%",
        }

    # Route to broker
    if req.broker in ("okx", "freqtrade"):
        return await _execute_via_freqtrade(req)
    elif req.broker == "ibkr":
        return await _execute_via_lumibot(req)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown broker: {req.broker}")


async def _execute_via_freqtrade(req: ExecuteRequest) -> dict:
    """Execute crypto trade via freqtrade REST API."""
    try:
        resp = await http_client.post(
            f"{settings.freqtrade_url}/api/v1/forcebuy",
            json={"pair": req.symbol, "price": req.entry},
            auth=(settings.freqtrade_username, settings.freqtrade_password),
        )
        resp.raise_for_status()
        return {"executed": True, "broker": "freqtrade", "result": resp.json()}
    except Exception as e:
        return {"executed": False, "broker": "freqtrade", "error": str(e)}


async def _execute_via_lumibot(req: ExecuteRequest) -> dict:
    """Execute stock trade via IBKR connector."""
    if ibkr_connector is None or not ibkr_connector.connected:
        return {
            "executed": False,
            "broker": "ibkr",
            "error": "IBKR not connected — ensure TWS/Gateway is running",
        }

    # Map direction to IBKR action
    action = "BUY" if req.direction.lower() == "long" else "SELL"

    # Calculate quantity from position_size_pct and portfolio_value
    risk_amount = req.portfolio_value * (req.position_size_pct / 100.0)
    risk_per_share = abs(req.entry - req.stop_loss)
    quantity = max(1, int(risk_amount / risk_per_share)) if risk_per_share > 0 else 1

    try:
        # Use bracket order (entry + TP + SL) when both SL and TP are provided
        if req.stop_loss and req.take_profit:
            result = await ibkr_connector.place_bracket_order(
                symbol=req.symbol,
                direction=action,
                quantity=quantity,
                entry_price=req.entry,
                take_profit=req.take_profit,
                stop_loss=req.stop_loss,
            )
        else:
            result = await ibkr_connector.place_order(
                symbol=req.symbol,
                direction=action,
                quantity=quantity,
                order_type="LMT",
                limit_price=req.entry,
            )
        return {"executed": True, "broker": "ibkr", "result": result}
    except Exception as e:
        return {"executed": False, "broker": "ibkr", "error": str(e)}


# --- Manual Trading Endpoints ---


def _require_manual():
    """Guard: raise 503 if manual trading system is not initialized."""
    if manual_executor is None:
        raise HTTPException(
            status_code=503,
            detail="Manual trading not configured — set TRADE_MANUAL_OKX_API_KEY",
        )


@app.post("/manual/propose")
async def manual_propose(req: ProposeTradeRequest):
    """
    Submit a trade proposal. Returns a callback_id to confirm within 60s.

    Auto-calculates SL (leverage-based), TP (R:R >= 2:1), and position size
    if not provided. Runs full risk checks before returning proposal.
    """
    _require_manual()
    return await manual_executor.propose_trade(
        symbol=req.symbol,
        direction=req.direction.value,
        leverage=req.leverage,
        stop_loss=req.stop_loss,
        take_profit=req.take_profit,
        size_usdt=req.size_usdt,
        mood=req.mood,
        note=req.note,
    )


@app.post("/manual/confirm/{callback_id}")
async def manual_confirm(callback_id: str):
    """
    Confirm and execute a previously proposed trade.

    Re-checks price (rejects if drift > 0.5%), places market order on OKX,
    sets SL/TP algo orders, writes to PB trade_history + trade_journal,
    and sends Telegram notification.
    """
    _require_manual()
    return await manual_executor.confirm_trade(callback_id)


@app.post("/manual/close")
async def manual_close(req: CloseTradeRequest):
    """
    Close an open manual trade by trade_id or symbol.

    Closes position on OKX, calculates realized PnL, updates PB records,
    and sends Telegram notification.
    """
    _require_manual()
    return await manual_executor.close_trade(trade_id=req.trade_id, symbol=req.symbol)


@app.get("/manual/positions")
async def manual_positions():
    """
    Get all open manual positions — live OKX data merged with PB tracking.
    """
    _require_manual()
    positions = await manual_executor.get_open_positions()
    return {"positions": positions, "count": len(positions)}


@app.get("/manual/history")
async def manual_history(limit: int = Query(default=50, ge=1, le=500)):
    """Get closed manual trade history from PocketBase."""
    _require_manual()
    trades = await manual_executor.get_history(limit=limit)
    return {"trades": trades, "count": len(trades)}


@app.get("/manual/pnl")
async def manual_pnl(days: int = Query(default=30, ge=1, le=365)):
    """Get PnL statistics for manual trades."""
    _require_manual()
    return await manual_executor.get_pnl_stats(days=days)


@app.post("/manual/mood")
async def manual_mood(req: MoodRequest):
    """Record pre/post-trade mood score (1-5). Affects position sizing if pre-trade."""
    _require_manual()
    chat_id = req.chat_id or "default"
    return await manual_executor.record_mood(chat_id, req.score, req.note)


@app.get("/manual/review")
async def manual_review(days: int = Query(default=7, ge=1, le=90)):
    """
    AI-powered review of recent manual trades.

    Analyzes patterns, risk management, mood correlations, and provides
    actionable improvement suggestions.
    """
    _require_manual()
    return await manual_executor.ai_review(
        days=days,
        http_client=http_client,
        lumigate_url=settings.lumigate_url,
        project_key=settings.lumigate_project_key,
    )


# --- WebSocket: Market Feed ---

def _placeholder_price(symbol: str) -> dict:
    """Generate placeholder price data for a symbol."""
    base = 150.0 if "/" not in symbol else 60000.0
    price = round(base + random.uniform(-5, 5), 4)
    return {
        "symbol": symbol,
        "price": price,
        "bid": round(price - random.uniform(0.01, 0.1), 4),
        "ask": round(price + random.uniform(0.01, 0.1), 4),
        "volume": random.randint(100, 50000),
    }


@app.websocket("/ws/market")
async def ws_market(
    websocket: WebSocket,
    symbols: str = Query(default="AAPL,BTC/USDT"),
):
    """
    Real-time market data feed.
    Connect with ?symbols=AAPL,BTC/USDT to subscribe.
    Pushes: price_update, signal_new, position_update, risk_alert.
    """
    await ws_manager.connect_market(websocket)
    symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
    try:
        # Send initial snapshot
        for sym in symbol_list:
            await websocket.send_json({
                "type": "price_update",
                "data": _placeholder_price(sym),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        # Continuous feed loop — also listens for client messages
        while True:
            # Push price updates every 3 seconds
            # Use wait_for so we can also detect client disconnect
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=3.0)
                # Client can send updated symbol list: {"symbols": "TSLA,ETH/USDT"}
                try:
                    payload = json.loads(msg)
                    if "symbols" in payload:
                        symbol_list = [s.strip() for s in payload["symbols"].split(",") if s.strip()]
                except (json.JSONDecodeError, AttributeError):
                    pass
            except asyncio.TimeoutError:
                pass

            for sym in symbol_list:
                await websocket.send_json({
                    "type": "price_update",
                    "data": _placeholder_price(sym),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect_market(websocket)


# --- WebSocket: Signal Feed ---

@app.websocket("/ws/signals")
async def ws_signals(websocket: WebSocket):
    """
    Real-time SMC signal feed.
    Pushes new signals as they are generated by the analysis engine.
    For now, sends placeholder signals periodically for testing.
    """
    await ws_manager.connect_signals(websocket)
    try:
        while True:
            # Placeholder: emit a synthetic signal every 10 seconds for testing
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
                # Client can send ping or config; ignored for now
            except asyncio.TimeoutError:
                pass

            placeholder_signal = {
                "symbol": random.choice(["AAPL", "BTC/USDT", "EURUSD", "SPY", "ETH/USDT"]),
                "direction": random.choice(["long", "short"]),
                "entry": round(random.uniform(100, 70000), 2),
                "stop_loss": round(random.uniform(90, 69000), 2),
                "take_profit": round(random.uniform(110, 72000), 2),
                "risk_reward": round(random.uniform(1.5, 4.0), 2),
                "confidence": round(random.uniform(0.5, 0.95), 3),
                "timeframe": random.choice(["5m", "15m", "1h", "4h", "1d"]),
                "indicators": {
                    "order_block": True,
                    "fair_value_gap": random.choice([True, False]),
                    "break_of_structure": random.choice([True, False]),
                },
            }

            await websocket.send_json({
                "type": "signal",
                "data": placeholder_signal,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect_signals(websocket)
