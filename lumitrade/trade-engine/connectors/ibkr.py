"""
IBKR Connector — async wrapper around ib_insync for Interactive Brokers TWS/Gateway.
Provides: connection management, account data, positions, historical bars, order placement.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

# ib_insync manages its own event loop which conflicts with uvicorn's asyncio loop.
# nest_asyncio allows nested event loops, resolving the conflict.
import nest_asyncio
try:
    nest_asyncio.apply()
except ValueError:
    pass  # uvloop doesn't support nest_asyncio; ib_insync uses sync wrappers instead

from ib_insync import IB, Contract, Stock, Forex, MarketOrder, LimitOrder, StopOrder

logger = logging.getLogger("lumitrade.ibkr")


class IBKRConnector:
    """Async-friendly IBKR connector using ib_insync."""

    def __init__(self, host: str = "127.0.0.1", port: int = 4002, client_id: int = 1):
        self._host = host
        self._port = port
        self._client_id = client_id
        self._ib = IB()

    # --- Connection ---

    @property
    def connected(self) -> bool:
        return self._ib.isConnected()

    async def connect(self) -> bool:
        """Connect to TWS/Gateway. Returns True on success, False on failure."""
        if self._ib.isConnected():
            return True
        try:
            await self._ib.connectAsync(
                self._host, self._port, clientId=self._client_id, timeout=10
            )
            logger.info("IBKR connected to %s:%s (client %s)", self._host, self._port, self._client_id)
            return True
        except Exception as e:
            logger.warning("IBKR connection failed: %s", e)
            return False

    async def disconnect(self):
        """Disconnect from TWS/Gateway."""
        if self._ib.isConnected():
            self._ib.disconnect()
            logger.info("IBKR disconnected")

    def status(self) -> dict:
        """Return connection status info."""
        return {
            "connected": self._ib.isConnected(),
            "host": self._host,
            "port": self._port,
            "client_id": self._client_id,
            "server_version": self._ib.client.serverVersion() if self._ib.isConnected() else None,
        }

    # --- Account ---

    async def account_summary(self) -> dict:
        """Return account summary (balance, P&L, buying power, etc.)."""
        if not self._ib.isConnected():
            raise ConnectionError("IBKR not connected")

        accounts = self._ib.managedAccounts()
        account_id = accounts[0] if accounts else ""

        summary_tags = [
            "NetLiquidation", "TotalCashValue", "BuyingPower",
            "GrossPositionValue", "UnrealizedPnL", "RealizedPnL",
            "AvailableFunds", "MaintMarginReq",
        ]
        values = await self._ib.accountSummaryAsync()
        result: dict[str, Any] = {"account_id": account_id}
        for item in values:
            if item.tag in summary_tags:
                try:
                    result[item.tag] = float(item.value)
                except (ValueError, TypeError):
                    result[item.tag] = item.value
        return result

    # --- Positions ---

    async def positions(self) -> list[dict]:
        """Return current IBKR positions."""
        if not self._ib.isConnected():
            raise ConnectionError("IBKR not connected")

        pos_list = await self._ib.reqPositionsAsync()
        results = []
        for pos in pos_list:
            results.append({
                "account": pos.account,
                "symbol": pos.contract.symbol,
                "sec_type": pos.contract.secType,
                "exchange": pos.contract.exchange,
                "currency": pos.contract.currency,
                "quantity": float(pos.position),
                "avg_cost": float(pos.avgCost),
                "market_value": float(pos.position) * float(pos.avgCost),
            })
        return results

    # --- Historical Data ---

    async def historical_bars(
        self,
        symbol: str,
        duration: str = "1 M",
        bar_size: str = "1 hour",
        sec_type: str = "STK",
        exchange: str = "SMART",
        currency: str = "USD",
    ) -> list[dict]:
        """
        Fetch historical OHLCV bars.
        duration: e.g. "1 D", "1 W", "1 M", "3 M", "1 Y"
        bar_size: e.g. "1 min", "5 mins", "15 mins", "1 hour", "1 day"
        """
        if not self._ib.isConnected():
            raise ConnectionError("IBKR not connected")

        contract = self._make_contract(symbol, sec_type, exchange, currency)
        await self._ib.qualifyContractsAsync(contract)

        bars = await self._ib.reqHistoricalDataAsync(
            contract,
            endDateTime="",
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow="TRADES" if sec_type == "STK" else "MIDPOINT",
            useRTH=True,
            formatDate=1,
        )

        return [
            {
                "date": str(b.date),
                "open": b.open,
                "high": b.high,
                "low": b.low,
                "close": b.close,
                "volume": int(b.volume),
                "average": b.average,
                "bar_count": b.barCount,
            }
            for b in bars
        ]

    # --- Order Placement ---

    async def place_order(
        self,
        symbol: str,
        direction: str,
        quantity: float,
        order_type: str = "MKT",
        limit_price: float | None = None,
        stop_price: float | None = None,
        sec_type: str = "STK",
        exchange: str = "SMART",
        currency: str = "USD",
    ) -> dict:
        """
        Place an order. Returns trade info.
        direction: "BUY" or "SELL"
        order_type: "MKT", "LMT", "STP"
        """
        if not self._ib.isConnected():
            raise ConnectionError("IBKR not connected")

        contract = self._make_contract(symbol, sec_type, exchange, currency)
        await self._ib.qualifyContractsAsync(contract)

        action = direction.upper()
        if action not in ("BUY", "SELL"):
            raise ValueError(f"Invalid direction: {direction}, must be BUY or SELL")

        if order_type == "MKT":
            order = MarketOrder(action, quantity)
        elif order_type == "LMT":
            if limit_price is None:
                raise ValueError("limit_price required for LMT order")
            order = LimitOrder(action, quantity, limit_price)
        elif order_type == "STP":
            if stop_price is None:
                raise ValueError("stop_price required for STP order")
            order = StopOrder(action, quantity, stop_price)
        else:
            raise ValueError(f"Unsupported order_type: {order_type}")

        trade = self._ib.placeOrder(contract, order)

        # Wait briefly for order acknowledgement
        await asyncio.sleep(0.5)

        return {
            "order_id": trade.order.orderId,
            "symbol": symbol,
            "action": action,
            "quantity": quantity,
            "order_type": order_type,
            "status": trade.orderStatus.status,
            "filled": trade.orderStatus.filled,
            "avg_fill_price": trade.orderStatus.avgFillPrice,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    # --- Helpers ---

    @staticmethod
    def _make_contract(
        symbol: str,
        sec_type: str = "STK",
        exchange: str = "SMART",
        currency: str = "USD",
    ) -> Contract:
        """Create an ib_insync Contract from simple params."""
        if sec_type == "CASH" or "/" in symbol:
            parts = symbol.split("/") if "/" in symbol else [symbol[:3], symbol[3:]]
            return Forex(parts[0] + parts[1])
        return Stock(symbol, exchange, currency)
