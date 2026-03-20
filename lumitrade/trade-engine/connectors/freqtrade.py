"""Freqtrade REST API connector."""
import logging
import httpx
from config import settings

logger = logging.getLogger(__name__)


class FreqtradeConnector:
    def __init__(self):
        self.base_url = settings.freqtrade_url
        self.username = settings.freqtrade_username
        self.password = settings.freqtrade_password
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
