"""
SMC (Smart Money Concepts) Strategy Analyzer for LumiTrade.

Uses the `smartmoneyconcepts` library to detect institutional trading patterns:
- Market structure (BOS / CHoCH)
- Order Blocks (OB)
- Fair Value Gaps (FVG)
- Liquidity levels
- Swing highs/lows

Generates trade signals by cross-referencing multi-timeframe SMC analysis.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

try:
    from smartmoneyconcepts import smc
except ImportError:
    smc = None
    logging.warning("smartmoneyconcepts not installed. pip install smart-money-concepts")

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SWING_LENGTH = 10  # default lookback for swing detection


def _generate_sample_ohlcv(symbol: str, periods: int = 200) -> pd.DataFrame:
    """Generate synthetic OHLCV data for development/testing.

    Will be replaced by real broker data once connectors are wired up.
    """
    rng = np.random.default_rng(hash(symbol) & 0xFFFFFFFF)
    base = 100.0
    prices = [base]
    for _ in range(periods - 1):
        prices.append(prices[-1] * (1 + rng.normal(0, 0.015)))

    closes = np.array(prices)
    highs = closes * (1 + rng.uniform(0.001, 0.012, periods))
    lows = closes * (1 - rng.uniform(0.001, 0.012, periods))
    opens = lows + rng.uniform(0, 1, periods) * (highs - lows)
    volumes = rng.integers(1000, 50000, periods).astype(float)

    idx = pd.date_range(end=datetime.now(tz=timezone.utc), periods=periods, freq="h")

    return pd.DataFrame(
        {"open": opens, "high": highs, "low": lows, "close": closes, "volume": volumes},
        index=idx,
    )


# ---------------------------------------------------------------------------
# SMCAnalyzer
# ---------------------------------------------------------------------------


class SMCAnalyzer:
    """Multi-timeframe Smart Money Concepts analyzer."""

    def __init__(self, swing_length: int = SWING_LENGTH):
        self.swing_length = swing_length
        if smc is None:
            raise RuntimeError(
                "smartmoneyconcepts library is required. Install with: "
                "pip install smart-money-concepts"
            )

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    async def analyze(
        self,
        symbol: str,
        timeframes: list[str],
    ) -> dict:
        """Run SMC analysis across multiple timeframes and generate signals.

        Parameters
        ----------
        symbol : str
            Instrument symbol (e.g. "EURUSD", "BTC-USDT").
        timeframes : list[str]
            List of timeframe strings (e.g. ["15m", "1h", "4h"]).

        Returns
        -------
        dict
            {
                "symbol": str,
                "timeframes": {tf: analysis_dict, ...},
                "signals": [signal_dict, ...],
                "market_structure": str,       # dominant structure
                "analyzed_at": str             # ISO timestamp
            }
        """
        analyses: dict[str, dict] = {}

        for tf in timeframes:
            ohlc = _generate_sample_ohlcv(symbol, periods=200)
            analysis = await asyncio.to_thread(self._analyze_timeframe, ohlc, tf)
            analyses[tf] = analysis

        signals = self._generate_signals(analyses, symbol)

        # Dominant market structure: use the highest timeframe result
        dominant_structure = "ranging"
        if analyses:
            last_tf = timeframes[-1]
            dominant_structure = analyses[last_tf].get("market_structure", "ranging")

        return {
            "symbol": symbol,
            "timeframes": analyses,
            "signals": signals,
            "market_structure": dominant_structure,
            "analyzed_at": datetime.now(tz=timezone.utc).isoformat(),
        }

    # ------------------------------------------------------------------
    # Single-timeframe analysis
    # ------------------------------------------------------------------

    def _analyze_timeframe(self, ohlc: pd.DataFrame, timeframe: str) -> dict:
        """Analyze a single timeframe using all SMC indicators.

        Parameters
        ----------
        ohlc : pd.DataFrame
            Must have columns: open, high, low, close  (lowercase).
        timeframe : str
            Timeframe label (e.g. "1h").

        Returns
        -------
        dict  with keys: swing_highs_lows, bos_choch, order_blocks,
              fair_value_gaps, liquidity, market_structure, entry_zones
        """
        result: dict = {
            "timeframe": timeframe,
            "candles": len(ohlc),
            "swing_highs_lows": None,
            "bos_choch": None,
            "order_blocks": None,
            "fair_value_gaps": None,
            "liquidity": None,
            "market_structure": "ranging",
            "entry_zones": [],
        }

        # --- Swing highs / lows ---
        try:
            swing_hl = smc.swing_highs_lows(ohlc, swing_length=self.swing_length)
            result["swing_highs_lows"] = self._df_to_records(swing_hl)
        except Exception as exc:
            logger.warning("swing_highs_lows failed (%s): %s", timeframe, exc)
            return result

        # --- BOS / CHoCH ---
        try:
            bos_choch = smc.bos_choch(ohlc, swing_hl, close_break=True)
            result["bos_choch"] = self._df_to_records(bos_choch)
            result["market_structure"] = self._detect_market_structure(bos_choch)
        except Exception as exc:
            logger.warning("bos_choch failed (%s): %s", timeframe, exc)

        # --- Order Blocks ---
        try:
            ob = smc.ob(ohlc, swing_hl, close_mitigation=False)
            result["order_blocks"] = self._df_to_records(ob)
        except Exception as exc:
            logger.warning("ob failed (%s): %s", timeframe, exc)

        # --- Fair Value Gaps ---
        try:
            fvg = smc.fvg(ohlc, join_consecutive=False)
            result["fair_value_gaps"] = self._df_to_records(fvg)
        except Exception as exc:
            logger.warning("fvg failed (%s): %s", timeframe, exc)

        # --- Liquidity ---
        try:
            liq = smc.liquidity(ohlc, swing_hl, range_percent=0.01)
            result["liquidity"] = self._df_to_records(liq)
        except Exception as exc:
            logger.warning("liquidity failed (%s): %s", timeframe, exc)

        # --- Entry zones (OB + FVG overlap) ---
        result["entry_zones"] = self._find_entry_zones(result)

        return result

    # ------------------------------------------------------------------
    # Signal generation (multi-timeframe)
    # ------------------------------------------------------------------

    def _generate_signals(self, analyses: dict[str, dict], symbol: str) -> list[dict]:
        """Cross-reference multi-timeframe analyses to produce trade signals.

        A signal is generated when an Order Block and FVG overlap in the
        correct premium/discount zone relative to recent swing range.
        """
        signals: list[dict] = []

        for tf, analysis in analyses.items():
            entry_zones = analysis.get("entry_zones", [])
            structure = analysis.get("market_structure", "ranging")

            for zone in entry_zones:
                direction = zone.get("direction")

                # Align direction with market structure
                if structure == "bullish_trending" and direction != "long":
                    continue
                if structure == "bearish_trending" and direction != "short":
                    continue

                entry = zone["entry"]
                stop_loss = zone["stop_loss"]
                risk = abs(entry - stop_loss)
                if risk == 0:
                    continue

                # Default 2:1 RR target
                if direction == "long":
                    take_profit = entry + risk * 2.0
                else:
                    take_profit = entry - risk * 2.0

                rr = abs(take_profit - entry) / risk

                # Confidence heuristic: structure alignment + zone quality
                confidence = 0.5
                if structure != "ranging":
                    confidence += 0.15
                if zone.get("fvg_overlap"):
                    confidence += 0.15
                if zone.get("ob_volume_pct", 0) > 50:
                    confidence += 0.1
                confidence = min(confidence, 1.0)

                signals.append(
                    {
                        "symbol": symbol,
                        "direction": direction,
                        "entry": round(entry, 6),
                        "stop_loss": round(stop_loss, 6),
                        "take_profit": round(take_profit, 6),
                        "risk_reward": round(rr, 2),
                        "confidence": round(confidence, 2),
                        "timeframe": tf,
                        "market_structure": structure,
                        "indicators": {
                            "ob_top": zone.get("ob_top"),
                            "ob_bottom": zone.get("ob_bottom"),
                            "fvg_top": zone.get("fvg_top"),
                            "fvg_bottom": zone.get("fvg_bottom"),
                        },
                        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
                    }
                )

        # Sort by confidence descending
        signals.sort(key=lambda s: s["confidence"], reverse=True)
        return signals

    # ------------------------------------------------------------------
    # Market structure detection
    # ------------------------------------------------------------------

    def _detect_market_structure(self, bos_choch_data: pd.DataFrame) -> str:
        """Determine market structure from BOS/CHoCH data.

        Returns
        -------
        str
            "bullish_trending", "bearish_trending", or "ranging"
        """
        if bos_choch_data is None or bos_choch_data.empty:
            return "ranging"

        # Look at recent BOS signals (last 20 rows that have a value)
        bos_col = "BOS" if "BOS" in bos_choch_data.columns else None
        choch_col = "CHOCH" if "CHOCH" in bos_choch_data.columns else None

        bullish_count = 0
        bearish_count = 0

        if bos_col:
            recent_bos = bos_choch_data[bos_col].dropna().tail(20)
            bullish_count += (recent_bos == 1).sum()
            bearish_count += (recent_bos == -1).sum()

        if choch_col:
            recent_choch = bos_choch_data[choch_col].dropna().tail(10)
            # CHoCH signals structure change — weight them more
            bullish_count += (recent_choch == 1).sum() * 2
            bearish_count += (recent_choch == -1).sum() * 2

        total = bullish_count + bearish_count
        if total == 0:
            return "ranging"

        ratio = bullish_count / total
        if ratio >= 0.65:
            return "bullish_trending"
        elif ratio <= 0.35:
            return "bearish_trending"
        return "ranging"

    # ------------------------------------------------------------------
    # Entry zone detection (OB + FVG overlap)
    # ------------------------------------------------------------------

    def _find_entry_zones(self, analysis: dict) -> list[dict]:
        """Find zones where Order Blocks and FVGs overlap.

        These overlapping zones represent high-probability entries in SMC.
        """
        zones: list[dict] = []

        ob_records = analysis.get("order_blocks") or []
        fvg_records = analysis.get("fair_value_gaps") or []

        # Filter to active (unmitigated) OBs and FVGs
        active_obs = [r for r in ob_records if r.get("OB") in (1, -1)]
        active_fvgs = [
            r
            for r in fvg_records
            if r.get("FVG") in (1, -1)
            and (r.get("MitigatedIndex") is None or np.isnan(r.get("MitigatedIndex", 0)))
        ]

        for ob in active_obs:
            ob_top = ob.get("Top")
            ob_bottom = ob.get("Bottom")
            ob_dir = ob.get("OB")  # 1=bullish, -1=bearish

            if ob_top is None or ob_bottom is None:
                continue
            if np.isnan(ob_top) or np.isnan(ob_bottom):
                continue

            fvg_overlap = False
            fvg_top = None
            fvg_bottom = None

            for fvg in active_fvgs:
                ft = fvg.get("Top")
                fb = fvg.get("Bottom")
                if ft is None or fb is None:
                    continue
                if np.isnan(ft) or np.isnan(fb):
                    continue

                # Check overlap
                if ob_bottom <= ft and ob_top >= fb:
                    fvg_overlap = True
                    fvg_top = ft
                    fvg_bottom = fb
                    break

            direction = "long" if ob_dir == 1 else "short"

            if direction == "long":
                entry = ob_top
                stop_loss = ob_bottom - (ob_top - ob_bottom) * 0.1
            else:
                entry = ob_bottom
                stop_loss = ob_top + (ob_top - ob_bottom) * 0.1

            zones.append(
                {
                    "direction": direction,
                    "entry": entry,
                    "stop_loss": stop_loss,
                    "ob_top": ob_top,
                    "ob_bottom": ob_bottom,
                    "ob_volume_pct": ob.get("Percentage", 0),
                    "fvg_overlap": fvg_overlap,
                    "fvg_top": fvg_top,
                    "fvg_bottom": fvg_bottom,
                }
            )

        return zones

    # ------------------------------------------------------------------
    # Utility
    # ------------------------------------------------------------------

    @staticmethod
    def _df_to_records(df: Optional[pd.DataFrame]) -> list[dict]:
        """Convert DataFrame to list of dicts, keeping only rows with data.

        Replaces NaN/Inf with None so the result is JSON-serializable.
        """
        if df is None or df.empty:
            return []
        # Drop rows where all indicator columns are NaN
        cleaned = df.dropna(how="all")
        # Replace NaN and Inf with None for JSON compliance
        cleaned = cleaned.replace([np.inf, -np.inf], np.nan)
        return cleaned.where(cleaned.notna(), other=None).to_dict(orient="records")
