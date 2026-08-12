#!/usr/bin/env node

/**
 * vision.mjs — Vision Support Skill 核心指令碼
 *
 * 鐵律：本指令碼設定的模型僅用於圖片內容辨識，絕不參與主邏輯推理。
 *
 * 零相依：僅使用 Node.js 18+ 內建模組
 *
 * 用法：
 *   node vision.mjs <圖片...> [prompt]            辨識一張或多張圖片
 *   node vision.mjs init                          互動式初始化（選擇主模型）
 *   node vision.mjs config add                    互動式新增 fallback 模型
 *   node vision.mjs config edit [name]            互動式編輯模型
 *   node vision.mjs config list                   列出已設定模型
 *   node vision.mjs config primary [name]         查看/設定主模型
 *   node vision.mjs config remove <name>          刪除模型
 *   node vision.mjs config set-key <name> <key>   設定金鑰
 *   node vision.mjs config set-url <name> <url>   設定 API 位址
 *   node vision.mjs config test [name]            測試連通性
 *   node vision.mjs --help
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import {
  join,
  dirname,
  extname,
  resolve,
  basename,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { homedir } from "node:os";
import { createConnection } from "node:net";

// ---------------------------------------------------------------------------
// 代理設定：config.json 的 proxy.disable 可完全關閉代理功能（最高優先）
//   disable: true  → 停用一切代理（含環境變數），fetch 一律直連
//   disable: false → 依下列四層策略自動偵測代理：
//     1. 環境變數 HTTPS_PROXY / HTTP_PROXY
//     2. config.json 中使用者設定的代理
//     3. Windows 系統代理設定（登錄檔）
//     4. 探測常見代理連接埠
// 偵測到後 patch 目前程序的 fetch，使其經由代理隧道
// ---------------------------------------------------------------------------

const COMMON_PROXY_PORTS = [
  // Clash 系列
  { port: 7890, host: "127.0.0.1" },
  { port: 7891, host: "127.0.0.1" },
  { port: 7892, host: "127.0.0.1" },
  { port: 7893, host: "127.0.0.1" },
  { port: 7897, host: "127.0.0.1" },
  // V2Ray / Xray
  { port: 10808, host: "127.0.0.1" },
  { port: 10809, host: "127.0.0.1" },
  { port: 1080, host: "127.0.0.1" },
  { port: 1081, host: "127.0.0.1" },
  // Shadowsocks
  { port: 1087, host: "127.0.0.1" },
  { port: 1086, host: "127.0.0.1" },
  // 其他常見
  { port: 8080, host: "127.0.0.1" },
  { port: 8118, host: "127.0.0.1" },
  { port: 9090, host: "127.0.0.1" },
];

// 從 config.json 讀取代理設定（disable 旗標 + 使用者自訂代理位址）
function loadConfigProxy() {
  try {
    const configDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const name of ["config.json", "config.example.json"]) {
      const p = join(configDir, name);
      if (existsSync(p)) {
        const cfg = JSON.parse(readFileSync(p, "utf-8"));
        return {
          disable: cfg.proxy?.disable === true,
          urls: Array.isArray(cfg.proxy?.urls) ? cfg.proxy.urls : [],
        };
      }
    }
  } catch {}
  return { disable: false, urls: [] };
}

// 探測單個連接埠是否有 HTTP 代理在監聽
function probePort(host, port, timeout = 300) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(timeout);
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => { sock.destroy(); resolve(false); });
  });
}

// 從 Windows 登錄檔讀取系統代理
function readWindowsSystemProxy() {
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer 2>nul',
      { encoding: "utf-8", timeout: 2000 }
    );
    const match = out.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (match) {
      let proxy = match[1].trim();
      // 處理 "127.0.0.1:7897" 或 "http=127.0.0.1:7897;https=127.0.0.1:7897"
      if (proxy.includes("=")) {
        const https = proxy.match(/https=([^;]+)/);
        const http = proxy.match(/http=([^;]+)/);
        proxy = https?.[1] || http?.[1] || proxy;
      }
      if (!proxy.startsWith("http")) proxy = `http://${proxy}`;
      return proxy;
    }
  } catch {}
  return null;
}

// 自動偵測代理
async function detectProxy() {
  // 第 0 層：config.json proxy.disable — 完全停用代理（含環境變數）
  const proxyCfg = loadConfigProxy();
  if (proxyCfg.disable) return null;

  // 第 1 層：環境變數（使用者顯式設定，最高優先）
  const fromEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
                  process.env.https_proxy || process.env.http_proxy;
  if (fromEnv) return fromEnv;

  // 第 2 層：config.json 中使用者設定的代理（配了先試，不通再走後面的自動偵測）
  const configUrls = proxyCfg.urls;
  if (configUrls.length > 0) {
    for (const url of configUrls) {
      try {
        const u = new URL(url);
        const ok = await probePort(u.hostname, parseInt(u.port) || 80, 500);
        if (ok) return url;
      } catch {}
    }
    // 使用者配的都不通，繼續走下面的自動偵測
  }

  // 第 3 層：Windows 系統代理
  if (process.platform === "win32") {
    const sysProxy = readWindowsSystemProxy();
    if (sysProxy) return sysProxy;
  }

  // 第 4 層：自動探測常見代理連接埠
  const results = await Promise.all(
    COMMON_PROXY_PORTS.map(async (c) => {
      const ok = await probePort(c.host, c.port);
      return ok ? `http://${c.host}:${c.port}` : null;
    })
  );

  return results.find((r) => r) || null;
}

// 偵測代理並 patch fetch，在目前程序中生效，不走 spawn 子程序
const _detectedProxy = await detectProxy();
if (_detectedProxy) {
  patchFetchProxy(_detectedProxy);
}

/**
 * 在程序中 patch globalThis.fetch，讓所有 fetch 呼叫走 HTTP 代理隧道
 * 好處：不用 spawn 子程序，避免 Node 24 Windows 上的退出碼 bug
 */
function patchFetchProxy(proxyUrl) {
  const pUrl = new URL(proxyUrl);
  const origFetch = globalThis.fetch;

  globalThis.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);

    // https 走代理，http 直連
    if (u.protocol !== "https:") {
      return origFetch(input, init);
    }

    // 透過代理建立 CONNECT 隧道
    const tunnel = await new Promise((resolve, reject) => {
      const connectReq = http.request({
        host: pUrl.hostname,
        port: parseInt(pUrl.port) || 80,
        method: "CONNECT",
        path: `${u.hostname}:${u.port || 443}`,
      });
      connectReq.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
          return;
        }
        // 用 CONNECT 得到的 socket 建立 TLS 連線
        const agent = new https.Agent({
          socket,
          createConnection: () => tls.connect({
            host: u.hostname,
            socket,
            servername: u.hostname,
          }),
        });
        resolve(agent);
      });
      connectReq.on("error", reject);
      connectReq.setTimeout(8000, () => {
        connectReq.destroy(new Error("Proxy connect timeout"));
      });
      connectReq.end();
    });

    // 透過隧道發 HTTPS 請求
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: init?.method || "GET",
        headers: init?.headers,
        agent: tunnel,
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve(new Response(new Blob(chunks), {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
          }));
        });
        res.on("error", reject);
      });

      req.on("error", reject);
      if (init?.body) {
        const body = init.body;
        if (typeof body === "string") req.write(body);
        else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) req.write(Buffer.from(body));
        else if (typeof body === "object" && body !== null) req.write(JSON.stringify(body));
      }
      req.end();
    });
  };
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_DIR = resolve(__dirname, "..");

const SUPPORTED_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg",
]);

const MIME_MAP = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const EXIT = {
  OK: 0, NO_CONFIG: 1, NO_IMAGE: 2, ALL_FAILED: 3,
  BAD_ARGS: 4, TOO_LARGE: 5, BAD_FORMAT: 6, CONFIG_ERROR: 7,
};

const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Provider 目錄 — 涵蓋國內外主流平台
// ---------------------------------------------------------------------------

const PROVIDER_CATALOG = [
  // ── 國際平台 ──
  {
    id: "openai",
    name: "OpenAI",
    apiFormat: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    fetchModels: true,
  },
  {
    id: "google",
    name: "Google Gemini",
    apiFormat: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyEnv: "GEMINI_API_KEY",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    fetchModels: true,
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    apiFormat: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyEnv: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-sonnet-20241022"],
    fetchModels: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    apiFormat: "openai",
    baseUrl: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat"],
    fetchModels: true,
  },
  {
    id: "groq",
    name: "Groq",
    apiFormat: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    models: ["llama-3.2-90b-vision", "llama-3.2-11b-vision"],
    fetchModels: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    apiFormat: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    models: ["pixtral-large-latest", "pixtral-12b-latest"],
    fetchModels: true,
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    apiFormat: "openai",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    models: ["grok-2-vision"],
    fetchModels: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    apiFormat: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    models: [],
    fetchModels: true,
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    apiFormat: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyEnv: "FIREWORKS_API_KEY",
    models: [],
    fetchModels: true,
  },
  // ── 中國平台 ──
  {
    id: "dashscope",
    name: "通義千問 (Qwen VL)",
    apiFormat: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY",
    models: ["qwen-vl-max", "qwen-vl-plus", "qwen2.5-vl-72b-instruct", "qwen2-vl-72b-instruct"],
    fetchModels: false,
  },
  {
    id: "zhipuai",
    name: "智譜 GLM (GLM-4V)",
    apiFormat: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyEnv: "GLM_API_KEY",
    models: ["glm-4v-plus", "glm-4v", "glm-4v-flash"],
    fetchModels: false,
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    apiFormat: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    keyEnv: "MOONSHOT_API_KEY",
    models: ["moonshot-v1-8k"],
    fetchModels: true,
  },
  {
    id: "stepfun",
    name: "階躍星辰 (Step)",
    apiFormat: "openai",
    baseUrl: "https://api.stepfun.com/v1",
    keyEnv: "STEPFUN_API_KEY",
    models: ["step-1v-8k"],
    fetchModels: true,
  },
  {
    id: "minimax",
    name: "MiniMax",
    apiFormat: "openai",
    baseUrl: "https://api.minimax.chat/v1",
    keyEnv: "MINIMAX_API_KEY",
    models: [],
    fetchModels: true,
  },
  {
    id: "siliconflow",
    name: "SiliconFlow (矽基流動)",
    apiFormat: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    keyEnv: "SILICONFLOW_API_KEY",
    models: [],
    fetchModels: true,
  },
  {
    id: "xiaomi",
    name: "小米 MiMo",
    apiFormat: "openai",
    baseUrl: "https://api.xiaomi.com/v1",
    keyEnv: "XIAOMI_API_KEY",
    models: [],
    fetchModels: true,
  },
  // ── 本機部署 ──
  {
    id: "ollama",
    name: "Ollama (本機)",
    apiFormat: "openai",
    baseUrl: "http://localhost:11434/v1",
    keyEnv: "",
    apiKey: "ollama",
    models: ["llava", "llava-llama3", "bakllava", "moondream2", "minicpm-v"],
    fetchModels: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio (本機)",
    apiFormat: "openai",
    baseUrl: "http://localhost:1234/v1",
    keyEnv: "",
    apiKey: "lm-studio",
    models: [],
    fetchModels: true,
  },
  // ── 自訂 / 第三方 ──
  {
    id: "custom",
    name: "第三方 OpenAI 相容平台",
    apiFormat: "openai",
    baseUrl: "",
    keyEnv: "",
    models: [],
    fetchModels: false,
    custom: true,
  },
];

// ---------------------------------------------------------------------------
// 日誌 → stderr
// ---------------------------------------------------------------------------

const log  = (lv, m) => {
  const t = new Date().toISOString().slice(11, 19);
  const p = lv === "error" ? "✖" : lv === "warn" ? "⚠" : "ℹ";
  process.stderr.write(`[${t}] ${p} [support-vision] ${m}\n`);
};
const info  = (m) => log("info", m);
const warn  = (m) => log("warn", m);
const error = (m) => log("error", m);

// ---------------------------------------------------------------------------
// 互動式 readline 工具
// ---------------------------------------------------------------------------

function rl() {
  return createInterface({ input: process.stdin, output: process.stderr });
}

function ask(question, defaultVal) {
  return new Promise((resolve) => {
    const r = rl();
    const hint = defaultVal ? ` [${defaultVal}]` : "";
    r.question(`  ${question}${hint}: `, (answer) => {
      r.close();
      resolve((answer.trim() || defaultVal || "").trim());
    });
  });
}

function askSelect(question, options) {
  return new Promise((resolve) => {
    const r = rl();
    process.stderr.write(`\n  ${question}:\n\n`);
    options.forEach((opt, i) => {
      const desc = opt.desc ? ` — ${opt.desc}` : "";
      process.stderr.write(`    ${i + 1}. ${opt.label}${desc}\n`);
    });
    process.stderr.write(`\n`);
    r.question(`  請選擇 (1-${options.length}): `, (answer) => {
      r.close();
      const n = parseInt(answer.trim(), 10);
      if (n >= 1 && n <= options.length) resolve(options[n - 1].value);
      else resolve(null);
    });
  });
}

function askConfirm(question, defaultYes = true) {
  return new Promise((resolve) => {
    const r = rl();
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    r.question(`  ${question} ${hint}: `, (answer) => {
      r.close();
      const a = answer.trim().toLowerCase();
      if (!a) resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}

// ---------------------------------------------------------------------------
// 設定檔管理
// ---------------------------------------------------------------------------

function configPath() {
  if (process.env.VISION_CONFIG_PATH)
    return resolve(process.env.VISION_CONFIG_PATH);
  if (existsSync(join(SKILL_DIR, "config.json")))
    return join(SKILL_DIR, "config.json");
  return join(SKILL_DIR, "config.example.json");
}

function loadConfig() {
  const p = configPath();
  if (!existsSync(p)) {
    error(`設定檔不存在: ${p}`);
    error("執行: node vision.mjs init  來初始化設定");
    process.exit(EXIT.NO_CONFIG);
  }
  try {
    const raw = readFileSync(p, "utf-8");
    const cfg = JSON.parse(raw);
    delete cfg.$schema;
    delete cfg.$comment;
    if (!Array.isArray(cfg.models)) cfg.models = [];
    return cfg;
  } catch (e) {
    error(`設定檔解析失敗: ${p}\n${e.message}`);
    process.exit(EXIT.NO_CONFIG);
  }
}

function saveConfig(cfg) {
  const src = configPath();
  const target = src.endsWith("config.example.json")
    ? join(SKILL_DIR, "config.json")
    : src;
  const out = {
    defaultPrompt: cfg.defaultPrompt || "Please describe this image in detail. If it shows a UI/web page, describe the layout, elements, colors, and any visible issues, errors, or misalignments.",
    models: cfg.models || [],
  };
  const content = JSON.stringify(out, null, 2) + "\n";
  writeFileSync(target, content, "utf-8");
  info(`設定已儲存: ${target}`);

  // 同步到所有其他已安裝位置
  const otherDirs = findOtherInstalls();
  for (const dir of otherDirs) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.json"), content, "utf-8");
      info(`  同步到: ${dir}`);
    } catch {}
  }
}

/** 查詢目前 skill 目錄以外的所有已安裝位置 */
function findOtherInstalls() {
  const home = homedir();
  const current = SKILL_DIR;
  const candidates = [
    join(home, ".agents", "skills", "support-vision"),
    join(home, ".pi", "agent", "skills", "support-vision"),
    join(home, ".claude", "skills", "support-vision"),
  ];
  return candidates.filter((d) => existsSync(d) && resolve(d) !== resolve(current));
}

function resolveApiKey(model) {
  if (model.apiKey && model.apiKey.trim()) return model.apiKey.trim();
  if (model.apiKeyEnv && process.env[model.apiKeyEnv])
    return process.env[model.apiKeyEnv].trim();
  if (process.env.VISION_API_KEY) return process.env.VISION_API_KEY.trim();
  return null;
}

function findModel(cfg, name) {
  return cfg.models.find(
    (m) => m.name === name || m.model === name
  );
}

// ---------------------------------------------------------------------------
// 從 API 自動拉取模型列表
// ---------------------------------------------------------------------------

async function fetchModelsFromAPI(provider, apiKey, baseUrl) {
  try {
    const apiFormat = provider.apiFormat;

    if (apiFormat === "openai") {
      const base = (baseUrl || provider.baseUrl).replace(/\/+$/, "");
      const url = `${base}/models`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const list = (data.data || []).map((m) => m.id || m.name || m);
      // 過濾可能支援視覺的模型（啟發式）
      return list;
    }

    if (apiFormat === "google") {
      const base = (baseUrl || provider.baseUrl).replace(/\/+$/, "");
      const url = `${base}/models?key=${apiKey}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return null;
      const data = await resp.json();
      return (data.models || []).map((m) => m.name?.replace("models/", "") || m.name);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 過濾可能支援視覺的模型（啟發式關鍵字比對）
 */
function filterVisionModels(models) {
  if (!models || models.length === 0) return [];
  const hints = [
    "vision", "vl", "visual", "image", "4o", "gpt-4-turbo",
    "gemini", "pixtral", "llava", "moondream", "minicpm",
    "qwen-vl", "qwen2-vl", "qwen2.5-vl", "glm-4v", "step-1v",
  ];
  return models.filter((m) => {
    const id = m.toLowerCase();
    return hints.some((h) => id.includes(h));
  });
}

// ---------------------------------------------------------------------------
// 互動式 init / add / edit
// ---------------------------------------------------------------------------

async function interactiveSetup(cfg, mode) {
  // mode: "init" | "add" | "edit"
  const isInit = mode === "init";
  const isEdit = mode === "edit";
  let editTarget = null;

  if (isEdit) {
    const argName = process.argv.find(
      (a, i) => i > 0 && process.argv[i - 1] === "edit" && a !== "edit"
    );
    if (argName) {
      editTarget = findModel(cfg, argName);
      if (!editTarget) {
        error(`未找到模型: ${argName}`);
        process.exit(EXIT.BAD_ARGS);
      }
    } else if (cfg.models.length > 0) {
      process.stderr.write(`\n  選擇要編輯的模型:\n\n`);
      cfg.models.forEach((m, i) => {
        const primary = i === 0 ? " ★" : "";
        process.stderr.write(`    ${i + 1}. ${m.name} (${m.model})${primary}\n`);
      });
      const sel = await askSelect("選擇", cfg.models.map((m) => ({
        value: m.name, label: `${m.name} (${m.model})`,
      })));
      editTarget = cfg.models.find((m) => m.name === sel);
    }
  }

  process.stderr.write(`\n  ╔══════════════════════════════════════════════╗\n`);
  process.stderr.write(`  ║  Vision Support — 鐵律：僅用於圖片辨識      ║\n`);
  process.stderr.write(`  ╚══════════════════════════════════════════════╝\n\n`);

  // ── 第一步：選擇 Provider ──
  const groups = [
    { label: "國際平台", items: PROVIDER_CATALOG.filter((p) => !p.id.match(/^(dashscope|zhipuai|moonshot|stepfun|minimax|siliconflow|ollama|lmstudio|custom)$/)) },
    { label: "中國平台", items: PROVIDER_CATALOG.filter((p) => p.id.match(/^(dashscope|zhipuai|moonshot|stepfun|minimax|siliconflow)$/)) },
    { label: "本機部署", items: PROVIDER_CATALOG.filter((p) => p.id.match(/^(ollama|lmstudio)$/)) },
    { label: "自訂", items: PROVIDER_CATALOG.filter((p) => p.id === "custom") },
  ];

  let provider;

  if (isEdit && editTarget) {
    // 編輯模式：回顯目前 provider
    provider = PROVIDER_CATALOG.find((p) => p.id === editTarget.provider)
      || PROVIDER_CATALOG.find((p) => p.apiFormat === editTarget.provider);
    if (provider) {
      process.stderr.write(`  目前 Provider: ${provider.name}\n`);
      const change = await askConfirm("是否更換 Provider？", false);
      if (!change) {
        // 保持原 provider
      } else {
        provider = null;
      }
    }
  }

  if (!provider) {
    process.stderr.write(`  選擇辨識模型平台:\n\n`);
    let idx = 1;
    const allOpts = [];
    for (const g of groups) {
      process.stderr.write(`  ── ${g.label} ──\n`);
      for (const p of g.items) {
        process.stderr.write(`    ${idx}. ${p.name}\n`);
        allOpts.push(p);
        idx++;
      }
    }
    const sel = await ask(`請選擇 (1-${allOpts.length})`);
    const n = parseInt(sel, 10);
    if (n < 1 || n > allOpts.length) {
      error("無效選擇");
      process.exit(EXIT.BAD_ARGS);
    }
    provider = allOpts[n - 1];
  }

  process.stderr.write(`\n  ✓ 已選擇: ${provider.name}\n\n`);

  // ── 第二步：API 金鑰 ──
  let apiKey = provider.apiKey || "";
  let apiKeyEnv = provider.keyEnv || "";

  if (isEdit && editTarget) {
    const curKey = editTarget.apiKey ? "***" + editTarget.apiKey.slice(-4) : "(未設定)";
    const curEnv = editTarget.apiKeyEnv || "(未設定)";
    process.stderr.write(`  目前金鑰: ${curKey}  環境變數: ${curEnv}\n`);
    const change = await askConfirm("是否修改金鑰？", false);
    if (!change) {
      apiKey = editTarget.apiKey || "";
      apiKeyEnv = editTarget.apiKeyEnv || "";
    }
  }

  if (isInit || (isEdit && !editTarget) || (isEdit && editTarget && (apiKey === "" && apiKeyEnv === ""))) {
    if (provider.keyEnv) {
      process.stderr.write(`  建議: 直接設定金鑰值（安全儲存在本機設定中）\n`);
      process.stderr.write(`  或輸入環境變數名稱（如 ${provider.keyEnv}）\n`);
    }
    const keyInput = await ask("API 金鑰（或環境變數名稱，直接 Enter 跳過）");
    if (keyInput) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(keyInput)) {
        apiKeyEnv = keyInput;
        apiKey = "";
      } else {
        apiKey = keyInput;
        apiKeyEnv = "";
      }
    }
  }

  const effectiveKey = apiKey || (apiKeyEnv && process.env[apiKeyEnv]) || "";

  // ── 第三步：API 位址（自訂或編輯模式）──
  let baseUrl = provider.baseUrl || "";

  if (provider.custom) {
    baseUrl = await ask("API 位址 (baseUrl)", baseUrl);
    if (!baseUrl) {
      error("自訂平台必須填寫 API 位址");
      process.exit(EXIT.BAD_ARGS);
    }
  } else if (isEdit && editTarget) {
    const curUrl = editTarget.baseUrl || provider.baseUrl;
    process.stderr.write(`  目前位址: ${curUrl}\n`);
    const newUrl = await ask("新位址（直接 Enter 保持不變）", curUrl);
    baseUrl = newUrl;
  } else {
    process.stderr.write(`  API 位址: ${baseUrl}\n`);
    const newUrl = await ask("自訂位址（直接 Enter 使用預設）", baseUrl);
    if (newUrl && newUrl !== baseUrl) baseUrl = newUrl;
  }

  // ── 第四步：選擇模型 ──
  let modelId = "";
  let modelName = "";

  if (isEdit && editTarget) {
    process.stderr.write(`\n  目前模型: ${editTarget.model}\n`);
    const change = await askConfirm("是否更換模型？", false);
    if (!change) {
      modelId = editTarget.model;
    }
  }

  if (!modelId) {
    // 嘗試從 API 拉取模型列表
    let remoteModels = null;
    if (effectiveKey && provider.fetchModels) {
      process.stderr.write(`\n  正在從 ${provider.name} 取得模型清單...`);
      try {
        const all = await fetchModelsFromAPI(provider, effectiveKey, baseUrl);
        if (all && all.length > 0) {
          const vision = filterVisionModels(all);
          remoteModels = vision.length > 0 ? vision : all;
          process.stderr.write(` ✓ 找到 ${remoteModels.length} 個模型\n`);
        } else {
          process.stderr.write(` 未找到模型\n`);
        }
      } catch {
        process.stderr.write(` 失敗\n`);
      }
    }

    if (remoteModels && remoteModels.length > 0) {
      process.stderr.write(`\n  可用模型:\n\n`);
      remoteModels.slice(0, 30).forEach((m, i) => {
        process.stderr.write(`    ${i + 1}. ${m}\n`);
      });
      if (remoteModels.length > 30) {
        process.stderr.write(`    ... 共 ${remoteModels.length} 個，僅顯示前 30 個\n`);
      }
      process.stderr.write(`\n`);
      const sel = await ask(`請選擇 (1-${Math.min(remoteModels.length, 30)})，或直接輸入模型名稱`);
      const n = parseInt(sel, 10);
      if (n >= 1 && n <= Math.min(remoteModels.length, 30)) {
        modelId = remoteModels[n - 1];
      } else if (sel) {
        modelId = sel;
      }
    } else if (provider.models.length > 0) {
      // 使用預設模型清單
      process.stderr.write(`\n  推薦模型:\n\n`);
      provider.models.forEach((m, i) => {
        process.stderr.write(`    ${i + 1}. ${m}\n`);
      });
      process.stderr.write(`\n`);
      const sel = await ask(`請選擇 (1-${provider.models.length})，或直接輸入模型名稱`);
      const n = parseInt(sel, 10);
      if (n >= 1 && n <= provider.models.length) {
        modelId = provider.models[n];
      } else if (sel) {
        modelId = sel;
      }
    } else {
      modelId = await ask("模型名稱 (model id)");
    }

    if (!modelId) {
      error("必須指定模型");
      process.exit(EXIT.BAD_ARGS);
    }
  }

  // ── 產生易讀名稱 ──
  let friendlyName;
  if (isEdit && editTarget) {
    friendlyName = editTarget.name;
  } else {
    friendlyName = `${provider.name} / ${modelId}`;
  }

  // ── 保存 ──
  const entry = {
    name: friendlyName,
    provider: provider.apiFormat,
    providerId: provider.id,
    model: modelId,
    baseUrl,
    apiKeyEnv,
    apiKey,
    timeout: 30000,
  };

  if (isEdit && editTarget) {
    const idx = cfg.models.indexOf(editTarget);
    if (idx >= 0) cfg.models[idx] = entry;
    else cfg.models.push(entry);
  } else if (isInit) {
    cfg.models.unshift(entry);
  } else {
    cfg.models.push(entry);
  }

  saveConfig(cfg);

  process.stderr.write(`\n`);
  if (isInit) {
    process.stderr.write(`  ✓ 主模型已設定: ${friendlyName}\n`);
  } else if (isEdit) {
    process.stderr.write(`  ✓ 模型已更新: ${friendlyName}\n`);
  } else {
    process.stderr.write(`  ✓ 已新增 fallback: ${friendlyName}\n`);
  }

  if (isInit && cfg.models.length === 1) {
    process.stderr.write(`\n  提示: 可以繼續執行 "node vision.mjs config add" 新增備援模型\n`);
    const more = await askConfirm("現在新增 fallback 模型？", false);
    if (more) {
      await interactiveSetup(cfg, "add");
    }
  }
}

// ---------------------------------------------------------------------------
// config 子指令
// ---------------------------------------------------------------------------

function cmdConfigList(cfg) {
  const models = cfg.models || [];
  if (models.length === 0) {
    process.stdout.write("  尚未設定模型。執行: node vision.mjs init\n");
    return;
  }
  process.stdout.write(`\n  已設定 ${models.length} 個辨識模型:\n\n`);
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const primary = i === 0 ? " ★ 主模型" : `   回退 ${i}`;
    const keyStatus = resolveApiKey(m) ? "✓" : "✗";
    process.stdout.write(
      `  ${i + 1}. ${m.name}${primary}\n` +
      `     模型: ${m.model}  |  金鑰: ${keyStatus}  |  位址: ${m.baseUrl || "預設"}\n\n`
    );
  }
  process.stdout.write("  鐵律：以上模型僅用於圖片內容辨識，絕不參與主邏輯推理。\n\n");
}

function cmdConfigRemove(cfg, name) {
  if (!name) { error("用法: config remove <名稱>"); process.exit(EXIT.BAD_ARGS); }
  const idx = cfg.models.findIndex((m) => m.name === name || m.model === name);
  if (idx === -1) { error(`未找到: ${name}`); process.exit(EXIT.BAD_ARGS); }
  const removed = cfg.models.splice(idx, 1)[0];
  saveConfig(cfg);
  console.log(`✓ 已刪除: ${removed.name}`);
}

function cmdConfigPrimary(cfg, name) {
  if (!name) { cmdConfigList(cfg); return; }
  const idx = cfg.models.findIndex((m) => m.name === name || m.model === name);
  if (idx === -1) { error(`未找到: ${name}`); process.exit(EXIT.BAD_ARGS); }
  if (idx === 0) { info(`"${cfg.models[0].name}" 已經是主模型`); return; }
  const [m] = cfg.models.splice(idx, 1);
  cfg.models.unshift(m);
  saveConfig(cfg);
  console.log(`✓ 主模型: ${m.name} (${m.model})`);
}

function cmdConfigSetKey(cfg, name, key) {
  if (!name || !key) { error("用法: config set-key <名稱> <金鑰或環境變數名稱>"); process.exit(EXIT.BAD_ARGS); }
  const m = findModel(cfg, name);
  if (!m) { error(`未找到: ${name}`); process.exit(EXIT.BAD_ARGS); }
  if (/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    m.apiKeyEnv = key; m.apiKey = "";
    saveConfig(cfg);
    console.log(`✓ ${m.name} → 環境變數 ${key}`);
  } else {
    m.apiKey = key;
    saveConfig(cfg);
    console.log(`✓ ${m.name} → 金鑰已設定`);
  }
}

function cmdConfigSetUrl(cfg, name, url) {
  if (!name || !url) { error("用法: config set-url <名稱> <API位址>"); process.exit(EXIT.BAD_ARGS); }
  const m = findModel(cfg, name);
  if (!m) { error(`未找到: ${name}`); process.exit(EXIT.BAD_ARGS); }
  m.baseUrl = url;
  saveConfig(cfg);
  console.log(`✓ ${m.name} → ${url}`);
}

async function cmdConfigTest(cfg, name) {
  const models = name
    ? cfg.models.filter((m) => m.name === name || m.model === name)
    : cfg.models;
  if (models.length === 0) { error(name ? `未找到: ${name}` : "無模型"); return; }

  info("測試連通性...\n");
  const testImage = {
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8D4HwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    mimeType: "image/png", isUrl: false,
  };
  let ok = 0;
  for (const model of models) {
    const tag = `${model.name} (${model.model})`;
    const apiKey = resolveApiKey(model);
    if (!apiKey) { error(`  ${tag}: ✗ 缺少金鑰`); continue; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      info(`  測試 ${tag}...`);
      await callModel(model, [testImage], "Reply OK.", ctrl.signal);
      clearTimeout(timer);
      info(`  ${tag}: ✓ 連通正常`);
      ok++;
    } catch (err) {
      clearTimeout(timer);
      error(`  ${tag}: ✗ ${err.name === "AbortError" ? "逾時" : err.message}`);
    }
  }
  info(`\n測試完成: ${ok}/${models.length} 正常`);
  if (ok === 0) { error("無可用模型"); process.exit(EXIT.ALL_FAILED); }
}

// ---------------------------------------------------------------------------
// 圖片處理
// ---------------------------------------------------------------------------

function isUrl(s) { return /^https?:\/\//i.test(s); }
function isImageFile(s) { return SUPPORTED_EXT.has(extname(s).toLowerCase()); }

function parseArgs(raw) {
  const images = [];
  const promptParts = [];
  for (const arg of raw) {
    if (isUrl(arg)) images.push(arg);
    else if (existsSync(resolve(arg)) && isImageFile(arg)) images.push(arg);
    else promptParts.push(arg);
  }
  return { images, prompt: promptParts.join(" ") || null };
}

async function loadImage(src) {
  if (isUrl(src)) return { path: src, base64: null, mimeType: null, isUrl: true };
  const abs = resolve(src);
  if (!existsSync(abs)) { error(`圖片不存在: ${abs}`); process.exit(EXIT.NO_IMAGE); }
  const ext = extname(abs).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) { error(`不支援: ${ext}`); process.exit(EXIT.BAD_FORMAT); }
  const stat = statSync(abs);
  if (stat.size > MAX_IMAGE_SIZE) { error(`過大: ${(stat.size / 1024 / 1024).toFixed(1)}MB`); process.exit(EXIT.TOO_LARGE); }
  const buffer = await readFile(abs);
  info(`已載入: ${basename(abs)} (${(stat.size / 1024).toFixed(1)}KB)`);
  return { path: abs, base64: buffer.toString("base64"), mimeType: MIME_MAP[ext] || "image/octet-stream", isUrl: false };
}

// ---------------------------------------------------------------------------
// Provider API 呼叫（均支援多圖）
// ---------------------------------------------------------------------------

async function callOpenAI(model, images, prompt, signal) {
  const apiKey = resolveApiKey(model);
  if (!apiKey) throw new Error(`缺少金鑰`);
  const base = (model.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const imageBlocks = images.map((img) =>
    img.isUrl
      ? { type: "image_url", image_url: { url: img.path, detail: "high" } }
      : { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: "high" } }
  );
  const body = {
    model: model.model,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageBlocks] }],
    max_tokens: model.maxTokens || 4096,
    temperature: model.temperature ?? 0.3,
  };
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body), signal,
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  return (await resp.json()).choices?.[0]?.message?.content?.trim() || "";
}

async function callGoogle(model, images, prompt, signal) {
  const apiKey = resolveApiKey(model);
  if (!apiKey) throw new Error(`缺少金鑰`);
  const base = (model.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const parts = [{ text: prompt }];
  for (const img of images) {
    if (img.isUrl) {
      const r = await fetch(img.path, { signal });
      const buf = Buffer.from(await r.arrayBuffer());
      parts.push({ inlineData: { mimeType: r.headers.get("content-type") || "image/png", data: buf.toString("base64") } });
    } else {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
  }
  const resp = await fetch(`${base}/models/${model.model}:generateContent?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: 4096, temperature: 0.3 } }),
    signal,
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  return ((await resp.json()).candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
}

async function callAnthropic(model, images, prompt, signal) {
  const apiKey = resolveApiKey(model);
  if (!apiKey) throw new Error(`缺少金鑰`);
  const base = (model.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const content = [];
  for (const img of images) {
    if (img.isUrl) {
      const r = await fetch(img.path, { signal });
      const buf = Buffer.from(await r.arrayBuffer());
      content.push({ type: "image", source: { type: "base64", media_type: r.headers.get("content-type") || "image/png", data: buf.toString("base64") } });
    } else {
      content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.base64 } });
    }
  }
  content.push({ type: "text", text: prompt });
  const resp = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: model.model, max_tokens: 4096, messages: [{ role: "user", content }] }),
    signal,
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  return ((await resp.json()).content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
}

async function callModel(model, images, prompt, signal) {
  const fmt = (model.provider || "openai").toLowerCase();
  if (fmt === "google" || fmt === "gemini") return callGoogle(model, images, prompt, signal);
  if (fmt === "anthropic" || fmt === "claude") return callAnthropic(model, images, prompt, signal);
  return callOpenAI(model, images, prompt, signal); // 預設：所有 OpenAI 相容平台
}

// ---------------------------------------------------------------------------
// 核心：多圖辨識 + 回退
// ---------------------------------------------------------------------------

async function recognize(cfg, imageSources, prompt) {
  const models = cfg.models || [];
  if (models.length === 0) {
    error("沒有設定模型，執行: node vision.mjs init");
    process.exit(EXIT.NO_CONFIG);
  }

  const override = process.env.VISION_DEFAULT_MODEL;
  let ordered = [...models];
  if (override) {
    const idx = ordered.findIndex((m) => m.name === override || m.model === override);
    if (idx > 0) { const [m] = ordered.splice(idx, 1); ordered.unshift(m); }
  }

  const images = [];
  for (const src of imageSources) images.push(await loadImage(src));
  info(`共 ${images.length} 張圖片`);

  const finalPrompt = prompt || cfg.defaultPrompt ||
    "Please describe this image in detail. If it shows a UI/web page, describe the layout, elements, colors, and any visible issues.";
  const effectivePrompt = images.length > 1
    ? `[${images.length} images provided] ${finalPrompt}`
    : finalPrompt;

  const errors = [];
  for (let i = 0; i < ordered.length; i++) {
    const model = ordered[i];
    const tag = `[${i + 1}/${ordered.length}] ${model.name} (${model.model})`;
    const timeout = model.timeout || 30000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      info(`${tag} 呼叫中...`);
      const result = await callModel(model, images, effectivePrompt, ctrl.signal);
      clearTimeout(timer);
      if (!result?.trim()) throw new Error("回傳為空");
      info(`${tag} ✓`);
      return { success: true, model: model.name, modelId: model.model, provider: model.provider, imageCount: images.length, result: result.trim() };
    } catch (err) {
      clearTimeout(timer);
      error(`${tag} ✗ ${err.name === "AbortError" ? "逾時" : err.message}`);
      errors.push({ model: model.name, error: err.name === "AbortError" ? "逾時" : err.message });
    }
  }

  error("所有模型均失敗");
  return { success: false, error: "所有辨識模型均呼叫失敗", details: errors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function showHelp() {
  console.log(`
support-vision — 非多模態模型的圖片辨識橋接

鐵律: 本工具設定的模型僅用於圖片內容辨識，絕不參與主邏輯推理。

━━━ 初始化 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  node vision.mjs init
    互動式選擇 Provider → 填金鑰 → 選模型，一步到位

━━━ 辨識圖片 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  node vision.mjs <圖片...> [prompt]
    支援同時傳入多張圖片，空格分隔，最後跟可選提示語

━━━ 設定管理 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  node vision.mjs config list                   列出模型
  node vision.mjs config add                    互動式新增 fallback
  node vision.mjs config edit [name]            互動式編輯模型
  node vision.mjs config primary [name]         查看/設定主模型
  node vision.mjs config remove <name>          刪除模型
  node vision.mjs config set-key <name> <key>   設定金鑰
  node vision.mjs config set-url <name> <url>   設定 API 位址
  node vision.mjs config test [name]            測試連通性

━━━ 環境變數 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  VISION_CONFIG_PATH    設定檔路徑
  VISION_DEFAULT_MODEL  覆蓋主模型
  VISION_API_KEY        全域金鑰回退
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    showHelp();
    process.exit(EXIT.OK);
  }

  // ── init ──
  if (args[0] === "init") {
    const cfg = existsSync(configPath()) ? loadConfig() : { models: [] };
    await interactiveSetup(cfg, "init");
    return;
  }

  // ── config ──
  if (args[0] === "config") {
    const sub = args[1];
    const cfg = loadConfig();

    switch (sub) {
      case "list":
      case "ls":
        cmdConfigList(cfg);
        break;
      case "add":
        await interactiveSetup(cfg, "add");
        break;
      case "edit":
        await interactiveSetup(cfg, "edit");
        break;
      case "primary":
        cmdConfigPrimary(cfg, args[2]);
        break;
      case "remove":
      case "rm":
        cmdConfigRemove(cfg, args[2]);
        break;
      case "set-key":
        cmdConfigSetKey(cfg, args[2], args[3]);
        break;
      case "set-url":
        cmdConfigSetUrl(cfg, args[2], args[3]);
        break;
      case "test":
        await cmdConfigTest(cfg, args[2]);
        break;
      default:
        error(`未知: config ${sub || "(空)"}`);
        error("可用: list, add, edit, primary, remove, set-key, set-url, test");
        process.exit(EXIT.BAD_ARGS);
    }
    return;
  }

  // ── 辨識圖片 ──
  const cfg = loadConfig();
  const { images: imageSources, prompt } = parseArgs(args);
  if (imageSources.length === 0) {
    error("未偵測到圖片。用法: node vision.mjs <圖片...> [prompt]");
    process.exit(EXIT.NO_IMAGE);
  }

  const result = await recognize(cfg, imageSources, prompt);
  if (result.success) {
    process.stdout.write(result.result);
    process.exit(EXIT.OK);
  } else {
    error(result.error);
    process.exit(EXIT.ALL_FAILED);
  }
}

main().catch((err) => {
  error(`異常: ${err.message}`);
  process.exit(EXIT.ALL_FAILED);
});
