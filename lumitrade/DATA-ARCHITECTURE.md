# LumiTrade Data Architecture — Complete Reference

## Overview

LumiTrade 的数据分布在 **5 个存储层**，不是所有数据都在 PocketBase 里。

```
┌─────────────────────────────────────────────────────────────────┐
│                        数据存储全景                              │
├─────────────────┬──────────────────────────────────────────────┤
│ PocketBase      │ 12 collections (lumitrade project)            │
│ freqtrade SQLite│ 5 tables (trades, orders, locks, KV, custom) │
│ Qdrant          │ lumitrade_rag collection (256-dim vectors)    │
│ 文件系统         │ ML models, OHLCV data, backtest results, configs │
│ 浏览器 localStorage │ FreqUI 设置, bot tokens, 布局配置          │
│ 内存 (无持久化)   │ 风控状态, WebSocket 连接, admin sessions     │
│ LumiGate JSON   │ users.json, projects.json, keys.json, etc.   │
└─────────────────┴──────────────────────────────────────────────┘
```

---

## 一、PocketBase (lumitrade project) — 12 Collections

### 1. `trade_signals` — SMC 交易信号 (17 fields)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| symbol | text | * | 交易对 (BTC/USDT, AAPL) |
| direction | text | | long/short |
| entry_price | number | | 入场价 |
| stop_loss | number | | 止损价 |
| take_profit | number | | 止盈价 |
| risk_reward | number | | R:R 比率 |
| confidence | number | | 信号置信度 0-1 |
| timeframe | text | | 15m/1h/4h |
| indicators | json | | SMC 指标 {ob, fvg, bos, choch} |
| source | text | | smc_strategy / tv_webhook / manual |
| status | text | | active / executed / expired |
| news_sentiment | number | | 新闻情绪分 -1~1 |
| broker | text | | okx / ibkr |
| user_id | text | | 用户 ID |
| action | text | | buy / sell |
| price | number | | 当前价格 |
| raw | text | | 原始信号数据 |

**写入**: TradingView webhook → routes/trade.js → PB; Trade Engine /analyze (手动触发)
**读取**: LumiTrader context injection; FreqUI 信号面板

### 2. `trade_positions` — 当前持仓 (44 fields)

核心字段:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| symbol | text | * | 交易对 |
| broker | text | | okx / ibkr |
| direction | text | | long / short |
| quantity | number | | 持仓量 |
| entry_price | number | | 入场价 |
| current_price | number | | 当前价 |
| stop_loss / take_profit | number | | SL/TP |
| unrealized_pnl / realized_pnl | number | | 浮盈/实现盈亏 |
| status | text | | open / closed |
| user_id | text | * | 用户 ID |
| r_multiple | number | | R 倍数 |
| session | text | | london / ny / asian / overlap |
| setup_type | text | | ob_fvg / bos_fvg / liquidity_sweep |

市场上下文 (13 fields): entry_candle_OHLCV, atr, spread, volume_ma_ratio, volatility_percentile, market_structure, higher_tf_bias, dxy

SMC 指标 (8 fields): nearest_ob/fvg_distance, premium/discount_zone, bos/choch_count, liquidity_swept, smc_confluence_score

组合上下文 (4 fields): portfolio_value, position_size_pct, open_positions_count, news_sentiment

### 3. `trade_history` — 历史成交 (79 fields, 最大的表)

| 字段组 | 数量 | 内容 |
|--------|------|------|
| 基础交易 | 22 | symbol, direction, entry/exit_price, pnl, strategy, tags, bot_name, exchange, trading_mode... |
| 价格行为 | 14 | entry/exit_candle_OHLCV, highest/lowest_during, MFE/MAE (含 R 单位) |
| 市场环境 | 7 | atr, spread, volume_ma_ratio, volatility, structure, tf_bias, dxy |
| SMC 指标 | 8 | 同 positions |
| 时间分析 | 6 | day_of_week, hour_utc, minutes_in_trade, candles_in_trade, time_to_tp/sl |
| 组合上下文 | 6 | portfolio_value, position_pct, consecutive_wins/losses |
| 情绪/新闻 | 5 | mood_at_entry, mood_score, news_context/headline, economic_event |
| RAG | 2 | trade_summary_text, embedding_id (→ Qdrant) |
| 退出原因 | 1 | exit_reason: tp_hit / sl_hit / trailing_stop / manual / choch_exit / roi |

### 4. `trade_pnl` — 每日盈亏汇总 (20 fields)

| Field | Type | Description |
|-------|------|-------------|
| date | text* | 日期 |
| daily_pnl / cumulative_pnl | number | 日/累计盈亏 |
| win_count / loss_count / win_rate | number | 胜率统计 |
| portfolio_value / max_drawdown | number | 组合价值 |
| total_r / avg_r / largest_win_r / largest_loss_r | number | R 倍数分析 |
| session_pnl | json | {london: {pnl, trades, wins}, ny: {...}} |
| killzone_pnl | json | {london_kz: {pnl, trades}, ny_am_kz: {...}} |
| streak | number | +N=连胜, -N=连败 |
| avg_mood / best_setup / worst_setup | mixed | 情绪/策略关联 |
| user_id | text* | 用户 ID |

### 5. `trade_news` — 新闻与情绪 (13 fields)

| Field | Type | Description |
|-------|------|-------------|
| symbol | text | 相关交易对 |
| headline / summary | text | 标题/摘要 |
| source / url / published_at | text | 来源信息 |
| finnhub_sentiment | number | Finnhub 原始评分 |
| finbert_sentiment | number | FinBERT 模型评分 |
| llm_sentiment | number | LumiGate LLM 深度评分 |
| final_sentiment | number | 加权最终评分 |
| impact / category | text | high/medium/low + etf/earnings/macro |
| processed | bool | 是否已处理 |

**注意**: 目前 Trade Engine 新闻管线**不自动写入**此表，schema 存在但无代码写入。

### 6. `trade_strategies` — 策略配置 (10 fields)

| Field | Type | Description |
|-------|------|-------------|
| name | text* | 策略名 (SMCStrategy) |
| description | text | 策略描述 |
| config | json | 详细配置参数 |
| is_active | bool | 是否启用 |
| symbols / timeframes | json | 交易对列表 / 时间框架 |
| backtest_results | json | 关联回测结果 |
| version | text | 版本号 |
| freqai_enabled | bool | FreqAI 是否启用 |
| last_backtest_id | text | 最近回测 ID |
| user_id | text* | 用户 ID |

### 7. `trade_backtest_results` — 回测结果 (29 fields)

| Field | Type | Description |
|-------|------|-------------|
| version | text* | v1, v2, v3... |
| description | text | 自动生成的描述 |
| strategy_name | text* | SMCStrategy |
| exchange / trading_mode | text | OKX / futures / spot |
| timerange / timeframe | text | 回测时段 / K线周期 |
| total_trades / wins / losses / winrate | number | 统计 |
| profit_total_abs / profit_total_pct | number | 绝对/百分比利润 |
| max_drawdown_abs / max_drawdown_pct | number | 最大回撤 |
| sharpe / sortino / calmar | number | 风险调整收益 |
| profit_factor | number | 盈利因子 |
| avg_duration | text | 平均持仓时间 |
| pairs_count | number | 交易对数量 |
| notes | text | 备注 |
| tags | json | ["futures", "long-only", "lumilearning"] |
| result_json | json | 完整回测原始数据 |
| filename | text | 回测文件名 |
| user_id | text | 用户 ID |

**写入**: routes/trade.js POST /backtest/sync → 从 freqtrade-bt 拉取结果解析后写入

### 8. `trade_journal` — 交易日记 (18 fields)

| Field | Type | Description |
|-------|------|-------------|
| date | text* | 日期 |
| session | text | london / ny / asian |
| mood_before / mood_after | text | 交易前后情绪 |
| notes / reflection / lessons_learned | text | 自述/反思/教训 |
| ai_summary / lessons | text | AI 生成的总结/教训 |
| trades_count / wins / losses / total_pnl | number | 当日统计 |
| best_trade / worst_trade | json | {symbol, pnl, entry, exit} |
| session_breakdown | json | 按时段分解 |
| killzone_performance | json | killzone 表现 |
| patterns_noted | json | 有效/无效的 SMC patterns |
| plan_adherence_score | number | 0-10 计划执行评分 |
| trades_reviewed | json | 复盘的 trade_history IDs |
| user_id | text* | 用户 ID |

### 9. `trade_mood_logs` — 情绪日志 (14 fields)

| Field | Type | Description |
|-------|------|-------------|
| timestamp | text* | 时间戳 |
| mood_label | text | calm / anxious / confident / fearful / greedy / excited / bored / frustrated / euphoric |
| mood_score | number | -5 到 +5 |
| energy_level | number | 1-10 |
| context | text | before_trade / after_trade / during_session / general |
| trade_id | text | 关联 trade_history ID |
| session | text | 交易时段 |
| notes | text | 文字记录 |
| ai_extracted | bool | 是否由 AI 自动提取 |
| source_message | text | 触发消息原文 |
| market_condition | text | trending / ranging / volatile / calm |
| user_id | text* | 用户 ID |
| consecutive_result | text | "3W" / "2L" 连胜/连败 |

### 10. `lt_sessions` — LumiTrader 对话会话 (11 fields)

| Field | Type | Description |
|-------|------|-------------|
| title | text | 会话标题 |
| user_id | text* | 用户 ID |
| model / preset | text | 使用的模型/预设 |
| message_count | number | 消息数 |
| last_message_at | text | 最后消息时间 |
| messages | json | 完整消息数组 |
| context_snapshot | json | 当时的交易上下文快照 |
| pair / exchange / market_type | text | 讨论的交易对/交易所/市场 |

### 11. `lt_messages` — LumiTrader 单条消息 (8 fields)

| Field | Type | Description |
|-------|------|-------------|
| session_id | text* | 关联 lt_sessions.id |
| role | text | user / assistant |
| content | text | 消息内容 |
| model | text | 使用的模型 |
| tokens_in / tokens_out | number | token 计数 |
| tool_calls | json | AI 工具调用记录 |
| context_data | json | 注入的上下文数据 |

### 12. `lt_user_settings` — LumiTrader 用户设置 (16 fields)

| Field | Type | Description |
|-------|------|-------------|
| user_id | text* | 用户 ID |
| chat_style | text | concise / detailed / educational |
| auto_execute | text | auto / manual / confirm |
| language | text | zh-CN / en |
| chart_analysis | text | 图表分析模式 |
| context_injection | text | 上下文注入级别 |
| notification_mode | text | 通知方式 |
| journal_mode | text | 日记模式 |
| strategy_dev | text | 策略开发模式 |
| risk_control | text | 风控级别 |
| data_scope | text | 数据范围 |
| history_retention | text | 历史保留时长 |
| preferred_model | text | 首选 AI 模型 |
| presets | json | 自定义预设列表 |
| custom_prompt | text | 自定义系统提示 |

---

## 二、freqtrade SQLite — tradesv3.sqlite (5 tables)

路径: `lumitrade/freqtrade/user_data/tradesv3.sqlite`
(每个 bot 实例独立: tradesv3.sqlite, tradesv3-pure.sqlite)

### `trades` — 核心交易记录 (51 columns)

| 字段组 | 内容 |
|--------|------|
| 标识 | id, pair, exchange, strategy, enter_tag |
| 财务 | open_rate, close_rate, stake_amount, amount, realized_profit, close_profit, close_profit_abs, open_trade_value |
| 手续费 | fee_open/close, fee_open/close_cost, fee_open/close_currency |
| 时间 | open_date, close_date, timeframe |
| 止损 | stop_loss, stop_loss_pct, initial_stop_loss, is_stop_loss_trailing, max_rate, min_rate |
| 退出 | exit_reason, exit_order_status |
| 持仓 | is_open, is_short, leverage, liquidation_price, trading_mode |
| 精度 | amount/price_precision, precision_mode, contract_size |
| 资金费 | funding_fees, funding_fee_running, interest_rate |

### `orders` — 订单记录 (26 columns)

ft_trade_id (FK→trades), order_id, side, status, order_type, price, average, amount, filled, remaining, cost, stop_price, timestamps, fees, tags

### `trade_custom_data` — 自定义数据 (7 columns)

ft_trade_id (FK→trades), cd_key, cd_type, cd_value — FreqAI 和策略存储每笔交易的元数据

### `pairlocks` — 交易对锁定 (7 columns)

pair, side, reason, lock_time, lock_end_time, active — 防止冷却期内重复进场

### `KeyValueStore` — 键值存储 (7 columns)

key, value (typed: string/datetime/float/int) — 目前存: bot_start_time, startup_time

**与 PB 的关系**: freqtrade SQLite 是交易的**真实来源 (source of truth)**，PB trade_history 是**同步副本**用于 LumiTrader 上下文注入和分析。目前没有自动同步机制。

---

## 三、Qdrant — lumitrade_rag (向量搜索)

| 项目 | 值 |
|------|-----|
| Collection | `lumitrade_rag` |
| Dimension | 256 (hash-based pseudo-embedding) |
| Distance | Cosine |
| 内容 | 交易记录摘要, 回测结果, 情绪日志, ICT/SMC 知识文档 |
| Point ID | MD5 hash of text (deterministic) |

**写入**: Trade Engine /rag/embed, /rag/knowledge + 启动时加载 smc_knowledge.json
**读取**: LumiTrader context injection (/rag/search)

**与 PB 的关系**: trade_history.embedding_id → Qdrant point ID (可选字段)。两个系统独立，无自动双向同步。

---

## 四、文件系统数据

### FreqAI 模型文件 (user_data/models/)

| 路径 | 内容 |
|------|------|
| `smc_lgbm/pair_dictionary.json` | 15 对 pair → model 文件映射 |
| `smc_lgbm/run_params.json` | 训练参数快照 |
| `smc_lgbm/historic_predictions.pkl` | 所有历史 ML 预测 (pandas DataFrame) |
| `smc_lgbm/sub-train-<PAIR>_<TS>/` | 每对 6 个文件: model.joblib, metadata.json, feature/label_pipeline.pkl, trained_dates/df.pkl |
| `smc_lgbm_backtest/` | 回测用的独立模型集 |

每个模型训练 **107 个特征**: close/volume/high_low_pct × periods(10,20,50) × timeframes(15m,1h,4h) × shifts(0,1,2) + RSI/MFI/ADX + 7个 SMC 特征 (bos, choch, ob_direction, fvg_direction, swing_hl, liquidity, liq_swept)

### OHLCV 市场数据

| 路径 | 格式 | 内容 |
|------|------|------|
| `user_data/data/okx/` | Apache Feather (.feather) | 15 pairs × 3 timeframes = 45 files |
| `user_data/data/binance/` | Feather | 回测用历史数据 |

### 回测结果文件

| 路径 | 内容 |
|------|------|
| `user_data/backtest_results/*.zip` | 完整回测数据 (trades, equity curve, per-pair) |
| `user_data/backtest_results/*.meta.json` | 回测元数据索引 |
| `user_data/hyperopt_results/*.fthypt` | 超参优化试验结果 |
| `user_data/hyperopt_results/hyperopt_tickerdata.pkl` | 超参优化缓存 |

### Bot 配置文件

| 文件 | 用途 |
|------|------|
| `config.json` | 主 bot (FreqAI enabled) |
| `config-pure-smc.json` | Pure SMC bot (FreqAI disabled) |
| `ib-gateway/jts.ini` | IBKR Gateway (Region=hk) |

---

## 五、浏览器 localStorage (FreqUI)

| Key | Store | 持久化内容 |
|-----|-------|-----------|
| `ftUISettings` | settings.ts | 主题, 时区, K线设置, 通知开关, 图表标签方向, 默认K线数量 |
| `ftLayoutSettings` | layout.ts | Dashboard (7 widget) + Trading (5 panel) 布局 |
| `ftPlotConfig` | plotConfig.ts | 图表叠加指标配置 (命名配置集) |
| `ftUIChartSettings` | chartConfig.ts | useLiveData 开关 |
| `ftPairlistConfig` | pairlistConfig.ts | 保存的 pairlist 配置 |
| `ftUIColorSettings` | colors.ts | 涨跌颜色偏好 (greenUp/redUp/custom) |
| `ftSelectedBot` | ftbotwrapper.ts | 当前选中的 bot ID |
| `ftAuthLoginInfo` | ftbotwrapper.ts | 所有 bot 的 URL/username/token |
| `ftBacktestAuth` | (custom) | 回测实例的独立 token |

---

## 六、LumiGate JSON 文件 (非 PB, 非 trade)

| 文件 | 内容 |
|------|------|
| `data/users.json` | LumiGate 管理员 (username, passwordHash, salt, role, MFA) |
| `data/projects.json` | 项目配置 (API keys, RPM limits, budgets) |
| `data/keys.json` | Provider API keys (AES-256-CTR 加密) |
| `data/tokens.json` | 临时 token 记录 |
| `data/usage.json` | API 使用日志 |
| `data/settings.json` | 全局设置 (含 root MFA TOTP) |

---

## 七、内存数据 (无持久化, 重启即丢失)

| 组件 | 数据 | 风险 |
|------|------|------|
| Risk Manager | `_open_positions` (set), `_daily_pnl` (dict) | 重启后熔断计数器归零 |
| WebSocket Manager | market/signal 连接列表 | 重启需客户端重连 |
| LumiGate Sessions | admin session Map (内存, 最大10000) | 重启后全部需重新登录 |
| MFA Tokens | 5分钟过期 Map | 重启后 MFA 流程中断 |

---

## 八、Collection 间关系图

```
trade_signals ──(signal_id)──→ trade_history
      │                              │
      │ (触发交易)                    │ (平仓后归档)
      ▼                              ▼
trade_positions ─(平仓)──→ trade_history
      │                              │
      │                   ┌──────────┼──────────┐
      │                   ▼          ▼          ▼
      │            trade_pnl   trade_journal  trade_mood_logs
      │            (日汇总)    (日记)          (情绪)
      │                              │
      │                              ▼
      └──── smc_confluence_score ──→ Qdrant (trade_summary_text → embedding)

trade_news ──(sentiment)──→ trade_signals.news_sentiment
                           → trade_history.news_sentiment_at_entry
                           → trade_positions.news_sentiment_at_entry

trade_strategies ──(config)──→ freqtrade bot 运行参数
                  ←(ref)──── trade_backtest_results.strategy_name

trade_backtest_results ──(result_json)──→ 包含完整 per-pair 和 per-trade 数据

lt_sessions ──(1:N, session_id)──→ lt_messages
lt_user_settings ──(1:1, user_id)──→ 用户偏好

freqtrade SQLite ═══(source of truth)═══→ PB trade_history (手动同步)
                                        → PB trade_positions (未实现)
```

---

## 九、数据写入/读出链路

### 写入链路

```
A. 实时交易: freqtrade bot → SQLite (自动) → [待实现: 自动同步到 PB]
B. 回测结果: freqtrade-bt → routes/trade.js /backtest/sync → PB trade_backtest_results
C. TradingView: webhook → routes/trade.js /tv-webhook → PB trade_signals
D. LumiTrader: 用户对话 → routes/lumitrader.js → PB lt_sessions + lt_messages
E. 新闻: Finnhub → FinBERT → LLM → [待实现: 写入 PB trade_news]
F. 情绪: LumiTrader AI 提取 → [待实现: 自动写入 PB trade_mood_logs]
G. 日记: 用户手动 / AI 生成 → PB trade_journal
```

### LumiTrader 读取链路 (context injection)

```
fetchTradingContext(userQuery, userId)
  ├─ Trade Engine /positions        → [Open Positions]
  ├─ Trade Engine /pnl              → [P&L]
  ├─ Trade Engine /signals?limit=5  → [Recent Signals]
  ├─ PB trade_history (10条)        → [Recent Trades]
  ├─ PB trade_journal (5条)         → [Journal Entries]
  ├─ PB trade_mood_logs (3条)       → [Recent Mood]
  ├─ Trade Engine /rag/search       → [Relevant Knowledge] (Qdrant)
  ├─ freqtrade-bt /backtest/history → [Backtest History]
  └─ PB trade_backtest_results (5条) → [Backtest Results from PB]

  → formatTradingContext() → 拼成文本 → 注入 system prompt → LLM
```

---

## 十、已知数据缺口

| 数据实体 | 当前位置 | 问题 |
|----------|---------|------|
| Risk Manager 状态 | 内存 | 重启后丢失，无 PB 持久化 |
| IBKR 订单/成交 | Response only | 无 PB collection 记录 |
| SMC 分析结果 | Response only | 每次重新计算，无缓存 |
| 新闻文章 | 不写入 | `trade_news` schema 存在但**无代码写入** |
| QuantStats 报告 | 按需计算 | 无缓存/历史 |
| Session/Killzone 分析 | 按需计算 | 只在手动创建 journal 时保存 |
| 情绪-绩效关联 | 按需计算 | 无持久化 |
| freqtrade → PB 同步 | 不存在 | **SQLite 是 source of truth，PB 无自动同步** |
| Telegram 通知记录 | fire-and-forget | 无发送历史 |

---

## 十一、Bot 配置速查

### 3 个 freqtrade 实例

| Bot | Container | Port | Config | bot_name | FreqAI | 模式 |
|-----|-----------|------|--------|----------|--------|------|
| 主 bot | lumigate-freqtrade | 18790 | config.json | LumiTrade-Crypto | enabled | dry_run |
| Pure SMC | lumigate-freqtrade-pure | 18791 | config-pure-smc.json | LumiTrade-PureSMC | disabled | dry_run |
| 回测 | lumigate-freqtrade-bt | 18795 | config.json | — | — | webserver |

### 改名方法

修改对应 config JSON 的 `bot_name` 字段，然后 recreate 容器:
```bash
# 改 config.json 或 config-pure-smc.json 中的 "bot_name": "新名字"
docker compose --profile trade up -d --no-deps --force-recreate freqtrade freqtrade-pure
```

### 共享凭据

| 项目 | 值 |
|------|-----|
| API username | lumitrade |
| API password | 123123@ |
| JWT secret | HGt4qDlTr_aTt2ELLahW-PVtsNFQIsIZBQU9Qaa87v0 |
| OKX keys | env vars (FREQTRADE__EXCHANGE__KEY/SECRET/PASSWORD) |

---

## 十二、Trade Engine 端点清单 (31 endpoints)

| 端点 | 方法 | 功能 |
|------|------|------|
| /health | GET | 健康检查 |
| /analyze | POST | SMC 分析 (含新闻情绪) |
| /risk-check | POST | 风控检查 |
| /execute | POST | 下单执行 |
| /signals | GET | 信号列表 |
| /positions | GET | 持仓列表 |
| /journal/analytics | GET | 日记分析 (session/killzone) |
| /journal/mood-analysis | GET | 情绪-绩效关联 |
| /reports/performance | GET | QuantStats 报告 |
| /reports/tearsheet | GET | QuantStats HTML |
| /ibkr/* | GET/POST | IBKR (status, positions, account, history, order) |
| /freqtrade/* | GET/POST | freqtrade 代理 (status, trades, performance, balance, config, backtest, download-data) |
| /unified/pairs | GET | 合并 crypto + stock pairs |
| /unified/positions | GET | 合并所有 broker 持仓 |
| /unified/history | GET | 合并交易历史 |
| /backtest | POST | 触发回测 |
| /rag/search | GET | Qdrant 向量搜索 |
| /rag/embed | POST | 嵌入文本到 Qdrant |
| /rag/knowledge | POST | 添加知识文档 |
| /ws/market | WebSocket | 市场数据推送 |
| /ws/signals | WebSocket | 信号推送 |
