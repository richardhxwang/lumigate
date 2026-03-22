"""
Manual Trade Executor — full lifecycle management for manual trades.

Flow:
  propose_trade() -> TradeProposal (60s TTL)
  confirm_trade(callback_id) -> execute on OKX + PB records
  close_trade(trade_id | symbol) -> close on OKX + PB update + PnL
  get_open_positions() -> OKX positions merged with PB data
  record_mood() -> PB mood log
  ai_review() -> fetch recent trades, build prompt, call AI
"""

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from manual.models import (
    TradeProposal,
    OpenTrade,
    TradeDirection,
)
from manual.risk import ManualRiskManager
from connectors.okx_manual import OKXManualConnector

logger = logging.getLogger("lumitrade.manual_executor")

PROPOSAL_TTL_SECONDS = 60
PRICE_DRIFT_MAX_PCT = 0.5


class ManualTradeExecutor:
    """
    Manages the full manual trade lifecycle:
    propose -> confirm -> monitor -> close.
    """

    def __init__(
        self,
        okx_connector: OKXManualConnector,
        risk_manager: ManualRiskManager,
        telegram_notifier,
        pb_post,
        pb_patch,
        pb_get,
    ):
        self.okx = okx_connector
        self.risk = risk_manager
        self.telegram = telegram_notifier
        self._pb_post = pb_post
        self._pb_patch = pb_patch
        self._pb_get = pb_get

        self._pending: dict[str, TradeProposal] = {}  # callback_id -> proposal
        self._open: dict[str, OpenTrade] = {}          # pb_record_id -> OpenTrade
        self._daily_pnl: float = 0.0
        self._mood_cache: dict[str, tuple[int, float]] = {}  # chat_id -> (score, timestamp)

    # ------------------------------------------------------------------
    # 1. Propose trade
    # ------------------------------------------------------------------

    async def propose_trade(
        self,
        symbol: str,
        direction: str,
        leverage: float,
        stop_loss: Optional[float] = None,
        take_profit: Optional[float] = None,
        size_usdt: Optional[float] = None,
        mood: Optional[int] = None,
        note: Optional[str] = None,
    ) -> dict:
        """
        Build a trade proposal with risk checks.

        Steps:
          1. Fetch current price from OKX
          2. Auto-calculate SL if not provided (leverage-based)
          3. Auto-calculate TP if not provided (R:R >= 2:1)
          4. Run risk checks (position/daily loss/leverage/liquidation/mood)
          5. Calculate position size
          6. Return proposal with 60s expiry

        Returns:
            dict with ok, callback_id, proposal, or error info
        """
        # Clean up expired proposals
        self._cleanup_expired()

        # 1. Get current price
        try:
            ticker = await self.okx.get_ticker(symbol)
            entry_price = ticker["last"]
            if not entry_price or entry_price <= 0:
                return {"ok": False, "error": f"Invalid price for {symbol}: {entry_price}"}
        except Exception as e:
            return {"ok": False, "error": f"Failed to fetch price for {symbol}: {e}"}

        # 2. Auto SL
        if stop_loss is None:
            stop_loss = self.risk.auto_stop_loss(entry_price, direction, leverage)
            logger.info("Auto SL for %s %s at %.1fx: %.8f", symbol, direction, leverage, stop_loss)

        # 3. Auto TP (R:R >= 2:1)
        if take_profit is None:
            take_profit = self.risk.auto_take_profit(entry_price, stop_loss, direction)
            logger.info("Auto TP for %s %s: %.8f (R:R 2:1)", symbol, direction, take_profit)

        # 4. Get balance for position sizing
        try:
            balance_info = await self.okx.get_balance()
            portfolio_value = balance_info.get("total", 0.0)
            if portfolio_value <= 0:
                return {"ok": False, "error": "Account balance is zero — cannot size position"}
        except Exception as e:
            return {"ok": False, "error": f"Failed to fetch balance: {e}"}

        # 5. Calculate position size
        if size_usdt is None:
            sizing = self.risk.calculate_position_size(
                balance=portfolio_value,
                entry=entry_price,
                stop_loss=stop_loss,
                leverage=leverage,
                mood=mood,
            )
            if sizing.get("error"):
                return {"ok": False, "error": sizing["error"]}
            size_usdt = sizing["size_usdt"]
            size_contracts = sizing["size_contracts"]
            position_pct = sizing["position_pct"]
            risk_usd = sizing["risk_usd"]
        else:
            # User specified size — compute derived values
            size_contracts = size_usdt / entry_price if entry_price > 0 else 0
            margin = size_usdt / leverage
            position_pct = (margin / portfolio_value * 100) if portfolio_value > 0 else 0
            risk_per_unit = abs(entry_price - stop_loss)
            risk_usd = size_contracts * risk_per_unit

        # 6. Risk checks
        risk_result = self.risk.check(
            symbol=symbol,
            direction=direction,
            entry=entry_price,
            stop_loss=stop_loss,
            take_profit=take_profit,
            position_pct=position_pct,
            portfolio_value=portfolio_value,
            leverage=leverage,
            mood=mood,
        )

        if not risk_result["passed"]:
            failed = [c for c in risk_result["checks"] if not c["passed"]]
            return {
                "ok": False,
                "error": "Risk check failed",
                "failed_checks": failed,
                "warnings": risk_result.get("warnings", []),
            }

        # Compute reward
        if direction.lower() == "long":
            reward_usd = size_contracts * (take_profit - entry_price)
        else:
            reward_usd = size_contracts * (entry_price - take_profit)

        # 7. Build proposal
        now = datetime.now(timezone.utc)
        proposal = TradeProposal(
            symbol=symbol,
            direction=TradeDirection(direction.lower()),
            leverage=leverage,
            entry_price=entry_price,
            stop_loss=stop_loss,
            take_profit=take_profit,
            size_usdt=round(size_usdt, 2),
            size_contracts=round(size_contracts, 8),
            risk_usd=round(risk_usd, 2),
            reward_usd=round(reward_usd, 2),
            risk_reward=risk_result["risk_reward_ratio"],
            position_pct=round(position_pct, 4),
            portfolio_value=round(portfolio_value, 2),
            mood=mood,
            note=note,
            risk_checks=risk_result["checks"],
            created_at=now,
            expires_at=now + timedelta(seconds=PROPOSAL_TTL_SECONDS),
        )

        self._pending[proposal.callback_id] = proposal
        logger.info(
            "Trade proposed: %s %s %s lev=%.0fx size=$%.2f SL=%.4f TP=%.4f R:R=%.2f [%s]",
            proposal.callback_id, direction, symbol, leverage,
            size_usdt, stop_loss, take_profit, risk_result["risk_reward_ratio"],
            f"expires in {PROPOSAL_TTL_SECONDS}s",
        )

        return {
            "ok": True,
            "callback_id": proposal.callback_id,
            "proposal": proposal.model_dump(mode="json"),
            "warnings": risk_result.get("warnings", []),
            "message": f"Confirm within {PROPOSAL_TTL_SECONDS}s via POST /manual/confirm/{proposal.callback_id}",
        }

    # ------------------------------------------------------------------
    # 2. Confirm trade
    # ------------------------------------------------------------------

    async def confirm_trade(self, callback_id: str) -> dict:
        """
        Execute a previously proposed trade.

        Steps:
          1. Check proposal exists and not expired
          2. Re-fetch price, reject if drift > 0.5%
          3. Set leverage on OKX
          4. Place market order
          5. Place SL/TP orders
          6. Write trade_history to PB (source=manual)
          7. Write trade_journal entry to PB
          8. Notify via Telegram
          9. Track in _open dict

        Returns:
            dict with ok, trade_id, order_id, details
        """
        # 1. Check proposal
        proposal = self._pending.get(callback_id)
        if proposal is None:
            return {"ok": False, "error": "Proposal not found — may have expired"}

        if proposal.is_expired:
            del self._pending[callback_id]
            return {"ok": False, "error": "Proposal expired — re-propose required"}

        # 2. Price drift check
        try:
            ticker = await self.okx.get_ticker(proposal.symbol)
            current_price = ticker["last"]
        except Exception as e:
            return {"ok": False, "error": f"Failed to re-check price: {e}"}

        drift = self.risk.check_price_drift(proposal.entry_price, current_price, PRICE_DRIFT_MAX_PCT)
        if not drift["passed"]:
            del self._pending[callback_id]
            return {
                "ok": False,
                "error": drift["detail"],
                "drift": drift,
            }

        # Use current price as actual entry
        actual_entry = current_price

        # 3 + 4. Place market order (set_leverage is called inside)
        try:
            order_result = await self.okx.place_market_order(
                symbol=proposal.symbol,
                direction=proposal.direction.value,
                amount=proposal.size_contracts,
                leverage=int(proposal.leverage),
            )
        except Exception as e:
            logger.error("Order execution failed for %s: %s", callback_id, e)
            return {"ok": False, "error": f"Order execution failed: {e}"}

        order_id = order_result.get("order_id")
        fill_price = order_result.get("price") or actual_entry

        # 5. Place SL/TP
        sl_tp_result = {"sl_order_id": None, "tp_order_id": None}
        try:
            sl_tp_result = await self.okx.place_sl_tp_orders(
                symbol=proposal.symbol,
                direction=proposal.direction.value,
                amount=proposal.size_contracts,
                stop_loss=proposal.stop_loss,
                take_profit=proposal.take_profit,
            )
        except Exception as e:
            logger.warning("SL/TP placement failed (position still open): %s", e)

        # Remove from pending
        del self._pending[callback_id]

        # 6. Write trade_history to PB
        now_iso = datetime.now(timezone.utc).isoformat()
        pb_record = {
            "pair": proposal.symbol,
            "direction": proposal.direction.value,
            "entry_price": fill_price,
            "stop_loss": proposal.stop_loss,
            "take_profit": proposal.take_profit,
            "leverage": proposal.leverage,
            "size_usdt": proposal.size_usdt,
            "size_contracts": proposal.size_contracts,
            "order_id": order_id or "",
            "sl_order_id": sl_tp_result.get("sl_order_id") or "",
            "tp_order_id": sl_tp_result.get("tp_order_id") or "",
            "status": "open",
            "source": "manual",
            "mood": proposal.mood or 0,
            "note": proposal.note or "",
            "opened_at": now_iso,
            "portfolio_value": proposal.portfolio_value,
            "risk_usd": proposal.risk_usd,
            "risk_reward": proposal.risk_reward,
        }

        pb_record_id = None
        try:
            resp = await self._pb_post("/api/collections/trade_history/records", pb_record)
            if resp.status_code in (200, 201):
                pb_data = resp.json()
                pb_record_id = pb_data.get("id")
                logger.info("Trade saved to PB: %s", pb_record_id)
            else:
                logger.warning("PB trade_history write failed: %s %s", resp.status_code, resp.text)
        except Exception as e:
            logger.warning("PB trade_history write error: %s", e)

        # 7. Write trade_journal entry
        try:
            journal_record = {
                "pair": proposal.symbol,
                "direction": proposal.direction.value,
                "entry_price": fill_price,
                "stop_loss": proposal.stop_loss,
                "take_profit": proposal.take_profit,
                "leverage": proposal.leverage,
                "mood_pre": proposal.mood or 0,
                "note": proposal.note or f"Manual {proposal.direction.value} {proposal.symbol} at {fill_price}",
                "source": "manual",
                "trade_history_id": pb_record_id or "",
                "opened_at": now_iso,
            }
            await self._pb_post("/api/collections/trade_journal/records", journal_record)
        except Exception as e:
            logger.warning("PB trade_journal write error: %s", e)

        # 8. Telegram notification
        try:
            msg = (
                f"<b>Manual Trade Opened</b>\n"
                f"Pair: <b>{proposal.symbol}</b>\n"
                f"Direction: <b>{proposal.direction.value.upper()}</b>\n"
                f"Leverage: {proposal.leverage:.0f}x\n"
                f"Entry: {fill_price}\n"
                f"SL: {proposal.stop_loss} | TP: {proposal.take_profit}\n"
                f"Size: ${proposal.size_usdt:.2f}\n"
                f"R:R: {proposal.risk_reward:.2f}\n"
                f"Risk: ${proposal.risk_usd:.2f}"
            )
            await self.telegram.send(msg)
        except Exception:
            pass  # non-critical

        # 9. Track in _open
        trade = OpenTrade(
            trade_id=pb_record_id or callback_id,
            symbol=proposal.symbol,
            direction=proposal.direction,
            leverage=proposal.leverage,
            entry_price=fill_price,
            stop_loss=proposal.stop_loss,
            take_profit=proposal.take_profit,
            size_usdt=proposal.size_usdt,
            size_contracts=proposal.size_contracts,
            order_id=order_id,
            sl_order_id=sl_tp_result.get("sl_order_id"),
            tp_order_id=sl_tp_result.get("tp_order_id"),
            pb_record_id=pb_record_id,
        )
        self._open[trade.trade_id] = trade

        return {
            "ok": True,
            "trade_id": pb_record_id,
            "order_id": order_id,
            "fill_price": fill_price,
            "message": f"Trade executed: {proposal.direction.value.upper()} {proposal.symbol} at {fill_price}",
            "details": {
                "symbol": proposal.symbol,
                "direction": proposal.direction.value,
                "leverage": proposal.leverage,
                "entry": fill_price,
                "sl": proposal.stop_loss,
                "tp": proposal.take_profit,
                "size_usdt": proposal.size_usdt,
                "risk_usd": proposal.risk_usd,
                "rr": proposal.risk_reward,
                "sl_order_id": sl_tp_result.get("sl_order_id"),
                "tp_order_id": sl_tp_result.get("tp_order_id"),
            },
        }

    # ------------------------------------------------------------------
    # 3. Close trade
    # ------------------------------------------------------------------

    async def close_trade(self, trade_id: Optional[str] = None, symbol: Optional[str] = None) -> dict:
        """
        Close an open manual trade.

        Steps:
          1. Find trade in _open (by trade_id or symbol)
          2. Close position on OKX
          3. Calculate realized PnL
          4. Update PB trade_history (exit data)
          5. Update PB trade_journal (AI summary placeholder)
          6. Update daily PnL tracker
          7. Telegram notification

        Returns:
            dict with ok, pnl_usdt, pnl_pct, message
        """
        # 1. Find trade
        trade = None
        if trade_id and trade_id in self._open:
            trade = self._open[trade_id]
        elif symbol:
            for t in self._open.values():
                if t.symbol == symbol:
                    trade = t
                    break

        if trade is None:
            # Try to close directly on OKX by symbol
            if symbol:
                return await self._close_by_symbol(symbol)
            return {"ok": False, "error": "Trade not found — provide trade_id or symbol"}

        # 2. Close on OKX
        try:
            close_result = await self.okx.close_position(
                symbol=trade.symbol,
                direction=trade.direction.value,
                amount=trade.size_contracts,
            )
            if not close_result.get("closed"):
                return {"ok": False, "error": close_result.get("error", "Close failed")}
        except Exception as e:
            return {"ok": False, "error": f"OKX close failed: {e}"}

        exit_price = close_result.get("price", 0.0)

        # 3. Calculate PnL
        if trade.direction == TradeDirection.LONG:
            pnl_per_unit = exit_price - trade.entry_price
        else:
            pnl_per_unit = trade.entry_price - exit_price

        pnl_usdt = pnl_per_unit * trade.size_contracts
        pnl_pct = (pnl_per_unit / trade.entry_price * 100) if trade.entry_price > 0 else 0
        # Leverage amplifies PnL percentage on margin
        pnl_pct_leveraged = pnl_pct * trade.leverage

        # 4. Update PB trade_history
        now_iso = datetime.now(timezone.utc).isoformat()
        if trade.pb_record_id:
            try:
                await self._pb_patch(
                    f"/api/collections/trade_history/records/{trade.pb_record_id}",
                    {
                        "exit_price": exit_price,
                        "pnl_usdt": round(pnl_usdt, 4),
                        "pnl_pct": round(pnl_pct_leveraged, 4),
                        "status": "closed",
                        "closed_at": now_iso,
                    },
                )
            except Exception as e:
                logger.warning("PB trade_history update error: %s", e)

        # 5. Update PB trade_journal
        if trade.pb_record_id:
            try:
                # Find journal entry by trade_history_id
                resp = await self._pb_get(
                    "/api/collections/trade_journal/records",
                    params={"filter": f'trade_history_id="{trade.pb_record_id}"', "perPage": 1},
                )
                if resp.status_code == 200:
                    items = resp.json().get("items", [])
                    if items:
                        journal_id = items[0]["id"]
                        outcome = "win" if pnl_usdt > 0 else "loss"
                        await self._pb_patch(
                            f"/api/collections/trade_journal/records/{journal_id}",
                            {
                                "exit_price": exit_price,
                                "pnl_usdt": round(pnl_usdt, 4),
                                "outcome": outcome,
                                "closed_at": now_iso,
                                "ai_summary": f"Manual {trade.direction.value} {trade.symbol}: "
                                              f"{'profit' if pnl_usdt > 0 else 'loss'} "
                                              f"${abs(pnl_usdt):.2f} ({pnl_pct_leveraged:+.2f}%)",
                            },
                        )
            except Exception as e:
                logger.warning("PB trade_journal update error: %s", e)

        # 6. Update daily PnL
        self.risk.record_pnl(pnl_usdt)
        self._daily_pnl += pnl_usdt

        # 7. Telegram
        try:
            emoji = "PROFIT" if pnl_usdt > 0 else "LOSS"
            msg = (
                f"<b>Manual Trade Closed — {emoji}</b>\n"
                f"Pair: <b>{trade.symbol}</b>\n"
                f"Direction: {trade.direction.value.upper()}\n"
                f"Entry: {trade.entry_price} -> Exit: {exit_price}\n"
                f"PnL: <b>${pnl_usdt:+.2f}</b> ({pnl_pct_leveraged:+.2f}%)\n"
                f"Leverage: {trade.leverage:.0f}x"
            )
            await self.telegram.send(msg)
        except Exception:
            pass

        # Remove from _open
        self._open.pop(trade.trade_id, None)

        logger.info(
            "Trade closed: %s %s PnL=$%.2f (%.2f%%)",
            trade.symbol, trade.direction.value, pnl_usdt, pnl_pct_leveraged,
        )

        return {
            "ok": True,
            "pnl_usdt": round(pnl_usdt, 4),
            "pnl_pct": round(pnl_pct_leveraged, 4),
            "exit_price": exit_price,
            "message": f"Closed {trade.direction.value} {trade.symbol}: ${pnl_usdt:+.2f} ({pnl_pct_leveraged:+.2f}%)",
        }

    async def _close_by_symbol(self, symbol: str) -> dict:
        """Fallback: close position on OKX even if not tracked in _open."""
        # Try both directions
        for direction in ("long", "short"):
            try:
                result = await self.okx.close_position(symbol, direction)
                if result.get("closed"):
                    logger.info("Closed untracked %s %s position", direction, symbol)
                    return {
                        "ok": True,
                        "pnl_usdt": 0.0,
                        "pnl_pct": 0.0,
                        "exit_price": result.get("price", 0),
                        "message": f"Closed {direction} {symbol} (untracked — PnL not calculated)",
                    }
            except Exception:
                continue
        return {"ok": False, "error": f"No open position found for {symbol}"}

    # ------------------------------------------------------------------
    # 4. Get open positions
    # ------------------------------------------------------------------

    async def get_open_positions(self) -> list[dict]:
        """
        Get all open positions — merges OKX data with PB records.
        """
        positions = []

        # Get live positions from OKX
        try:
            okx_positions = await self.okx.get_positions()
        except Exception as e:
            logger.warning("Failed to fetch OKX positions: %s", e)
            okx_positions = []

        # Build lookup from _open tracking
        tracked = {t.symbol: t for t in self._open.values()}

        for pos in okx_positions:
            symbol = pos.get("symbol", "")
            track = tracked.get(symbol)
            entry = pos.get("entry_price", 0)
            mark = pos.get("mark_price", 0)

            position_data = {
                "symbol": symbol,
                "direction": pos.get("side", ""),
                "leverage": pos.get("leverage", 1),
                "entry_price": entry,
                "current_price": mark,
                "unrealized_pnl": pos.get("unrealized_pnl", 0),
                "unrealized_pnl_pct": pos.get("percentage", 0),
                "size_usdt": pos.get("notional", 0),
                "contracts": pos.get("contracts", 0),
                "liquidation_price": pos.get("liquidation_price", 0),
                "margin_mode": pos.get("margin_mode", ""),
                "source": "manual" if track else "unknown",
            }

            # Merge tracked data (SL/TP, PB ID, etc.)
            if track:
                position_data.update({
                    "stop_loss": track.stop_loss,
                    "take_profit": track.take_profit,
                    "trade_id": track.trade_id,
                    "pb_record_id": track.pb_record_id,
                    "opened_at": track.opened_at.isoformat(),
                })

            positions.append(position_data)

        return positions

    # ------------------------------------------------------------------
    # 5. Trade history (from PB)
    # ------------------------------------------------------------------

    async def get_history(self, limit: int = 50) -> list[dict]:
        """Get closed manual trades from PocketBase."""
        try:
            resp = await self._pb_get(
                "/api/collections/trade_history/records",
                params={
                    "filter": 'source="manual"',
                    "perPage": limit,
                },
            )
            if resp.status_code == 200:
                return resp.json().get("items", [])
        except Exception as e:
            logger.warning("Failed to fetch trade history: %s", e)
        return []

    # ------------------------------------------------------------------
    # 6. PnL statistics
    # ------------------------------------------------------------------

    async def get_pnl_stats(self, days: int = 30) -> dict:
        """Calculate PnL statistics from PB trade_history."""
        try:
            resp = await self._pb_get(
                "/api/collections/trade_history/records",
                params={
                    "filter": f'source="manual" && status="closed"',
                    "perPage": 500,
                },
            )
            if resp.status_code != 200:
                return {"error": "Failed to fetch trades"}

            trades = resp.json().get("items", [])
        except Exception as e:
            return {"error": str(e)}

        if not trades:
            return {
                "total_trades": 0,
                "total_pnl": 0,
                "win_rate": 0,
                "avg_pnl": 0,
                "best_trade": 0,
                "worst_trade": 0,
                "daily_stats": self.risk.get_daily_stats(),
            }

        pnls = [float(t.get("pnl_usdt", 0)) for t in trades]
        wins = [p for p in pnls if p > 0]
        losses = [p for p in pnls if p < 0]

        return {
            "total_trades": len(trades),
            "total_pnl": round(sum(pnls), 2),
            "win_rate": round(len(wins) / len(trades) * 100, 2) if trades else 0,
            "avg_pnl": round(sum(pnls) / len(pnls), 2) if pnls else 0,
            "avg_win": round(sum(wins) / len(wins), 2) if wins else 0,
            "avg_loss": round(sum(losses) / len(losses), 2) if losses else 0,
            "best_trade": round(max(pnls), 2) if pnls else 0,
            "worst_trade": round(min(pnls), 2) if pnls else 0,
            "wins": len(wins),
            "losses": len(losses),
            "daily_stats": self.risk.get_daily_stats(),
        }

    # ------------------------------------------------------------------
    # 7. Mood tracking
    # ------------------------------------------------------------------

    async def record_mood(self, chat_id: str, score: int, note: str = "") -> dict:
        """Record mood to PB and cache."""
        now = datetime.now(timezone.utc)
        self._mood_cache[chat_id] = (score, now.timestamp())

        try:
            resp = await self._pb_post("/api/collections/trade_mood_logs/records", {
                "score": score,
                "note": note,
                "source": "manual",
                "recorded_at": now.isoformat(),
            })
            if resp.status_code in (200, 201):
                return {"ok": True, "score": score, "message": f"Mood recorded: {score}/5"}
            else:
                return {"ok": False, "error": f"PB write failed: {resp.status_code}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_cached_mood(self, chat_id: str, max_age_seconds: int = 3600) -> Optional[int]:
        """Get cached mood score if recent enough."""
        if chat_id not in self._mood_cache:
            return None
        score, ts = self._mood_cache[chat_id]
        if time.time() - ts > max_age_seconds:
            return None
        return score

    # ------------------------------------------------------------------
    # 8. AI Review
    # ------------------------------------------------------------------

    async def ai_review(self, days: int = 7, http_client=None, lumigate_url: str = "", project_key: str = "") -> dict:
        """
        Generate AI review of recent manual trades.

        Fetches recent trades from PB, builds analysis prompt,
        calls LumiGate for AI response.
        """
        # Fetch recent manual trades
        try:
            resp = await self._pb_get(
                "/api/collections/trade_history/records",
                params={
                    "filter": f'source="manual"',
                    "perPage": 100,
                },
            )
            if resp.status_code != 200:
                return {"ok": False, "error": "Failed to fetch trades for review"}
            trades = resp.json().get("items", [])
        except Exception as e:
            return {"ok": False, "error": str(e)}

        if not trades:
            return {"ok": True, "review": "No manual trades found in the specified period."}

        # Fetch mood logs
        mood_logs = []
        try:
            mood_resp = await self._pb_get(
                "/api/collections/trade_mood_logs/records",
                params={"perPage": 50},
            )
            if mood_resp.status_code == 200:
                mood_logs = mood_resp.json().get("items", [])
        except Exception:
            pass

        # Build review prompt
        trade_summary = []
        for t in trades:
            pnl = t.get("pnl_usdt", 0)
            status = t.get("status", "unknown")
            trade_summary.append(
                f"- {t.get('pair', '?')} {t.get('direction', '?').upper()} "
                f"lev={t.get('leverage', 1)}x "
                f"entry={t.get('entry_price', '?')} "
                f"{'exit=' + str(t.get('exit_price', '?')) + ' ' if status == 'closed' else ''}"
                f"PnL=${pnl:+.2f} "
                f"R:R={t.get('risk_reward', '?')} "
                f"status={status} "
                f"mood={t.get('mood', '?')}"
            )

        mood_summary = ""
        if mood_logs:
            scores = [m.get("score", 3) for m in mood_logs]
            avg_mood = sum(scores) / len(scores)
            mood_summary = f"\nAverage mood: {avg_mood:.1f}/5 over {len(scores)} entries."

        prompt = (
            f"You are a trading performance coach. Analyze these recent manual trades "
            f"and provide actionable feedback.\n\n"
            f"Trades (last {days} days):\n"
            + "\n".join(trade_summary)
            + mood_summary
            + "\n\nProvide:\n"
            "1. Overall performance assessment\n"
            "2. Pattern analysis (common mistakes, strengths)\n"
            "3. Risk management evaluation\n"
            "4. Mood correlation with trade outcomes\n"
            "5. Specific actionable improvements\n"
            "Keep it concise but direct."
        )

        # Call AI via LumiGate if available
        if http_client and lumigate_url:
            try:
                headers = {"Content-Type": "application/json"}
                if project_key:
                    headers["X-Project-Key"] = project_key

                ai_resp = await http_client.post(
                    f"{lumigate_url}/v1/openai/chat/completions",
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": 1500,
                    },
                    headers=headers,
                    timeout=30.0,
                )
                if ai_resp.status_code == 200:
                    data = ai_resp.json()
                    review_text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                    return {"ok": True, "review": review_text, "trade_count": len(trades)}
            except Exception as e:
                logger.warning("AI review call failed: %s", e)

        # Fallback: return raw data for manual review
        return {
            "ok": True,
            "review": "AI review unavailable — returning raw trade data for manual review.",
            "trades": trade_summary,
            "trade_count": len(trades),
            "mood_summary": mood_summary,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _cleanup_expired(self):
        """Remove expired proposals."""
        expired = [k for k, v in self._pending.items() if v.is_expired]
        for k in expired:
            del self._pending[k]
        if expired:
            logger.debug("Cleaned up %d expired proposals", len(expired))

    def get_pending_count(self) -> int:
        self._cleanup_expired()
        return len(self._pending)

    def get_open_count(self) -> int:
        return len(self._open)
