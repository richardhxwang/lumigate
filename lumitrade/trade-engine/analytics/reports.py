"""Trading performance reports using QuantStats."""
import logging
from datetime import datetime
from io import StringIO

import math

import pandas as pd

logger = logging.getLogger(__name__)


def _safe_float(val, decimals: int = 2, multiplier: float = 1.0) -> float:
    """Convert a value to a JSON-safe float, replacing NaN/Inf with 0."""
    try:
        f = float(val) * multiplier
        if math.isnan(f) or math.isinf(f):
            return 0.0
        return round(f, decimals)
    except (TypeError, ValueError):
        return 0.0


async def generate_performance_report(trades: list[dict], benchmark: str = "SPY") -> dict:
    """Generate performance analytics from trade history.

    Args:
        trades: List of trade dicts with: entry_time, exit_time, pnl, pnl_pct
        benchmark: Benchmark symbol for comparison

    Returns: dict with metrics
    """
    if not trades:
        return {"error": "No trades to analyze"}

    try:
        import quantstats as qs
    except ImportError:
        return {"error": "quantstats not installed"}

    # Build returns series from trades
    returns_data = []
    for t in trades:
        try:
            exit_time = t.get("exit_time", t.get("closed_at", ""))
            pnl_pct = t.get("pnl_pct", 0)
            if exit_time and pnl_pct:
                dt = pd.to_datetime(exit_time)
                returns_data.append({"date": dt, "return": pnl_pct / 100})
        except (ValueError, TypeError):
            continue

    if not returns_data:
        return {"error": "No valid trade returns data"}

    df = pd.DataFrame(returns_data)
    df = df.groupby("date")["return"].sum()
    df = df.sort_index()

    # Calculate metrics
    try:
        metrics = {
            "total_return": _safe_float(qs.stats.comp(df), 2, 100),
            "cagr": _safe_float(qs.stats.cagr(df), 2, 100) if len(df) > 1 else 0,
            "sharpe": _safe_float(qs.stats.sharpe(df), 3),
            "sortino": _safe_float(qs.stats.sortino(df), 3),
            "max_drawdown": _safe_float(qs.stats.max_drawdown(df), 2, 100),
            "calmar": _safe_float(qs.stats.calmar(df), 3) if len(df) > 1 else 0,
            "win_rate": _safe_float(qs.stats.win_rate(df), 1, 100),
            "profit_factor": _safe_float(qs.stats.profit_factor(df), 2),
            "avg_win": _safe_float(qs.stats.avg_win(df), 2, 100),
            "avg_loss": _safe_float(qs.stats.avg_loss(df), 2, 100),
            "payoff_ratio": _safe_float(qs.stats.payoff_ratio(df), 2),
            "volatility": _safe_float(qs.stats.volatility(df), 2, 100),
            "best_day": _safe_float(df.max(), 2, 100),
            "worst_day": _safe_float(df.min(), 2, 100),
            "total_trades": len(trades),
            "trading_days": len(df),
        }
    except Exception as e:
        logger.warning(f"QuantStats metrics error: {e}")
        metrics = {"error": str(e)}

    return metrics


async def generate_html_report(trades: list[dict]) -> str:
    """Generate full HTML tear sheet report."""
    try:
        import quantstats as qs
    except ImportError:
        return "<p>quantstats not installed</p>"

    returns_data = []
    for t in trades:
        try:
            exit_time = t.get("exit_time", t.get("closed_at", ""))
            pnl_pct = t.get("pnl_pct", 0)
            if exit_time and pnl_pct:
                dt = pd.to_datetime(exit_time)
                returns_data.append({"date": dt, "return": pnl_pct / 100})
        except Exception:
            continue

    if not returns_data:
        return "<p>No trade data available</p>"

    df = pd.DataFrame(returns_data)
    df = df.groupby("date")["return"].sum().sort_index()

    try:
        buf = StringIO()
        qs.reports.html(df, output=buf, title="LumiTrade Performance")
        return buf.getvalue()
    except Exception as e:
        return f"<p>Report generation error: {e}</p>"
