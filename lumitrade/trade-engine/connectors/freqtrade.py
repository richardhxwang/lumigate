"""Freqtrade REST API connector — supports multiple bots."""
import asyncio
import logging
import httpx
from config import settings

logger = logging.getLogger(__name__)


class FreqtradeConnector:
    def __init__(self, base_url: str = "", username: str = "", password: str = ""):
        self.base_url = base_url or settings.freqtrade_url
        self.username = username or settings.freqtrade_username
        self.password = password or settings.freqtrade_password
        self._token = None

    async def _get(self, path: str) -> dict:
        """GET with HTTP Basic Auth (freqtrade's default auth method)."""
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{self.base_url}{path}",
                auth=(self.username, self.password),
            )
            resp.raise_for_status()
            return resp.json()

    async def _post(self, path: str, body: dict | None = None) -> dict:
        """POST with HTTP Basic Auth."""
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{self.base_url}{path}",
                json=body or {},
                auth=(self.username, self.password),
            )
            resp.raise_for_status()
            return resp.json()

    async def _delete(self, path: str) -> dict:
        """DELETE with HTTP Basic Auth."""
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.delete(
                f"{self.base_url}{path}",
                auth=(self.username, self.password),
            )
            resp.raise_for_status()
            return resp.json()

    async def ping(self) -> bool:
        try:
            data = await self._get("/api/v1/ping")
            return data.get("status") == "pong"
        except:
            return False

    async def get_status(self) -> list:
        """Get open trades."""
        return await self._get("/api/v1/status")

    async def get_count(self) -> dict:
        return await self._get("/api/v1/count")

    async def get_profit(self) -> dict:
        return await self._get("/api/v1/profit")

    async def get_trades(self, limit=50) -> dict:
        return await self._get(f"/api/v1/trades?limit={limit}")

    async def get_performance(self) -> list:
        return await self._get("/api/v1/performance")

    async def get_balance(self) -> dict:
        return await self._get("/api/v1/balance")

    async def get_config(self) -> dict:
        return await self._get("/api/v1/show_config")

    async def get_locks(self) -> dict:
        return await self._get("/api/v1/locks")

    async def get_logs(self, limit=50) -> dict:
        return await self._get(f"/api/v1/logs?limit={limit}")

    async def forceexit(self, trade_id: int | str) -> dict:
        """Force-exit a specific trade by ID."""
        return await self._post("/api/v1/forceexit", {"tradeid": str(trade_id)})

    async def forceexit_all(self) -> list[dict]:
        """Force-exit ALL open trades on this bot."""
        results = []
        try:
            trades = await self.get_status()
            if not isinstance(trades, list):
                trades = []
            for trade in trades:
                tid = trade.get("trade_id")
                if tid is None:
                    continue
                try:
                    res = await self.forceexit(tid)
                    results.append({"trade_id": tid, "ok": True, "result": res})
                except Exception as e:
                    results.append({"trade_id": tid, "ok": False, "error": str(e)})
        except Exception as e:
            results.append({"error": f"Failed to list trades: {e}"})
        return results

    async def stop_buy(self) -> dict:
        """Pause new entries by setting max_open_trades=0 via stopbuy endpoint."""
        return await self._post("/api/v1/stopbuy")


# ---------------------------------------------------------------------------
# Multi-bot connector — polls all bots in parallel
# ---------------------------------------------------------------------------

# All known bot instances (Docker service hostnames on the same network).
# Group A = standard, Group B = leveraged.
BOT_CONFIGS = [
    {"name": "LumiLearning",      "url": "http://lumigate-freqtrade:8080",          "group": "A"},
    {"name": "PureSMC",           "url": "http://lumigate-freqtrade-pure:8080",     "group": "A"},
    {"name": "AI-Enhanced",       "url": "http://lumigate-freqtrade-ai:8080",       "group": "A"},
    {"name": "LumiLearning-Lev",  "url": "http://lumigate-freqtrade-lev:8080",     "group": "B"},
    {"name": "PureSMC-Lev",       "url": "http://lumigate-freqtrade-pure-lev:8080", "group": "B"},
    {"name": "AI-Enhanced-Lev",   "url": "http://lumigate-freqtrade-ai-lev:8080",  "group": "B"},
]


class MultiBotConnector:
    """Manages connections to all freqtrade bot instances."""

    def __init__(self):
        self.bots: list[FreqtradeConnector] = []
        self.bot_labels: list[str] = []
        self.bot_groups: list[str] = []
        for cfg in BOT_CONFIGS:
            self.bots.append(FreqtradeConnector(
                base_url=cfg["url"],
                username=settings.freqtrade_username,
                password=settings.freqtrade_password,
            ))
            self.bot_labels.append(cfg["name"])
            self.bot_groups.append(cfg["group"])

    # ── Helper: run a method on one bot, never raise ──

    async def _safe_call(self, idx: int, method: str, *args, **kwargs):
        """Call a method on bot[idx]. Returns (label, group, result_or_None)."""
        bot = self.bots[idx]
        label = self.bot_labels[idx]
        group = self.bot_groups[idx]
        try:
            result = await getattr(bot, method)(*args, **kwargs)
            return (label, group, result)
        except Exception as e:
            logger.debug("Failed to poll %s %s: %s", label, method, e)
            return (label, group, None)

    # ── Parallel data fetchers ──

    async def get_all_open_trades(self) -> list[dict]:
        """Fetch open trades from all bots in parallel. Returns list with _bot label attached."""
        results = await asyncio.gather(
            *[self._safe_call(i, "get_status") for i in range(len(self.bots))]
        )
        all_trades = []
        for label, _group, trades in results:
            if isinstance(trades, list):
                for t in trades:
                    t["_bot"] = label
                all_trades.extend(trades)
        return all_trades

    async def get_all_profit(self) -> list[dict]:
        """Fetch profit summary from all bots in parallel."""
        results = await asyncio.gather(
            *[self._safe_call(i, "get_profit") for i in range(len(self.bots))]
        )
        out = []
        for label, _group, profit in results:
            if isinstance(profit, dict):
                profit["_bot"] = label
                out.append(profit)
        return out

    async def get_all_balance(self) -> list[dict]:
        """Fetch balance from all bots in parallel."""
        results = await asyncio.gather(
            *[self._safe_call(i, "get_balance") for i in range(len(self.bots))]
        )
        out = []
        for label, _group, balance in results:
            if isinstance(balance, dict):
                balance["_bot"] = label
                out.append(balance)
        return out

    async def get_all_bots_status(self) -> list[dict]:
        """
        Get comprehensive status for every bot: online/offline, open trades, profit.
        Each bot is queried in parallel. Offline bots return gracefully.
        Used by LumiTrader context to give AI visibility into all bots.
        """
        async def _fetch_one(idx: int) -> dict:
            bot = self.bots[idx]
            label = self.bot_labels[idx]
            group = self.bot_groups[idx]
            entry = {"name": label, "group": group, "online": False,
                     "open_trades": [], "trade_count": 0, "profit": None}
            try:
                alive = await bot.ping()
            except Exception:
                alive = False
            if not alive:
                return entry
            entry["online"] = True
            # Fetch status + profit concurrently within this bot
            status_res, profit_res = await asyncio.gather(
                bot.get_status(), bot.get_profit(),
                return_exceptions=True,
            )
            if isinstance(status_res, list):
                entry["open_trades"] = status_res
                entry["trade_count"] = len(status_res)
            if isinstance(profit_res, dict):
                entry["profit"] = profit_res
            return entry

        return list(await asyncio.gather(
            *[_fetch_one(i) for i in range(len(self.bots))]
        ))

    # ── Data for alerts ──

    async def get_all_trades(self, limit: int = 20) -> list[dict]:
        """Fetch recent closed trades from all bots. Returns list with _bot label."""
        results = await asyncio.gather(
            *[self._safe_call(i, "get_trades", limit=limit) for i in range(len(self.bots))]
        )
        all_trades = []
        for label, _group, data in results:
            if isinstance(data, dict):
                trades = data.get("trades", [])
            elif isinstance(data, list):
                trades = data
            else:
                continue
            for t in trades:
                t["_bot"] = label
            all_trades.extend(trades)
        return all_trades

    async def get_all_logs(self, limit: int = 50) -> dict[str, list]:
        """Fetch recent logs from all bots. Returns {bot_name: [log_entries]}."""
        results = await asyncio.gather(
            *[self._safe_call(i, "get_logs", limit=limit) for i in range(len(self.bots))]
        )
        out = {}
        for label, _group, data in results:
            if isinstance(data, dict):
                out[label] = data.get("logs", [])
            else:
                out[label] = []
        return out

    async def ping_all(self) -> dict[str, bool]:
        """Ping all bots, return {bot_name: is_online}."""
        results = await asyncio.gather(
            *[self._safe_call(i, "ping") for i in range(len(self.bots))]
        )
        return {label: (result is True) for label, _group, result in results}

    # ── Bulk actions ──

    async def forceexit_all_bots(self) -> dict:
        """Force-exit ALL trades on ALL bots in parallel."""
        results_list = await asyncio.gather(
            *[self._safe_call(i, "forceexit_all") for i in range(len(self.bots))]
        )
        results = {}
        for label, _group, res in results_list:
            if res is not None:
                results[label] = {"ok": True, "exits": res}
            else:
                results[label] = {"ok": False, "error": "call failed"}
        return results

    async def stop_buy_all_bots(self) -> dict:
        """Pause new entries on ALL bots in parallel."""
        results_list = await asyncio.gather(
            *[self._safe_call(i, "stop_buy") for i in range(len(self.bots))]
        )
        results = {}
        for label, _group, res in results_list:
            if res is not None:
                results[label] = {"ok": True, "result": res}
            else:
                results[label] = {"ok": False, "error": "call failed"}
        return results
