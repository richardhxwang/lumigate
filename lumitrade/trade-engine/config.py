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

    # Analysis
    default_timeframes: list[str] = ["15m", "1h", "4h"]
    default_symbols: list[str] = ["AAPL", "TSLA", "SPY"]
    default_crypto_pairs: list[str] = ["BTC/USDT", "ETH/USDT"]

    model_config = {"env_prefix": "TRADE_"}


settings = Settings()
