"""
Data models for manual trading system.
Day 1 — defines all Pydantic models used across the manual trading pipeline.
"""

from datetime import datetime, timezone
from enum import Enum
from pydantic import BaseModel, Field
from typing import Optional
import uuid


class TradeDirection(str, Enum):
    LONG = "long"
    SHORT = "short"


class TradeStatus(str, Enum):
    PROPOSED = "proposed"
    CONFIRMED = "confirmed"
    OPEN = "open"
    CLOSED = "closed"
    EXPIRED = "expired"
    REJECTED = "rejected"


class MoodLevel(int, Enum):
    """1-5 mood scale: 1=terrible, 5=great."""
    TERRIBLE = 1
    BAD = 2
    NEUTRAL = 3
    GOOD = 4
    GREAT = 5


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class ProposeTradeRequest(BaseModel):
    symbol: str = Field(..., description="Trading pair, e.g. BTC/USDT:USDT")
    direction: TradeDirection
    leverage: float = Field(default=1.0, ge=1.0, le=125.0)
    stop_loss: Optional[float] = Field(default=None, description="SL price; auto-calculated if omitted")
    take_profit: Optional[float] = Field(default=None, description="TP price; auto-calculated if omitted")
    size_usdt: Optional[float] = Field(default=None, description="Position size in USDT; auto-calculated if omitted")
    mood: Optional[int] = Field(default=None, ge=1, le=5, description="Pre-trade mood score 1-5")
    note: Optional[str] = Field(default=None, description="Trade rationale / journal note")


class CloseTradeRequest(BaseModel):
    trade_id: Optional[str] = Field(default=None, description="PB record ID of the trade to close")
    symbol: Optional[str] = Field(default=None, description="Symbol to close (if trade_id not known)")


class MoodRequest(BaseModel):
    score: int = Field(..., ge=1, le=5)
    note: str = ""
    chat_id: Optional[str] = None


class ReviewRequest(BaseModel):
    days: int = Field(default=7, ge=1, le=90)


# ---------------------------------------------------------------------------
# Internal models (not API-facing)
# ---------------------------------------------------------------------------

class TradeProposal(BaseModel):
    """Pending trade waiting for user confirmation. Expires after 60s."""
    callback_id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    symbol: str
    direction: TradeDirection
    leverage: float
    entry_price: float
    stop_loss: float
    take_profit: float
    size_usdt: float
    size_contracts: float = 0.0
    risk_usd: float = 0.0
    reward_usd: float = 0.0
    risk_reward: float = 0.0
    position_pct: float = 0.0
    portfolio_value: float = 0.0
    mood: Optional[int] = None
    note: Optional[str] = None
    risk_checks: list[dict] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.expires_at


class OpenTrade(BaseModel):
    """Tracks an open manual trade."""
    trade_id: str  # PB record ID
    symbol: str
    direction: TradeDirection
    leverage: float
    entry_price: float
    stop_loss: float
    take_profit: float
    size_usdt: float
    size_contracts: float
    order_id: Optional[str] = None
    sl_order_id: Optional[str] = None
    tp_order_id: Optional[str] = None
    opened_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    pb_record_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class ProposalResponse(BaseModel):
    ok: bool = True
    callback_id: str
    proposal: dict  # serialized TradeProposal
    message: str = ""


class ConfirmResponse(BaseModel):
    ok: bool = True
    trade_id: Optional[str] = None
    order_id: Optional[str] = None
    message: str = ""
    details: dict = Field(default_factory=dict)


class CloseResponse(BaseModel):
    ok: bool = True
    pnl_usdt: float = 0.0
    pnl_pct: float = 0.0
    message: str = ""


class PositionResponse(BaseModel):
    symbol: str
    direction: str
    leverage: float
    entry_price: float
    current_price: float = 0.0
    unrealized_pnl: float = 0.0
    unrealized_pnl_pct: float = 0.0
    size_usdt: float = 0.0
    stop_loss: float = 0.0
    take_profit: float = 0.0
    opened_at: Optional[str] = None
    source: str = "manual"
