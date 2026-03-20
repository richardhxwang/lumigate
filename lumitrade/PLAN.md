# LumiTrade — Architecture & Implementation Path

## Context

构建 AI 辅助的 SMC/ICT 交易平台，作为 LumiGate 子模块。核心原则：**能用现成的就用现成的，只自研胶水层和 UI**。

---

## 最终选型

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 引擎语言 | Python FastAPI 容器 | 交易生态全在 Python |
| 美股执行 | **lumibot** (2k★) | 已有成熟 IBKR 集成+回测，不需要自研 |
| Crypto 执行 | **freqtrade** (36k★) | 最成熟的 crypto 框架，自带 Telegram bot + FreqUI |
| SMC 指标 | **smart-money-concepts** (1.1k★) | 唯一成熟的 Python SMC 库 |
| 回测 (美股) | **vectorbt** (7k★) | 向量化回测，最快 |
| 回测 (crypto) | freqtrade 内置 | 自带+支持 FreqAI ML 优化 |
| 新闻采集 | **Finnhub** (核心) + SearXNG (补充) + TV webhooks | Finnhub 自带情绪评分+经济日历 |
| 情绪分析 | **FinBERT** 预筛 + **LumiGate LLM** 深度 | 两层过滤，重要的才走 LLM |
| 行情推送 | 全 SSE 经 Node.js | SMC 策略看 15m+ K 线，10-30ms 延迟无影响 |
| 自动化 | 半自动 (<=1%仓位自动，大仓位人工) | — |
| 通知 | Telegram 始终推 + LumiChat 在线同步 | — |
| 前端 | LumiChat 工具 + lumitrade.html (LumiChat 风格) | — |
| 专业 UI 基础 | **FreqUI** (Vue) 改 LumiChat 风格 | 不从零做，改现成的 |

---

## Architecture

### 总体架构图

```
                              ┌─────────────┐
                              │   你 (User)  │
                              └──────┬───────┘
                     ┌───────────────┼───────────────┐
                     │               │               │
              ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
              │  LumiChat   │ │ lumitrade   │ │  Telegram   │
              │  (对话交易) │ │  .html      │ │  Bot        │
              │             │ │(FreqUI改版) │ │(freqtrade   │
              │             │ │ LumiChat风格│ │  内置)      │
              └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
                     │               │               │
              ═══════╪═══════════════╪═══════════════╪══════
                     │        Nginx (:9471)          │
              ═══════╪═══════════════╪═══════════════╪══════
                     │               │               │
              ┌──────┴───────────────┴───────────────┘
              │
      ┌───────┴────────┐
      │  LumiGate      │ ← 现有 Node.js 服务
      │  server.js     │
      │                │
      │  新增:         │
      │  routes/       │
      │   trade.js     │ ← 胶水层：统一 API，合并两个引擎的数据
      │  tools/        │
      │   trade-tools  │ ← 5个 AI 可调用工具
      │   .js          │
      └───────┬────────┘
              │
     ┌────────┼────────────────┐
     │        │                │
┌────┴─────┐ ┌┴──────────┐ ┌──┴───────────┐
│ lumibot  │ │ freqtrade │ │ Trade Engine │
│ (IBKR)   │ │ (Crypto)  │ │ (FastAPI)    │
│          │ │           │ │              │
│ 现成:    │ │ 现成:     │ │ 自研:        │
│ ·IBKR连接│ │ ·OKX交易  │ │ ·SMC计算     │
│ ·下单执行│ │ ·回测+ML  │ │ ·信号生成    │
│ ·持仓管理│ │ ·Telegram │ │ ·风控引擎    │
│ ·回测    │ │ ·FreqUI   │ │ ·新闻管线    │
│          │ │ ·100+交易所│ │ ·持仓管理    │
└────┬─────┘ └┬──────────┘ └──┬───────────┘
     │        │               │
┌────┴─────┐ ┌┴──────────┐   │
│ IBKR TWS │ │ OKX       │   │
│ Gateway  │ │ Exchange  │   │
│(paper/   │ │(testnet/  │   │
│ live)    │ │ live)     │   │
└──────────┘ └───────────┘   │
                              │
     ┌────────────────────────┼────────────────┐
     │                        │                │
┌────┴─────┐  ┌───────────┐  ┌┴──────────────┐
│ Finnhub  │  │ SearXNG   │  │ TradingView   │
│ API      │  │ (已部署)  │  │ Webhooks      │
│          │  │           │  │ (已有Premium) │
│ ·实时新闻│  │ ·补充搜索 │  │ ·重大事件    │
│ ·情绪评分│  │ ·中文新闻 │  │  alerts       │
│ ·经济日历│  │ ·社交媒体 │  │               │
└────┬─────┘  └─────┬─────┘  └───────┬───────┘
     │              │                │
     └──────────────┼────────────────┘
                    │
          ┌─────────┴─────────┐
          │   FinBERT (预筛)  │ ← Docker 容器，CPU 推理
          │   score > 0.7 ?   │
          │   ↓ yes           │
          │   LumiGate LLM   │ ← 复用现有 /v1/chat
          │   (深度分析)      │
          └─────────┬─────────┘
                    │
     ┌──────────────┼──────────────┐
     │              │              │
┌────┴─────┐ ┌─────┴──────┐ ┌────┴─────────┐
│PocketBase│ │  Qdrant    │ │ data/trade/  │
│          │ │            │ │              │
│ 6个交易  │ │ 新闻向量   │ │ K线历史缓存  │
│ collection│ │ 信号向量   │ │ 回测结果     │
│          │ │ (RAG检索)  │ │              │
└──────────┘ └────────────┘ └──────────────┘
```

### 数据流：完整交易链路

```
① 数据采集
   IBKR ──(lumibot)──→ OHLCV
   OKX  ──(freqtrade)─→ OHLCV
   Finnhub ───────────→ 新闻 + 情绪 + 经济日历
   SearXNG ───────────→ 补充新闻/社交
   TradingView ───────→ 重大事件 webhook

          ↓

② SMC 分析 (Trade Engine, smart-money-concepts 库)
   多时间框架 K 线 → BOS/CHoCH → 市场结构
                   → Swing H/L → 流动性池
                   → Order Block + FVG → 入场区

          ↓

③ 信号生成
   OB + FVG 重叠 + 正确 zone + 多 TF 确认
   + 新闻情绪分 (Finnhub + FinBERT/LLM)
   → Signal {symbol, direction, entry, SL, TP, R:R, confidence}

          ↓

④ 风控 (不可绕过，在执行链路中间)
   ·仓位 ≤ 2% ？
   ·日亏损 < 3% ？(否则熔断)
   ·持仓数 < 5 ？
   ·R:R ≥ 2:1 ？
   ·重大事件前 30min ？(Finnhub 经济日历)

          ↓

⑤ 执行决策
   仓位 ≤ 1% → 自动执行 → lumibot(IBKR) 或 freqtrade(OKX) 下单
   仓位 > 1% → 推通知等确认 → Telegram 按钮 / LumiChat 弹窗
                              → 确认后下单

          ↓

⑥ 持仓管理 (每 30s 循环)
   到 1:1 → 部分平仓 50% + 移动止损到入场价
   到 1.5:1 → 启动 trailing stop
   检测 CHoCH 反转 → 全部平仓

          ↓

⑦ 记录
   → PocketBase: trade_signals, trade_positions, trade_history, trade_pnl
   → Qdrant: 信号 embedding (供 AI 对话检索)
   → Telegram + LumiChat: 实时通知
```

### 通知逻辑

```
信号产生
  │
  ├─ 始终 → Telegram Bot 推送（freqtrade 内置，IBKR 端自研）
  │         含 [确认] [拒绝] inline 按钮
  │
  └─ 检测 LumiChat 在线状态
       ├─ 正在对话中 → LumiChat 内直接告知（融入对话流）
       └─ 不在线 → 仅 Telegram
```

---

## 自研 vs 现成 — 明细

### 直接用，零开发

| 组件 | 来源 | 提供什么 |
|------|------|---------|
| IBKR 交易执行 | lumibot | 连接、下单、持仓、回测 |
| Crypto 交易全链路 | freqtrade | OKX 交易、回测、ML 优化、Telegram bot、FreqUI |
| SMC 指标计算 | smart-money-concepts (pip) | OB、FVG、BOS、CHoCH、Swing H/L |
| 回测 (美股) | vectorbt (pip) | 向量化快速回测 |
| 新闻+情绪+日历 | Finnhub API (免费60次/min) | 按 ticker 过滤、自带情绪评分 |
| 补充搜索 | SearXNG (已部署) | 中文新闻、社交媒体 |
| 重大事件 | TradingView webhooks (已有 Premium) | 直推 |
| 情绪预筛 | FinBERT (Docker) | <100ms/article CPU 推理 |
| 深度情绪 | LumiGate LLM (已有) | 复用现有 /v1/chat |
| 向量存储 | Qdrant (已部署) | 新闻/信号 embedding |
| 数据存储 | PocketBase (已部署) | 交易 collections |
| 认证 | LumiChat JWT (已有) | 复用 |
| 专业 UI 基础 | FreqUI (Vue, freqtrade 自带) | 改成 LumiChat 风格 |

### 需要自研（约 20-30% 工作量）

| 模块 | 说明 | 复杂度 |
|------|------|--------|
| **routes/trade.js** | Node.js 胶水层，统一 lumibot + freqtrade 的 API | 中 |
| **tools/trade-tools.js** | 5 个 AI 工具注册到 UnifiedRegistry | 低 |
| **Trade Engine (FastAPI)** | SMC 信号生成 + 风控 + 调度 + 新闻管线 | 高 |
| **SMC → lumibot 对接** | smart-money-concepts 输出 → lumibot 下单 | 中 |
| **SMC → freqtrade 策略** | 写 freqtrade Strategy class 用 SMC 指标 | 中 |
| **lumitrade.html** | FreqUI 改 LumiChat 风格（frosted glass, CSS vars） | 中 |
| **IBKR 端 Telegram 通知** | freqtrade 自带 crypto 端的，IBKR 端需自研 | 低 |
| **PB collections** | 6 个交易 collection 的 schema | 低 |

---

## 可行性验证 — 社区已证明的

| 环节 | 验证来源 | 数据 |
|------|---------|------|
| SMC 策略有效性 | [2600 笔回测](https://medium.com/@space.garaa/i-backtested-2-600-trades-using-smart-money-concepts-heres-what-actually-works-bb3c671098c6) | **61% 胜率, 2.17 profit factor, +2.27R** |
| freqtrade 稳定性 | GitHub 36k★, 50k+ 开发者 | 2017 年至今持续维护，最活跃的 crypto bot |
| lumibot IBKR 集成 | 官方文档 + 社区验证 | 支持 paper + live，回测内置 |
| smart-money-concepts | 1.1k★, PyPI | OB/FVG/BOS/CHoCH 都有，唯一成熟 SMC 库 |
| FinBERT 金融情绪 | ProsusAI 3k★ | 金融文本专用 BERT，准确率远超通用模型 |
| Finnhub 数据质量 | HackerNoon 2026 推荐 | 免费额度充足，自带情绪+经济日历 |
| vectorbt 回测性能 | 7k★ | NumPy 向量化，比 backtrader 快 100x |
| FreqAI ML 优化 | freqtrade 官方模块 | LSTM/XGBoost 策略自适应 |

### 未验证/需要我们自己验证的

| 环节 | 风险 | 缓解 |
|------|------|------|
| SMC 在我们选的标的上是否有效 | 回测数据来自别人的标的 | Phase 1 先回测验证再上纸交易 |
| lumibot + SMC 的集成复杂度 | lumibot 没有 SMC 策略示例 | 先跑通 lumibot 简单策略再加 SMC |
| FinBERT 对中文新闻效果 | FinBERT 训练数据是英文 | 中文新闻走 LumiGate LLM 而非 FinBERT |
| 多组件协同稳定性 | 5+ Docker 容器 | 复用 LumiGate watchdog 监控 |

---

## 实施路径

### Phase 1: 验证策略 (Week 1-2) — 边回测边纸交易

```
目标：证明 SMC 策略在目标标的上有效

- [x] Docker 启动 Trade Engine (FastAPI 骨架)
- [x] pip install smart-money-concepts (smartmoneyconcepts)
- [ ] 拉取 IBKR 历史数据 → vectorbt 回测 AAPL/TSLA/SPY (pending — IBKR 未配置)
- [ ] 拉取 OKX 历史数据 → freqtrade 回测 BTC/ETH (in progress — freqtrade 部署中)
- [ ] 同时接 IBKR paper trading + OKX testnet (OKX dry_run 已配置，IBKR pending)
- [ ] 输出：回测报告 (胜率、profit factor、最大回撤)

验证标准：胜率 > 55%, profit factor > 1.5, 最大回撤 < 10%
```

### Phase 2: 执行链路 (Week 2-3)

```
目标：信号 → 风控 → 下单 全链路跑通

1. lumibot 接 IBKR paper trading
2. freqtrade 接 OKX testnet
3. Trade Engine: SMC 信号 → 风控检查 → 调用 lumibot/freqtrade 下单
4. routes/trade.js: Node.js 胶水层，统一 API
5. tools/trade-tools.js: 注册 AI 工具到 UnifiedRegistry
6. 输出：在 LumiChat 里说"分析 AAPL"能触发完整流程
```

### Phase 3: 新闻情绪 + 通知 (Week 3-4)

```
目标：新闻影响交易决策

1. Finnhub API 接入 (新闻 + 情绪 + 经济日历)
2. FinBERT Docker 容器
3. SearXNG 定时补充采集
4. 情绪分 → 融入信号 confidence
5. 经济日历 → News Blackout 联动风控
6. Telegram 通知 (IBKR 端)
7. LumiChat 在线检测 + 智能通知切换
```

### Phase 4: 前端 (Week 4-5)

```
目标：专业交易界面

1. FreqUI 代码 fork → 改 LumiChat 视觉风格
   - Frosted glass, --accent #10a37f, --r1~r5
   - 暗色主题 --bg:#212121, 无 emoji, SVG icons
2. 接入 TradingView Lightweight Charts (K 线)
3. SMC 标注叠加层 (OB/FVG/BOS 在 K 线上)
4. SSE 实时数据更新
5. LumiChat 内交易工具面板
```

### Phase 5: 优化 + 上线 (Week 5-6)

```
目标：从纸交易过渡到小仓位实盘

1. 回顾 2-4 周纸交易数据
2. FreqAI ML 策略优化 (crypto 端)
3. vectorbt 参数优化 (美股端)
4. watchdog 添加交易容器监控
5. IBKR paper → live (小仓位)
6. OKX testnet → live (小仓位)
```

---

## Docker Compose 新增容器

```
现有 (不动)                        新增 (trade profile)
─────────────                     ──────────────────
nginx (:9471)                     trade-engine (:3200) — FastAPI, SMC+风控+新闻
lumigate (:9471 internal)         freqtrade (:8080) — crypto 全链路
pocketbase (:8090)                finbert (:5000) — 情绪预筛
qdrant (:6333)
searxng (:8080)                   启动: docker compose --profile trade up -d
...
```

---

## 验证方法

| 阶段 | 怎么验证 |
|------|---------|
| Phase 1 完成 | vectorbt 输出回测报告，freqtrade backtesting 输出报告 |
| Phase 2 完成 | IBKR paper 和 OKX testnet 上有实际纸交易记录 |
| Phase 3 完成 | Finnhub 新闻出现在 PB trade_news，FinBERT 情绪分有值 |
| Phase 4 完成 | /lumitrade 页面能看到 K 线 + SMC 标注 + 实时信号 |
| Phase 5 完成 | 小仓位实盘 1 周，P&L 为正或回撤在可控范围内 |

---

## 关键复用清单 (LumiGate 现有)

| 复用什么 | 在哪里 |
|---------|--------|
| Route factory pattern | routes/chat.js |
| UnifiedRegistry 工具注册 | tools/unified-registry.js |
| SSE streaming 模式 | routes/chat.js |
| PB collection 自动创建 | services/pb-schema.js |
| PB 数据读写 helper | routes/lumichat.js (lcPbFetch) |
| SearXNG 搜索 | tools/builtin-handlers.js |
| Qdrant 向量操作 | services/knowledge/vector-store.js |
| HTML 页面服务 + nonce | server.js (readPublicHtml) |
| JWT 认证 | routes/lumichat.js |
| watchdog 监控 | watchdog-launchd.js |
