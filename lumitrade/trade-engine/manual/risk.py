"""
Manual Trading Risk Manager — specialized risk checks for manual trades.

Extends the base RiskManager with manual-trading-specific rules:
- Leverage-based auto SL/TP calculation
- Mood-adjusted risk (poor mood -> tighter limits)
- Position sizing from balance
- Price drift rejection on confirm
"""

import logging
from datetime import datetime, timezone

logger = logging.getLogger("lumitrade.manual_risk")

# Auto SL distance by leverage tier
_SL_BY_LEVERAGE = {
    # leverage_threshold: sl_distance_pct
    100: 0.25,
    50: 0.5,
    30: 1.0,
    20: 1.5,
    10: 2.5,
    5: 5.0,
    3: 8.0,
    1: 15.0,
}

# Mood multipliers — poor mood tightens risk
_MOOD_MULTIPLIERS = {
    1: 0.5,   # terrible: halve position
    2: 0.75,  # bad: 75% position
    3: 1.0,   # neutral: normal
    4: 1.0,   # good: normal
    5: 1.0,   # great: normal
}


class ManualRiskManager:
    """Risk checks specialized for manual trading with leverage."""

    def __init__(self, settings):
        self.settings = settings
        self._daily_pnl: float = 0.0
        self._daily_pnl_date: str = ""
        self._trade_count_today: int = 0

    # ------------------------------------------------------------------
    # Auto SL/TP calculation
    # ------------------------------------------------------------------

    def auto_stop_loss(self, entry: float, direction: str, leverage: float) -> float:
        """Calculate automatic SL based on leverage tier."""
        sl_pct = 15.0  # default for 1x
        for lev_threshold, pct in sorted(_SL_BY_LEVERAGE.items(), reverse=True):
            if leverage >= lev_threshold:
                sl_pct = pct
                break

        if direction.lower() == "long":
            return round(entry * (1 - sl_pct / 100), 8)
        else:
            return round(entry * (1 + sl_pct / 100), 8)

    def auto_take_profit(self, entry: float, stop_loss: float, direction: str, min_rr: float = 2.0) -> float:
        """Calculate TP to achieve minimum R:R ratio."""
        risk = abs(entry - stop_loss)
        reward = risk * min_rr
        if direction.lower() == "long":
            return round(entry + reward, 8)
        else:
            return round(entry - reward, 8)

    # ------------------------------------------------------------------
    # Position sizing
    # ------------------------------------------------------------------

    def calculate_position_size(
        self,
        balance: float,
        entry: float,
        stop_loss: float,
        leverage: float = 1.0,
        mood: int | None = None,
        max_risk_pct: float | None = None,
    ) -> dict:
        """
        Calculate position size based on risk per trade.

        Uses fixed-fractional method: risk X% of balance per trade.
        Mood adjusts the risk fraction down if mood is poor.

        Returns:
            dict with size_usdt, size_contracts, risk_usd, position_pct
        """
        max_pct = max_risk_pct or self.settings.max_position_pct
        mood_mult = _MOOD_MULTIPLIERS.get(mood, 1.0) if mood else 1.0
        effective_risk_pct = max_pct * mood_mult

        # Risk per unit
        risk_per_unit = abs(entry - stop_loss)
        if risk_per_unit <= 0 or entry <= 0:
            return {"size_usdt": 0, "size_contracts": 0, "risk_usd": 0, "position_pct": 0, "error": "Invalid SL"}

        # Max risk in USD
        risk_usd = balance * (effective_risk_pct / 100)

        # Number of contracts (in base currency units)
        contracts = risk_usd / risk_per_unit

        # Notional value
        size_usdt = contracts * entry

        # With leverage, margin required is size_usdt / leverage
        margin_required = size_usdt / leverage

        # Cap at available balance
        if margin_required > balance * 0.95:  # leave 5% buffer
            margin_required = balance * 0.95
            size_usdt = margin_required * leverage
            contracts = size_usdt / entry

        position_pct = (margin_required / balance * 100) if balance > 0 else 0

        return {
            "size_usdt": round(size_usdt, 2),
            "size_contracts": round(contracts, 8),
            "margin_required": round(margin_required, 2),
            "risk_usd": round(risk_usd, 2),
            "position_pct": round(position_pct, 4),
            "mood_multiplier": mood_mult,
            "effective_risk_pct": round(effective_risk_pct, 4),
        }

    # ------------------------------------------------------------------
    # Full risk check for manual trades
    # ------------------------------------------------------------------

    def check(
        self,
        symbol: str,
        direction: str,
        entry: float,
        stop_loss: float,
        take_profit: float,
        position_pct: float,
        portfolio_value: float,
        leverage: float = 1.0,
        mood: int | None = None,
    ) -> dict:
        """
        Run all risk checks for a manual trade proposal.

        Returns:
            dict with passed (bool), checks list, warnings list
        """
        checks = []
        warnings = []

        # 1. Position size
        max_pct = self.settings.max_position_pct
        pos_ok = position_pct <= max_pct
        checks.append({
            "rule": "position_size",
            "passed": pos_ok,
            "detail": f"{position_pct:.2f}% {'<=' if pos_ok else '>'} {max_pct:.2f}% limit",
        })

        # 2. R:R ratio
        if direction.lower() == "long":
            risk = entry - stop_loss
            reward = take_profit - entry
        else:
            risk = stop_loss - entry
            reward = entry - take_profit

        rr = (reward / risk) if risk > 0 else 0
        rr_ok = rr >= self.settings.min_risk_reward
        checks.append({
            "rule": "risk_reward",
            "passed": rr_ok,
            "detail": f"R:R {rr:.2f} >= {self.settings.min_risk_reward:.2f}" if rr_ok
                      else f"R:R {rr:.2f} below {self.settings.min_risk_reward:.2f} minimum",
        })

        # 3. Daily loss circuit breaker
        today = str(datetime.now(timezone.utc).date())
        if self._daily_pnl_date != today:
            self._daily_pnl = 0.0
            self._daily_pnl_date = today
            self._trade_count_today = 0

        daily_loss_pct = (abs(min(self._daily_pnl, 0)) / portfolio_value * 100) if portfolio_value > 0 else 0
        cb_ok = daily_loss_pct < self.settings.max_daily_loss_pct
        checks.append({
            "rule": "daily_loss",
            "passed": cb_ok,
            "detail": f"Daily loss {daily_loss_pct:.2f}% {'<' if cb_ok else '>='} {self.settings.max_daily_loss_pct:.2f}%",
        })

        # 4. Leverage limit
        max_lev = self.settings.max_leverage
        lev_ok = leverage <= max_lev
        checks.append({
            "rule": "leverage",
            "passed": lev_ok,
            "detail": f"Leverage {leverage:.0f}x {'<=' if lev_ok else '>'} {max_lev:.0f}x limit",
        })

        # 5. Notional exposure
        notional_pct = position_pct * leverage
        max_notional = self.settings.max_notional_pct
        notional_ok = notional_pct <= max_notional
        checks.append({
            "rule": "notional_exposure",
            "passed": notional_ok,
            "detail": f"Notional {notional_pct:.2f}% {'<=' if notional_ok else '>'} {max_notional:.2f}%",
        })

        # 6. Liquidation distance
        liq_distance = 1.0 / leverage if leverage > 0 else 1.0
        min_liq = self.settings.min_liquidation_distance
        liq_ok = liq_distance >= min_liq
        checks.append({
            "rule": "liquidation_distance",
            "passed": liq_ok,
            "detail": f"Liq distance {liq_distance:.2%} {'>=' if liq_ok else '<'} {min_liq:.2%} minimum",
        })

        # 7. Mood check (warning only, not blocking)
        if mood is not None and mood <= 2:
            warnings.append({
                "rule": "mood_warning",
                "detail": f"Mood score {mood}/5 — position reduced by {int((1 - _MOOD_MULTIPLIERS[mood]) * 100)}%",
            })

        all_passed = all(c["passed"] for c in checks)

        return {
            "passed": all_passed,
            "checks": checks,
            "warnings": warnings,
            "risk_reward_ratio": round(rr, 4),
        }

    # ------------------------------------------------------------------
    # Price drift check (for confirm step)
    # ------------------------------------------------------------------

    def check_price_drift(self, original_price: float, current_price: float, max_drift_pct: float = 0.5) -> dict:
        """Check if price has drifted too much since proposal."""
        drift_pct = abs(current_price - original_price) / original_price * 100 if original_price > 0 else 0
        ok = drift_pct <= max_drift_pct
        return {
            "passed": ok,
            "drift_pct": round(drift_pct, 4),
            "original_price": original_price,
            "current_price": current_price,
            "detail": f"Price drift {drift_pct:.3f}% <= {max_drift_pct}% max" if ok
                      else f"Price moved {drift_pct:.3f}% since proposal (max {max_drift_pct}%) — re-propose required",
        }

    # ------------------------------------------------------------------
    # Daily P&L tracking
    # ------------------------------------------------------------------

    def record_pnl(self, pnl: float):
        """Record realized PnL for daily tracking."""
        today = str(datetime.now(timezone.utc).date())
        if self._daily_pnl_date != today:
            self._daily_pnl = 0.0
            self._daily_pnl_date = today
            self._trade_count_today = 0
        self._daily_pnl += pnl
        self._trade_count_today += 1

    def get_daily_stats(self) -> dict:
        return {
            "daily_pnl": round(self._daily_pnl, 2),
            "trade_count_today": self._trade_count_today,
            "date": self._daily_pnl_date,
        }
