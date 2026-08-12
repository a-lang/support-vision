#!/usr/bin/env node

/**
 * support-vision 安裝指令碼
 *
 * 用法:
 *   node install.mjs              # 互動式選擇安裝到哪個 agent（預設全域）
 *   node install.mjs --all        # 安裝到所有已知 agent
 *   node install.mjs --local      # 安裝到目前專案目錄
 *   node install.mjs --dir <path> # 指定目錄
 *   node install.mjs --uninstall  # 解除安裝
 *
 * 一行安裝:
 *   git clone https://github.com/a-lang/support-vision.git /tmp/support-vision && node /tmp/support-vision/install.mjs
 *   Mac/Linux: bash -c "$(curl -fsSL https://raw.githubusercontent.com/a-lang/support-vision/main/install.sh)"
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_DIR = resolve(__dirname);
const SKILL_NAME = "support-vision";

// ---------------------------------------------------------------------------
// 已知 agent 安裝位置
// ---------------------------------------------------------------------------

const KNOWN_AGENTS = [
  {
    id: "common",
    name: "通用 Agent Skills",
    desc: "Pi / Codex / Cursor / Trae / Windsurf 等所有支援 Agent Skills 標準的工具",
    dir: join(homedir(), ".agents", "skills"),
  },
  {
    id: "claude",
    name: "Claude Code",
    desc: "~/.claude/skills/",
    dir: join(homedir(), ".claude", "skills"),
  },
];

// ---------------------------------------------------------------------------
// 工具函式
// ---------------------------------------------------------------------------

function ask(question) {
  return new Promise((resolve) => {
    const r = createInterface({ input: process.stdin, output: process.stdout });
    r.question(`  ${question}: `, (answer) => {
      r.close();
      resolve((answer.trim() || "").trim());
    });
  });
}

function askConfirm(question, defaultYes = true) {
  return new Promise((resolve) => {
    const r = createInterface({ input: process.stdin, output: process.stdout });
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    r.question(`  ${question} ${hint}: `, (answer) => {
      r.close();
      const a = answer.trim().toLowerCase();
      resolve(!a ? defaultYes : a === "y" || a === "yes");
    });
  });
}

function banner(text) {
  const line = "─".repeat(46);
  process.stdout.write(`\n  ┌${line}┐\n`);
  process.stdout.write(`  │${text.padStart((46 + text.length) / 2).padEnd(46)}│\n`);
  process.stdout.write(`  └${line}┘\n\n`);
}

// ---------------------------------------------------------------------------
// 複製 skill 檔案
// ---------------------------------------------------------------------------

const FILES_TO_COPY = [
  "SKILL.md",
  "config.example.json",
  join("scripts", "vision.mjs"),
  join("references", "supported-models.md"),
];

function copySkill(destDir) {
  // 備份使用者設定（如果有）
  const configPath = join(destDir, "config.json");
  let userConfig = null;
  if (existsSync(configPath)) {
    try { userConfig = readFileSync(configPath, "utf-8"); } catch {}
  }

  mkdirSync(destDir, { recursive: true });
  for (const f of FILES_TO_COPY) {
    const src = join(SOURCE_DIR, f);
    const dst = join(destDir, f);
    const dstDir = dirname(dst);
    if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
    if (existsSync(src)) cpSync(src, dst);
  }

  // 還原使用者設定
  if (userConfig) {
    writeFileSync(configPath, userConfig, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// 安裝
// ---------------------------------------------------------------------------

async function install(opts) {
  // --local: 安裝到目前專案
  if (opts.local) {
    const destDir = join(process.cwd(), ".agents", "skills", SKILL_NAME);
    banner(`${SKILL_NAME} 安裝（專案級）`);
    copySkill(destDir);
    process.stdout.write(`\n  ✓ 已安裝到: ${destDir}\n\n`);
    return;
  }

  // --dir: 指定目錄
  if (opts.dir) {
    const destDir = join(resolve(opts.dir), SKILL_NAME);
    banner(`${SKILL_NAME} 安裝`);
    copySkill(destDir);
    process.stdout.write(`\n  ✓ 已安裝到: ${destDir}\n`);
    showNextSteps(destDir);
    return;
  }

  // --all: 全部安裝
  if (opts.all) {
    banner(`${SKILL_NAME} 安裝`);
    installToAgents(KNOWN_AGENTS);
    return;
  }

  // 互動式選擇
  banner(`${SKILL_NAME} 安裝`);

  process.stdout.write(`  選擇要安裝到哪些 agent:\n\n`);
  KNOWN_AGENTS.forEach((agent, i) => {
    process.stdout.write(`    ${i + 1}. ${agent.name}\n`);
    process.stdout.write(`       ${agent.desc}\n\n`);
  });
  process.stdout.write(`    ${KNOWN_AGENTS.length + 1}. ALL  全部安裝\n\n`);

  const input = await ask(`請選擇 (1-${KNOWN_AGENTS.length + 1}，可多選如 "1 2")`);

  if (!input) {
    process.stdout.write("  已取消\n");
    process.exit(0);
  }

  if (input.toLowerCase() === "all" || input === String(KNOWN_AGENTS.length + 1)) {
    installToAgents(KNOWN_AGENTS);
    return;
  }

  const nums = input.split(/[\s,]+/).map((s) => parseInt(s, 10))
    .filter((n) => n >= 1 && n <= KNOWN_AGENTS.length);

  if (nums.length > 0) {
    const selected = nums.map((n) => KNOWN_AGENTS[n - 1]);
    installToAgents(selected);
    return;
  }

  process.stdout.write("  已取消\n");
}

function installToAgents(agents) {
  process.stdout.write(`\n`);
  const installed = [];

  for (const agent of agents) {
    const destDir = join(agent.dir, SKILL_NAME);

    // 備份使用者設定
    const configPath = join(destDir, "config.json");
    let userConfig = null;
    if (existsSync(configPath)) {
      try { userConfig = readFileSync(configPath, "utf-8"); } catch {}
    }

    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
    copySkill(destDir);

    // 還原使用者設定
    if (userConfig) {
      writeFileSync(configPath, userConfig, "utf-8");
    }

    process.stdout.write(`    ✓ ${agent.name}\n`);
    process.stdout.write(`      ${destDir}\n\n`);
    installed.push(destDir);
  }

  process.stdout.write(`  共安裝到 ${installed.length} 個位置\n`);
  showNextSteps(installed[0]);
}

async function showNextSteps(destDir) {
  process.stdout.write(`\n  ━━━ 下一步 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`);
  process.stdout.write(`  初始化模型設定:\n\n`);
  process.stdout.write(`    node ${join(destDir, "scripts", "vision.mjs")} init\n\n`);

  const doInit = await askConfirm("是否現在初始化？", true);
  if (doInit) {
    process.stdout.write("\n");
    try {
      execSync(`node "${join(destDir, "scripts", "vision.mjs")}" init`, { stdio: "inherit" });
    } catch {}
  }

  process.stdout.write(`\n  ✓ 安裝完成！\n\n`);
}

// ---------------------------------------------------------------------------
// 解除安裝
// ---------------------------------------------------------------------------

async function uninstall() {
  banner(`${SKILL_NAME} 解除安裝`);

  const locations = [
    ...KNOWN_AGENTS.map((a) => ({ name: a.name, dir: join(a.dir, SKILL_NAME) })),
    { name: "目前專案", dir: join(process.cwd(), ".agents", "skills", SKILL_NAME) },
  ];

  const installed = locations.filter((l) => existsSync(l.dir));

  if (installed.length === 0) {
    process.stdout.write("  未偵測到已安裝的 support-vision\n");
    process.exit(0);
  }

  process.stdout.write("  偵測到安裝:\n\n");
  for (const l of installed) {
    process.stdout.write(`    - ${l.name}: ${l.dir}\n`);
  }

  const confirm = await askConfirm("\n  確認解除安裝以上所有？", false);
  if (!confirm) {
    process.stdout.write("  已取消\n");
    process.exit(0);
  }

  for (const l of installed) {
    rmSync(l.dir, { recursive: true, force: true });
    process.stdout.write(`  ✓ 已刪除: ${l.name}\n`);
  }

  process.stdout.write("\n  ✓ 解除安裝完成\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--uninstall") || args.includes("-u")) {
  uninstall();
} else {
  install({
    all: args.includes("--all"),
    local: args.includes("--local") || args.includes("-l"),
    dir: (() => {
      const i = args.indexOf("--dir");
      return i >= 0 ? args[i + 1] : null;
    })(),
  });
}
