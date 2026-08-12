---
name: support-vision
description: "Provides image recognition for non-multimodal models (text-only models like deepseek-v4-pro, GLM-5.1, mimo-v2.5-pro). Use when the main model cannot see images, when the user attaches a screenshot, design mockup, or UI screenshot, or when the user says 看看這張圖, 分析這個截圖, 這張圖片有什麼問題, 界面, 設計稿. Also use for any scenario where the user pasted an image but the current model does not support image input. Supports recognizing multiple images at once, with primary/fallback model failover. Can be triggered manually with /skill:support-vision or /vision. Iron rule: models configured by this skill are for image content recognition ONLY and must never participate in main reasoning. If the current model is already multimodal (e.g. Claude Sonnet 4, GPT-4o, Gemini), do not use this skill — let the main model recognize the image directly."
license: MIT
metadata:
  version: "1.0.1"
  repository: https://github.com/a-lang/support-vision
---

# Support Vision — Image Recognition Bridge for Non-Multimodal Models

## Iron Rule

Models configured by this skill are used **only** to describe image contents. They must **never** participate in main reasoning, decisions, analysis, or coding. They only "look" at images and output a text description of what they see.

## When to use this skill

Use this skill when:

- The user attached an image in the conversation, but the current model does not support image understanding
- The user mentions screenshots/images/UI: 看看這張圖, 分析這個截圖, 這張圖片有什麼問題, 界面, 設計稿, "the layout looks wrong", "the UI is broken"
- The user describes a visual problem vaguely: 網頁顯示不對, 佈局亂了, "the page displays incorrectly"
- You encounter an image file (PNG/JPG/WebP/etc.) while working
- The user explicitly triggers it with `/vision` or `/skill:support-vision`

**Do NOT use** when the current model is itself multimodal (e.g. Claude Sonnet 4, GPT-4o, Gemini). Let the main model recognize the image directly.

## Workflow

### 1. First-time setup — one-shot initialization

```bash
node scripts/vision.mjs init
```

Interactive guided setup with three steps:

1. **Select provider** — pick from a curated list of major platforms
2. **Enter API key** — input the API Key (or an environment variable name)
3. **Select model** — automatically fetches the available model list from the API (falls back to a recommended list if fetching fails)

Supported platforms:

| Category | Platforms |
| --- | --- |
| International | OpenAI, Google Gemini, Anthropic Claude, DeepSeek, Groq, Mistral, xAI (Grok), OpenRouter, Fireworks AI |
| China | 通義千問 (Qwen VL), 智譜 GLM (GLM-4V), Moonshot (Kimi), 階躍星辰 (Step), MiniMax, SiliconFlow (硅基流動), 小米 MiMo |
| Local | Ollama, LM Studio |
| Custom | Any OpenAI-compatible third-party platform (enter baseUrl yourself) |

### 2. Add fallback models

```bash
node scripts/vision.mjs config add
```

Same interactive flow. Added models act as fallbacks: if the primary model fails, the script automatically tries the next one.

### 3. Configuration commands

```bash
# Interactive
node scripts/vision.mjs init                    # Initialize primary model
node scripts/vision.mjs config add              # Add fallback model
node scripts/vision.mjs config edit [name]      # Edit a model

# Quick commands
node scripts/vision.mjs config list             # List all models
node scripts/vision.mjs config primary [name]   # View/set the primary model
node scripts/vision.mjs config remove <name>    # Remove a model
node scripts/vision.mjs config set-key <name> <key>   # Set API key
node scripts/vision.mjs config set-url <name> <url>   # Set API base URL
node scripts/vision.mjs config test [name]      # Test connectivity
```

### 4. Recognize images

**Single image:**

```bash
node scripts/vision.mjs ./screenshot.png
node scripts/vision.mjs ./ui.png "What layout problems does this UI have?"
node scripts/vision.mjs "https://example.com/img.png" "Describe this image"
```

**Multiple images:**

```bash
node scripts/vision.mjs img1.png img2.png "Compare the differences between these two images"
node scripts/vision.mjs ./screenshots/*.png "Analyze these UI screenshots"
node scripts/vision.mjs ./local.png https://example.com/remote.jpg "Describe both images"
```

### 5. Find the image first

If the user mentions an image but did not provide a path, search for it:

```bash
find . -name "*.png" -o -name "*.jpg" -o -name "*.webp" | head -20
ls -lt *.png *.jpg *.webp 2>/dev/null
```

## Using the recognition result

On success, the script writes the recognition result as **plain text on stdout** (stderr contains only logs and can be ignored).

1. **Read the result**: stdout content is the image description
2. **Combine with the user's question**: merge the description with the user's intent
3. **Main model continues**: use the result as context to complete the remaining task

## Fallback mechanism

The model marked ★ (first in `config list`) is the primary and is tried first. On failure, subsequent models are tried in order automatically. If all models fail, the script exits with a non-zero exit code.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `VISION_CONFIG_PATH` | Custom config file path |
| `VISION_DEFAULT_MODEL` | Temporarily override the primary model (matched by name) |
| `VISION_API_KEY` | Global API key fallback |

## Proxy configuration

In `config.json`, the `proxy` section controls proxy behavior:

```json
"proxy": {
  "disable": false,
  "urls": []
}
```

| Field | Meaning |
| --- | --- |
| `disable` | `true` disables proxying entirely — `HTTPS_PROXY`/`HTTP_PROXY` env vars and all auto-detection are ignored, and requests go direct. Omit or set to `false` to keep auto-detection (env vars > `urls` > Windows system proxy > common port probing). |
| `urls` | Explicit proxy addresses, tried first. If unreachable, falls back to auto-detection (unless `disable` is `true`). |
