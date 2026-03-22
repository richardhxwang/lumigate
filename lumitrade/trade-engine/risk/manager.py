"""
LumiTrade Risk Management Engine

Enforces non-negotiable trading rules before any order is placed.
All checks must pass for a trade to be approved.
"""

import logging
from datetime import date
from dataclasses import dataclass, field

logger = logging.getLogger("lumitrade.risk")


@dataclass
class RiskSettings:
    max_position_pct: float = 2.0          # max single position as % of portfolio
    max_daily_loss_pct: float = 3.0        # circuit breaker threshold
    max_open_positions: int = 5
    min_risk_reward: float = 2.0           # minimum R:R ratio
    news_blackout_minutes: int = 30        # minutes around high-impact news
    auto_exec_max_pct: float = 1.0         # max position % for auto-execution
    max_leverage: float = 5.0              # global leverage ceiling
    max_notional_pct: float = 10.0         # max notional exposure % (position * leverage)
    min_liquidation_distance: float = 0.12 # minimum distance to liquidation (12%)


class RiskManager:
    """Strict risk gatekeeper. Every trade proposal must pass all checks."""

    def __init__(self, settings: RiskSettings | None = None):
        self.settings = settings or RiskSettings()
        self._open_positions: set[str] = set()
        self._daily_pnl: dict[str, float] = {}  # date_str -> realized P&L in USD

    # ------------------------------------------------------------------
    # Core check
    # ------------------------------------------------------------------

    def check(
        self,
        symbol: str,
        direction: str,
        entry: float,
        stop_loss: float,
        take_profit: float,
        position_size_pct: float,
        portfolio_value: float,
        leverage: float = 1.0,
    ) -> dict:
        """
        Run all risk checks against a proposed trade.

        Args:
            symbol: Ticker / instrument identifier
            direction: "long" or "short"
            entry: Planned entry price
            stop_loss: Stop-loss price
            take_profit: Take-profit price
            position_size_pct: Proposed position size as % of portfolio
            portfolio_value: Current total portfolio value in USD
            leverage: Leverage multiplier (default 1.0 for spot)

        Returns:
            dict with passed (bool), checks list, and computed metrics.
        """
        direction = direction.lower()
        checks: list[dict] = []

        # --- 1. Position size ---
        pos_ok = position_size_pct <= self.settings.max_position_pct
        checks.append({
            "rule": "position_size",
            "passed": pos_ok,
            "detail": (
                f"{position_size_pct:.2f}% <= {self.settings.max_position_pct:.2f}% limit"
                if pos_ok
                else f"{position_size_pct:.2f}% exceeds {self.settings.max_position_pct:.2f}% max position limit"
            ),
        })
        if not pos_ok:
            logger.warning(
                "REJECTED %s %s: position size %.2f%% > %.2f%% limit",
                direction, symbol, position_size_pct, self.settings.max_position_pct,
            )

        # --- 2. Risk / Reward ---
        if direction == "long":
            risk_per_unit = entry - stop_loss
            reward_per_unit = take_profit - entry
        else:  # short
            risk_per_unit = stop_loss - entry
            reward_per_unit = entry - take_profit

        if risk_per_unit <= 0:
            rr_ratio = 0.0
            rr_ok = False
            rr_detail = f"Invalid stop-loss: risk per unit <= 0 (entry={entry}, sl={stop_loss})"
        elif reward_per_unit <= 0:
            rr_ratio = 0.0
            rr_ok = False
            rr_detail = f"Invalid take-profit: reward per unit <= 0 (entry={entry}, tp={take_profit})"
        else:
            rr_ratio = reward_per_unit / risk_per_unit
            rr_ok = rr_ratio >= self.settings.min_risk_reward
            rr_detail = (
                f"R:R {rr_ratio:.2f} >= {self.settings.min_risk_reward:.2f} minimum"
                if rr_ok
                else f"R:R {rr_ratio:.2f} below {self.settings.min_risk_reward:.2f} minimum"
            )

        checks.append({"rule": "risk_reward", "passed": rr_ok, "detail": rr_detail})
        if not rr_ok:
            logger.warning("REJECTED %s %s: %s", direction, symbol, rr_detail)

        # --- 3. Daily loss / circuit breaker ---
        cb_active = self.is_circuit_breaker_active(portfolio_value)
        dl_ok = not cb_active
        today_pnl = self._daily_pnl.get(str(date.today()), 0.0)
        daily_loss_pct = abs(min(today_pnl, 0.0)) / portfolio_value * 100 if portfolio_value > 0 else 0.0
        checks.append({
            "rule": "daily_loss",
            "passed": dl_ok,
            "detail": (
                f"Daily loss {daily_loss_pct:.2f}% within {self.settings.max_daily_loss_pct:.2f}% limit"
                if dl_ok
                else f"CIRCUIT BREAKER: daily loss {daily_loss_pct:.2f}% exceeds {self.settings.max_daily_loss_pct:.2f}% limit — trading halted"
            ),
        })
        if not dl_ok:
            logger.critical(
                "CIRCUIT BREAKER ACTIVE for %s %s: daily loss %.2f%% > %.2f%%",
                direction, symbol, daily_loss_pct, self.settings.max_daily_loss_pct,
            )

        # --- 4. Open positions ---
        open_count = len(self._open_positions)
        op_ok = open_count < self.settings.max_open_positions
        checks.append({
            "rule": "open_positions",
            "passed": op_ok,
            "detail": (
                f"{open_count} open positions, limit {self.settings.max_open_positions}"
                if op_ok
                else f"{open_count} open positions reached {self.settings.max_open_positions} limit"
            ),
        })
        if not op_ok:
            logger.warning(
                "REJECTED %s %s: %d open positions at limit %d",
                direction, symbol, open_count, self.settings.max_open_positions,
            )

        # --- 5. News blackout (placeholder) ---
        nb_ok = True  # TODO: integrate Finnhub economic calendar
        checks.append({
            "rule": "news_blackout",
            "passed": nb_ok,
            "detail": "No active news blackout (placeholder — Finnhub integration pending)",
        })

        # --- 6. Leverage checks ---
        if leverage > 1.0:
            # Effective max leverage — lower for illiquid pairs
            HIGH_LIQUIDITY_PAIRS = {"BTC/USDT", "ETH/USDT", "SOL/USDT"}
            effective_max_lev = self.settings.max_leverage
            if symbol not in HIGH_LIQUIDITY_PAIRS:
                effective_max_lev = min(effective_max_lev, 3.0)

            # 6a. Leverage ceiling
            lev_ok = leverage <= effective_max_lev
            checks.append({
                "rule": "leverage_limit",
                "passed": lev_ok,
                "detail": (
                    f"Leverage {leverage:.1f}x <= {effective_max_lev:.1f}x limit"
                    if lev_ok
                    else (
                        f"Leverage {leverage:.1f}x exceeds {effective_max_lev:.1f}x limit"
                        + (f" (low-liquidity cap for {symbol})" if effective_max_lev < self.settings.max_leverage else "")
                    )
                ),
            })
            if not lev_ok:
                logger.warning(
                    "REJECTED %s %s: leverage %.1fx > %.1fx limit",
                    direction, symbol, leverage, effective_max_lev,
                )

            # 6b. Notional exposure
            notional_pct = position_size_pct * leverage
            notional_ok = notional_pct <= self.settings.max_notional_pct
            checks.append({
                "rule": "notional_exposure",
                "passed": notional_ok,
                "detail": (
                    f"Notional {notional_pct:.2f}% <= {self.settings.max_notional_pct:.2f}% limit"
                    if notional_ok
                    else f"Notional {notional_pct:.2f}% (size {position_size_pct:.2f}% x {leverage:.1f}x) exceeds {self.settings.max_notional_pct:.2f}% limit"
                ),
            })
            if not notional_ok:
                logger.warning(
                    "REJECTED %s %s: notional exposure %.2f%% > %.2f%% limit",
                    direction, symbol, notional_pct, self.settings.max_notional_pct,
                )

            # 6c. Liquidation distance
            liq_distance = 1.0 / leverage
            liq_ok = liq_distance > self.settings.min_liquidation_distance
            checks.append({
                "rule": "liquidation_distance",
                "passed": liq_ok,
                "detail": (
                    f"Liquidation distance {liq_distance:.2%} > {self.settings.min_liquidation_distance:.2%} minimum"
                    if liq_ok
                    else f"Liquidation distance {liq_distance:.2%} too close (minimum {self.settings.min_liquidation_distance:.2%} required at {leverage:.1f}x leverage)"
                ),
            })
            if not liq_ok:
                logger.warning(
                    "REJECTED %s %s: liquidation distance %.2f%% < %.2f%% minimum at %.1fx leverage",
                    direction, symbol, liq_distance * 100, self.settings.min_liquidation_distance * 100, leverage,
                )

        # --- Compute USD metrics ---
        position_size_usd = portfolio_value * position_size_pct / 100.0
        # Number of units the position represents
        units = position_size_usd / entry if entry > 0 else 0.0
        risk_per_trade_usd = units * risk_per_unit if risk_per_unit > 0 else 0.0
        potential_reward_usd = units * reward_per_unit if reward_per_unit > 0 else 0.0

        all_passed = all(c["passed"] for c in checks)

        if all_passed:
            logger.info(
                "APPROVED %s %s: size=%.2f%% R:R=%.2f risk=$%.2f reward=$%.2f",
                direction, symbol, position_size_pct, rr_ratio,
                risk_per_trade_usd, potential_reward_usd,
            )
        else:
            failed = [c["rule"] for c in checks if not c["passed"]]
            logger.warning(
                "TRADE BLOCKED %s %s: failed checks: %s",
                direction, symbol, ", ".join(failed),
            )

        return {
            "passed": all_passed,
            "checks": checks,
            "position_size_usd": round(position_size_usd, 2),
            "risk_per_trade_usd": round(risk_per_trade_usd, 2),
            "potential_reward_usd": round(potential_reward_usd, 2),
            "risk_reward_ratio": round(rr_ratio, 4),
        }

    # ------------------------------------------------------------------
    # Position tracking
    # ------------------------------------------------------------------

    def open_position(self, symbol: str) -> None:
        """Register a newly opened position."""
        self._open_positions.add(symbol)
        logger.info("Position opened: %s (total open: %d)", symbol, len(self._open_positions))

    def close_position(self, symbol: str) -> None:
        """Remove a closed position from tracking."""
        self._open_positions.discard(symbol)
        logger.info("Position closed: %s (total open: %d)", symbol, len(self._open_positions))

    # ------------------------------------------------------------------
    # Daily P&L tracking
    # ------------------------------------------------------------------

    def record_trade_result(self, pnl: float, portfolio_value: float) -> None:
        """Record realized P&L from a closed trade. Updates daily tracker."""
        today = str(date.today())
        self._daily_pnl[today] = self._daily_pnl.get(today, 0.0) + pnl
        daily_total = self._daily_pnl[today]
        loss_pct = abs(min(daily_total, 0.0)) / portfolio_value * 100 if portfolio_value > 0 else 0.0
        logger.info(
            "Trade result recorded: PnL=$%.2f | Daily total=$%.2f (%.2f%% of portfolio)",
            pnl, daily_total, loss_pct,
        )
        if loss_pct >= self.settings.max_daily_loss_pct:
            logger.critical(
                "CIRCUIT BREAKER TRIGGERED: daily loss %.2f%% >= %.2f%% limit",
                loss_pct, self.settings.max_daily_loss_pct,
            )

    def is_circuit_breaker_active(self, portfolio_value: float | None = None) -> bool:
        """Check if daily loss limit has been breached."""
        if portfolio_value is None or portfolio_value <= 0:
            return False
        today_pnl = self._daily_pnl.get(str(date.today()), 0.0)
        if today_pnl >= 0:
            return False
        loss_pct = abs(today_pnl) / portfolio_value * 100
        return loss_pct >= self.settings.max_daily_loss_pct

    def reset_daily(self) -> None:
        """Reset daily P&L tracking. Call at market open."""
        today = str(date.today())
        old = self._daily_pnl.get(today, 0.0)
        self._daily_pnl[today] = 0.0
        logger.info("Daily risk counters reset (previous daily PnL: $%.2f)", old)

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self) -> dict:
        """Return current risk management state."""
        today = str(date.today())
        return {
            "open_positions": sorted(self._open_positions),
            "open_position_count": len(self._open_positions),
            "max_open_positions": self.settings.max_open_positions,
            "daily_pnl_usd": round(self._daily_pnl.get(today, 0.0), 2),
            "max_daily_loss_pct": self.settings.max_daily_loss_pct,
            "max_position_pct": self.settings.max_position_pct,
            "min_risk_reward": self.settings.min_risk_reward,
            "auto_exec_max_pct": self.settings.auto_exec_max_pct,
            "news_blackout_minutes": self.settings.news_blackout_minutes,
            "max_leverage": self.settings.max_leverage,
            "max_notional_pct": self.settings.max_notional_pct,
            "min_liquidation_distance": self.settings.min_liquidation_distance,
        }
