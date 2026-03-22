from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Service
    host: str = "0.0.0.0"
    port: int = 3200

    # PocketBase
    pb_url: str = "http://pocketbase:8090"
    pb_admin_email: str = ""
    pb_admin_password: str = ""

    # Finnhub
    finnhub_api_key: str = ""

    # Telegram (for IBKR-side notifications; freqtrade has its own)
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""

    # LunarCrush (crypto social sentiment — Twitter/Reddit/Telegram)
    # Free key: https://lunarcrush.com/developers/api
    lunarcrush_api_key: str = ""

    # SearXNG (supplementary news search — Chinese + social media)
    searxng_url: str = "http://lumigate-searxng:8080"
    searxng_interval_minutes: int = 15

    # LumiGate (for LLM deep sentiment analysis)
    lumigate_url: str = "http://lumigate:9471"
    lumigate_project_key: str = ""

    # Freqtrade REST API
    freqtrade_url: str = "http://freqtrade:8080"
    freqtrade_username: str = "lumitrade"
    freqtrade_password: str = ""

    # IBKR
    ibkr_host: str = "127.0.0.1"
    ibkr_port: int = 4002  # 4001=live, 4002=paper
    ibkr_client_id: int = 1

    # Risk defaults (non-negotiable minimums, can tighten but not loosen)
    max_position_pct: float = 2.0
    max_daily_loss_pct: float = 3.0
    max_open_positions: int = 5
    min_risk_reward: float = 2.0
    news_blackout_minutes: int = 30
    auto_exec_max_pct: float = 1.0
    max_leverage: float = 5.0
    max_notional_pct: float = 10.0         # max notional exposure % (position * leverage)
    min_liquidation_distance: float = 0.12 # minimum distance to liquidation (12%)
    daily_loss_warn_pct: float = 2.0       # warn before circuit breaker
    losing_streak_threshold: int = 3       # alert after N consecutive losses

    # Manual trading (OKX direct via CCXT)
    manual_okx_api_key: str = ""
    manual_okx_api_secret: str = ""
    manual_okx_passphrase: str = ""
    manual_capital: float = 5000.0                 # USD capital for manual trading
    manual_max_leverage: float = 50.0              # max leverage for manual trades
    manual_risk_pct: float = 3.0                   # max % of capital per trade
    manual_max_positions: int = 3                  # max concurrent manual positions
    manual_daily_loss_pct: float = 10.0            # daily loss circuit breaker %
    manual_allowed_pairs: list[str] = [
        "BTC/USDT:USDT",
        "ETH/USDT:USDT",
        "SOL/USDT:USDT",
    ]

    # Analysis
    default_timeframes: list[str] = ["15m", "1h", "4h"]
    default_symbols: list[str] = ["AAPL", "TSLA", "SPY"]
    default_crypto_pairs: list[str] = ["BTC/USDT", "ETH/USDT"]

    # PocketBase project isolation
    pb_project: str = "lumitrade"

    model_config = {"env_prefix": "TRADE_"}


settings = Settings()


def pb_api(path: str) -> str:
    """
    Rewrite a PocketBase API path for project isolation.

    /api/collections/trade_news/records  →  /api/p/lumitrade/collections/trade_news/records
    /api/collections (list/create)       →  /api/p/lumitrade/collections

    Paths targeting _superusers (auth) are NOT rewritten — they are global.
    """
    project = settings.pb_project
    if not project:
        return path
    # Don't rewrite superuser auth paths
    if "/_superusers/" in path or "/_superusers" == path.split("/")[-1]:
        return path
    # Rewrite /api/collections/... → /api/p/{project}/collections/...
    if path.startswith("/api/collections"):
        return f"/api/p/{project}/collections{path[len('/api/collections'):]}"
    return path
