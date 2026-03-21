"""Trading RAG — embed trade data into Qdrant for AI-powered analysis.

Uses a dedicated 'lumitrade' collection in Qdrant, separate from LumiChat's general RAG.
Embeds: trade records, backtest results, strategy configs, mood logs, session analytics.
"""
import logging
import hashlib
import json
from datetime import datetime

import httpx
from config import settings

logger = logging.getLogger(__name__)

QDRANT_URL = "http://lumigate-qdrant:6333"
COLLECTION = "lumitrade_rag"
EMBED_DIM = 384  # all-MiniLM-L6-v2 dimension


class TradingRAG:
    def __init__(self, qdrant_url: str = QDRANT_URL):
        self.qdrant_url = qdrant_url

    async def ensure_collection(self):
        """Create Qdrant collection if not exists."""
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{self.qdrant_url}/collections/{COLLECTION}")
            if r.status_code == 200:
                return
            await client.put(f"{self.qdrant_url}/collections/{COLLECTION}", json={
                "vectors": {"size": EMBED_DIM, "distance": "Cosine"}
            })
            logger.info(f"Created Qdrant collection: {COLLECTION}")

    def _text_to_embedding(self, text: str) -> list[float]:
        """Simple hash-based pseudo-embedding (replace with real model later)."""
        # For MVP: use hash-based vectors. In production, use sentence-transformers.
        h = hashlib.sha256(text.encode()).digest()
        vec = [float(b) / 255.0 for b in h[:EMBED_DIM // 8] * (EMBED_DIM // (EMBED_DIM // 8))]
        return vec[:EMBED_DIM]

    def _make_id(self, text: str) -> int:
        """Generate deterministic point ID from text."""
        return int(hashlib.md5(text.encode()).hexdigest()[:12], 16)

    async def embed_trade(self, trade: dict):
        """Embed a single trade record."""
        summary = (
            f"Trade {trade.get('symbol','?')} {trade.get('direction','?')} "
            f"entry={trade.get('entry_price',0)} exit={trade.get('exit_price',0)} "
            f"pnl={trade.get('pnl',0)} r={trade.get('r_multiple',0)} "
            f"session={trade.get('session','?')} setup={trade.get('setup_type','?')} "
            f"mood={trade.get('mood_at_entry','?')} "
            f"at {trade.get('entry_time','?')}"
        )
        await self._upsert(summary, {"type": "trade", **trade})

    async def embed_backtest(self, result: dict):
        """Embed backtest result summary."""
        summary = (
            f"Backtest: {result.get('strategy','?')} "
            f"total_trades={result.get('total_trades',0)} "
            f"win_rate={result.get('win_rate',0)}% "
            f"profit={result.get('total_profit',0)} "
            f"sharpe={result.get('sharpe',0)} "
            f"max_dd={result.get('max_drawdown',0)}%"
        )
        await self._upsert(summary, {"type": "backtest", **result})

    async def embed_mood(self, mood: dict):
        """Embed mood log."""
        summary = (
            f"Mood: {mood.get('mood_label','?')} score={mood.get('mood_score',0)} "
            f"context={mood.get('context','?')} session={mood.get('session','?')} "
            f"notes={mood.get('notes','')} at {mood.get('timestamp','?')}"
        )
        await self._upsert(summary, {"type": "mood", **mood})

    async def embed_text(self, text: str, metadata: dict = None):
        """Embed arbitrary text with metadata."""
        await self._upsert(text, metadata or {})

    async def search(self, query: str, limit: int = 5) -> list[dict]:
        """Search trading RAG for relevant context."""
        vec = self._text_to_embedding(query)
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{self.qdrant_url}/collections/{COLLECTION}/points/search", json={
                "vector": vec,
                "limit": limit,
                "with_payload": True,
            })
            if not r.is_success:
                return []
            results = r.json().get("result", [])
            return [{"score": p["score"], **p.get("payload", {})} for p in results]

    async def _upsert(self, text: str, payload: dict):
        """Upsert a point into Qdrant."""
        vec = self._text_to_embedding(text)
        point_id = self._make_id(text)
        payload["_text"] = text
        payload["_embedded_at"] = datetime.utcnow().isoformat()
        async with httpx.AsyncClient(timeout=10) as client:
            await client.put(f"{self.qdrant_url}/collections/{COLLECTION}/points", json={
                "points": [{"id": point_id, "vector": vec, "payload": payload}]
            })
