#!/usr/bin/env node

/**
 * support-vision CLI 入口（npm 全域安裝後使用）
 *
 * 用法:
 *   support-vision <圖片...> [prompt]       辨識圖片
 *   support-vision init                     初始化
 *   support-vision config <cmd> [args]      設定管理
 *
 * 本檔案是 npm bin 入口，實際邏輯在 scripts/vision.mjs
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const SKILL_NAME = "support-vision";

/**
 * 找出 vision.mjs 的位置
 * 1) npm 安裝：在同目錄的 scripts/vision.mjs
 * 2) skill 安裝：在 ~/.agents/skills/support-vision/scripts/vision.mjs
 */
function findScript() {
  // 優先使用包內的
  const local = join(PKG_DIR, "scripts", "vision.mjs");
  if (existsSync(local)) return local;

  // 回退到 skill 目錄
  const home = homedir();
  const candidates = [
    join(home, ".agents", "skills", SKILL_NAME, "scripts", "vision.mjs"),
    join(home, ".pi", "agent", "skills", SKILL_NAME, "scripts", "vision.mjs"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  console.error(`✖ 找不到 vision.mjs，請重新安裝: npm install -g support-vision`);
  process.exit(1);
}

// 直接將參數透傳給 vision.mjs
const scriptPath = findScript();
const args = process.argv.slice(2).map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");

// 用動態 import 的方式不太好控制程序退出，直接用 child_process
import { execFileSync } from "node:child_process";
try {
  const result = execFileSync("node", [scriptPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env },
    timeout: 120000,
  });
} catch (err) {
  // execFileSync 在非零退出碼時會 throw，但 stdio: inherit 已經輸出了內容
  // 只需要傳遞退出碼
  if (err.status) process.exit(err.status);
}
