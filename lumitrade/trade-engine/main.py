"""
LumiTrade Engine — FastAPI service for SMC analysis, risk management, and trade orchestration.
Runs as a Docker container, communicates with LumiGate (Node.js) via HTTP.
"""

from contextlib import asynccontextmanager
from datetime import datetime, timezone

import asyncio
import json
import logging
import random

import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from pydantic import BaseModel

from config import settings
from connectors.ibkr import IBKRConnector
from connectors.freqtrade import FreqtradeConnector
from risk.manager import RiskManager
from analytics.sessions import SessionAnalyzer
from analytics.reports import generate_performance_report, generate_html_report
from analytics.mood_correlator import MoodCorrelator
from strategies.smc_strategy import SMCAnalyzer

logger = logging.getLogger("lumitrade")

risk_manager = RiskManager(settings)
smc_analyzer = SMCAnalyzer()
session_analyzer = SessionAnalyzer()
mood_correlator = MoodCorrelator()
http_client: httpx.AsyncClient | None = None
ibkr_connector: IBKRConnector | None = None
ft_connector = FreqtradeConnector()


# --- WebSocket Connection Manager ---

class ConnectionManager:
    """Manages active WebSocket connections. Thread-safe via asyncio."""

    def __init__(self):
        self._market_connections: list[WebSocket] = []
        self._signal_connections: list[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect_market(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self._market_connections.append(websocket)

    async def connect_signals(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self._signal_connections.append(websocket)

    async def disconnect_market(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self._market_connections:
                self._market_connections.remove(websocket)

    async def disconnect_signals(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self._signal_connections:
                self._signal_connections.remove(websocket)

    async def broadcast_market(self, message: dict):
        async with self._lock:
            stale: list[WebSocket] = []
            for ws in self._market_connections:
                try:
                    await ws.send_json(message)
                except Exception:
                    stale.append(ws)
            for ws in stale:
                self._market_connections.remove(ws)

    async def broadcast_signals(self, message: dict):
        async with self._lock:
            stale: list[WebSocket] = []
            for ws in self._signal_connections:
                try:
                    await ws.send_json(message)
                except Exception:
                    stale.append(ws)
            for ws in stale:
                self._signal_connections.remove(ws)

    async def broadcast(self, message: dict):
        """Broadcast to all connection pools."""
        await self.broadcast_market(message)
        await self.broadcast_signals(message)


ws_manager = ConnectionManager()


_pb_token: str = ""
_pb_token_exp: float = 0

async def get_pb_token() -> str:
    """Get PB admin token, cached for 30 min."""
    global _pb_token, _pb_token_exp
    import time
    if _pb_token and time.time() < _pb_token_exp:
        return _pb_token
    if not settings.pb_admin_email or not settings.pb_admin_password:
        return ""
    try:
        resp = await http_client.post(
            f"{settings.pb_url}/api/collections/_superusers/auth-with-password",
            json={"identity": settings.pb_admin_email, "password": settings.pb_admin_password},
        )
        if resp.is_success:
            _pb_token = resp.json().get("token", "")
            _pb_token_exp = time.time() + 1800
            return _pb_token
    except Exception:
        pass
    return ""

async def pb_get(path: str, params: dict = None) -> httpx.Response:
    """GET from PocketBase with admin auth."""
    token = await get_pb_token()
    headers = {"Authorization": token} if token else {}
    return await http_client.get(f"{settings.pb_url}{path}", params=params, headers=headers)


async def notify_clients(event_type: str, data: dict):
    """Broadcast an event to all connected WebSocket clients."""
    message = {
        "type": event_type,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if event_type in ("signal_new", "signal"):
        await ws_manager.broadcast_signals(message)
    await ws_manager.broadcast_market(message)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client, ibkr_connector
    http_client = httpx.AsyncClient(timeout=30.0)

    # IBKR connector — non-blocking, log if TWS/Gateway is unavailable
    ibkr_connector = IBKRConnector(
        host=settings.ibkr_host,
        port=settings.ibkr_port,
        client_id=settings.ibkr_client_id,
    )
    try:
        connected = await ibkr_connector.connect()
        if connected:
            logger.info("IBKR connector ready")
        else:
            logger.warning("IBKR not available at startup — endpoints will return 503 until connected")
    except Exception as e:
        logger.warning("IBKR startup connection error (non-fatal): %s", e)

    yield

    # Shutdown
    if ibkr_connector:
        await ibkr_connector.disconnect()
    await http_client.aclose()


app = FastAPI(title="LumiTrade Engine", version="0.1.0", lifespan=lifespan)


# --- Health ---

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "trade-engine",
        "version": "0.1.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# --- Analysis ---

class AnalyzeRequest(BaseModel):
    symbol: str
    timeframes: list[str] | None = None
    include_news: bool = False


class Signal(BaseModel):
    symbol: str
    direction: str  # long / short
    entry: float
    stop_loss: float
    take_profit: float
    risk_reward: float
    confidence: float  # 0-1
    timeframe: str
    indicators: dict
    timestamp: str


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    """Run SMC analysis on a symbol across timeframes."""
    timeframes = req.timeframes or settings.default_timeframes
    try:
        result = await smc_analyzer.analyze(req.symbol, timeframes)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    signals = result.get("signals", [])

    if req.include_news and settings.finnhub_api_key:
        from news.sentiment import get_sentiment_score
        sentiment = await get_sentiment_score(req.symbol, http_client)
        for sig in signals:
            sig["news_sentiment"] = sentiment
        result["news_sentiment"] = sentiment

    return result


# --- Risk Check ---

class RiskCheckRequest(BaseModel):
    symbol: str
    direction: str
    entry: float
    stop_loss: float
    take_profit: float
    position_size_pct: float
    portfolio_value: float


@app.post("/risk-check")
async def risk_check(req: RiskCheckRequest):
    """Check if a trade passes risk management rules. Returns pass/fail + reasons."""
    result = risk_manager.check(
        symbol=req.symbol,
        direction=req.direction,
        entry=req.entry,
        stop_loss=req.stop_loss,
        take_profit=req.take_profit,
        position_size_pct=req.position_size_pct,
        portfolio_value=req.portfolio_value,
    )
    return result


# --- Signals ---

@app.get("/signals")
async def list_signals(symbol: str | None = None, limit: int = 50):
    """List recent signals from PocketBase."""
    filter_q = f"symbol='{symbol}'" if symbol else ""
    try:
        resp = await pb_get(
            "/api/collections/trade_signals/records",
            params={"filter": filter_q, "perPage": limit},
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"PocketBase error: {e}")


# --- Positions ---

@app.get("/positions")
async def list_positions(status: str = "open"):
    """List positions from PocketBase."""
    try:
        resp = await pb_get(
            "/api/collections/trade_positions/records",
            params={"filter": f"status='{status}'", "perPage": 100},
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"PocketBase error: {e}")


# --- Journal Analytics ---

@app.get("/journal/analytics")
async def journal_analytics(days: int = 30):
    """Analyze trading performance by session, killzone, and day of week."""
    try:
        resp = await pb_get(
            "/api/collections/trade_history/records",
            params={"perPage": 500},
        )
        if not resp.is_success:
            return {"error": "Failed to fetch trades from PB"}
        data = resp.json()
        trades = data.get("items", [])
        result = session_analyzer.analyze_trades(trades)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/journal/mood-analysis")
async def mood_analysis():
    """Analyze correlation between mood and trading performance."""
    try:
        trades_resp = await pb_get(
            "/api/collections/trade_history/records",
            params={"perPage": 500},
        )
        trades = trades_resp.json().get("items", []) if trades_resp.is_success else []

        mood_resp = await pb_get(
            "/api/collections/trade_mood_logs/records",
            params={"perPage": 500},
        )
        mood_logs = mood_resp.json().get("items", []) if mood_resp.is_success else []

        return mood_correlator.analyze(trades, mood_logs)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Performance Reports (QuantStats) ---

@app.get("/reports/performance")
async def performance_report():
    """Return QuantStats performance metrics from trade history."""
    try:
        resp = await pb_get(
            "/api/collections/trade_history/records",
            params={"perPage": 500},
        )
        trades = resp.json().get("items", []) if resp.is_success else []
        result = await generate_performance_report(trades)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/reports/tearsheet")
async def tearsheet_report():
    """Return full HTML tear sheet report."""
    from fastapi.responses import HTMLResponse
    try:
        resp = await pb_get(
            "/api/collections/trade_history/records",
            params={"perPage": 500},
        )
        trades = resp.json().get("items", []) if resp.is_success else []
        html = await generate_html_report(trades)
        return HTMLResponse(content=html)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- IBKR Endpoints ---

def _require_ibkr():
    """Raise 503 if IBKR connector is not connected."""
    if ibkr_connector is None or not ibkr_connector.connected:
        raise HTTPException(status_code=503, detail="IBKR not connected")


@app.get("/ibkr/status")
async def ibkr_status():
    """Return IBKR connection status."""
    if ibkr_connector is None:
        return {"connected": False, "detail": "Connector not initialized"}
    return ibkr_connector.status()


@app.get("/ibkr/positions")
async def ibkr_positions():
    """Return current IBKR positions."""
    _require_ibkr()
    try:
        positions = await ibkr_connector.positions()
        return {"positions": positions, "count": len(positions)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"IBKR error: {e}")


@app.get("/ibkr/account")
async def ibkr_account():
    """Return IBKR account summary."""
    _require_ibkr()
    try:
        summary = await ibkr_connector.account_summary()
        return summary
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"IBKR error: {e}")


@app.get("/ibkr/history/{symbol}")
async def ibkr_history(
    symbol: str,
    duration: str = Query(default="1 M", description="e.g. 1 D, 1 W, 1 M, 3 M, 1 Y"),
    bar_size: str = Query(default="1 hour", description="e.g. 1 min, 5 mins, 15 mins, 1 hour, 1 day"),
    sec_type: str = Query(default="STK"),
    exchange: str = Query(default="SMART"),
    currency: str = Query(default="USD"),
):
    """Return historical OHLCV bars from IBKR."""
    _require_ibkr()
    try:
        bars = await ibkr_connector.historical_bars(
            symbol=symbol,
            duration=duration,
            bar_size=bar_size,
            sec_type=sec_type,
            exchange=exchange,
            currency=currency,
        )
        return {"symbol": symbol, "bars": bars, "count": len(bars)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"IBKR error: {e}")


class IBKROrderRequest(BaseModel):
    symbol: str
    direction: str  # BUY / SELL
    quantity: float
    order_type: str = "MKT"  # MKT / LMT / STP
    limit_price: float | None = None
    stop_price: float | None = None
    sec_type: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    # Risk check fields
    entry: float
    stop_loss: float
    take_profit: float
    position_size_pct: float
    portfolio_value: float


@app.post("/ibkr/order")
async def ibkr_order(req: IBKROrderRequest):
    """Place an IBKR order after mandatory risk check."""
    _require_ibkr()

    # Mandatory risk check before any order
    risk_result = risk_manager.check(
        symbol=req.symbol,
        direction=req.direction.lower(),
        entry=req.entry,
        stop_loss=req.stop_loss,
        take_profit=req.take_profit,
        position_size_pct=req.position_size_pct,
        portfolio_value=req.portfolio_value,
    )
    if not risk_result["passed"]:
        return {"executed": False, "reason": "risk_check_failed", "details": risk_result}

    try:
        result = await ibkr_connector.place_order(
            symbol=req.symbol,
            direction=req.direction,
            quantity=req.quantity,
            order_type=req.order_type,
            limit_price=req.limit_price,
            stop_price=req.stop_price,
            sec_type=req.sec_type,
            exchange=req.exchange,
            currency=req.currency,
        )
        return {"executed": True, "broker": "ibkr", "result": result}
    except Exception as e:
        return {"executed": False, "broker": "ibkr", "error": str(e)}


# --- Freqtrade Endpoints ---

@app.get("/freqtrade/status")
async def ft_status():
    """Return freqtrade connection status, open trades, and profit summary."""
    try:
        is_alive = await ft_connector.ping()
        if not is_alive:
            return {"connected": False, "error": "Freqtrade not reachable"}
        status = await ft_connector.get_status()
        count = await ft_connector.get_count()
        profit = await ft_connector.get_profit()
        return {"connected": True, "open_trades": status, "count": count, "profit": profit}
    except Exception as e:
        return {"connected": False, "error": str(e)}


@app.get("/freqtrade/trades")
async def ft_trades(limit: int = 50):
    """Return completed trades from freqtrade."""
    try:
        return await ft_connector.get_trades(limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/freqtrade/performance")
async def ft_performance():
    """Return per-pair performance stats from freqtrade."""
    try:
        return await ft_connector.get_performance()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/freqtrade/balance")
async def ft_balance():
    """Return exchange balance from freqtrade."""
    try:
        return await ft_connector.get_balance()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# --- Backtest ---

class BacktestRequest(BaseModel):
    symbol: str
    timeframe: str = "1h"
    start_date: str | None = None
    end_date: str | None = None
    initial_capital: float = 100000.0


@app.post("/backtest")
async def run_backtest(req: BacktestRequest):
    """Run SMC strategy backtest using vectorbt."""
    try:
        from strategies.backtester import run_smc_backtest
        result = await run_smc_backtest(
            symbol=req.symbol,
            timeframe=req.timeframe,
            start_date=req.start_date,
            end_date=req.end_date,
            initial_capital=req.initial_capital,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Execute Trade ---

class ExecuteRequest(BaseModel):
    symbol: str
    direction: str
    entry: float
    stop_loss: float
    take_profit: float
    position_size_pct: float
    portfolio_value: float
    broker: str  # ibkr / okx
    auto: bool = False


@app.post("/execute")
async def execute_trade(req: ExecuteRequest):
    """Execute a trade after risk check. Auto-executes only if position <= auto_exec_max_pct."""
    # Mandatory risk check
    risk_result = risk_manager.check(
        symbol=req.symbol,
        direction=req.direction,
        entry=req.entry,
        stop_loss=req.stop_loss,
        take_profit=req.take_profit,
        position_size_pct=req.position_size_pct,
        portfolio_value=req.portfolio_value,
    )

    if not risk_result["passed"]:
        return {"executed": False, "reason": "risk_check_failed", "details": risk_result}

    # Auto-execution gate
    if req.position_size_pct > settings.auto_exec_max_pct and req.auto:
        return {
            "executed": False,
            "reason": "requires_confirmation",
            "message": f"Position {req.position_size_pct}% exceeds auto-exec limit {settings.auto_exec_max_pct}%",
        }

    # Route to broker
    if req.broker == "okx":
        return await _execute_via_freqtrade(req)
    elif req.broker == "ibkr":
        return await _execute_via_lumibot(req)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown broker: {req.broker}")


async def _execute_via_freqtrade(req: ExecuteRequest) -> dict:
    """Execute crypto trade via freqtrade REST API."""
    try:
        resp = await http_client.post(
            f"{settings.freqtrade_url}/api/v1/forcebuy",
            json={"pair": req.symbol, "price": req.entry},
            auth=(settings.freqtrade_username, settings.freqtrade_password),
        )
        resp.raise_for_status()
        return {"executed": True, "broker": "freqtrade", "result": resp.json()}
    except Exception as e:
        return {"executed": False, "broker": "freqtrade", "error": str(e)}


async def _execute_via_lumibot(req: ExecuteRequest) -> dict:
    """Execute stock trade via IBKR connector."""
    if ibkr_connector is None or not ibkr_connector.connected:
        return {
            "executed": False,
            "broker": "ibkr",
            "error": "IBKR not connected — ensure TWS/Gateway is running",
        }

    # Map direction to IBKR action
    action = "BUY" if req.direction.lower() == "long" else "SELL"

    # Calculate quantity from position_size_pct and portfolio_value
    risk_amount = req.portfolio_value * (req.position_size_pct / 100.0)
    risk_per_share = abs(req.entry - req.stop_loss)
    quantity = max(1, int(risk_amount / risk_per_share)) if risk_per_share > 0 else 1

    try:
        result = await ibkr_connector.place_order(
            symbol=req.symbol,
            direction=action,
            quantity=quantity,
            order_type="LMT",
            limit_price=req.entry,
        )
        return {"executed": True, "broker": "ibkr", "result": result}
    except Exception as e:
        return {"executed": False, "broker": "ibkr", "error": str(e)}


# --- WebSocket: Market Feed ---

def _placeholder_price(symbol: str) -> dict:
    """Generate placeholder price data for a symbol."""
    base = 150.0 if "/" not in symbol else 60000.0
    price = round(base + random.uniform(-5, 5), 4)
    return {
        "symbol": symbol,
        "price": price,
        "bid": round(price - random.uniform(0.01, 0.1), 4),
        "ask": round(price + random.uniform(0.01, 0.1), 4),
        "volume": random.randint(100, 50000),
    }


@app.websocket("/ws/market")
async def ws_market(
    websocket: WebSocket,
    symbols: str = Query(default="AAPL,BTC/USDT"),
):
    """
    Real-time market data feed.
    Connect with ?symbols=AAPL,BTC/USDT to subscribe.
    Pushes: price_update, signal_new, position_update, risk_alert.
    """
    await ws_manager.connect_market(websocket)
    symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
    try:
        # Send initial snapshot
        for sym in symbol_list:
            await websocket.send_json({
                "type": "price_update",
                "data": _placeholder_price(sym),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        # Continuous feed loop — also listens for client messages
        while True:
            # Push price updates every 3 seconds
            # Use wait_for so we can also detect client disconnect
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=3.0)
                # Client can send updated symbol list: {"symbols": "TSLA,ETH/USDT"}
                try:
                    payload = json.loads(msg)
                    if "symbols" in payload:
                        symbol_list = [s.strip() for s in payload["symbols"].split(",") if s.strip()]
                except (json.JSONDecodeError, AttributeError):
                    pass
            except asyncio.TimeoutError:
                pass

            for sym in symbol_list:
                await websocket.send_json({
                    "type": "price_update",
                    "data": _placeholder_price(sym),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect_market(websocket)


# --- WebSocket: Signal Feed ---

@app.websocket("/ws/signals")
async def ws_signals(websocket: WebSocket):
    """
    Real-time SMC signal feed.
    Pushes new signals as they are generated by the analysis engine.
    For now, sends placeholder signals periodically for testing.
    """
    await ws_manager.connect_signals(websocket)
    try:
        while True:
            # Placeholder: emit a synthetic signal every 10 seconds for testing
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
                # Client can send ping or config; ignored for now
            except asyncio.TimeoutError:
                pass

            placeholder_signal = {
                "symbol": random.choice(["AAPL", "BTC/USDT", "EURUSD", "SPY", "ETH/USDT"]),
                "direction": random.choice(["long", "short"]),
                "entry": round(random.uniform(100, 70000), 2),
                "stop_loss": round(random.uniform(90, 69000), 2),
                "take_profit": round(random.uniform(110, 72000), 2),
                "risk_reward": round(random.uniform(1.5, 4.0), 2),
                "confidence": round(random.uniform(0.5, 0.95), 3),
                "timeframe": random.choice(["5m", "15m", "1h", "4h", "1d"]),
                "indicators": {
                    "order_block": True,
                    "fair_value_gap": random.choice([True, False]),
                    "break_of_structure": random.choice([True, False]),
                },
            }

            await websocket.send_json({
                "type": "signal",
                "data": placeholder_signal,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect_signals(websocket)
