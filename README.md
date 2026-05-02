# Ask LLM & Link

Obsidian 插件：选中文字/表格/代码块/图片 → 向 LLM 提问 → 回答自动保存为新笔记 → 原文后插入 `[[wiki link]]`。

## 功能

- **多内容类型**：支持选中文字、表格、代码块、图片（多模态）
- **全文上下文**：LLM 结合笔记全文理解选中内容
- **目录镜像**：回答笔记自动存放在与源文件对应的目录结构下
- **多 Provider**：支持 OpenAI / Anthropic / Ollama，设置中切换
- **自定义模板**：笔记格式可配置，支持 `{{title}}` `{{content}}` `{{source}}` `{{date}}` 变量
- **自定义系统提示词**：在设置中调整 LLM 的回答风格

## 安装

### 手动安装

1. 从 [Releases](https://github.com/cshinjnu-eng/obsidian-ask-llm-link/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 复制到你的 vault：`<vault>/.obsidian/plugins/obsidian-ask-llm-link/`
3. 在 Obsidian → 设置 → 第三方插件 → 启用 "Ask LLM & Link"

### 从源码构建

```bash
git clone https://github.com/cshinjnu-eng/obsidian-ask-llm-link.git
cd obsidian-ask-llm-link
npm install
npm run build
```

然后将 `main.js`、`manifest.json`、`styles.css` 复制到 vault 的插件目录。

## 使用

1. 选中内容（文字、表格行、代码块、或 `![[image.png]]`）
2. 右键 → "Ask LLM & Link"，或在命令面板搜索 "Ask LLM & Link"
3. 输入问题 → 发送
4. 确认保存目录和文件名 → 创建
5. 原文后自动插入 `[[链接]]`，新笔记自动打开

## 设置

| 设置项 | 说明 |
|--------|------|
| AI Provider | OpenAI / Anthropic / Ollama |
| API Key | 对应 provider 的密钥（Ollama 可留空） |
| Base URL | API 地址（默认自动填充） |
| 模型 | 模型名称，如 gpt-4o、claude-sonnet-4-6、llama3 |
| 系统提示词 | 指导 LLM 如何回答 |
| 默认保存目录 | 回答笔记的根目录 |
| 自动打开新笔记 | 创建后是否自动打开 |
| 笔记模板 | 支持 {{title}} {{content}} {{source}} {{date}} |

## 目录镜像

源文件 `notes/project/a.md` + 默认目录 `LLM-Answers` → 回答存到 `LLM-Answers/notes/project/日期_提问.md`。

## License

MIT
