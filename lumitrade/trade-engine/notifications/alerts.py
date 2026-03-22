"""
LumiTrade Proactive Alert System

Monitors trading activity and pushes Telegram alerts for:
1. Daily loss approaching circuit breaker (>= 2%)
2. Losing streak (>= 3 consecutive losses)
3. Bot offline (unreachable for > 5 min)
4. Drawdown exceeding backtest max drawdown
5. FreqAI training failure detected in logs

Each alert type has an independent cooldown to prevent spam.
"""

import logging
import time
from dataclasses import dataclass, field

logger = logging.getLogger("lumitrade.alerts")


@dataclass
class AlertCooldowns:
    """Tracks last-sent timestamp per alert type to enforce cooldowns."""
    daily_loss: float = 0.0          # 30 min cooldown
    losing_streak: float = 0.0       # resets on new loss (always sends)
    bot_offline: dict = field(default_factory=dict)  # per-bot, 5 min cooldown
    drawdown: float = 0.0            # 1 hour cooldown
    freqai_fail: dict = field(default_factory=dict)  # per-bot, 1 hour cooldown

    # Last known losing streak length (only alert on NEW losses)
    _last_streak_len: int = 0


COOLDOWN_DAILY_LOSS = 30 * 60      # 30 minutes
COOLDOWN_BOT_OFFLINE = 30 * 60  # 30 minutes
COOLDOWN_DRAWDOWN = 60 * 60        # 1 hour
COOLDOWN_FREQAI_FAIL = 60 * 60     # 1 hour


class AlertManager:
    """
    Stateful alert manager. Call check methods every poll cycle;
    they return a message string if an alert should fire, or None.
    """

    def __init__(self):
        self._cd = AlertCooldowns()
        # Track bot offline start times
        self._bot_offline_since: dict[str, float] = {}

    # ------------------------------------------------------------------
    # 1. Daily loss warning (>= 2%, approaching 3% circuit breaker)
    # ------------------------------------------------------------------

    def check_daily_loss(self, loss_pct: float, daily_pnl: float, total_balance: float) -> str | None:
        """Returns alert message if daily loss >= 2% and cooldown elapsed."""
        if loss_pct < 2.0:
            return None

        now = time.time()
        if now - self._cd.daily_loss < COOLDOWN_DAILY_LOSS:
            return None

        self._cd.daily_loss = now
        remaining = 3.0 - loss_pct
        msg = (
            f"<b>Daily Loss Warning</b>\n\n"
            f"Today's loss: <b>-{loss_pct:.1f}%</b> (${abs(daily_pnl):.2f})\n"
            f"Circuit breaker at 3% — only <b>{remaining:.1f}%</b> remaining\n"
            f"Balance: ${total_balance:.2f}"
        )
        logger.warning("Daily loss alert: -%.1f%% (PnL=$%.2f)", loss_pct, daily_pnl)
        return msg

    # ------------------------------------------------------------------
    # 2. Losing streak (>= 3 consecutive losses)
    # ------------------------------------------------------------------

    def check_losing_streak(self, trades: list[dict]) -> str | None:
        """
        Detect consecutive losing trades from recent trade history.
        trades: list of trade dicts with 'profit_abs' or 'close_profit' field.
        Returns alert if streak >= 3 and streak grew since last check.
        """
        if not trades:
            return None

        # Sort by close_date descending (most recent first)
        sorted_trades = sorted(
            trades,
            key=lambda t: t.get("close_date", "") or "",
            reverse=True,
        )

        streak = 0
        for t in sorted_trades:
            profit = t.get("profit_abs", t.get("close_profit_abs", 0.0))
            if profit is not None and profit < 0:
                streak += 1
            else:
                break

        if streak < 3:
            self._cd._last_streak_len = streak
            return None

        # Only alert if streak grew (new loss added)
        if streak <= self._cd._last_streak_len:
            return None

        self._cd._last_streak_len = streak

        # Compute total loss in the streak
        total_loss = 0.0
        for i, t in enumerate(sorted_trades):
            if i >= streak:
                break
            total_loss += abs(t.get("profit_abs", t.get("close_profit_abs", 0.0)) or 0.0)

        msg = (
            f"<b>Losing Streak Alert</b>\n\n"
            f"<b>{streak}</b> consecutive losses (total -${total_loss:.2f})\n"
            f"Consider pausing to review strategy."
        )
        logger.warning("Losing streak alert: %d consecutive losses", streak)
        return msg

    # ------------------------------------------------------------------
    # 3. Bot offline (unreachable)
    # ------------------------------------------------------------------

    def check_bot_offline(self, bot_name: str, is_online: bool) -> str | None:
        """
        Track bot connectivity. Alert if offline for > 5 minutes.
        Call once per bot per poll cycle.
        """
        now = time.time()

        if is_online:
            # Bot came back — clear tracking
            if bot_name in self._bot_offline_since:
                del self._bot_offline_since[bot_name]
            return None

        # Bot is offline — record start time
        if bot_name not in self._bot_offline_since:
            self._bot_offline_since[bot_name] = now
            return None  # Just went offline, wait before alerting

        offline_duration = now - self._bot_offline_since[bot_name]
        if offline_duration < 5 * 60:
            return None  # Not long enough yet

        # Check cooldown per bot
        last_alert = self._cd.bot_offline.get(bot_name, 0.0)
        if now - last_alert < COOLDOWN_BOT_OFFLINE:
            return None

        self._cd.bot_offline[bot_name] = now
        minutes = int(offline_duration / 60)
        msg = (
            f"<b>Bot Offline</b>\n\n"
            f"<b>{bot_name}</b> unreachable for {minutes} minutes.\n"
            f"Check container status and network."
        )
        logger.warning("Bot offline alert: %s (offline %d min)", bot_name, minutes)
        return msg

    # ------------------------------------------------------------------
    # 4. Drawdown exceeds backtest max drawdown
    # ------------------------------------------------------------------

    def check_drawdown(
        self,
        current_drawdown_pct: float,
        backtest_max_dd_pct: float,
    ) -> str | None:
        """
        Alert if live drawdown exceeds the backtest maximum drawdown.
        Both values should be positive percentages.
        """
        if backtest_max_dd_pct <= 0:
            return None  # No baseline available
        if current_drawdown_pct <= backtest_max_dd_pct:
            return None

        now = time.time()
        if now - self._cd.drawdown < COOLDOWN_DRAWDOWN:
            return None

        self._cd.drawdown = now
        excess = current_drawdown_pct - backtest_max_dd_pct
        msg = (
            f"<b>Drawdown Exceeded Backtest</b>\n\n"
            f"Live drawdown: <b>-{current_drawdown_pct:.1f}%</b>\n"
            f"Backtest max: <b>-{backtest_max_dd_pct:.1f}%</b>\n"
            f"Exceeds by {excess:.1f}% — review risk exposure."
        )
        logger.warning(
            "Drawdown alert: live -%.1f%% > backtest max -%.1f%%",
            current_drawdown_pct, backtest_max_dd_pct,
        )
        return msg

    # ------------------------------------------------------------------
    # 5. FreqAI training failure
    # ------------------------------------------------------------------

    def check_freqai_failure(self, bot_name: str, log_entries: list[dict]) -> str | None:
        """
        Scan bot log entries for FreqAI training errors.
        log_entries: list of {"message": str, "timestamp": str, ...}
        """
        if not log_entries:
            return None

        now = time.time()
        last_alert = self._cd.freqai_fail.get(bot_name, 0.0)
        if now - last_alert < COOLDOWN_FREQAI_FAIL:
            return None

        error_keywords = [
            "freqai training failed",
            "freqai error",
            "could not train",
            "training exception",
            "model training error",
            "lightgbm error",
            "catboost error",
            "xgboost error",
        ]

        for entry in log_entries:
            # freqtrade /api/v1/logs returns list of [timestamp, message] or {"message": ...}
            if isinstance(entry, list) and len(entry) >= 2:
                msg_text = str(entry[1]).lower()
            elif isinstance(entry, dict):
                msg_text = str(entry.get("message", "")).lower()
            else:
                continue

            for kw in error_keywords:
                if kw in msg_text:
                    self._cd.freqai_fail[bot_name] = now
                    # Extract relevant portion of the log message
                    raw = entry[1] if isinstance(entry, list) else entry.get("message", "")
                    # Truncate long messages
                    snippet = raw[:200] if len(raw) > 200 else raw
                    msg = (
                        f"<b>FreqAI Training Failed</b>\n\n"
                        f"Bot: <b>{bot_name}</b>\n"
                        f"Error: <code>{snippet}</code>"
                    )
                    logger.warning("FreqAI failure alert: %s — %s", bot_name, snippet[:80])
                    return msg

        return None
