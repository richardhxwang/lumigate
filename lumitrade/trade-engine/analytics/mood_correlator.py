"""Mood-performance correlation analysis.

Correlates trader's emotional state with trading outcomes to identify:
- Which moods lead to best/worst performance
- Tilt detection (deteriorating performance after losses)
- Optimal trading conditions (mood + session + market)
"""
import logging
from collections import defaultdict
from datetime import datetime

logger = logging.getLogger(__name__)

MOOD_LABELS = [
    "calm", "confident", "focused", "excited",
    "anxious", "fearful", "greedy", "frustrated",
    "bored", "euphoric", "revenge", "tilted",
]


class MoodCorrelator:
    """Analyze correlation between mood and trading performance."""

    def analyze(self, trades: list[dict], mood_logs: list[dict]) -> dict:
        """
        Cross-reference mood logs with trade outcomes.

        trades: [{entry_time, pnl, pnl_pct, r_multiple, symbol, session, ...}]
        mood_logs: [{timestamp, mood_label, mood_score, trade_id, context, ...}]
        """
        if not trades:
            return {"error": "No trades to analyze"}

        # Index mood logs by trade_id and by timestamp
        mood_by_trade = {}
        for m in mood_logs:
            tid = m.get("trade_id", "")
            if tid:
                mood_by_trade[tid] = m

        # Analyze by mood label
        mood_performance = defaultdict(lambda: {
            "count": 0, "wins": 0, "losses": 0,
            "total_pnl": 0.0, "total_r": 0.0,
            "pnls": [], "r_values": [],
        })

        # Analyze tilt (consecutive losses -> mood deterioration -> more losses)
        streak = 0
        tilt_trades = []  # trades made after 3+ consecutive losses
        normal_trades = []

        for i, trade in enumerate(trades):
            pnl = trade.get("pnl", 0)
            r_mult = trade.get("r_multiple", 0)
            trade_id = trade.get("id", "")

            # Get mood for this trade
            mood = trade.get("mood_at_entry", "")
            mood_score = trade.get("mood_score", 0)
            if not mood and trade_id in mood_by_trade:
                mood = mood_by_trade[trade_id].get("mood_label", "unknown")
                mood_score = mood_by_trade[trade_id].get("mood_score", 0)
            if not mood:
                mood = "unknown"

            # Track by mood
            mp = mood_performance[mood]
            mp["count"] += 1
            mp["total_pnl"] += pnl
            mp["total_r"] += r_mult
            mp["pnls"].append(pnl)
            mp["r_values"].append(r_mult)
            if pnl > 0:
                mp["wins"] += 1
            else:
                mp["losses"] += 1

            # Track streaks for tilt detection
            if pnl > 0:
                streak = max(streak + 1, 1)
            else:
                streak = min(streak - 1, -1)

            if streak <= -3:
                tilt_trades.append(trade)
            else:
                normal_trades.append(trade)

        # Calculate stats per mood
        mood_stats = {}
        for mood, mp in mood_performance.items():
            if mp["count"] == 0:
                continue
            mood_stats[mood] = {
                "count": mp["count"],
                "wins": mp["wins"],
                "losses": mp["losses"],
                "win_rate": round(mp["wins"] / mp["count"] * 100, 1),
                "total_pnl": round(mp["total_pnl"], 2),
                "avg_pnl": round(mp["total_pnl"] / mp["count"], 2),
                "total_r": round(mp["total_r"], 2),
                "avg_r": round(mp["total_r"] / mp["count"], 2),
            }

        # Sort by win rate
        mood_stats = dict(sorted(mood_stats.items(), key=lambda x: x[1]["win_rate"], reverse=True))

        # Tilt analysis
        tilt_pnl = sum(t.get("pnl", 0) for t in tilt_trades)
        normal_pnl = sum(t.get("pnl", 0) for t in normal_trades)
        tilt_wr = sum(1 for t in tilt_trades if t.get("pnl", 0) > 0) / len(tilt_trades) * 100 if tilt_trades else 0
        normal_wr = sum(1 for t in normal_trades if t.get("pnl", 0) > 0) / len(normal_trades) * 100 if normal_trades else 0

        # Mood + Session cross analysis
        mood_session = defaultdict(lambda: defaultdict(lambda: {"count": 0, "wins": 0, "pnl": 0.0}))
        for trade in trades:
            mood = trade.get("mood_at_entry", "unknown")
            session = trade.get("session", "unknown")
            pnl = trade.get("pnl", 0)
            ms = mood_session[mood][session]
            ms["count"] += 1
            ms["pnl"] += pnl
            if pnl > 0:
                ms["wins"] += 1

        mood_session_stats = {}
        for mood, sessions in mood_session.items():
            mood_session_stats[mood] = {}
            for session, stats in sessions.items():
                mood_session_stats[mood][session] = {
                    "count": stats["count"],
                    "win_rate": round(stats["wins"] / stats["count"] * 100, 1) if stats["count"] > 0 else 0,
                    "pnl": round(stats["pnl"], 2),
                }

        # Generate insights
        insights = []
        if mood_stats:
            best = next(iter(mood_stats))
            worst = list(mood_stats.keys())[-1]
            if mood_stats[best]["count"] >= 3:
                insights.append(f"Best mood for trading: '{best}' ({mood_stats[best]['win_rate']}% win rate, avg {mood_stats[best]['avg_r']:+.1f}R)")
            if mood_stats[worst]["count"] >= 3 and worst != best:
                insights.append(f"Worst mood: '{worst}' ({mood_stats[worst]['win_rate']}% win rate, avg {mood_stats[worst]['avg_r']:+.1f}R)")

        if tilt_trades:
            insights.append(f"Tilt detection: {len(tilt_trades)} trades after 3+ losses, win rate {tilt_wr:.0f}% vs normal {normal_wr:.0f}%")
            if tilt_pnl < 0:
                insights.append(f"Tilt cost you ${abs(tilt_pnl):.2f}. Consider taking a break after 3 consecutive losses.")

        return {
            "mood_performance": mood_stats,
            "tilt_analysis": {
                "tilt_trades": len(tilt_trades),
                "tilt_pnl": round(tilt_pnl, 2),
                "tilt_win_rate": round(tilt_wr, 1),
                "normal_trades": len(normal_trades),
                "normal_pnl": round(normal_pnl, 2),
                "normal_win_rate": round(normal_wr, 1),
            },
            "mood_session_cross": mood_session_stats,
            "insights": insights,
            "total_trades_analyzed": len(trades),
            "mood_logs_matched": len(mood_by_trade),
        }
