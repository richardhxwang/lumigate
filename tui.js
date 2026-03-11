#!/usr/bin/env node
// ============================================================
// LumiGate — Terminal UI Dashboard
// Interactive full-screen terminal app using raw ANSI codes
// No external dependencies — Node.js built-in modules only
// ============================================================

const http = require("http");
const https = require("https");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// --- Config ---
let GATEWAY_URL = process.env.GATEWAY_URL || "";
let GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";

// Load from .env in script directory
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const m = line.match(/^(\w+)=(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    const v = val.replace(/^["']|["']$/g, "").trim();
    if (key === "GATEWAY_URL" && !process.env.GATEWAY_URL) GATEWAY_URL = v;
    if (key === "ADMIN_SECRET" && !process.env.GATEWAY_SECRET) GATEWAY_SECRET = v;
  }
}

// Load from ~/.lumigate
const homeConfig = path.join(process.env.HOME || "~", ".lumigate");
if (fs.existsSync(homeConfig)) {
  const content = fs.readFileSync(homeConfig, "utf8");
  for (const line of content.split("\n")) {
    const m = line.match(/^(\w+)=(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    const v = val.replace(/^["']|["']$/g, "").trim();
    if (key === "GATEWAY_URL" && !GATEWAY_URL) GATEWAY_URL = v;
    if (key === "GATEWAY_SECRET" && !GATEWAY_SECRET) GATEWAY_SECRET = v;
  }
}

if (!GATEWAY_URL) GATEWAY_URL = "http://localhost:9471";
GATEWAY_URL = GATEWAY_URL.replace(/\/$/, "");

// --- ANSI helpers ---
const ESC = "\x1b";
const CSI = `${ESC}[`;

const ansi = {
  clear: `${CSI}2J${CSI}H`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  // Colors
  black: `${CSI}30m`,
  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  blue: `${CSI}34m`,
  magenta: `${CSI}35m`,
  cyan: `${CSI}36m`,
  white: `${CSI}37m`,
  // Bright colors
  brightBlack: `${CSI}90m`,
  brightRed: `${CSI}91m`,
  brightGreen: `${CSI}92m`,
  brightYellow: `${CSI}93m`,
  brightBlue: `${CSI}94m`,
  brightMagenta: `${CSI}95m`,
  brightCyan: `${CSI}96m`,
  brightWhite: `${CSI}97m`,
  // Background
  bgBlue: `${CSI}44m`,
  bgBlack: `${CSI}40m`,
  bgGreen: `${CSI}42m`,
  bgRed: `${CSI}41m`,
  bgYellow: `${CSI}43m`,
  bgWhite: `${CSI}47m`,
  bgBrightBlack: `${CSI}100m`,
  // Cursor
  moveTo: (row, col) => `${CSI}${row};${col}H`,
  moveUp: (n = 1) => `${CSI}${n}A`,
  clearLine: `${CSI}2K`,
};

// Visible length (strips ANSI codes)
function visLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Pad/truncate to fit width (ANSI-aware)
function fitStr(s, width, align = "left") {
  const vl = visLen(s);
  if (vl > width) {
    // Truncate — naive but works for most cases
    let count = 0;
    let result = "";
    let inEsc = false;
    for (const ch of s) {
      if (ch === "\x1b") { inEsc = true; result += ch; continue; }
      if (inEsc) { result += ch; if (/[a-zA-Z]/.test(ch)) inEsc = false; continue; }
      if (count >= width - 1) { result += "…"; break; }
      result += ch;
      count++;
    }
    return result + ansi.reset;
  }
  const pad = " ".repeat(width - vl);
  return align === "right" ? pad + s : s + pad;
}

// Box drawing characters
const box = {
  tl: "┌", tr: "┐", bl: "└", br: "┘",
  h: "─", v: "│",
  lt: "├", rt: "┤", tt: "┬", bt: "┴",
  cross: "┼",
};

// --- HTTP client ---
function apiRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(GATEWAY_URL + urlPath);
    const isHttps = url.protocol === "https:";
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "X-Admin-Token": GATEWAY_SECRET,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    };

    const mod = isHttps ? https : http;
    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: "Invalid JSON response", raw: data.slice(0, 200) });
        }
      });
    });
    req.on("error", (e) => reject(e));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// --- State ---
const state = {
  currentTab: 0,
  tabs: ["Overview", "Providers", "Projects", "Usage"],
  // Data
  health: null,
  providers: [],
  projects: [],
  models: {},
  usage: null,
  uptime: null,
  // UI state
  selectedIndex: 0,
  scrollOffset: 0,
  loading: false,
  error: null,
  lastRefresh: null,
  showHelp: false,
  inputMode: false,
  inputBuffer: "",
  inputPrompt: "",
  inputCallback: null,
  // Provider tab: expanded models
  expandedProvider: null,
  testResult: null,
};

let cols = process.stdout.columns || 80;
let rows = process.stdout.rows || 24;

// --- Data fetching ---
async function fetchAll() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const [health, providers, projects, uptime, usage] = await Promise.all([
      apiRequest("GET", "/health").catch(() => null),
      apiRequest("GET", "/providers").catch(() => []),
      apiRequest("GET", "/admin/projects").catch(() => []),
      apiRequest("GET", "/admin/uptime").catch(() => null),
      apiRequest("GET", "/admin/usage/summary?days=7").catch(() => null),
    ]);
    state.health = health;
    state.providers = Array.isArray(providers) ? providers : [];
    state.projects = Array.isArray(projects) ? projects : [];
    state.uptime = uptime;
    state.usage = usage;
    state.lastRefresh = new Date();
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
}

async function fetchModels(provider) {
  try {
    const models = await apiRequest("GET", `/models/${provider}`);
    state.models[provider] = Array.isArray(models) ? models : [];
  } catch {
    state.models[provider] = [];
  }
}

async function testProvider(provider, model) {
  state.testResult = { provider, testing: true };
  render();
  try {
    const query = model ? `?model=${model}` : "";
    const result = await apiRequest("GET", `/admin/test/${provider}${query}`);
    state.testResult = { provider, ...result };
  } catch (e) {
    state.testResult = { provider, success: false, error: e.message };
  }
}

async function createProject(name) {
  try {
    const result = await apiRequest("POST", "/admin/projects", { name });
    if (result.success) {
      await fetchAll();
      state.testResult = { success: true, message: `Project '${name}' created. Key: ${result.project.key}` };
    } else {
      state.testResult = { success: false, error: result.error || "Failed" };
    }
  } catch (e) {
    state.testResult = { success: false, error: e.message };
  }
}

async function deleteProject(name) {
  try {
    const result = await apiRequest("DELETE", `/admin/projects/${name}`);
    if (result.success) {
      await fetchAll();
      state.testResult = { success: true, message: `Project '${name}' deleted` };
    } else {
      state.testResult = { success: false, error: result.error || "Failed" };
    }
  } catch (e) {
    state.testResult = { success: false, error: e.message };
  }
}

async function toggleProject(name, enabled) {
  try {
    const url = new URL(GATEWAY_URL + `/admin/projects/${encodeURIComponent(name)}`);
    const isHttps = url.protocol === "https:";
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "PUT",
      headers: {
        "X-Admin-Token": GATEWAY_SECRET,
        "Content-Type": "application/json",
      },
    };
    await new Promise((resolve, reject) => {
      const mod = isHttps ? https : http;
      const req = mod.request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      });
      req.on("error", reject);
      req.write(JSON.stringify({ enabled }));
      req.end();
    });
    await fetchAll();
  } catch {}
}

// --- Rendering ---
const buf = [];

function w(s) {
  buf.push(s);
}

function flush() {
  process.stdout.write(buf.join(""));
  buf.length = 0;
}

function drawBox(row, col, width, height, title = "") {
  // Top border
  w(ansi.moveTo(row, col));
  w(ansi.blue + ansi.bold);
  let top = box.tl;
  if (title) {
    top += box.h + " " + title + " ";
    top += box.h.repeat(Math.max(0, width - visLen(top) - 1));
  } else {
    top += box.h.repeat(width - 2);
  }
  top += box.tr;
  w(top);

  // Sides
  for (let r = 1; r < height - 1; r++) {
    w(ansi.moveTo(row + r, col));
    w(box.v);
    w(ansi.moveTo(row + r, col + width - 1));
    w(box.v);
  }

  // Bottom border
  w(ansi.moveTo(row + height - 1, col));
  w(box.bl + box.h.repeat(width - 2) + box.br);
  w(ansi.reset);
}

function drawHLine(row, col, width) {
  w(ansi.moveTo(row, col));
  w(ansi.blue + ansi.bold);
  w(box.lt + box.h.repeat(width - 2) + box.rt);
  w(ansi.reset);
}

function drawText(row, col, text, maxWidth) {
  w(ansi.moveTo(row, col));
  if (maxWidth) {
    w(fitStr(text, maxWidth));
  } else {
    w(text);
  }
}

function renderTabs(row, col, width) {
  w(ansi.moveTo(row, col + 1));
  w(" ");
  for (let i = 0; i < state.tabs.length; i++) {
    const label = `[${i + 1}]${state.tabs[i]}`;
    if (i === state.currentTab) {
      w(ansi.bgBlue + ansi.white + ansi.bold + ` ${label} ` + ansi.reset);
    } else {
      w(ansi.dim + ` ${label} ` + ansi.reset);
    }
    w(" ");
  }
}

function renderStatusBar(row, col, width) {
  w(ansi.moveTo(row, col + 1));
  w(ansi.dim);
  const parts = [
    "q:quit",
    "r:refresh",
    "1-4:tabs",
    "j/k:navigate",
    "?:help",
  ];
  if (state.currentTab === 1) parts.splice(3, 0, "t:test", "Enter:expand");
  if (state.currentTab === 2) parts.splice(3, 0, "n:new", "d:delete", "space:toggle");
  w(" " + parts.join("  "));
  w(ansi.reset);

  // Loading indicator / timestamp
  const rightPart = state.loading
    ? `${ansi.yellow}Loading...${ansi.reset}`
    : state.lastRefresh
      ? `${ansi.dim}${state.lastRefresh.toLocaleTimeString()}${ansi.reset}`
      : "";
  const rightLen = visLen(rightPart);
  w(ansi.moveTo(row, col + width - rightLen - 2));
  w(rightPart);
}

function renderOverview(startRow, col, width, maxRows) {
  let row = startRow;
  const innerW = width - 4;

  // Status line
  if (state.health) {
    const statusDot = state.health.status === "ok"
      ? `${ansi.green}${ansi.bold}●${ansi.reset} ${ansi.green}Online${ansi.reset}`
      : `${ansi.red}●${ansi.reset} ${ansi.red}Offline${ansi.reset}`;

    const activeCount = state.health.providers ? state.health.providers.length : 0;
    const totalProviders = 8;

    const uptimeStr = state.uptime ? state.uptime.uptime : formatUptime(state.health.uptime || 0);

    drawText(row, col + 2,
      `Status: ${statusDot}    Providers: ${ansi.bold}${activeCount}/${totalProviders}${ansi.reset}    ` +
      `Up: ${ansi.bold}${uptimeStr}${ansi.reset}`,
      innerW);
    row += 2;
  } else {
    drawText(row, col + 2, `${ansi.red}Cannot connect to gateway${ansi.reset}`, innerW);
    drawText(row + 1, col + 2, `${ansi.dim}URL: ${GATEWAY_URL}${ansi.reset}`, innerW);
    row += 3;
  }

  // Provider grid
  if (state.providers.length > 0) {
    drawText(row, col + 2, `${ansi.blue}${ansi.bold}Providers${ansi.reset}`, innerW);
    row++;

    const cardWidth = 14;
    const cardsPerRow = Math.max(1, Math.floor((innerW - 2) / (cardWidth + 1)));

    for (let i = 0; i < state.providers.length; i++) {
      const p = state.providers[i];
      const gridCol = (i % cardsPerRow) * (cardWidth + 1);
      const gridRow = Math.floor(i / cardsPerRow);
      const baseRow = row + gridRow * 4;

      if (baseRow + 3 >= startRow + maxRows - 2) break;

      const x = col + 2 + gridCol;

      // Card top
      w(ansi.moveTo(baseRow, x));
      w(ansi.dim + box.tl + box.h.repeat(cardWidth - 2) + box.tr + ansi.reset);

      // Card name
      w(ansi.moveTo(baseRow + 1, x));
      w(ansi.dim + box.v + ansi.reset);
      const name = fitStr(p.name, cardWidth - 4, "left");
      w(` ${ansi.bold}${name}${ansi.reset} `);
      w(ansi.dim + box.v + ansi.reset);

      // Card status
      w(ansi.moveTo(baseRow + 2, x));
      w(ansi.dim + box.v + ansi.reset);
      const dot = p.available
        ? `${ansi.green}●${ansi.reset}`
        : `${ansi.red}○${ansi.reset}`;
      const padL = Math.floor((cardWidth - 3) / 2);
      w(" ".repeat(padL) + dot + " ".repeat(cardWidth - 2 - padL - 1));
      w(ansi.dim + box.v + ansi.reset);

      // Card bottom
      w(ansi.moveTo(baseRow + 3, x));
      w(ansi.dim + box.bl + box.h.repeat(cardWidth - 2) + box.br + ansi.reset);
    }

    const gridRows = Math.ceil(state.providers.length / cardsPerRow);
    row += gridRows * 4 + 1;
  }

  // Usage summary
  if (state.usage && row < startRow + maxRows - 4) {
    drawText(row, col + 2, `${ansi.blue}${ansi.bold}Usage (7 days)${ansi.reset}`, innerW);
    row++;
    drawText(row, col + 2,
      `Requests: ${ansi.bold}${state.usage.totalRequests}${ansi.reset}    ` +
      `Cost: ${ansi.yellow}${ansi.bold}$${state.usage.totalCost} USD${ansi.reset}`,
      innerW);
    row++;
  }

  // Error display
  if (state.error && row < startRow + maxRows - 2) {
    row++;
    drawText(row, col + 2, `${ansi.red}Error: ${state.error}${ansi.reset}`, innerW);
  }
}

function renderProviders(startRow, col, width, maxRows) {
  let row = startRow;
  const innerW = width - 4;
  const providerList = state.providers;

  if (providerList.length === 0) {
    drawText(row, col + 2, `${ansi.dim}No providers loaded${ansi.reset}`, innerW);
    return;
  }

  // Header
  drawText(row, col + 2,
    `${ansi.bold}${fitStr("PROVIDER", 14)}${fitStr("STATUS", 10)}${fitStr("BASE URL", innerW - 26)}${ansi.reset}`,
    innerW);
  row++;
  drawText(row, col + 2, ansi.dim + "─".repeat(Math.min(innerW, 70)) + ansi.reset, innerW);
  row++;

  const maxItems = maxRows - 4;

  for (let i = 0; i < providerList.length && row < startRow + maxRows - 2; i++) {
    const p = providerList[i];
    const isSelected = i === state.selectedIndex;
    const isExpanded = p.name === state.expandedProvider;

    const prefix = isSelected ? `${ansi.cyan}▸ ${ansi.reset}` : "  ";
    const statusStr = p.available
      ? `${ansi.green}● online${ansi.reset}  `
      : `${ansi.red}○ no key${ansi.reset}  `;
    const bg = isSelected ? ansi.bgBrightBlack : "";
    const bgReset = isSelected ? ansi.reset : "";

    drawText(row, col + 2,
      `${bg}${prefix}${ansi.bold}${fitStr(p.name, 12)}${ansi.reset}${bg}${statusStr}${ansi.dim}${fitStr(p.baseUrl || "", innerW - 30)}${ansi.reset}${bgReset}`,
      innerW);
    row++;

    // Expanded: show models
    if (isExpanded && state.models[p.name]) {
      const models = state.models[p.name];
      for (const m of models) {
        if (row >= startRow + maxRows - 2) break;
        const tier = m.tier === "economy" ? `${ansi.green}${m.tier}${ansi.reset}`
          : m.tier === "standard" ? `${ansi.yellow}${m.tier}${ansi.reset}`
          : `${ansi.red}${m.tier}${ansi.reset}`;
        const priceStr = `$${m.price.in}/${m.price.out}`;
        const freeStr = m.freeRPD ? ` ${ansi.cyan}(${m.freeRPD} free/d)${ansi.reset}` : "";
        drawText(row, col + 6,
          `${ansi.dim}├${ansi.reset} ${fitStr(m.id, 28)} ${fitStr(tier, 18)} ${ansi.dim}${priceStr}${ansi.reset}${freeStr}`,
          innerW - 4);
        row++;
      }
    }
  }

  // Test result
  if (state.testResult && row < startRow + maxRows - 2) {
    row++;
    if (state.testResult.testing) {
      drawText(row, col + 2, `${ansi.yellow}Testing ${state.testResult.provider}...${ansi.reset}`, innerW);
    } else if (state.testResult.success) {
      drawText(row, col + 2,
        `${ansi.green}✓ ${state.testResult.provider}${ansi.reset} ` +
        `model: ${state.testResult.model || "?"} ` +
        `reply: "${state.testResult.reply || ""}" ` +
        `${ansi.dim}${state.testResult.latency || 0}ms${ansi.reset}`,
        innerW);
    } else if (state.testResult.error) {
      drawText(row, col + 2,
        `${ansi.red}✗ ${state.testResult.provider || ""}: ${state.testResult.error}${ansi.reset}`,
        innerW);
    } else if (state.testResult.message) {
      drawText(row, col + 2,
        `${ansi.green}✓ ${state.testResult.message}${ansi.reset}`,
        innerW);
    }
  }
}

function renderProjects(startRow, col, width, maxRows) {
  let row = startRow;
  const innerW = width - 4;
  const projectList = state.projects;

  if (projectList.length === 0) {
    drawText(row, col + 2, `${ansi.dim}No projects configured${ansi.reset}`, innerW);
    drawText(row + 1, col + 2, `${ansi.dim}Press 'n' to create one${ansi.reset}`, innerW);
    return;
  }

  // Header
  drawText(row, col + 2,
    `${ansi.bold}${fitStr("NAME", 20)}${fitStr("STATUS", 12)}${fitStr("CREATED", 14)}${fitStr("KEY", innerW - 48)}${ansi.reset}`,
    innerW);
  row++;
  drawText(row, col + 2, ansi.dim + "─".repeat(Math.min(innerW, 70)) + ansi.reset, innerW);
  row++;

  for (let i = 0; i < projectList.length && row < startRow + maxRows - 2; i++) {
    const p = projectList[i];
    const isSelected = i === state.selectedIndex;

    const prefix = isSelected ? `${ansi.cyan}▸ ${ansi.reset}` : "  ";
    const statusStr = p.enabled
      ? `${ansi.green}enabled${ansi.reset}     `
      : `${ansi.red}disabled${ansi.reset}    `;
    const created = (p.createdAt || "").slice(0, 10);
    const keyShort = (p.key || "").slice(0, 16) + "...";
    const bg = isSelected ? ansi.bgBrightBlack : "";
    const bgReset = isSelected ? ansi.reset : "";

    drawText(row, col + 2,
      `${bg}${prefix}${ansi.bold}${fitStr(p.name, 18)}${ansi.reset}${bg}${statusStr}${fitStr(created, 14)}${ansi.dim}${keyShort}${ansi.reset}${bgReset}`,
      innerW);
    row++;
  }

  // Result message
  if (state.testResult && row < startRow + maxRows - 2) {
    row++;
    if (state.testResult.success && state.testResult.message) {
      drawText(row, col + 2, `${ansi.green}✓ ${state.testResult.message}${ansi.reset}`, innerW);
    } else if (state.testResult.error) {
      drawText(row, col + 2, `${ansi.red}✗ ${state.testResult.error}${ansi.reset}`, innerW);
    }
  }
}

function renderUsage(startRow, col, width, maxRows) {
  let row = startRow;
  const innerW = width - 4;

  if (!state.usage) {
    drawText(row, col + 2, `${ansi.dim}Loading usage data...${ansi.reset}`, innerW);
    return;
  }

  // Summary
  drawText(row, col + 2,
    `${ansi.bold}Period:${ansi.reset} ${state.usage.days} days    ` +
    `${ansi.bold}Requests:${ansi.reset} ${state.usage.totalRequests}    ` +
    `${ansi.bold}Cost:${ansi.reset} ${ansi.yellow}$${state.usage.totalCost} USD${ansi.reset}`,
    innerW);
  row += 2;

  // Bar chart by model
  drawText(row, col + 2, `${ansi.blue}${ansi.bold}Cost by Model (7d, USD)${ansi.reset}`, innerW);
  row++;

  // Aggregate models across all projects
  const modelMap = {};
  if (state.usage.byProject) {
    for (const [proj, pData] of Object.entries(state.usage.byProject)) {
      if (!pData.models) continue;
      for (const [modelKey, mData] of Object.entries(pData.models)) {
        if (!modelMap[modelKey]) modelMap[modelKey] = { count: 0, cost: 0, inputTokens: 0, outputTokens: 0 };
        modelMap[modelKey].count += mData.count;
        modelMap[modelKey].cost += mData.cost;
        modelMap[modelKey].inputTokens += mData.inputTokens;
        modelMap[modelKey].outputTokens += mData.outputTokens;
      }
    }
  }

  const models = Object.entries(modelMap)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.cost - a.cost);

  if (models.length === 0) {
    drawText(row, col + 2, `${ansi.dim}No usage data yet${ansi.reset}`, innerW);
    return;
  }

  const maxCost = Math.max(...models.map((m) => m.cost), 0.001);
  const barMaxLen = Math.min(20, innerW - 42);
  const nameWidth = Math.min(28, Math.max(...models.map((m) => m.name.length)) + 2);

  for (const m of models) {
    if (row >= startRow + maxRows - 2) break;

    const filledLen = Math.round((m.cost / maxCost) * barMaxLen);
    const emptyLen = barMaxLen - filledLen;
    const bar = "█".repeat(filledLen) + "░".repeat(emptyLen);

    const costStr = m.cost === 0
      ? `${ansi.dim}$0 (free)${ansi.reset}`
      : `${ansi.yellow}$${m.cost.toFixed(4)}${ansi.reset}`;

    drawText(row, col + 2,
      `${fitStr(m.name, nameWidth)}${ansi.green}${bar}${ansi.reset}  ${costStr}  ${ansi.dim}(${m.count} calls)${ansi.reset}`,
      innerW);
    row++;
  }

  // Project breakdown
  if (state.usage.byProject && row < startRow + maxRows - 4) {
    row += 2;
    drawText(row, col + 2, `${ansi.blue}${ansi.bold}By Project${ansi.reset}`, innerW);
    row++;

    drawText(row, col + 2,
      `${ansi.bold}${fitStr("PROJECT", 20)}${fitStr("REQUESTS", 12, "right")}${fitStr("IN TOKENS", 14, "right")}${fitStr("OUT TOKENS", 14, "right")}${fitStr("COST", 12, "right")}${ansi.reset}`,
      innerW);
    row++;
    drawText(row, col + 2, ansi.dim + "─".repeat(Math.min(innerW, 72)) + ansi.reset, innerW);
    row++;

    for (const [proj, pData] of Object.entries(state.usage.byProject)) {
      if (row >= startRow + maxRows - 2) break;
      drawText(row, col + 2,
        `${fitStr(proj, 20)}${fitStr(String(pData.requests), 12, "right")}${fitStr(fmtNum(pData.inputTokens), 14, "right")}${fitStr(fmtNum(pData.outputTokens), 14, "right")}${ansi.yellow}${fitStr("$" + pData.cost.toFixed(4), 12, "right")}${ansi.reset}`,
        innerW);
      row++;
    }
  }
}

function renderHelp(startRow, col, width, maxRows) {
  let row = startRow;
  const innerW = width - 4;

  drawText(row, col + 2, `${ansi.blue}${ansi.bold}Keyboard Shortcuts${ansi.reset}`, innerW);
  row += 2;

  const shortcuts = [
    ["q / Ctrl+C", "Quit"],
    ["1-4", "Switch tabs"],
    ["r", "Refresh data"],
    ["j / ↓", "Move down in list"],
    ["k / ↑", "Move up in list"],
    ["Enter", "Select / expand item"],
    ["t", "Test selected provider (Providers tab)"],
    ["n", "New project (Projects tab)"],
    ["d", "Delete selected project (Projects tab)"],
    ["Space", "Toggle project enabled/disabled"],
    ["?", "Toggle this help"],
  ];

  for (const [key, desc] of shortcuts) {
    if (row >= startRow + maxRows - 2) break;
    drawText(row, col + 4,
      `${ansi.cyan}${ansi.bold}${fitStr(key, 14)}${ansi.reset} ${desc}`,
      innerW - 2);
    row++;
  }

  row += 2;
  if (row < startRow + maxRows - 4) {
    drawText(row, col + 2, `${ansi.blue}${ansi.bold}Configuration${ansi.reset}`, innerW);
    row += 2;
    drawText(row, col + 4, `${ansi.dim}GATEWAY_URL=${ansi.reset}${GATEWAY_URL}`, innerW - 2);
    row++;
    drawText(row, col + 4, `${ansi.dim}GATEWAY_SECRET=${ansi.reset}${GATEWAY_SECRET ? "****" + GATEWAY_SECRET.slice(-4) : "(not set)"}`, innerW - 2);
    row++;
    drawText(row, col + 4, `${ansi.dim}Config files: ~/.lumigate, .env${ansi.reset}`, innerW - 2);
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function render() {
  cols = process.stdout.columns || 80;
  rows = process.stdout.rows || 24;

  const outerWidth = Math.min(cols, 120);
  const outerCol = Math.max(1, Math.floor((cols - outerWidth) / 2) + 1);
  const outerHeight = rows - 1; // leave 1 row at bottom

  w(ansi.clear);
  w(ansi.hideCursor);

  // Main box
  drawBox(1, outerCol, outerWidth, outerHeight, "AI Gateway");

  // Tab bar
  renderTabs(2, outerCol, outerWidth);

  // Divider after tabs
  drawHLine(3, outerCol, outerWidth);

  // Content area
  const contentStart = 4;
  const contentMaxRows = outerHeight - 5; // leave room for status bar + bottom border

  // Input mode overlay
  if (state.inputMode) {
    drawText(contentStart, outerCol + 2,
      `${ansi.yellow}${state.inputPrompt}${ansi.reset} ${state.inputBuffer}█`,
      outerWidth - 4);
  } else if (state.showHelp) {
    renderHelp(contentStart, outerCol, outerWidth, contentMaxRows);
  } else {
    switch (state.currentTab) {
      case 0: renderOverview(contentStart, outerCol, outerWidth, contentMaxRows); break;
      case 1: renderProviders(contentStart, outerCol, outerWidth, contentMaxRows); break;
      case 2: renderProjects(contentStart, outerCol, outerWidth, contentMaxRows); break;
      case 3: renderUsage(contentStart, outerCol, outerWidth, contentMaxRows); break;
    }
  }

  // Divider before status bar
  drawHLine(outerHeight - 1, outerCol, outerWidth);

  // Status bar
  renderStatusBar(outerHeight, outerCol, outerWidth);

  flush();
}

// --- Input handling ---
function startInput(prompt, callback) {
  state.inputMode = true;
  state.inputPrompt = prompt;
  state.inputBuffer = "";
  state.inputCallback = callback;
  // Show cursor for input
  process.stdout.write(ansi.showCursor);
  render();
}

function handleInputKey(key) {
  if (key === "\r" || key === "\n") {
    // Enter — submit
    const value = state.inputBuffer.trim();
    const cb = state.inputCallback;
    state.inputMode = false;
    state.inputBuffer = "";
    state.inputCallback = null;
    process.stdout.write(ansi.hideCursor);
    if (cb && value) cb(value);
    else render();
    return;
  }
  if (key === "\x1b" || key === "\x03") {
    // Escape or Ctrl+C — cancel input
    state.inputMode = false;
    state.inputBuffer = "";
    state.inputCallback = null;
    process.stdout.write(ansi.hideCursor);
    render();
    return;
  }
  if (key === "\x7f" || key === "\b") {
    // Backspace
    state.inputBuffer = state.inputBuffer.slice(0, -1);
    render();
    return;
  }
  // Regular character
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.inputBuffer += key;
    render();
  }
}

function getListLength() {
  switch (state.currentTab) {
    case 1: return state.providers.length;
    case 2: return state.projects.length;
    default: return 0;
  }
}

async function handleKey(key) {
  // Input mode
  if (state.inputMode) {
    handleInputKey(key);
    return;
  }

  // Global keys
  if (key === "q" || key === "\x03") {
    // Quit
    process.stdout.write(ansi.clear + ansi.showCursor + ansi.moveTo(1, 1));
    process.exit(0);
  }

  if (key === "?") {
    state.showHelp = !state.showHelp;
    render();
    return;
  }

  if (state.showHelp) {
    // Any key except ? closes help
    state.showHelp = false;
    render();
    return;
  }

  // Tab switching
  if (key >= "1" && key <= "4") {
    state.currentTab = parseInt(key) - 1;
    state.selectedIndex = 0;
    state.testResult = null;
    state.expandedProvider = null;
    render();
    return;
  }

  // Refresh
  if (key === "r") {
    await fetchAll();
    render();
    return;
  }

  // Arrow keys (escape sequences)
  if (key === "\x1b[D" || key === "\x1b[Z") {
    // Left arrow or Shift+Tab
    state.currentTab = (state.currentTab - 1 + 4) % 4;
    state.selectedIndex = 0;
    state.testResult = null;
    state.expandedProvider = null;
    render();
    return;
  }
  if (key === "\x1b[C" || key === "\t") {
    // Right arrow or Tab
    state.currentTab = (state.currentTab + 1) % 4;
    state.selectedIndex = 0;
    state.testResult = null;
    state.expandedProvider = null;
    render();
    return;
  }

  // Navigation
  const listLen = getListLength();
  if (key === "j" || key === "\x1b[B") {
    // Down
    if (listLen > 0) {
      state.selectedIndex = Math.min(state.selectedIndex + 1, listLen - 1);
      render();
    }
    return;
  }
  if (key === "k" || key === "\x1b[A") {
    // Up
    if (listLen > 0) {
      state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
      render();
    }
    return;
  }

  // Enter — expand/select
  if (key === "\r" || key === "\n") {
    if (state.currentTab === 1 && state.providers.length > 0) {
      const p = state.providers[state.selectedIndex];
      if (state.expandedProvider === p.name) {
        state.expandedProvider = null;
      } else {
        state.expandedProvider = p.name;
        if (!state.models[p.name]) {
          await fetchModels(p.name);
        }
      }
      render();
    }
    return;
  }

  // Test provider
  if (key === "t" && state.currentTab === 1 && state.providers.length > 0) {
    const p = state.providers[state.selectedIndex];
    if (p.available) {
      await testProvider(p.name);
      render();
    }
    return;
  }

  // New project
  if (key === "n" && state.currentTab === 2) {
    startInput("Project name:", async (name) => {
      await createProject(name);
      render();
    });
    return;
  }

  // Delete project
  if (key === "d" && state.currentTab === 2 && state.projects.length > 0) {
    const p = state.projects[state.selectedIndex];
    startInput(`Delete '${p.name}'? Type name to confirm:`, async (confirm) => {
      if (confirm === p.name) {
        await deleteProject(p.name);
        state.selectedIndex = Math.min(state.selectedIndex, state.projects.length - 1);
      } else {
        state.testResult = { success: false, error: "Name did not match — delete cancelled" };
      }
      render();
    });
    return;
  }

  // Toggle project
  if (key === " " && state.currentTab === 2 && state.projects.length > 0) {
    const p = state.projects[state.selectedIndex];
    await toggleProject(p.name, !p.enabled);
    render();
    return;
  }
}

// --- Terminal setup ---
function setupTerminal() {
  if (!process.stdin.isTTY) {
    console.error("Error: This tool requires an interactive terminal (TTY).");
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdout.write(ansi.hideCursor);

  // Handle keypress
  process.stdin.on("data", (data) => {
    handleKey(data).catch((e) => {
      state.error = e.message;
      render();
    });
  });

  // Handle resize
  process.stdout.on("resize", () => {
    cols = process.stdout.columns || 80;
    rows = process.stdout.rows || 24;
    render();
  });

  // Graceful exit
  const cleanup = () => {
    process.stdout.write(ansi.clear + ansi.showCursor + ansi.moveTo(1, 1));
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// --- Auto-refresh ---
let refreshTimer = null;

function startAutoRefresh() {
  refreshTimer = setInterval(async () => {
    if (!state.inputMode) {
      await fetchAll();
      render();
    }
  }, 10000);
}

// --- Main ---
async function main() {
  setupTerminal();

  // Initial render with loading state
  state.loading = true;
  render();

  // Fetch data
  await fetchAll();
  render();

  // Start auto-refresh
  startAutoRefresh();
}

main().catch((e) => {
  process.stdout.write(ansi.showCursor);
  console.error("Fatal error:", e.message);
  process.exit(1);
});
