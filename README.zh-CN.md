<p align="center">
  <img src="public/icons/icon-128.png" width="80" height="80" alt="timTabTool logo" />
</p>

<h1 align="center">timTabTool</h1>

<p align="center">
  <strong>标签页自动驾驶仪。</strong><br/>
  智能分组 · 即时搜索 · 可选 AI · 100% 隐私
</p>

<p align="center">
  <a href="https://github.com/timlai0/timTabTool/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/manifest-v3-green.svg" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/chrome-extension-yellow.svg" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/firefox-addon-orange.svg" alt="Firefox Add-on" />
  <img src="https://img.shields.io/badge/vue-3-brightgreen.svg" alt="Vue 3" />
  <img src="https://img.shields.io/badge/typescript-5-blue.svg" alt="TypeScript" />
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> ·
  <a href="#安装">安装</a> ·
  <a href="#为什么选择-timtabtool">为什么选择 timTabTool</a> ·
  <a href="#开发">开发</a> ·
  <a href="#贡献">贡献</a>
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

---

> **timTabTool** 是一款免费开源的 Chrome 与 Firefox 标签页自动分组管理扩展。
> 内置 **155+ 规则**，开箱即用无需 API 密钥，零配置即可覆盖 ~75% 标签分类。
> 可选接入 **OpenAI、Claude、Gemini、OpenRouter** 或本地大模型（Ollama、DeepSeek），准确率提升至 ~95%。
> 所有数据本地存储，无需注册，不追踪，不上传。OneTab / Workona / AI Tab Master 替代方案。
>
> **timTabTool** is a free, open-source Chrome and Firefox extension for automatic tab grouping.
> 155+ built-in rules, zero config. Optional AI (OpenAI/Claude/Gemini/OpenRouter/Ollama) boosts accuracy to ~95%.
> 100% local & private. A better alternative to OneTab, Workona, and AI Tab Master.

---

## 功能特性

### 一键智能分组

单击即可将所有标签页整理为浏览器原生标签组。timTabTool 使用**内置规则引擎**，包含 155+ 域名规则和 20+ 关键词模式 — 无需 API 密钥。

### 闪电搜索

按 `Ctrl+Shift+F` 打开 Spotlight 风格的搜索浮层。跨**所有打开的标签和最近关闭的标签**搜索，支持模糊匹配、关键词高亮和相关性排序。

### 可选 AI 增强与 Window Chat

使用自己的 API 密钥将分类准确率从 ~75% 提升到 ~95%，或使用多会话 Window Chat 与当前窗口标签对话。timTabTool 支持主流 AI 供应商：

| 供应商 | 模型 |
|--------|------|
| OpenAI | gpt-4o-mini |
| Claude | claude-sonnet-4-20250514 |
| Gemini | gemini-2.5-flash |
| OpenRouter | openai/gpt-4o-mini 及各类免费/BYOK 模型 |
| 自定义 | 任何 OpenAI 兼容端点（如 DeepSeek、Ollama、Groq） |

两种 AI 分组模式：
- **增强模式** — AI 仅处理规则引擎无法分类的标签
- **自由分组模式** — AI 动态创建自定义分组名称和颜色

### 新标签自动归类

AI 分组后，新打开的标签会自动保持未分组状态。一键用 AI 将它们分到已有分组中。

### 隐私优先

- 所有数据通过 `chrome.storage.local` 存储在本地（参见 [docs/PRIVACY_POLICY.md](docs/PRIVACY_POLICY.md)）
- API 密钥仅发送到你选择的 AI 供应商
- 无账号、无追踪、无分析
- 完全开源 — 你可以自行审计代码

### 双语支持

完整的英文和简体中文支持，自动匹配你的浏览器语言设置。

## 安装

### 从扩展商店安装

- **Chrome Web Store**：*（即将上架）*
- **Firefox Add-ons (AMO)**：*（即将上架 — 需 Firefox 142+）*

### 从 GitHub Releases 下载（推荐）

1. 前往 [Releases](https://github.com/timlai0/timTabTool/releases) 页面，下载最新的 `timtabtool-chrome-vX.X.X.zip`（Chrome）或 `timtabtool-firefox-vX.X.X.zip`（Firefox）
2. 解压到一个文件夹
3. Chrome 打开 `chrome://extensions`，开启右上角的**开发者模式**，点击**加载已解压的扩展程序**并选择解压后的文件夹；Firefox 打开 `about:debugging#/runtime/this-firefox` 并加载临时扩展

### 从源码构建

<details>
<summary>适合想要自行构建的开发者</summary>

```bash
git clone https://github.com/timlai0/timTabTool.git
cd timTabTool
npm ci
npx vite build        # 构建 Chrome 版本 (dist/)
npm run build:firefox # 构建 Firefox 版本 (dist-firefox/)
```

然后在 `chrome://extensions` 中加载 `dist/` 目录（需开启开发者模式），或在 Firefox `about:debugging` 中加载 `dist-firefox/manifest.json`。

</details>

## 为什么选择 timTabTool

每个重度浏览器用户都有标签页焦虑。开发者尤其严重 — GitHub PR、Stack Overflow、文档、Jira、Slack 全混在一起。原生标签组需要手动拖拽，没人会真的去做。

**现有方案都有痛点：**

| 类别 | 代表产品 | 问题 |
|------|---------|------|
| 标签保存类 | OneTab | 把标签收成列表 — 破坏性，无智能分类 |
| 工作区类 | Workona, Partizion | 需要提前手动设置工作区 |
| AI 驱动类 | AI Tab Master, Tabaroo | 必须有 API Key，没 Key 完全不能用 |
| 域名分组类 | Tabblar | 按网站分组，缺少上下文（GitHub PR != GitHub 个人主页） |

**timTabTool 的方案：渐进增强。**

1. **Level 0（零配置）** — 规则引擎覆盖 155+ 域名和 20+ 关键词，约 75% 准确率
2. **Level 1（配置 API Key）** — AI 增强剩余 25%，准确率提升到 ~95%
3. **Level 2（AI 自由分组）** — AI 完全自定义分组名称和颜色

最好的标签管理器应该**零配置即可用**，然后用 AI 逐步增强。

## 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript |
| UI | Vue 3 + Composition API |
| 构建 | Vite + CRXJS |
| 样式 | Tailwind CSS |
| 扩展 | Manifest V3 (Chrome & Firefox 142+) |
| 测试 | Vitest |

## 项目结构

```
src/
├── background/     # Service Worker：分类器、标签管理、搜索、存储
├── popup/          # Popup UI（分组预览 + Window Chat + 操作）
├── content/        # Spotlight 搜索浮层
├── shared/         # 类型、常量、规则、AI 客户端、国际化、工具函数
└── styles/         # 全局 CSS（Tailwind）
```

## 开发

```bash
npm ci                # 安装依赖
npm run dev           # 开发服务器（HMR 热重载）
npm run build         # Chrome 生产构建
npm run build:firefox # Firefox 生产构建
npm test              # 运行测试
npm run typecheck     # 类型检查
```

## 贡献

欢迎贡献。请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解贡献指南。

## 支持

如果 timTabTool 对你有帮助，欢迎：

- 在 GitHub 上 Star 这个项目
- 分享给你的朋友

## 致谢

**timTabTool** 派生自开源扩展 [TabPilot](https://github.com/florianlanx/tabpilot)（原作者 Florian）。

## 许可证

[MIT](LICENSE) © Florian & Tim Lai
