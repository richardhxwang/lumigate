"""
manual/models.py -- Pydantic data models for manual trading system.

PendingTrade: pre-confirmation state (60s TTL, awaiting user confirm).
OpenTrade: live trade with OKX order IDs, tracked until close.
"""

import uuid
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel, Field


class PendingTrade(BaseModel):
    """
    A trade proposal awaiting user confirmation.
    Created after risk checks pass, expires after 60 seconds.
    """
    callback_id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    symbol: str                          # e.g. BTC/USDT:USDT
    direction: str                       # "long" or "short"
    leverage: int                        # 1-50
    entry_price: float                   # current market price at proposal time
    stop_loss: float
    take_profit: float
    margin: float                        # USDT margin (capital allocated)
    position_size: float                 # contracts / quantity
    risk_usd: float                      # USD at risk (margin * sl_pct)
    rr_ratio: float                      # reward / risk ratio
    mood_score: int | None = None        # -5 to +5
    risk_checks: list[dict] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc) + timedelta(seconds=60)
    )

    @property
    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.expires_at


class OpenTrade(BaseModel):
    """
    An active trade on OKX, tracked from open to close.
    """
    trade_id: str = Field(default_factory=lambda: uuid.uuid4().hex[:16])
    pb_record_id: str = ""               # PocketBase trade_history record ID
    symbol: str
    direction: str
    leverage: int
    entry_price: float
    stop_loss: float
    take_profit: float
    margin: float                        # USDT margin committed
    okx_order_ids: list[str] = Field(default_factory=list)  # [market_order, sl_algo, tp_algo]
    opened_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    mood_score: int | None = None


class TradeRequest(BaseModel):
    """Incoming request to open a manual trade."""
    symbol: str                          # e.g. BTC/USDT:USDT
    direction: str                       # "long" or "short"
    leverage: int = 10                   # 1-50
    sl_pct: float                        # stop loss as % from entry (e.g. 1.0 = 1%)
    tp_pct: float                        # take profit as % from entry
    risk_pct: float | None = None        # override: % of capital to risk (default from config)
    mood_score: int | None = None        # optional mood score


class CloseRequest(BaseModel):
    """Request to close an open trade."""
    trade_id: str                        # OpenTrade.trade_id or callback_id
    reason: str = "manual"               # manual / sl / tp / liquidation
