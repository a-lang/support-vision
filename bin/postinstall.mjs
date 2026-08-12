#!/usr/bin/env node

/**
 * support-vision npm postinstall 指令碼
 *
 * npm install -g support-vision 後自動執行
 * 安裝到所有已知 agent 的 skills 目錄（自動建立目錄）
 */

import { existsSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const SKILL_NAME = "support-vision";

const KNOWN_AGENTS = [
  { name: "通用 (Pi / Codex)", dir: join(homedir(), ".agents", "skills") },
  { name: "Pi Agent", dir: join(homedir(), ".pi", "agent", "skills") },
  { name: "Claude Code", dir: join(homedir(), ".claude", "skills") },
];

const FILES = [
  ["SKILL.md", "SKILL.md"],
  ["config.example.json", "config.example.json"],
  ["scripts/vision.mjs", "scripts/vision.mjs"],
  ["references/supported-models.md", "references/supported-models.md"],
];

function installSkill() {
  const skillMd = join(PKG_DIR, "SKILL.md");
  if (!existsSync(skillMd)) return;

  const installed = [];

  for (const agent of KNOWN_AGENTS) {
    const dest = join(agent.dir, SKILL_NAME);
    mkdirSync(dest, { recursive: true });

    for (const [src, dst] of FILES) {
      const srcPath = join(PKG_DIR, src);
      const dstPath = join(dest, dst);
      const dstDir = dirname(dstPath);
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
      if (existsSync(srcPath)) cpSync(srcPath, dstPath);
    }

    installed.push(`${agent.name}: ${agent.dir}`);
  }

  if (installed.length > 0) {
    process.stderr.write(
      `\n  ✓ support-vision 已安裝到 ${installed.length} 個位置:\n` +
      installed.map((i) => `    - ${i}`).join("\n") +
      `\n  執行 support-vision init 來設定模型\n\n`
    );
  }
}

try {
  installSkill();
} catch {
  // 靜默失敗，不影響 npm install
}
