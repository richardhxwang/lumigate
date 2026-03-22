from freqtrade.strategy import IStrategy, IntParameter, DecimalParameter
from pandas import DataFrame
import pandas as pd
import talib as ta
import numpy as np
import logging

logger = logging.getLogger(__name__)


class SMCStrategy(IStrategy):
    """
    Smart Money Concepts strategy for crypto markets.
    Uses BOS/CHoCH for structure, OB+FVG for entries, swing points for SL/TP.
    """

    INTERFACE_VERSION = 3
    can_short = True  # All bots now run futures mode

    timeframe = "15m"
    startup_candle_count = 200
    process_only_new_candles = True
    use_exit_signal = True  # CHoCH exit limits SL damage (saves ~2000 USDT vs no exit signal)
    use_custom_stoploss = False

    # Risk management — hyperopt-optimized (2025-06 to 2026-03, 292 days)
    # Wide ROI lets winners run; wide SL avoids noise stops; trailing locks profit at 20%+
    minimal_roi = {"0": 0.306, "109": 0.107, "273": 0.039, "625": 0}
    stoploss = -0.077
    trailing_stop = True
    trailing_stop_positive = 0.201
    trailing_stop_positive_offset = 0.203
    trailing_only_offset_is_reached = True

    # FreqAI configuration
    freqai_info = {
        "model": "LightGBMRegressor",
        "conv_width": 10,
    }

    # Hyperoptable parameters (optimized values baked in)
    swing_length = IntParameter(5, 50, default=5, space="buy", optimize=True)
    ob_strength_min = DecimalParameter(0.3, 0.8, default=0.381, space="buy", optimize=True)

    plot_config = {
        "main_plot": {
            "ob_top": {"color": "rgba(46, 204, 113, 0.4)", "type": "line"},
            "ob_bottom": {"color": "rgba(46, 204, 113, 0.4)", "type": "line"},
            "fvg_top": {"color": "rgba(241, 196, 15, 0.4)", "type": "line"},
            "fvg_bottom": {"color": "rgba(241, 196, 15, 0.4)", "type": "line"},
        },
        "subplots": {
            "SMC Structure": {
                "bos": {"color": "#2ecc71", "type": "bar"},
                "choch": {"color": "#e74c3c", "type": "bar"},
            },
            "Liquidity": {
                "liquidity": {"color": "#9b59b6", "type": "line"},
                "liq_swept": {"color": "#f39c12", "type": "bar"},
            },
        },
    }

    def informative_pairs(self):
        pairs = self.dp.current_whitelist()
        return [(pair, "1h") for pair in pairs] + [(pair, "4h") for pair in pairs]

    # Lookback window: BOS/CHoCH/OB/FVG signals are valid for N candles after firing.
    # SMC signals fire on different candles and almost never co-occur, so we propagate
    # each signal forward to create a "context window" where confluence can be detected.
    signal_lookback = IntParameter(3, 20, default=8, space="buy", optimize=True)

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        try:
            from smartmoneyconcepts import smc
        except ImportError:
            logger.warning("smart-money-concepts not installed, skipping SMC indicators")
            return dataframe

        ohlc = dataframe[["open", "high", "low", "close", "volume"]].copy()

        # Swing Highs/Lows
        try:
            swing_hl = smc.swing_highs_lows(ohlc, swing_length=self.swing_length.value)
            dataframe["swing_hl"] = swing_hl["HighLow"]
            dataframe["swing_level"] = swing_hl["Level"]
        except Exception as e:
            logger.debug(f"swing_highs_lows failed: {e}")
            dataframe["swing_hl"] = 0
            dataframe["swing_level"] = 0.0

        # BOS / CHoCH
        try:
            bos_choch = smc.bos_choch(ohlc, swing_hl, close_break=True)
            dataframe["bos"] = bos_choch["BOS"]
            dataframe["choch"] = bos_choch["CHOCH"]
        except Exception as e:
            logger.debug(f"bos_choch failed: {e}")
            dataframe["bos"] = 0
            dataframe["choch"] = 0

        # Order Blocks
        try:
            ob = smc.ob(ohlc, swing_hl, close_mitigation=False)
            dataframe["ob_direction"] = ob["OB"]
            dataframe["ob_top"] = ob["Top"]
            dataframe["ob_bottom"] = ob["Bottom"]
            dataframe["ob_volume"] = ob.get("OBVolume", 0)
        except Exception as e:
            logger.debug(f"ob failed: {e}")
            dataframe["ob_direction"] = 0
            dataframe["ob_top"] = 0.0
            dataframe["ob_bottom"] = 0.0
            dataframe["ob_volume"] = 0

        # Fair Value Gaps
        try:
            fvg = smc.fvg(ohlc, join_consecutive=False)
            dataframe["fvg_direction"] = fvg["FVG"]
            dataframe["fvg_top"] = fvg["Top"]
            dataframe["fvg_bottom"] = fvg["Bottom"]
        except Exception as e:
            logger.debug(f"fvg failed: {e}")
            dataframe["fvg_direction"] = 0
            dataframe["fvg_top"] = 0.0
            dataframe["fvg_bottom"] = 0.0

        # Liquidity
        try:
            liq = smc.liquidity(ohlc, swing_hl, range_percent=0.01)
            dataframe["liquidity"] = liq["Liquidity"]
            dataframe["liq_level"] = liq["Level"]
            # liq["Swept"] stores the candle INDEX where liquidity gets swept,
            # placed at the candle where liquidity was *detected*.
            # We need a flag at the *sweep* candle, not the detection candle.
            swept_indices = liq["Swept"].dropna().astype(int).values
            liq_swept = np.zeros(len(dataframe), dtype=int)
            for si in swept_indices:
                if 0 <= si < len(dataframe):
                    liq_swept[si] = 1
            dataframe["liq_swept"] = liq_swept
        except Exception as e:
            logger.debug(f"liquidity failed: {e}")
            dataframe["liquidity"] = 0
            dataframe["liq_level"] = 0.0
            dataframe["liq_swept"] = 0

        # --- Fill NaN with 0 for all SMC signal columns ---
        # The SMC library returns NaN for non-signal candles, but entry logic
        # compares with == 1 / == -1 which fails on NaN.
        for col in ["bos", "choch", "ob_direction", "fvg_direction",
                     "liq_swept", "liquidity"]:
            dataframe[col] = dataframe[col].fillna(0)

        # --- Propagate signals forward using lookback window ---
        # BOS/CHoCH/OB/FVG fire on different candles and almost never co-occur.
        # Create "recent_*" columns: 1/-1 if signal fired within last N candles.
        lb = self.signal_lookback.value
        for col, out in [
            ("bos", "recent_bos"),
            ("choch", "recent_choch"),
            ("ob_direction", "recent_ob"),
            ("fvg_direction", "recent_fvg"),
        ]:
            # For each direction (+1, -1), propagate forward using rolling max/min
            bull = (dataframe[col] == 1).astype(int)
            bear = (dataframe[col] == -1).astype(int)
            # If any bullish signal in last lb candles → 1; bearish → -1
            recent_bull = bull.rolling(lb, min_periods=1).max()
            recent_bear = bear.rolling(lb, min_periods=1).max()
            dataframe[out] = recent_bull - recent_bear  # 1, -1, or 0

        # Propagate OB zone (top/bottom) forward: carry last known OB zone
        dataframe["active_ob_top"] = dataframe["ob_top"].replace(0, np.nan).ffill().fillna(0)
        dataframe["active_ob_bottom"] = dataframe["ob_bottom"].replace(0, np.nan).ffill().fillna(0)
        # Invalidate if OB is too old: count candles since last OB signal
        has_ob = (dataframe["ob_direction"] != 0).astype(int)
        # Create groups: new group starts at each OB signal
        ob_group = has_ob.cumsum()
        # Count candles within each group (resets at each OB signal)
        ob_age = ob_group.groupby(ob_group).cumcount()
        # Invalidate if OB is too old (beyond 2x lookback)
        stale_ob = ob_age > (lb * 2)
        dataframe.loc[stale_ob, "active_ob_top"] = 0.0
        dataframe.loc[stale_ob, "active_ob_bottom"] = 0.0

        # Propagate liq_swept forward
        dataframe["recent_liq_swept"] = (
            dataframe["liq_swept"].rolling(lb, min_periods=1).max()
        )

        # --- Continuous features for FreqAI (supplement sparse 0/1 signals) ---

        # Swing high/low tracking: forward-fill last known swing high and swing low
        swing_high_raw = dataframe.loc[dataframe["swing_hl"] == 1, "swing_level"]
        swing_low_raw = dataframe.loc[dataframe["swing_hl"] == -1, "swing_level"]
        dataframe["swing_high"] = swing_high_raw.reindex(dataframe.index).ffill().fillna(0)
        dataframe["swing_low"] = swing_low_raw.reindex(dataframe.index).ffill().fillna(0)

        # ATR for volatility feature
        dataframe["atr_14"] = ta.ATR(dataframe["high"], dataframe["low"],
                                     dataframe["close"], timeperiod=14)

        # FreqAI / LumiLearning — only run if enabled in config
        if self.freqai and hasattr(self, 'freqai') and self.config.get('freqai', {}).get('enabled', False):
            dataframe = self.freqai.start(dataframe, metadata, self)

        return dataframe

    # --- FreqAI feature engineering methods ---

    def feature_engineering_expand_all(self, dataframe, period, metadata, **kwargs):
        dataframe["%-close_pct"] = dataframe["close"].pct_change(period)
        dataframe["%-volume_pct"] = dataframe["volume"].pct_change(period)
        dataframe["%-high_low_pct"] = (dataframe["high"] - dataframe["low"]) / dataframe["close"]
        return dataframe

    def feature_engineering_expand_basic(self, dataframe, metadata, **kwargs):
        dataframe["%-rsi"] = ta.RSI(dataframe["close"], timeperiod=14)
        dataframe["%-mfi"] = ta.MFI(dataframe["high"], dataframe["low"], dataframe["close"], dataframe["volume"], timeperiod=14)
        dataframe["%-adx"] = ta.ADX(dataframe["high"], dataframe["low"], dataframe["close"], timeperiod=14)
        return dataframe

    def feature_engineering_standard(self, dataframe, metadata, **kwargs):
        # Use SMC indicators as ML features.
        # SMC library returns NaN for non-signal candles — fillna(0) first.
        # These features are sparse (mostly 0), so VarianceThreshold(threshold=0) in
        # datasieve's pipeline would drop any column with zero variance across a training
        # window where no signal fired. Adding tiny Gaussian noise (std=0.001) ensures
        # every column has non-zero variance and survives the filter. The noise is small
        # enough to not affect model signal — the actual signal values are ±1.
        rng = np.random.default_rng(seed=42)
        for src, dst in [
            ("bos", "%-bos"),
            ("choch", "%-choch"),
            ("ob_direction", "%-ob_direction"),
            ("fvg_direction", "%-fvg_direction"),
            ("swing_hl", "%-swing_hl"),
            ("liquidity", "%-liquidity"),
            ("liq_swept", "%-liq_swept"),
            ("recent_bos", "%-recent_bos"),
            ("recent_choch", "%-recent_choch"),
            ("recent_ob", "%-recent_ob"),
            ("recent_fvg", "%-recent_fvg"),
            ("recent_liq_swept", "%-recent_liq_swept"),
        ]:
            base = dataframe[src].fillna(0) if src in dataframe.columns else 0
            dataframe[dst] = base + rng.normal(0, 0.001, len(dataframe))

        # --- Continuous-value features (solve LightGBM "No further splits") ---
        # These give LightGBM real gradients to split on, unlike sparse 0/1 signals.

        close = dataframe["close"]

        # Helper: safe column access — always returns a Series, never bare int
        def _col(name, default=0):
            if name in dataframe.columns:
                return dataframe[name]
            return pd.Series(default, index=dataframe.index)

        # 1. OB distance: how far price is relative to active OB zone
        ob_top = _col("active_ob_top")
        ob_bot = _col("active_ob_bottom")
        ob_range = ob_top - ob_bot
        ob_range_safe = ob_range.replace(0, np.nan)
        dataframe["%-ob_distance"] = ((close - ob_bot) / ob_range_safe).fillna(-1)
        dataframe["%-ob_width"] = (ob_range / close).fillna(0)

        # 2. FVG distance: how far price is relative to last FVG zone
        fvg_top = _col("fvg_top").replace(0, np.nan).ffill().fillna(0)
        fvg_bot = _col("fvg_bottom").replace(0, np.nan).ffill().fillna(0)
        fvg_range = fvg_top - fvg_bot
        fvg_range_safe = fvg_range.replace(0, np.nan)
        dataframe["%-fvg_distance"] = ((close - fvg_bot) / fvg_range_safe).fillna(-1)
        dataframe["%-fvg_width"] = (fvg_range / close).fillna(0)

        # 3. Liquidity distance: % distance to nearest liquidity level
        liq_level = _col("liq_level").replace(0, np.nan).ffill().fillna(0)
        liq_safe = liq_level.replace(0, np.nan)
        dataframe["%-liq_distance"] = ((close - liq_safe) / close).fillna(0)

        # 4. Structure signal accumulation (rolling counts over 20 candles)
        dataframe["%-recent_bos_count"] = _col("bos").abs().rolling(20, min_periods=1).sum().fillna(0)
        dataframe["%-recent_choch_count"] = _col("choch").abs().rolling(20, min_periods=1).sum().fillna(0)
        dataframe["%-recent_fvg_count"] = _col("fvg_direction").abs().rolling(20, min_periods=1).sum().fillna(0)

        # 5. Price vs swing structure
        swing_high = _col("swing_high", default=close)
        swing_low = _col("swing_low", default=close)
        sh_safe = swing_high.replace(0, np.nan)
        sl_safe = swing_low.replace(0, np.nan)
        dataframe["%-price_vs_swing_high"] = ((close - sh_safe) / sh_safe).fillna(0)
        dataframe["%-price_vs_swing_low"] = ((close - sl_safe) / sl_safe).fillna(0)

        # 6. Normalized volatility
        dataframe["%-atr_pct"] = (_col("atr_14") / close).fillna(0)

        # Add tiny noise to continuous features to survive VarianceThreshold
        # (same technique as sparse SMC features above)
        for col in ["%-ob_distance", "%-ob_width", "%-fvg_distance", "%-fvg_width",
                     "%-liq_distance", "%-recent_bos_count", "%-recent_choch_count",
                     "%-recent_fvg_count", "%-price_vs_swing_high", "%-price_vs_swing_low",
                     "%-atr_pct"]:
            if col in dataframe.columns:
                dataframe[col] = dataframe[col] + rng.normal(0, 0.001, len(dataframe))

        return dataframe

    def set_freqai_targets(self, dataframe, metadata, **kwargs):
        # Predict if price will go up by more than 1% in next 12 candles
        dataframe["&-target"] = (
            dataframe["close"].shift(-12) / dataframe["close"] - 1
        ).clip(-0.05, 0.05)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # FreqAI prediction filter: require ML model predicts >= 0.3% upside
        # (lowered from 0.5% — previous threshold was too strict)
        freqai_ok = True  # default: pass through if FreqAI column missing
        if "&-target" in dataframe.columns:
            freqai_ok = dataframe["&-target"] > 0.003

        # Use propagated "recent_*" signals — these carry forward for signal_lookback
        # candles, solving the fundamental issue that BOS/CHoCH/OB/FVG never fire on
        # the same candle in the SMC library.

        # Primary: recent BOS/CHoCH + recent OB + FVG (strict SMC confluence)
        # Uses active OB zone (forward-filled) for price-in-OB check
        primary_long = (
            (dataframe["recent_bos"] + dataframe["recent_choch"] > 0)  # any bullish structure
            & (dataframe["recent_ob"] == 1)
            & (dataframe["fvg_direction"] == 1)
            & (dataframe["close"] >= dataframe["active_ob_bottom"])
            & (dataframe["close"] <= dataframe["active_ob_top"])
            & (dataframe["active_ob_top"] > 0)
            & (dataframe["volume"] > 0)
            & freqai_ok
        )
        dataframe.loc[primary_long, "enter_long"] = 1
        dataframe.loc[primary_long, "enter_tag"] = "smc_primary_long"

        # Fallback: recent BOS/CHoCH + FVG (no OB required — more signals)
        fallback_long = (
            (dataframe["enter_long"] != 1)
            & (dataframe["recent_bos"] + dataframe["recent_choch"] > 0)
            & (dataframe["fvg_direction"] == 1)
            & (dataframe["volume"] > 0)
            & freqai_ok
        )
        dataframe.loc[fallback_long, "enter_long"] = 1
        dataframe.loc[fallback_long, "enter_tag"] = "smc_fallback_long"

        # Minimal: FVG alone when liquidity was recently swept (catch reversals)
        minimal_long = (
            (dataframe["enter_long"] != 1)
            & (dataframe["fvg_direction"] == 1)
            & (dataframe["recent_liq_swept"] > 0)
            & (dataframe["volume"] > 0)
            & freqai_ok
        )
        dataframe.loc[minimal_long, "enter_long"] = 1
        dataframe.loc[minimal_long, "enter_tag"] = "smc_minimal_long"

        # Short entries — mirror of long with bearish signals
        # Primary: bearish structure + bearish OB + bearish FVG
        primary_short = (
            (dataframe["recent_bos"] + dataframe["recent_choch"] < 0)  # any bearish structure
            & (dataframe["recent_ob"] == -1)
            & (dataframe["fvg_direction"] == -1)
            & (dataframe["close"] >= dataframe["active_ob_bottom"])
            & (dataframe["close"] <= dataframe["active_ob_top"])
            & (dataframe["active_ob_top"] > 0)
            & (dataframe["volume"] > 0)
            & freqai_ok
        )
        dataframe.loc[primary_short, "enter_short"] = 1
        dataframe.loc[primary_short, "enter_tag"] = "smc_primary_short"

        # Fallback: bearish structure + bearish FVG
        fallback_short = (
            (dataframe["enter_short"] != 1)
            & (dataframe["recent_bos"] + dataframe["recent_choch"] < 0)
            & (dataframe["fvg_direction"] == -1)
            & (dataframe["volume"] > 0)
            & freqai_ok
        )
        dataframe.loc[fallback_short, "enter_short"] = 1
        dataframe.loc[fallback_short, "enter_tag"] = "smc_fallback_short"

        # Minimal: bearish FVG + recent liquidity sweep
        minimal_short = (
            (dataframe["enter_short"] != 1)
            & (dataframe["fvg_direction"] == -1)
            & (dataframe["recent_liq_swept"] > 0)
            & (dataframe["volume"] > 0)
            & freqai_ok
        )
        dataframe.loc[minimal_short, "enter_short"] = 1
        dataframe.loc[minimal_short, "enter_tag"] = "smc_minimal_short"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Exit long on bearish CHoCH
        dataframe.loc[
            ((dataframe["choch"] == -1) & (dataframe["volume"] > 0)),
            "exit_long",
        ] = 1

        # Exit short on bullish CHoCH
        dataframe.loc[
            ((dataframe["choch"] == 1) & (dataframe["volume"] > 0)),
            "exit_short",
        ] = 1

        return dataframe

    def leverage(self, pair, current_time, current_rate,
                 proposed_leverage, max_leverage, entry_tag, side, **kwargs):
        """Dynamic leverage based on signal quality + FreqAI confidence."""
        lev_config = self.config.get("leverage_config", {})
        if not lev_config:
            return 1.0  # no leverage config → 1x (backward compatible)

        cap = min(lev_config.get("max_leverage", 1), max_leverage)

        # Base leverage from entry_tag signal quality
        tag = entry_tag or ""
        if "primary" in tag:
            base = lev_config.get("primary", 1.0)
        elif "fallback" in tag:
            base = lev_config.get("fallback", 1.0)
        else:
            base = lev_config.get("minimal", 1.0)

        # FreqAI high-confidence boost
        if lev_config.get("freqai_boost") and self.config.get("freqai", {}).get("enabled"):
            try:
                df, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
                if not df.empty and "&-target" in df.columns:
                    pred = df.iloc[-1]["&-target"]
                    threshold = lev_config.get("freqai_threshold", 0.01)
                    if pred > threshold:
                        base += lev_config.get("freqai_bonus", 0.5)
            except Exception:
                pass

        # Liquidation safety: ensure liq distance > stoploss * 1.5
        max_safe = 1.0 / (abs(self.stoploss) * 1.5)  # ≈ 8.66x
        leverage = max(min(base, cap, max_safe), 1.0)

        return leverage

    def custom_stoploss(
        self, pair, trade, current_time, current_rate, current_profit, **kwargs
    ):
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if dataframe.empty:
            return self.stoploss

        last = dataframe.iloc[-1]

        # If we have a swing low, use it as dynamic stop
        if last.get("swing_hl") == -1 and last.get("swing_level", 0) > 0:
            swing_low = last["swing_level"]
            sl_distance = (swing_low - current_rate) / current_rate
            return max(sl_distance, self.stoploss)

        return self.stoploss
