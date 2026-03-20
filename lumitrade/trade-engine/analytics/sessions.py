"""Trading session and killzone analytics.

ICT Killzones (UTC):
- Asian Session: 00:00 - 08:00 UTC (Tokyo/Sydney)
- London Killzone: 07:00 - 10:00 UTC (highest volatility overlap)
- NY AM Killzone: 12:00 - 15:00 UTC (NY open, highest volume)
- NY PM / London Close: 15:00 - 17:00 UTC
- Full London: 07:00 - 16:00 UTC
- Full NY: 12:00 - 21:00 UTC
"""

from datetime import datetime, timezone
from typing import Optional
import logging

logger = logging.getLogger(__name__)

KILLZONES = {
    "asian": (0, 8),
    "london_killzone": (7, 10),
    "ny_am_killzone": (12, 15),
    "ny_pm_killzone": (15, 17),
    "london_full": (7, 16),
    "ny_full": (12, 21),
    "overlap": (12, 16),  # London-NY overlap
}

SESSIONS = {
    "asian": (0, 8),
    "london": (7, 16),
    "new_york": (12, 21),
    "off_hours": None,  # everything else
}


def classify_session(hour_utc: int) -> str:
    for name, hours in SESSIONS.items():
        if hours is None:
            continue
        start, end = hours
        if start <= hour_utc < end:
            return name
    return "off_hours"


def classify_killzone(hour_utc: int) -> list[str]:
    zones = []
    for name, (start, end) in KILLZONES.items():
        if start <= hour_utc < end:
            zones.append(name)
    return zones if zones else ["no_killzone"]


class SessionAnalyzer:
    def analyze_trades(self, trades: list[dict]) -> dict:
        """Analyze a list of trades by session and killzone.

        Each trade should have: entry_time (ISO), pnl (float), symbol, direction
        """
        session_stats = {s: {"wins": 0, "losses": 0, "pnl": 0.0, "count": 0, "trades": []} for s in SESSIONS}
        killzone_stats = {k: {"wins": 0, "losses": 0, "pnl": 0.0, "count": 0} for k in KILLZONES}

        hourly_pnl = {h: 0.0 for h in range(24)}
        day_of_week = {d: {"wins": 0, "losses": 0, "pnl": 0.0, "count": 0} for d in ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}

        best_trade = None
        worst_trade = None
        total_pnl = 0.0
        wins = 0
        losses = 0

        for trade in trades:
            pnl = trade.get("pnl", 0)
            total_pnl += pnl

            entry_time = trade.get("entry_time", "")
            try:
                dt = datetime.fromisoformat(entry_time.replace("Z", "+00:00"))
                hour = dt.hour
                dow = dt.strftime("%a")
            except (ValueError, AttributeError):
                hour = 12
                dow = "Mon"

            session = classify_session(hour)
            zones = classify_killzone(hour)

            is_win = pnl > 0
            if is_win:
                wins += 1
            else:
                losses += 1

            # Session stats
            session_stats[session]["count"] += 1
            session_stats[session]["pnl"] += pnl
            if is_win:
                session_stats[session]["wins"] += 1
            else:
                session_stats[session]["losses"] += 1

            # Killzone stats
            for zone in zones:
                if zone in killzone_stats:
                    killzone_stats[zone]["count"] += 1
                    killzone_stats[zone]["pnl"] += pnl
                    if is_win:
                        killzone_stats[zone]["wins"] += 1
                    else:
                        killzone_stats[zone]["losses"] += 1

            # Hourly P&L
            hourly_pnl[hour] += pnl

            # Day of week
            if dow in day_of_week:
                day_of_week[dow]["count"] += 1
                day_of_week[dow]["pnl"] += pnl
                if is_win:
                    day_of_week[dow]["wins"] += 1
                else:
                    day_of_week[dow]["losses"] += 1

            # Best/worst
            if best_trade is None or pnl > best_trade.get("pnl", 0):
                best_trade = trade
            if worst_trade is None or pnl < worst_trade.get("pnl", 0):
                worst_trade = trade

        # Calculate win rates
        for stats in list(session_stats.values()) + list(killzone_stats.values()) + list(day_of_week.values()):
            total = stats.get("count", 0)
            stats["win_rate"] = round(stats["wins"] / total * 100, 1) if total > 0 else 0
            stats["pnl"] = round(stats["pnl"], 2)

        # Best/worst hours
        best_hour = max(hourly_pnl, key=hourly_pnl.get)
        worst_hour = min(hourly_pnl, key=hourly_pnl.get)

        return {
            "total_trades": len(trades),
            "wins": wins,
            "losses": losses,
            "win_rate": round(wins / len(trades) * 100, 1) if trades else 0,
            "total_pnl": round(total_pnl, 2),
            "best_trade": best_trade,
            "worst_trade": worst_trade,
            "sessions": {k: {kk: vv for kk, vv in v.items() if kk != "trades"} for k, v in session_stats.items()},
            "killzones": killzone_stats,
            "hourly_pnl": {str(h).zfill(2): round(v, 2) for h, v in hourly_pnl.items()},
            "day_of_week": day_of_week,
            "best_hour_utc": best_hour,
            "worst_hour_utc": worst_hour,
            "insights": generate_insights(session_stats, killzone_stats, day_of_week, wins, losses),
        }


def generate_insights(sessions, killzones, dow, wins, losses) -> list[str]:
    insights = []

    # Best session
    best_session = max(sessions.items(), key=lambda x: x[1]["pnl"])
    if best_session[1]["count"] > 0:
        insights.append(f"Best session: {best_session[0]} ({best_session[1]['pnl']:+.2f}, {best_session[1]['win_rate']}% win rate)")

    # Best killzone
    active_kz = {k: v for k, v in killzones.items() if v["count"] > 0}
    if active_kz:
        best_kz = max(active_kz.items(), key=lambda x: x[1]["pnl"])
        insights.append(f"Best killzone: {best_kz[0].replace('_', ' ')} ({best_kz[1]['pnl']:+.2f})")

    # Best day
    active_days = {k: v for k, v in dow.items() if v["count"] > 0}
    if active_days:
        best_day = max(active_days.items(), key=lambda x: x[1]["pnl"])
        worst_day = min(active_days.items(), key=lambda x: x[1]["pnl"])
        insights.append(f"Best day: {best_day[0]} ({best_day[1]['pnl']:+.2f})")
        if worst_day[1]["pnl"] < 0:
            insights.append(f"Avoid trading on {worst_day[0]} ({worst_day[1]['pnl']:+.2f})")

    # Overall
    total = wins + losses
    if total > 0:
        wr = wins / total * 100
        if wr < 50:
            insights.append(f"Win rate {wr:.0f}% is below 50% — review entry criteria")
        elif wr > 65:
            insights.append(f"Strong {wr:.0f}% win rate — maintain current approach")

    return insights
