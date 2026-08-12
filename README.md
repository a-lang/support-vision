# Support Vision

> **Iron Rule: Models configured in this skill are used ONLY for image recognition. They never participate in main logic reasoning.**

Provides image recognition capabilities for **non-multimodal models** (like deepseek-v4-pro, GLM-5.1, mimo-v2.5-pro) in Claude Code, Codex, Pi Agent, and any other AI coding tools.

When your main model can't "see" images, support-vision automatically calls a configured vision model to describe the image, returning the text description so your main model can continue working.

## Features

- 🖼️ **Multi-image** — Analyze multiple images at once for comparison
- 🔄 **Auto-fallback** — Primary model fails → automatically tries fallback models
- 🌍 **19+ platforms** — OpenAI / Gemini / Qwen-VL / GLM-4V / Ollama / and more
- 🎯 **Zero dependencies** — Node.js 18+ only, no install needed
- 🛠️ **Interactive setup** — `init` command guides you through provider → API key → model selection
- 🔌 **Cross-tool** — Works with any tool supporting the Agent Skills standard

## Screenshots

![Running support-vision in terminal](images/screenshot1.png)

![Recognition result](images/screenshot2.png)

## Installation

### `npx skills` (Recommended)

```bash
npx skills add https://github.com/a-lang/support-vision -g -y
```

### Mac / Linux one-liner

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/a-lang/support-vision/main/install.sh)"
```

### Git Clone (Manual)

```bash
git clone https://github.com/a-lang/support-vision.git ~/.agents/skills/support-vision
```

### Uninstall

```bash
# npx skills
npx skills remove support-vision

# Manual
node install.mjs --uninstall
```

## Quick Start

After installation, configure a vision model (one-time setup):

### git / npx skills users

```bash
# Bash / Mac / Linux
node ~/.agents/skills/support-vision/scripts/vision.mjs init

# Windows PowerShell
node "$HOME\.agents\skills\support-vision\scripts\vision.mjs" init
```

### In an Agent (Pi / Claude Code)

```
/support-vision init
```

## Usage

### git / npx skills users

```bash
# Bash / Mac / Linux
node ~/.agents/skills/support-vision/scripts/vision.mjs ./image.png

# Windows PowerShell
node "$HOME\.agents\skills\support-vision\scripts\vision.mjs" ./image.png
```

### In an Agent

Attach an image and say "look at this screenshot" or "analyze this UI" — auto-triggers. Or manually:

```
/support-vision Look at this image
```

## Configuration

```bash
node ~/.agents/skills/support-vision/scripts/vision.mjs init                   # Interactive setup
node ~/.agents/skills/support-vision/scripts/vision.mjs config add             # Add a fallback model
node ~/.agents/skills/support-vision/scripts/vision.mjs config edit [name]     # Edit a model
node ~/.agents/skills/support-vision/scripts/vision.mjs config list            # List all models
node ~/.agents/skills/support-vision/scripts/vision.mjs config primary [name]  # Set primary model
node ~/.agents/skills/support-vision/scripts/vision.mjs config remove <name>   # Remove a model
node ~/.agents/skills/support-vision/scripts/vision.mjs config set-key <n> <k> # Set API key
node ~/.agents/skills/support-vision/scripts/vision.mjs config set-url <n> <u> # Set API URL
node ~/.agents/skills/support-vision/scripts/vision.mjs config test [name]     # Test connectivity
```

## Supported Platforms

| Category | Providers |
|----------|-----------|
| International | OpenAI, Google Gemini, Anthropic Claude, DeepSeek, Groq, Mistral, xAI (Grok), OpenRouter, Fireworks AI |
| China | Qwen VL (DashScope), GLM-4V (ZhipuAI), Moonshot (Kimi), StepFun, MiniMax, SiliconFlow, Xiaomi MiMo |
| Local | Ollama, LM Studio |
| Custom | Any OpenAI-compatible platform (provide your own baseUrl) |

## How It Works

```
User sends image + question
       ↓
 Agent reads SKILL.md, calls vision.mjs
       ↓
 Primary vision model (Gemini) ──success──→ Returns description
       ↓ failure
 Fallback 1 (GPT-4o) ──success──→ Returns description
       ↓ failure
 Fallback 2 (Qwen-VL) ──success──→ Returns description
       ↓
 stdout text → main model continues working
```

> **Note:** If your main model is already multimodal (e.g., Claude Sonnet 4, GPT-4o), this skill will NOT auto-trigger. Use `/support-vision` only if you want to force using the configured vision model.

## License

MIT

---

[简体中文](README.zh_CN.md) · [繁體中文](README.zh_TW.md)
