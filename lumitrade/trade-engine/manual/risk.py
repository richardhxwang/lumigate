"""
manual/risk.py -- High-leverage risk management for manual trading.

Extends the base RiskManager with manual-trading-specific rules:
- Higher leverage ceiling (50x vs 5x for bots)
- Mood-aware gating (blocks or warns based on mood score)
- Position sizing calculator for leveraged trades
- Tighter liquidation distance requirements
"""

import logging
from dataclasses import dataclass

from risk.manager import RiskManager, RiskSettings

logger = logging.getLogger("lumitrade.manual.risk")


@dataclass
class ManualRiskSettings(RiskSettings):
    """
    Risk settings for manual high-leverage trading.
    These are INDEPENDENT from bot risk settings.
    """
    # Override base defaults for manual trading context
    max_position_pct: float = 3.0          # max 3% of capital per trade
    max_daily_loss_pct: float = 10.0       # 10% daily loss circuit breaker
    max_open_positions: int = 3
    max_leverage: float = 50.0             # up to 50x
    min_liquidation_distance: float = 0.015  # 1.5% minimum distance to liquidation
    max_notional_pct: float = 150.0        # 3% * 50x = 150% max notional

    # Manual-specific
    require_mood: bool = True              # require mood score before trading
    mood_warn_threshold: int = 4           # warn if mood >= 4 (anxious/greedy)
    mood_block_threshold: int = 5          # block if mood == 5 (extreme)

    # Min R:R relaxed slightly for scalping
    min_risk_reward: float = 1.5


class ManualRiskManager(RiskManager):
    """
    Risk manager for manual high-leverage trading.
    Inherits all base checks, adds mood gating and position calculator.
    """

    def __init__(self, settings: ManualRiskSettings | None = None):
        super().__init__(settings or ManualRiskSettings())
        self.settings: ManualRiskSettings  # type narrowing

    # ------------------------------------------------------------------
    # Position sizing calculator
    # ------------------------------------------------------------------

    def calculate_position(
        self,
        capital: float,
        risk_pct: float,
        leverage: int,
        entry_price: float,
        sl_pct: float,
    ) -> dict:
        """
        Calculate position size for a leveraged trade.

        Args:
            capital:     Total trading capital (USDT)
            risk_pct:    % of capital willing to risk (e.g. 2.0 = 2%)
            leverage:    Leverage multiplier (e.g. 10)
            entry_price: Current market price
            sl_pct:      Stop loss distance as % (e.g. 1.0 = 1%)

        Returns:
            dict with margin, position_size, risk_usd, liquidation_distance, etc.
        """
        # Risk amount in USD
        risk_usd = capital * (risk_pct / 100.0)

        # Margin = risk / (sl_pct / 100)
        # Because: if SL triggers at sl_pct%, you lose margin * sl_pct% * leverage
        # Actually: loss = position_size * sl_pct% = margin * leverage * sl_pct%
        # We want loss = risk_usd, so: margin = risk_usd / (leverage * sl_pct / 100)
        if sl_pct <= 0 or leverage <= 0:
            return {"error": "sl_pct and leverage must be > 0"}

        margin = risk_usd / (leverage * sl_pct / 100.0)

        # Cap margin at max_position_pct of capital
        max_margin = capital * (self.settings.max_position_pct / 100.0)
        if margin > max_margin:
            margin = max_margin
            # Recalculate actual risk with capped margin
            risk_usd = margin * leverage * (sl_pct / 100.0)

        # Position size in USDT notional
        position_notional = margin * leverage

        # Position size in contracts (units of base currency)
        position_size = position_notional / entry_price if entry_price > 0 else 0.0

        # Liquidation distance (approximate: 1/leverage for isolated margin)
        liquidation_distance = 1.0 / leverage

        # Margin as % of capital
        margin_pct = (margin / capital * 100) if capital > 0 else 0.0

        return {
            "margin": round(margin, 2),
            "margin_pct": round(margin_pct, 2),
            "position_notional": round(position_notional, 2),
            "position_size": round(position_size, 6),
            "risk_usd": round(risk_usd, 2),
            "risk_pct": round(risk_pct, 2),
            "leverage": leverage,
            "sl_pct": sl_pct,
            "liquidation_distance_pct": round(liquidation_distance * 100, 2),
            "entry_price": entry_price,
        }

    # ------------------------------------------------------------------
    # Mood-aware check
    # ------------------------------------------------------------------

    def check_with_mood(
        self,
        symbol: str,
        direction: str,
        entry: float,
        stop_loss: float,
        take_profit: float,
        position_size_pct: float,
        portfolio_value: float,
        leverage: float,
        mood_score: int | None = None,
    ) -> dict:
        """
        Full risk check including mood assessment.

        Args:
            (same as RiskManager.check, plus)
            mood_score: -5 (very calm) to +5 (very agitated/greedy)
                        None means mood not provided.

        Returns:
            dict with passed, checks, mood_warning, mood_blocked, and position metrics.
        """
        # Run all standard risk checks
        result = self.check(
            symbol=symbol,
            direction=direction,
            entry=entry,
            stop_loss=stop_loss,
            take_profit=take_profit,
            position_size_pct=position_size_pct,
            portfolio_value=portfolio_value,
            leverage=leverage,
        )

        checks = result["checks"]

        # --- Mood check ---
        mood_warning = None
        mood_blocked = False

        if self.settings.require_mood and mood_score is None:
            checks.append({
                "rule": "mood_required",
                "passed": False,
                "detail": "Mood score required before trading. Rate your emotional state (-5 calm to +5 agitated).",
            })
            result["passed"] = False
            logger.warning("REJECTED %s %s: mood score not provided", direction, symbol)

        elif mood_score is not None:
            abs_mood = abs(mood_score)

            if abs_mood >= self.settings.mood_block_threshold:
                mood_blocked = True
                checks.append({
                    "rule": "mood_block",
                    "passed": False,
                    "detail": f"Mood score {mood_score} is extreme (threshold: +/-{self.settings.mood_block_threshold}). Trading blocked. Take a break.",
                })
                result["passed"] = False
                logger.warning(
                    "BLOCKED %s %s: extreme mood score %d",
                    direction, symbol, mood_score,
                )

            elif abs_mood >= self.settings.mood_warn_threshold:
                mood_warning = (
                    f"Mood score {mood_score} is elevated (threshold: +/-{self.settings.mood_warn_threshold}). "
                    f"Proceed with caution — consider reducing size."
                )
                checks.append({
                    "rule": "mood_warning",
                    "passed": True,  # warning, not blocking
                    "detail": mood_warning,
                })
                logger.info(
                    "WARNING %s %s: elevated mood score %d",
                    direction, symbol, mood_score,
                )
            else:
                checks.append({
                    "rule": "mood_check",
                    "passed": True,
                    "detail": f"Mood score {mood_score} is within acceptable range.",
                })

        result["checks"] = checks
        result["passed"] = all(c["passed"] for c in checks)
        result["mood_warning"] = mood_warning
        result["mood_blocked"] = mood_blocked

        return result
