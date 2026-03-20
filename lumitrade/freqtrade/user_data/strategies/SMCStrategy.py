from freqtrade.strategy import IStrategy, IntParameter, DecimalParameter
from pandas import DataFrame
import logging

logger = logging.getLogger(__name__)


class SMCStrategy(IStrategy):
    """
    Smart Money Concepts strategy for crypto markets.
    Uses BOS/CHoCH for structure, OB+FVG for entries, swing points for SL/TP.
    """

    INTERFACE_VERSION = 3
    can_short = False

    timeframe = "15m"
    startup_candle_count = 200
    process_only_new_candles = True
    use_exit_signal = True

    # Risk management
    minimal_roi = {"0": 0.06, "30": 0.04, "60": 0.02, "120": 0.01}
    stoploss = -0.03
    trailing_stop = True
    trailing_stop_positive = 0.01
    trailing_stop_positive_offset = 0.02
    trailing_only_offset_is_reached = True

    # Hyperoptable parameters
    swing_length = IntParameter(5, 50, default=10, space="buy", optimize=True)
    ob_strength_min = DecimalParameter(0.3, 0.8, default=0.5, space="buy", optimize=True)

    def informative_pairs(self):
        pairs = self.dp.current_whitelist()
        return [(pair, "1h") for pair in pairs] + [(pair, "4h") for pair in pairs]

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        try:
            from smartmoneyconcepts import smc
        except ImportError:
            logger.warning("smart-money-concepts not installed, skipping SMC indicators")
            return dataframe

        ohlc = dataframe[["open", "high", "low", "close"]].copy()

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

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Primary: BOS/CHoCH + OB + FVG (strict SMC confluence)
        dataframe.loc[
            (
                ((dataframe["bos"] == 1) | (dataframe["choch"] == 1))
                & (dataframe["ob_direction"] == 1)
                & (dataframe["fvg_direction"] == 1)
                & (dataframe["close"] >= dataframe["ob_bottom"])
                & (dataframe["close"] <= dataframe["ob_top"])
                & (dataframe["volume"] > 0)
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
            ),
            "enter_long",
        ] = 1

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Exit on bearish CHoCH (change of character = trend reversal)
        dataframe.loc[
            ((dataframe["choch"] == -1) & (dataframe["volume"] > 0)),
            "exit_long",
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
