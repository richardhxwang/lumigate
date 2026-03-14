# Autorums.com 主页设计构思

## 一、公司品牌命名备选

以下命名方案围绕 **AI + 宠物科技 + 国际化** 三个核心维度展开，按推荐优先级排列：

### Tier 1 — 强烈推荐

| 名称 | 含义 | 域名可行性 | 理由 |
|------|------|-----------|------|
| **Autorums** (保留现有) | Auto + Rums，自动化 + 韵律感 | ✅ 已持有 | 辨识度已建立，techy 感强，但语义偏弱 |
| **Petrovian** | Petro(宠物) + Ovian(进化的) | 需查询 | 听感像欧洲科技公司，高级感强，AI+Pet 双关 |
| **Autura** | Auto + Natura(自然) | 需查询 | 自动化×自然生命，发音优雅，国际友好 |
| **Vivo Labs** | Vivo = 生命(拉丁语) | 需查询 | 生命科学+实验室调性，适合 AI+宠物+功能食品 |

### Tier 2 — 值得考虑

| 名称 | 含义 | 调性 |
|------|------|------|
| **Neura Pet** | Neural + Pet | 直白的 AI 宠物定位，但略窄 |
| **Lumino Group** | 光 + 集团 | 延续你现有的 LumiGate 命名体系 |
| **Oricore** | Origin + Core | 原点核心，中性大气 |
| **Zephon** | Zephyr(微风) + On | 轻盈科技感，国际发音友好 |
| **Pawtron** | Paw(爪子) + Patron/Neutron | 有趣但可能偏 playful |

### Tier 3 — 中文名配套方案

| 英文名 | 中文名 | 寓意 |
|--------|--------|------|
| Autorums | 奥拓朗 | 音译，大气 |
| Autura | 奥图拉 / 启元 | 音译或意译均可 |
| Vivo Labs | 维沃实验室 / 熠恒科技 | 可复用你之前偏好的「熠恒」 |
| Lumino Group | 熠光集团 | 延续 LumiGate 体系 |

> **建议**：如果你想保留 Autorums，完全可行——把它当成一个 holding company / tech group 的名字，旗下产品各有品牌（FurNote、LumiGate 等）。这其实是最实际的路径。

---

## 二、网站整体架构

```
autorums.com
├── / .......................... 主页（品牌展示 + 产品矩阵）
├── /furnote .................. FurNote 产品页（AI 猫咪护理）
├── /nutrition ................ 功能性宠物营养品牌页（牛磺酸零食）
├── /ai ....................... AI 技术能力展示页
├── /about .................... 关于我们 / 团队
├── /careers .................. 招聘
├── /blog ..................... 博客 / 宠物知识内容
├── /contact .................. 联系方式
│
├── lumigate.autorums.com ..... [Staff] AI API Gateway
├── pb.autorums.com ........... [Staff] PocketBase
└── cmd.autorums.com .......... [Staff] Remote Dev Console
```

---

## 三、主页 (/) 设计方案

### 3.1 设计调性

- **风格定位**：Premium Tech × Warm Life Science
- **参考气质**：介于 Stripe（极致工程感）和 Petcube（宠物温度）之间
- **色彩系统**：
  - 主色：Deep Navy `#0A1628` — 科技信任感
  - 辅色：Warm Amber `#F5A623` — 宠物温暖感
  - 强调色：Electric Teal `#00D4AA` — AI / 数据 / 活力
  - 背景：Off-white `#FAFAF8` — 干净但不冷
  - 文字：Charcoal `#1A1A2E`
- **字体**：
  - Display: **Clash Display** 或 **Cabinet Grotesk** — 几何感但有性格
  - Body: **Satoshi** 或 **General Sans** — 现代可读
  - 中文: **思源黑体** 或 **阿里巴巴普惠体**
- **特征**：大留白、微动效、高质量产品渲染图、数据驱动的可视化

### 3.2 页面分区详细设计

---

#### Section 1 — Hero（首屏）

**布局**：全屏，左文字右视觉

**左侧文案区**：

```
标语主文（EN/CN 切换）:
"Technology that understands life."
「理解生命的科技」

副标语:
"We build AI systems that care — for pets, for people, for the future."
「我们构建有温度的 AI —— 为宠物、为人、为未来。」

CTA 按钮:
[Explore FurNote →]  [Our Technology →]
```

**右侧视觉区**：
- 一只猫的高质量摄影/3D渲染，周围环绕着轻微的数据流粒子效果
- 粒子从猫的轮廓向外扩散，暗示 AI 在感知生命体征
- 鼠标移动时粒子产生微妙的视差效果
- **不要**用低质量的卡通猫，要有高级感

**背景**：
- 深色渐变 + 极细的网格线动效（类似 Linear.app 的风格）
- 网格线颜色随滚动从 teal 渐变为 amber

---

#### Section 2 — Product Matrix（产品矩阵）

**标题**：`What We Build` / `我们在做什么`

**布局**：三列 Bento Grid（不等宽）

| 卡片 | 占比 | 内容 |
|------|------|------|
| **FurNote** | 50% 宽 | AI 猫咪护理 App，展示手机 mockup + 对话界面截图。标语："Your cat's AI health companion." 底部 CTA → /furnote |
| **Nutrition** | 25% 宽 | 功能性宠物零食产品线，展示产品包装 render。标语："Science-backed treats, powered by taurine." 底部 CTA → /nutrition |
| **AI Platform** | 25% 宽 | AI 基础设施能力，抽象的 API 调用可视化动效。标语："Enterprise AI infrastructure." 底部 CTA → /ai |

**设计细节**：
- 卡片 hover 时轻微上浮 + 投影加深
- 每张卡片有独特的品牌色调标识（FurNote = Amber, Nutrition = Green, AI = Teal）
- Bento 风格圆角，间距 16px，类似 Apple 产品页的模块化感觉

---

#### Section 3 — FurNote Spotlight（核心产品深入）

**标题**：`Meet FurNote` / `认识 FurNote`

**布局**：左右交替展示，滚动触发动效

**Block A（左图右文）**：
```
图：App 界面 — 用户和 AI 的对话截图
文：
"No forms. No manual input. Just talk."
「不需要填表，不需要手动记录。聊天就好。」

FurNote 通过自然对话理解你的猫咪，
自动构建完整的健康档案。
```

**Block B（右图左文）**：
```
图：AI 生成的猫咪健康周报卡片
文：
"AI that knows your cat's breed, age, and needs."
「懂品种、懂年龄、懂需求的 AI」

基于 15+ 品种 × 4 个年龄阶段的专业知识库，
FurNote 主动提醒你该关注什么。
```

**Block C（左图右文）**：
```
图：推送通知界面 mockup
文：
"Proactive, not reactive."
「主动关怀，而非被动响应」

智能推送提醒：疫苗、驱虫、换粮、体检……
在你忘记之前，FurNote 已经记住了。
```

**动效**：每个 Block 在滚动进入视口时，图片从侧面滑入 + 文字淡入，交错延迟 200ms

---

#### Section 4 — Nutrition（营养产品线）

**标题**：`Nutrition, Reimagined` / `重新定义宠物营养`

**布局**：全宽背景图 + 悬浮信息卡

**背景**：牛磺酸分子结构的抽象 3D 渲染（深色调，发光线条）

**悬浮卡片内容**：
```
核心信息:
"Taurine-enriched functional treats for cats"
「牛磺酸强化功能性猫零食」

三个数据亮点（横排图标+数字）:
🔬 Pharmaceutical-grade taurine source
   「医药级牛磺酸原料供应」
🌏 Formulated for Southeast Asian markets
   「专为东南亚市场配方」
🐱 Developed with veterinary science
   「兽医科学背书」
```

**设计要点**：
- 产品照片放在分子结构背景上，科学感 + 产品感并存
- 强调原料供应链优势（家族关系的牛磺酸供应商）但措辞要国际化
- CTA: `Learn More →`

---

#### Section 5 — Technology（AI 技术实力）

**标题**：`Built on Intelligence` / `以智能为基」

**布局**：暗色背景 + 技术指标 Dashboard 风格

**内容模块**：

```
┌─────────────────────────────────────────────┐
│  Our AI Stack                                │
│                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │ LumiGate │ │ Multi-LLM│ │ Edge     │     │
│  │ API      │ │ Routing  │ │ Inference│     │
│  │ Gateway  │ │ Engine   │ │          │     │
│  └──────────┘ └──────────┘ └──────────┘     │
│                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │ Real-time│ │ Privacy  │ │ On-device│     │
│  │ Health   │ │ First    │ │ ML       │     │
│  │ Analysis │ │ Design   │ │          │     │
│  └──────────┘ └──────────┘ └──────────┘     │
│                                              │
│  Models we orchestrate:                      │
│  DeepSeek · Claude · GPT · Gemini            │
└─────────────────────────────────────────────┘
```

**动效**：
- 六个能力模块卡片依次亮起（stagger animation）
- 底部模型名称以 typing effect 逐个显现
- 背景有缓慢移动的代码行（类似 GitHub Copilot 官网）

**关键文案**：
```
"We don't build one AI. We orchestrate many."
「我们不只构建一个 AI，我们编排它们的协奏。」

Autorums 的技术平台整合多家顶级 AI 模型，
根据任务类型智能路由，在成本、速度和质量之间
找到最优解。
```

---

#### Section 6 — Metrics / Social Proof（数据展示）

**布局**：横向滚动的数字条

```
┌─────────┬─────────┬─────────┬─────────┐
│   15+   │  4      │  5+     │  99.9%  │
│ Cat     │ Age     │ AI      │ Uptime  │
│ Breeds  │ Stages  │ Models  │         │
│ Covered │ Tracked │ Unified │         │
└─────────┴─────────┴─────────┴─────────┘
```

**设计**：数字在滚动进入时从 0 动态递增到目标值（counter animation）

---

#### Section 7 — Vision Statement（愿景声明）

**布局**：全屏居中，大字体

```
"Every pet deserves an AI that understands them.
 Every owner deserves peace of mind."

「每只宠物都值得拥有懂它的 AI，
  每个主人都值得一份安心。」
```

**背景**：柔和的 amber 渐变，底部有极淡的猫咪剪影

---

#### Section 8 — Footer

**布局**：四列

```
Products          Company          Resources         Connect
─────────         ─────────        ─────────         ─────────
FurNote           About Us         Blog              Twitter/X
Nutrition         Careers          Knowledge Base    LinkedIn
AI Platform       Press            API Docs          Xiaohongshu
                  Contact          Status            Douyin

──────────────────────────────────────────────────────────
© 2026 Autorums Technology Co., Ltd.  |  深圳市南山区
Privacy Policy  ·  Terms of Service

Powered by 🐱 and AI
```

---

## 四、Staff 入口处理

**设计原则**：内部工具不在公开导航中出现，但可通过以下方式访问：

1. **Footer 隐藏入口**：在 Footer 最底部加一个不起眼的 `Staff Portal →` 文字链接
2. **点击后跳转到统一 Staff Dashboard**（可以是 `staff.autorums.com`），包含：
   - LumiGate (AI Gateway)
   - PocketBase (Database)
   - CMD (Remote Dev Console)
3. **所有 Staff 子域名统一加 Cloudflare Access 认证**，未登录用户看到的是统一的 Autorums 登录页

---

## 五、多语言策略

| 层级 | 策略 |
|------|------|
| 默认语言 | English（国际大公司调性） |
| 支持语言 | 简体中文、繁体中文 |
| 切换方式 | 右上角语言切换器（🌐 EN / 中文） |
| URL 结构 | `autorums.com/zh/furnote` 或 `autorums.com/furnote?lang=zh` |
| 内容策略 | 英文为主，中文为本地化版本，不是逐字翻译而是文化适配 |

---

## 六、技术实现建议

| 方面 | 推荐方案 | 理由 |
|------|---------|------|
| 框架 | **Next.js 14+ (App Router)** | SSG + 国际化路由 + Vercel 部署，性能极佳 |
| 样式 | **Tailwind CSS + Framer Motion** | 快速开发 + 高质量动效 |
| CMS | **PocketBase**（你已有） | 博客内容管理，复用现有基础设施 |
| 部署 | **Vercel** 或 **Cloudflare Pages** | 全球 CDN，与你现有的 CF 生态无缝衔接 |
| 分析 | **Plausible** 或 **Umami** | 隐私友好，自部署在你的 NAS 上 |
| i18n | **next-intl** | Next.js 生态最成熟的国际化方案 |

---

## 七、SEO & 品牌关键词策略

**核心关键词矩阵**：

```
品牌词:      Autorums, FurNote, LumiGate
产品词:      AI cat care app, smart pet health, taurine cat treats
技术词:      multi-model AI orchestration, pet health AI, veterinary AI
长尾词:      best AI app for cat owners, cat breed health guide,
             taurine benefits for cats, AI pet health monitoring
```

**每个页面的 meta 策略**：
- 主页: 品牌词 + 公司定位
- FurNote: 产品词 + 长尾词
- Nutrition: 产品词 + 牛磺酸相关
- AI: 技术词 + B2B 定位

---

## 八、设计执行优先级

| 阶段 | 内容 | 时间估计 |
|------|------|---------|
| **P0** | 主页 Hero + Product Matrix + Footer | 1-2 周 |
| **P1** | FurNote 产品页完整设计 | 1 周 |
| **P2** | AI 技术页 + Nutrition 页 | 1 周 |
| **P3** | Blog 系统 + 多语言 | 2 周 |
| **P4** | Staff Portal 统一入口 | 3 天 |

---

> **下一步行动**：确认公司命名 → 确定色彩/字体 → 出 Figma 高保真稿 → 用 Next.js 实现
>
> 如果需要，我可以直接帮你用 React 生成可交互的主页原型。
