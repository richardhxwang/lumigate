"""
connectors/okx_manual.py -- CCXT-based OKX connector for manual high-leverage trading.

Uses ccxt.okx (sync) wrapped in asyncio.to_thread for non-blocking calls.
Supports perpetual swap contracts (USDT-margined), isolated margin mode.

Key operations:
- get_balance: USDT available balance
- get_ticker: current price for a symbol
- get_positions: open positions on OKX
- open_position: set leverage -> market order -> attach SL/TP algo orders
- close_position: market close a position
- set_leverage: configure leverage for a symbol
"""

import asyncio
import logging
from typing import Any

import ccxt

from config import settings

logger = logging.getLogger("lumitrade.okx_manual")


class OKXManualConnector:
    """
    Direct OKX connection via CCXT for manual trading.
    Independent from freqtrade -- uses its own API key (OKX_KEY_LUMITRADE).
    Uses sync ccxt wrapped in asyncio.to_thread to avoid blocking the event loop.
    """

    def __init__(
        self,
        api_key: str = "",
        api_secret: str = "",
        passphrase: str = "",
        sandbox: bool = False,
    ):
        self._api_key = api_key or settings.manual_okx_api_key
        self._api_secret = api_secret or settings.manual_okx_api_secret
        self._passphrase = passphrase or settings.manual_okx_passphrase

        self._exchange: ccxt.okx | None = None
        self._sandbox = sandbox

    def _get_exchange(self) -> ccxt.okx:
        """Lazy-init the CCXT exchange instance (sync, reused across calls)."""
        if self._exchange is None:
            self._exchange = ccxt.okx({
                "apiKey": self._api_key,
                "secret": self._api_secret,
                "password": self._passphrase,
                "enableRateLimit": True,
                "options": {
                    "defaultType": "swap",  # perpetual contracts
                },
            })
            if self._sandbox:
                self._exchange.set_sandbox_mode(True)
            logger.info("OKX Manual connector initialized (sandbox=%s)", self._sandbox)
        return self._exchange

    # ------------------------------------------------------------------
    # Async wrappers (run sync ccxt in thread pool)
    # ------------------------------------------------------------------

    async def _run(self, fn, *args, **kwargs) -> Any:
        """Run a sync CCXT method in a thread to avoid blocking the event loop."""
        return await asyncio.to_thread(fn, *args, **kwargs)

    # ------------------------------------------------------------------
    # Market data
    # ------------------------------------------------------------------

    async def get_ticker(self, symbol: str) -> dict:
        """
        Get current ticker for a symbol.

        Args:
            symbol: e.g. "BTC/USDT:USDT"

        Returns:
            dict with last, bid, ask, high, low, volume, etc.
        """
        ex = self._get_exchange()
        ticker = await self._run(ex.fetch_ticker, symbol)
        return {
            "symbol": symbol,
            "last": ticker.get("last"),
            "bid": ticker.get("bid"),
            "ask": ticker.get("ask"),
            "high": ticker.get("high"),
            "low": ticker.get("low"),
            "volume": ticker.get("baseVolume"),
            "timestamp": ticker.get("timestamp"),
        }

    # ------------------------------------------------------------------
    # Account
    # ------------------------------------------------------------------

    async def get_balance(self) -> dict:
        """
        Get trading account balance.

        Returns:
            dict with total, free, used USDT balances.
        """
        ex = self._get_exchange()
        balance = await self._run(ex.fetch_balance, {"type": "swap"})
        usdt = balance.get("USDT", {})
        return {
            "total": usdt.get("total", 0.0),
            "free": usdt.get("free", 0.0),
            "used": usdt.get("used", 0.0),
            "currency": "USDT",
        }

    async def get_positions(self, symbol: str | None = None) -> list[dict]:
        """
        Get open positions.

        Args:
            symbol: optional filter by symbol. None = all positions.

        Returns:
            list of position dicts (only non-empty positions).
        """
        ex = self._get_exchange()
        symbols = [symbol] if symbol else None
        positions = await self._run(ex.fetch_positions, symbols)

        result = []
        for pos in positions:
            contracts = float(pos.get("contracts", 0))
            if contracts == 0:
                continue  # skip empty positions
            result.append({
                "symbol": pos.get("symbol"),
                "side": pos.get("side"),              # "long" or "short"
                "contracts": contracts,
                "notional": float(pos.get("notional", 0)),
                "leverage": int(float(pos.get("leverage", 1))),
                "entry_price": float(pos.get("entryPrice", 0)),
                "mark_price": float(pos.get("markPrice", 0)),
                "liquidation_price": float(pos.get("liquidationPrice", 0)),
                "unrealized_pnl": float(pos.get("unrealizedPnl", 0)),
                "margin": float(pos.get("initialMargin", 0)),
                "margin_mode": pos.get("marginMode", "isolated"),
                "timestamp": pos.get("timestamp"),
            })
        return result

    # ------------------------------------------------------------------
    # Leverage
    # ------------------------------------------------------------------

    async def set_leverage(self, symbol: str, leverage: int) -> dict:
        """
        Set leverage for a symbol (isolated margin mode).

        Args:
            symbol:   e.g. "BTC/USDT:USDT"
            leverage: 1-50

        Returns:
            OKX response dict.
        """
        ex = self._get_exchange()
        # OKX requires setting margin mode to isolated first
        try:
            await self._run(ex.set_margin_mode, "isolated", symbol)
        except ccxt.ExchangeError as e:
            # "Margin mode is already set" is fine
            if "already" not in str(e).lower():
                logger.warning("set_margin_mode error for %s: %s", symbol, e)

        result = await self._run(ex.set_leverage, leverage, symbol, {"mgnMode": "isolated"})
        logger.info("Leverage set: %s %dx", symbol, leverage)
        return result

    # ------------------------------------------------------------------
    # Order execution
    # ------------------------------------------------------------------

    async def open_position(
        self,
        symbol: str,
        direction: str,
        leverage: int,
        amount: float,
        stop_loss: float | None = None,
        take_profit: float | None = None,
    ) -> dict:
        """
        Open a leveraged position:
        1. Set leverage (isolated margin)
        2. Place market order
        3. Attach SL/TP as algo (conditional) orders

        Args:
            symbol:      e.g. "BTC/USDT:USDT"
            direction:   "long" or "short"
            leverage:    1-50
            amount:      position size in contracts (base currency units)
            stop_loss:   SL trigger price (optional)
            take_profit: TP trigger price (optional)

        Returns:
            dict with order IDs and status.
        """
        ex = self._get_exchange()
        order_ids = []

        # 1. Set leverage
        await self.set_leverage(symbol, leverage)

        # 2. Market order
        side = "buy" if direction == "long" else "sell"
        logger.info(
            "Opening %s %s: %s %.6f contracts @ market, %dx leverage",
            direction, symbol, side, amount, leverage,
        )

        market_order = await self._run(
            ex.create_order,
            symbol,
            "market",
            side,
            amount,
            None,  # price=None for market orders
            {"tdMode": "isolated"},
        )
        market_order_id = market_order.get("id", "")
        order_ids.append(market_order_id)
        logger.info("Market order placed: %s (id=%s)", symbol, market_order_id)

        # 3. Attach SL algo order
        sl_order_id = ""
        if stop_loss is not None:
            try:
                sl_side = "sell" if direction == "long" else "buy"
                sl_order = await self._run(
                    ex.create_order,
                    symbol,
                    "market",
                    sl_side,
                    amount,
                    None,
                    {
                        "tdMode": "isolated",
                        "stopLossPrice": stop_loss,
                        "reduceOnly": True,
                    },
                )
                sl_order_id = sl_order.get("id", "")
                order_ids.append(sl_order_id)
                logger.info("SL algo order placed: %s @ %.2f (id=%s)", symbol, stop_loss, sl_order_id)
            except Exception as e:
                logger.error("Failed to place SL for %s: %s", symbol, e)

        # 4. Attach TP algo order
        tp_order_id = ""
        if take_profit is not None:
            try:
                tp_side = "sell" if direction == "long" else "buy"
                tp_order = await self._run(
                    ex.create_order,
                    symbol,
                    "market",
                    tp_side,
                    amount,
                    None,
                    {
                        "tdMode": "isolated",
                        "takeProfitPrice": take_profit,
                        "reduceOnly": True,
                    },
                )
                tp_order_id = tp_order.get("id", "")
                order_ids.append(tp_order_id)
                logger.info("TP algo order placed: %s @ %.2f (id=%s)", symbol, take_profit, tp_order_id)
            except Exception as e:
                logger.error("Failed to place TP for %s: %s", symbol, e)

        # Get fill price from market order
        fill_price = float(market_order.get("average", 0) or market_order.get("price", 0) or 0)

        return {
            "success": True,
            "symbol": symbol,
            "direction": direction,
            "leverage": leverage,
            "amount": amount,
            "fill_price": fill_price,
            "market_order_id": market_order_id,
            "sl_order_id": sl_order_id,
            "tp_order_id": tp_order_id,
            "order_ids": order_ids,
        }

    async def close_position(
        self,
        symbol: str,
        direction: str,
        amount: float | None = None,
    ) -> dict:
        """
        Close a position (full or partial).

        Args:
            symbol:    e.g. "BTC/USDT:USDT"
            direction: "long" or "short" (the position being closed)
            amount:    contracts to close. None = close entire position.

        Returns:
            dict with order details.
        """
        ex = self._get_exchange()

        # If no amount specified, fetch current position size
        if amount is None:
            positions = await self.get_positions(symbol)
            for pos in positions:
                if pos["side"] == direction:
                    amount = pos["contracts"]
                    break
            if amount is None or amount == 0:
                return {"success": False, "error": f"No open {direction} position for {symbol}"}

        # Close = opposite side order with reduceOnly
        close_side = "sell" if direction == "long" else "buy"

        logger.info("Closing %s %s: %s %.6f contracts @ market", direction, symbol, close_side, amount)

        order = await self._run(
            ex.create_order,
            symbol,
            "market",
            close_side,
            amount,
            None,
            {
                "tdMode": "isolated",
                "reduceOnly": True,
            },
        )

        fill_price = float(order.get("average", 0) or order.get("price", 0) or 0)

        # Cancel any remaining SL/TP algo orders for this symbol
        try:
            open_orders = await self._run(ex.fetch_open_orders, symbol)
            for oo in open_orders:
                try:
                    await self._run(ex.cancel_order, oo["id"], symbol)
                    logger.info("Cancelled residual order %s for %s", oo["id"], symbol)
                except Exception as e:
                    logger.warning("Failed to cancel order %s: %s", oo["id"], e)
        except Exception as e:
            logger.warning("Failed to fetch/cancel open orders for %s: %s", symbol, e)

        return {
            "success": True,
            "symbol": symbol,
            "direction": direction,
            "close_side": close_side,
            "amount": amount,
            "fill_price": fill_price,
            "order_id": order.get("id", ""),
        }

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    async def ping(self) -> bool:
        """Check if OKX connection is alive."""
        try:
            ex = self._get_exchange()
            await self._run(ex.fetch_status)
            return True
        except Exception as e:
            logger.debug("OKX ping failed: %s", e)
            return False

    async def get_market_info(self, symbol: str) -> dict | None:
        """Get market info (min order size, tick size, contract size, etc.)."""
        try:
            ex = self._get_exchange()
            await self._run(ex.load_markets)
            market = ex.market(symbol)
            return {
                "symbol": symbol,
                "min_amount": market.get("limits", {}).get("amount", {}).get("min"),
                "min_cost": market.get("limits", {}).get("cost", {}).get("min"),
                "price_precision": market.get("precision", {}).get("price"),
                "amount_precision": market.get("precision", {}).get("amount"),
                "contract_size": market.get("contractSize"),
            }
        except Exception as e:
            logger.error("Failed to get market info for %s: %s", symbol, e)
            return None
