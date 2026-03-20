"""Telegram notification service for IBKR-side trading alerts."""
import logging
import httpx
from config import settings

logger = logging.getLogger(__name__)


class TelegramNotifier:
    def __init__(self, token: str = "", chat_id: str = ""):
        self.token = token or settings.telegram_bot_token
        self.chat_id = chat_id or settings.telegram_chat_id
        self._enabled = bool(self.token and self.chat_id)

    @property
    def enabled(self):
        return self._enabled

    async def send(self, message: str, parse_mode: str = "HTML"):
        if not self._enabled:
            logger.debug("Telegram not configured, skipping notification")
            return False
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json={
                    "chat_id": self.chat_id,
                    "text": message,
                    "parse_mode": parse_mode,
                })
                if resp.status_code == 200:
                    return True
                logger.warning(f"Telegram send failed: {resp.status_code} {resp.text}")
                return False
        except Exception as e:
            logger.warning(f"Telegram send error: {e}")
            return False

    async def notify_signal(self, signal: dict):
        direction = "LONG" if signal.get("direction") == "long" else "SHORT"
        emoji_dir = "UP" if direction == "LONG" else "DOWN"
        msg = (
            f"<b>{emoji_dir} New Signal: {signal.get('symbol', '?')}</b>\n"
            f"Direction: <b>{direction}</b>\n"
            f"Entry: {signal.get('entry', '?')}\n"
            f"SL: {signal.get('stop_loss', '?')} | TP: {signal.get('take_profit', '?')}\n"
            f"R:R: {signal.get('risk_reward', '?')} | Confidence: {signal.get('confidence', '?')}\n"
            f"Timeframe: {signal.get('timeframe', '?')}\n"
            f"Source: SMC Analysis"
        )
        return await self.send(msg)

    async def notify_trade_executed(self, trade: dict):
        msg = (
            f"<b>Trade Executed</b>\n"
            f"Symbol: {trade.get('symbol', '?')}\n"
            f"Action: {trade.get('action', '?')}\n"
            f"Qty: {trade.get('quantity', '?')}\n"
            f"Broker: {trade.get('broker', '?')}\n"
            f"Status: {trade.get('status', '?')}"
        )
        return await self.send(msg)

    async def notify_risk_alert(self, alert: dict):
        msg = (
            f"<b>RISK ALERT</b>\n"
            f"Rule: {alert.get('rule', '?')}\n"
            f"Detail: {alert.get('detail', '?')}"
        )
        return await self.send(msg)
