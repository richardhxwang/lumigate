from freqtrade.strategy import IStrategy, IntParameter, DecimalParameter
from pandas import DataFrame
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
    can_short = False  # Set True only with futures trading_mode

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

    def informative_pairs(self):
        pairs = self.dp.current_whitelist()
        return [(pair, "1h") for pair in pairs] + [(pair, "4h") for pair in pairs]

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
            dataframe["liq_swept"] = liq["Swept"]
        except Exception as e:
            logger.debug(f"liquidity failed: {e}")
            dataframe["liquidity"] = 0
            dataframe["liq_level"] = 0.0
            dataframe["liq_swept"] = 0

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
        ]:
            base = dataframe[src].fillna(0) if src in dataframe.columns else 0
            dataframe[dst] = base + rng.normal(0, 0.001, len(dataframe))
        return dataframe

    def set_freqai_targets(self, dataframe, metadata, **kwargs):
        # Predict if price will go up by more than 1% in next 12 candles
        dataframe["&-target"] = (
            dataframe["close"].shift(-12) / dataframe["close"] - 1
        ).clip(-0.05, 0.05)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # FreqAI prediction filter: require ML model predicts >= 0.5% upside
        freqai_ok = True  # default: pass through if FreqAI column missing
        if "&-target" in dataframe.columns:
            freqai_ok = dataframe["&-target"] > 0.005

        # Primary: BOS/CHoCH + OB + FVG (strict SMC confluence)
        dataframe.loc[
            (
                ((dataframe["bos"] == 1) | (dataframe["choch"] == 1))
                & (dataframe["ob_direction"] == 1)
                & (dataframe["fvg_direction"] == 1)
                & (dataframe["close"] >= dataframe["ob_bottom"])
                & (dataframe["close"] <= dataframe["ob_top"])
                & (dataframe["volume"] > 0)
                & freqai_ok
            ),
            "enter_long",
        ] = 1

        # Fallback: BOS/CHoCH + FVG (no OB required — more signals)
        dataframe.loc[
            (
                (dataframe["enter_long"] != 1)
                & ((dataframe["bos"] == 1) | (dataframe["choch"] == 1))
                & (dataframe["fvg_direction"] == 1)
                & (dataframe["volume"] > 0)
                & freqai_ok
            ),
            "enter_long",
        ] = 1

        # Minimal: FVG alone when liquidity was just swept (catch reversals)
        dataframe.loc[
            (
                (dataframe["enter_long"] != 1)
                & (dataframe["fvg_direction"] == 1)
                & (dataframe["liq_swept"] == 1)
                & (dataframe["volume"] > 0)
                & freqai_ok
            ),
            "enter_long",
        ] = 1

        # Short entries — mirror of long with bearish signals (-1)
        # Primary: bearish BOS/CHoCH + bearish OB + bearish FVG
        dataframe.loc[
            (
                ((dataframe["bos"] == -1) | (dataframe["choch"] == -1))
                & (dataframe["ob_direction"] == -1)
                & (dataframe["fvg_direction"] == -1)
                & (dataframe["close"] >= dataframe["ob_bottom"])
                & (dataframe["close"] <= dataframe["ob_top"])
                & (dataframe["volume"] > 0)
                & freqai_ok
            ),
            "enter_short",
        ] = 1

        # Fallback: bearish BOS/CHoCH + bearish FVG
        dataframe.loc[
            (
                (dataframe["enter_short"] != 1)
                & ((dataframe["bos"] == -1) | (dataframe["choch"] == -1))
                & (dataframe["fvg_direction"] == -1)
                & (dataframe["volume"] > 0)
                & freqai_ok
            ),
            "enter_short",
        ] = 1

        # Minimal: bearish FVG + liquidity swept (BSL sweep → short)
        dataframe.loc[
            (
                (dataframe["enter_short"] != 1)
                & (dataframe["fvg_direction"] == -1)
                & (dataframe["liq_swept"] == 1)
                & (dataframe["volume"] > 0)
                & freqai_ok
            ),
            "enter_short",
        ] = 1

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
