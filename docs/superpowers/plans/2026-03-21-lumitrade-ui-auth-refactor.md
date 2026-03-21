# LumiTrade UI/Auth 系统性重构

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 LumiTrade 从"FreqUI 套了层皮"变成"LumiChat 风格的交易平台，内部调用 FreqUI 的 trading 引擎"。

**Architecture:** Auth 完全走 PB（复用 LumiChat 的 `/lc/auth/*`），FreqUI 的 bot auth 变成后台自动化（用户无感）。UI 层面：App shell（导航、auth、主题、移动端 sidebar）全部用 LumiChat 的设计，trading 内容区（图表、交易列表、回测面板）保留 FreqUI 的 Vue 组件但换 CSS。LumiTrader 从 iframe 改成原生 Vue 组件。

**Tech Stack:** Vue 3, PrimeVue 4, Pinia, PocketBase auth (lc_token cookie), Tailwind v4, FreqUI trading stores

**核心原则：** 不从头写 UI/auth — 直接移植 LumiChat 已验证的代码。

---

## 当前问题清单

| 问题 | 根因 | 解决方案 |
|------|------|---------|
| 登录后还要再登 FreqUI BotLogin | 两套 auth 并存：PB auth gate 在 App.vue + FreqUI BotLogin 在 HomeView | 删掉 FreqUI 的 BotLogin/HomeView，auto-login 在 PB auth 成功后自动完成 |
| 主界面闪一下再跳登录 | Vue mount 后 router guard 才执行 | App.vue 用 v-if 完全阻止主 UI 渲染直到 auth 完成 |
| 切换菜单慢 | FreqUI router + initBots() 每次 nav 都重新初始化 | initBots() 只在首次调用，后续 nav 纯 Vue Router 切换 |
| LumiTrader 是 iframe | 暴力植入，不共享用户状态 | 改成原生 Vue 组件，直接调 /lumitrader/chat API |
| 用户系统没统一 | FreqUI 用 bot username/password，LumiTrader 用 caller-supplied userId | 统一用 PB user，lumitrader.js 加 requireLcAuth |
| 间距太密 | CSS 改了但没 recreate 容器 / 覆盖不够全 | 系统性重写 tailwind.css 的 spacing layer |
| 圆角不够大 | 同上 | 统一 20-24px |
| 不是 macOS 风格 | 还在用 mdi 图标 | 替换成 Lucide Icons（和 Feather/SF Symbols 一致的细线条） |

---

## 文件结构

### 需要修改的文件

| 文件 | 职责 | 改动 |
|------|------|------|
| `frequi-src/src/App.vue` | App shell + auth gate | **重写**：PB auth gate → splash → login → main app，删 FreqUI BotLogin 痕迹 |
| `frequi-src/src/router/index.ts` | Router + guard | **简化**：删掉 initBots guard，所有 auth 在 App.vue 层面处理 |
| `frequi-src/src/main.ts` | Bootstrap | **简化**：删掉 autoLogin()，App.vue 处理 |
| `frequi-src/src/views/HomeView.vue` | Landing page | **删除或替换**：不再需要 BotLogin landing |
| `frequi-src/src/views/LoginView.vue` | 登录页 | **删除**：登录在 App.vue 里处理 |
| `frequi-src/src/views/LumiChatView.vue` | LumiTrader 全屏 | **重写**：从 iframe 改成原生 Vue 聊天组件 |
| `frequi-src/src/components/ThemeSelect.vue` | 主题切换 | 已改完（SVG sun/moon） |
| `frequi-src/src/components/layout/NavBar.vue` | 导航栏 | **重写**：macOS 风格，Lucide 图标 |
| `frequi-src/src/components/layout/BodyLayout.vue` | 内容区 | 加 `<Transition>` 页面切换动画 |
| `frequi-src/src/styles/tailwind.css` | 全局样式 | **重写 spacing/radius/icon layer** |
| `frequi-src/src/plugins/primevue.ts` | PrimeVue 主题 | 微调 borderRadius tokens |
| `frequi-src/package.json` | 依赖 | 加 `@iconify-json/lucide` 或 `lucide-vue-next` |
| `frequi-src/vite.config.ts` | 构建配置 | 加 Lucide icon resolver |
| `routes/lumitrader.js` | LumiTrader API | 加 `requireLcAuth`，用 `req.lcUser.id` 代替 caller-supplied userId |
| `server.js` | 路由挂载 | LumiTrader 路由加 lcAuth 中间件 |

### 不需要改的文件（保留 FreqUI trading 功能）

- `frequi-src/src/views/TradingView.vue` — 保留
- `frequi-src/src/views/DashboardView.vue` — 保留
- `frequi-src/src/views/BacktestingView.vue` — 保留
- `frequi-src/src/views/ChartsView.vue` — 保留
- `frequi-src/src/views/LogView.vue` — 保留
- `frequi-src/src/stores/ftbot*.ts` — 保留（trading 数据引擎）
- `frequi-src/src/composables/loginInfo.ts` — 保留（auto-login 需要）
- 所有 `frequi-src/src/components/ftbot/` — 保留（交易组件）

---

## Task 1: 替换图标系统 — mdi → Lucide

**Files:**
- Modify: `frequi-src/package.json`
- Modify: `frequi-src/vite.config.ts`
- Modify: `frequi-src/src/styles/tailwind.css`

- [ ] **Step 1: 安装 Lucide 图标包**
```bash
cd lumitrade/frequi-src
pnpm add -D @iconify-json/lucide
```

- [ ] **Step 2: vite.config.ts 加 Lucide resolver**
在 `IconsResolve()` 的 collections 里加上 `lucide`。unplugin-icons 会自动从 `@iconify-json/lucide` 加载。

- [ ] **Step 3: tailwind.css 删掉 mdi 全局样式 hack**
删掉 `[class^="i-mdi-"]` 的 opacity/scale 规则（不再需要，Lucide 自带细线条）。

- [ ] **Step 4: Build 测试**
```bash
pnpm build
```

- [ ] **Step 5: Commit**
```bash
git add frequi-src/package.json frequi-src/vite.config.ts frequi-src/src/styles/tailwind.css frequi-src/pnpm-lock.yaml
git commit -m "chore: add Lucide icons, prepare for mdi replacement"
```

---

## Task 2: 重写 App.vue — 统一 Auth Gate

**Files:**
- Rewrite: `frequi-src/src/App.vue`
- Delete: `frequi-src/src/views/LoginView.vue`
- Delete: `frequi-src/src/views/HomeView.vue`

**关键设计：**
App.vue 管理 3 个状态：`splash` → `login` → `app`。**不使用 Vue Router 来控制 auth**。

- [ ] **Step 1: 重写 App.vue script**

```
appState: 'splash' | 'login' | 'app'

onMounted:
  1. 同时发起: checkPBSession() + waitSplashAnimation(2s)
  2. 两个都完成后:
     - 有 PB session → doFreqtradeAutoLogin() → appState='app'
     - 无 PB session → appState='login'

login flow (复制 LumiChat):
  - /lc/auth/methods → 检测 Google OAuth
  - Google btn → /lc/auth/oauth-start?redirect=/lumitrade/
  - Email → /lc/auth/check-email → login or register
  - 成功 → doFreqtradeAutoLogin() → appState='app'

doFreqtradeAutoLogin():
  - GET /lumitrade/auto-auth → creds
  - POST /lumitrade/api/v1/token/login → freqtrade tokens
  - 写入 localStorage ftAuthLoginInfo
  - 调一次 initBots() 初始化 pinia stores
```

- [ ] **Step 2: 重写 App.vue template**

```
v-if="appState === 'splash'" → 全屏 splash（和 LumiChat 一样的球）
v-else-if="appState === 'login'" → 全屏登录卡片（LumiChat 完整移植）
v-else → 主界面（NavBar + BodyLayout + NavFooter + LumiTrader FAB/Panel）
```

关键：`v-else` 确保主界面在 auth 完成前 **绝对不渲染**。

- [ ] **Step 3: 删 HomeView.vue 和 LoginView.vue**

Router 的 `/` 改为直接指向 DashboardView 或 TradingView。`/login` 路由删除。

- [ ] **Step 4: 简化 router/index.ts**

```ts
// 删掉 beforeEach guard 里的 initBots() 和 auth 检查
// App.vue 已经处理了，router 只负责路由
router.beforeEach((to, from, next) => { next(); });
```

`/` 指向 `/trade`（默认首页是交易页）。

- [ ] **Step 5: 简化 main.ts**

删掉 `autoLogin()` 函数和调用。

- [ ] **Step 6: Build + 测试完整 auth 流程**

测试矩阵：
1. 未登录 → splash → 登录卡片（Google + email）
2. Google 登录 → callback → auto-login freqtrade → 主界面
3. 已登录刷新 → splash → 直接进主界面（不闪 login）
4. 切换页面 → 瞬间切换（不触发 auth check）

- [ ] **Step 7: Commit**

---

## Task 3: 重写 NavBar — macOS 风格

**Files:**
- Rewrite: `frequi-src/src/components/layout/NavBar.vue`

- [ ] **Step 1: 替换所有 mdi 图标为 Lucide**

```
i-mdi-currency-usd → i-lucide-dollar-sign
i-mdi-view-dashboard → i-lucide-layout-dashboard
i-mdi-chart-line → i-lucide-trending-up
i-mdi-flask → i-lucide-flask-conical
i-mdi-chat → i-lucide-message-square
i-mdi-format-list-bulleted → i-lucide-scroll-text
i-mdi-cog → i-lucide-settings
i-mdi-download → i-lucide-download
i-mdi-logout → i-lucide-log-out
i-mdi-lock-reset → i-lucide-rotate-ccw
i-mdi-menu → i-lucide-menu
i-mdi-close → i-lucide-x
i-mdi-chevron-down → i-lucide-chevron-down
i-mdi-run-fast → i-lucide-zap
i-mdi-alert → i-lucide-alert-triangle
```

- [ ] **Step 2: Desktop nav 加图标**

目前 desktop nav 只显示文字。加上 Lucide 图标（和 text 并排），像 macOS Settings.app sidebar。

- [ ] **Step 3: Mobile Drawer 改 LumiChat sidebar 风格**

用 LumiChat 的 sidebar 设计：frosted glass 背景，session 列表风格的 nav items，底部用户信息栏。

- [ ] **Step 4: 右侧用户区**

显示 PB 用户信息（名字、avatar initial），不是 bot name。用 LumiChat 的 `sb-foot` 样式。

- [ ] **Step 5: Commit**

---

## Task 4: 统一 Spacing & Border Radius

**Files:**
- Rewrite: `frequi-src/src/styles/tailwind.css` (spacing layer)
- Modify: `frequi-src/src/plugins/primevue.ts` (borderRadius tokens)

- [ ] **Step 1: PrimeVue tokens 统一 radius**

```ts
borderRadius: {
  none: '0',
  xs: '6px',
  sm: '10px',   // buttons, tags, chips
  md: '14px',   // inputs, select
  lg: '20px',   // cards, tables
  xl: '24px',   // dialogs, panels
}
```

- [ ] **Step 2: tailwind.css spacing 重写**

全局规则，不依赖单个组件覆盖：
```css
:root {
  /* LumiTrade spacing scale (LumiChat 基础上调整) */
  --lt-gap-xs: 6px;
  --lt-gap-sm: 10px;
  --lt-gap-md: 16px;
  --lt-gap-lg: 24px;
  --lt-gap-xl: 32px;
}
```

Card body padding: 20px, table cell padding: 12px 16px, button padding: 10px 18px, grid gap: 12px。

- [ ] **Step 3: 全局行高**

`body { line-height: 1.6 }`, headings `1.3`, data cells `1.5`。

- [ ] **Step 4: 验证绿色一致性**

全局搜索所有 green/accent 色值，确保只有 `#10a37f` 和它的色阶（在 primevue.ts 里定义）。

- [ ] **Step 5: Build + 视觉验证**
- [ ] **Step 6: Commit**

---

## Task 5: LumiTrader 从 iframe 改原生组件

**Files:**
- Rewrite: `frequi-src/src/views/LumiChatView.vue`
- Modify: `routes/lumitrader.js` (加 auth)
- Modify: `server.js` (lumitrader 路由加 lcAuth)

- [ ] **Step 1: lumitrader.js 加 requireLcAuth**

```js
// 所有 /lumitrader/* 路由加 lcAuth
const lcAuthMiddleware = (req, res, next) => {
  const cookies = parseCookies(req);
  const token = cookies.lc_token;
  const payload = validateLcTokenPayload(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  req.lcUser = payload;
  req.lcToken = token;
  next();
};

// /lumitrader/chat 用 req.lcUser.id 代替 caller-supplied userId
```

- [ ] **Step 2: 传 lcAuth 依赖到 lumitrader.js**

server.js 挂载时传入 `parseCookies`, `validateLcTokenPayload`。

- [ ] **Step 3: LumiChatView.vue 改原生聊天组件**

不用 iframe。直接用 Vue 实现：
- 消息列表（v-for messages）
- 输入框 + 发送按钮
- SSE 流式渲染（和 LumiChat 一样的 Text node 方式）
- 调 `/lumitrader/chat` API（带 `credentials: 'include'` 传 lc_token）
- 从 App.vue 拿当前 PB user info

- [ ] **Step 4: 浮窗 LumiTrader 也改成原生组件**

App.vue 里的浮窗从 iframe 改成直接渲染 LumiTrader 聊天组件。

- [ ] **Step 5: Commit**

---

## Task 6: 页面切换动画 + 性能

**Files:**
- Modify: `frequi-src/src/components/layout/BodyLayout.vue`
- Modify: `frequi-src/src/stores/ftbotwrapper.ts`

- [ ] **Step 1: BodyLayout 加 Transition**

```html
<main>
  <RouterView v-slot="{ Component }">
    <Transition name="lt-page" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>
</main>
```

```css
.lt-page-enter-active { transition: opacity 0.15s ease; }
.lt-page-leave-active { transition: opacity 0.1s ease; }
.lt-page-enter-from { opacity: 0; }
.lt-page-leave-to { opacity: 0; }
```

- [ ] **Step 2: initBots() 只调一次**

在 `ftbotwrapper.ts` 里加 `_initialized` flag，`initBots()` 只在第一次调用时执行。

- [ ] **Step 3: Commit**

---

## Task 7: 全流程测试 + 部署

- [ ] **Step 1: pnpm build**
- [ ] **Step 2: rm + cp 部署到 frequi-custom/installed/**
- [ ] **Step 3: docker stop + rm + compose up（recreate）**
- [ ] **Step 4: 清浏览器缓存测试**

测试清单：
- [ ] 首次访问：splash → Google 登录 → 自动进入主界面
- [ ] 刷新：splash → 直接进主界面（不闪 login）
- [ ] 切换 Trade/Dashboard/Chart/Backtest/Logs：瞬间切换，有 fade 动画
- [ ] LumiTrader 浮窗：打开/关闭/展开全屏
- [ ] LumiTrader 全屏页：原生聊天组件，不是 iframe
- [ ] 移动端：drawer 导航，大按钮，安全区适配
- [ ] 暗色模式：切换流畅，所有绿色是 #10a37f

- [ ] **Step 5: Commit + push**

---

## 执行顺序

Task 1 → 2 → 3 → 4 可以按顺序执行。
Task 5（LumiTrader 原生化）可以和 3/4 并行。
Task 6 最后做。
Task 7 最终验证。

预估：每个 Task 约 20-40 分钟（含 build/test），总计 ~3-4 小时。
