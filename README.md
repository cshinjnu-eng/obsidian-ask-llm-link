# Ask LLM & Link

Obsidian 插件：选中内容 → 向 LLM 提问 → 回答保存为新笔记 → 原文自动高亮并插入 `[[wiki link]]`。

## 功能亮点

### 多内容类型支持

选中任意内容右键即可提问：

| 类型 | 示例 | LLM 策略 |
|------|------|----------|
| **文字** | 段落、句子 | 深入分析、解释概念、补充知识 |
| **表格** | Markdown 表格行列 | 分析数据关系、趋势、异常值 |
| **代码块** | ` ``` ` 包裹的代码 | 解释逻辑、指出问题、建议优化 |
| **图片** | `![[image.png]]` | 多模态理解，描述内容并结合上下文解读 |

### 全文上下文

LLM 不只看到你选中的片段，而是结合**笔记全文**来理解上下文，回答更有深度。

### 自动高亮 + 链接

操作后原文变为：
```
==选中的文字== [[2026-05-02_提问内容]]
```
- `==...==`：Obsidian 原生高亮，一眼看出哪些内容被提问过
- `[[...]]`：wiki link，点击直达 LLM 的回答笔记

### 目录结构镜像

回答笔记自动镜像源文件的目录结构：

```
源文件: notes/project/a.md
默认目录: LM-Answers
→ 回答存到: LLM-Answers/notes/project/2026-05-02_提问.md
```

### 多 Provider

在设置中一键切换：

| Provider | 模型示例 | 多模态 |
|----------|---------|--------|
| OpenAI / OpenRouter | gpt-4o | 是 |
| Anthropic | claude-sonnet-4-6 | 是 |
| Ollama（本地） | llama3 | 取决于模型 |

### 可自定义

- **系统提示词**：控制 LLM 的回答风格和策略
- **笔记模板**：支持 `{{title}}` `{{content}}` `{{source}}` `{{date}}` 变量
- **默认保存目录**：设置回答笔记的根目录
- **自动打开**：创建后是否自动打开新笔记

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

将 `main.js`、`manifest.json`、`styles.css` 复制到 vault 的插件目录。

## 使用方法

1. **选中内容**（文字 / 表格 / 代码块 / 图片引用）
2. **右键** → "Ask LLM & Link"（或命令面板搜索同名命令）
3. **输入问题** → 发送（`Cmd/Ctrl + Enter` 快捷发送）
4. **确认目录和文件名** → 创建
5. 完成：原文高亮 + 链接插入 + 新笔记打开

## 设置项

| 设置项 | 说明 |
|--------|------|
| AI Provider | OpenAI / Anthropic / Ollama |
| API Key | 对应 provider 的密钥（Ollama 可留空） |
| Base URL | API 地址（默认自动填充） |
| 模型 | 模型名称，如 gpt-4o、claude-sonnet-4-6、llama3 |
| 系统提示词 | 指导 LLM 如何结合全文回答 |
| 默认保存目录 | 回答笔记的根目录 |
| 自动打开新笔记 | 创建后是否自动打开 |
| 笔记模板 | `{{title}}` `{{content}}` `{{source}}` `{{date}}` |

## License

MIT
