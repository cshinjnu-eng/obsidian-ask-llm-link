import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";

// ─── Types ───────────────────────────────────────────────────────────────────

type Provider = "openai" | "anthropic" | "ollama";

interface AskLlmLinkSettings {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  noteTemplate: string;
  defaultFolder: string;
  autoOpenNote: boolean;
}

const DEFAULT_SYSTEM_PROMPT = `你是一个知识分析助手。用户正在 Obsidian 中编辑一篇笔记，会选中内容并向你提问。

你会收到：
- 笔记的完整内容（用于理解上下文）
- 用户选中的内容（可能是文字、表格、代码块或图片）
- 用户的提问

要求：
1. 结合笔记全文的上下文来理解选中内容的含义和背景
2. 根据内容类型采取不同策略：
   - 表格：分析数据关系、趋势、异常值，必要时用文字重新组织关键信息
   - 代码块：解释逻辑、指出潜在问题、建议优化方案
   - 图片：描述图片内容、分析图中信息、结合上下文解读含义
   - 文字：深入分析、解释概念、补充关联知识
3. 回答要具体、有深度，不要泛泛而谈
4. 回答语言与笔记语言保持一致（中文笔记用中文回答，英文笔记用英文回答）
5. 回答将被保存为独立的 Obsidian 笔记，使用 Markdown 格式
6. 适当使用标题、列表、代码块等格式增强可读性
7. 如果提问涉及笔记中未提及的内容，明确标注哪些是补充知识`;

const DEFAULT_SETTINGS: AskLlmLinkSettings = {
  provider: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  noteTemplate: `---
source: [[{{source}}]]
date: {{date}}
tags: [llm-answer]
---

# {{title}}

{{content}}`,
  defaultFolder: "LLM-Answers",
  autoOpenNote: true,
};

const PROVIDER_DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com", model: "gpt-4o" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-20250514" },
  ollama: { baseUrl: "http://localhost:11434", model: "llama3" },
};

// ─── Image Utilities ─────────────────────────────────────────────────────────

interface ImageData {
  base64: string;
  mediaType: string;
}

const IMAGE_EXTS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

function getMediaType(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTS[ext] || null;
}

function detectContentTypes(text: string): string[] {
  const types: string[] = [];
  if (/^\|.+\|$/m.test(text)) types.push("表格");
  if (/^```/m.test(text)) types.push("代码块");
  if (/!\[\[.+\]\]|!\[.*\]\(.+\)/.test(text)) types.push("图片");
  if (types.length === 0) types.push("文字");
  return types;
}

/**
 * 从选中文字中提取图片引用，读取为 base64
 */
async function extractImages(
  app: App,
  selection: string
): Promise<{ images: ImageData[]; imagePaths: string[] }> {
  const images: ImageData[] = [];
  const imagePaths: string[] = [];

  // Obsidian wiki embed: ![[image.png]] or ![[image.png|alt]]
  const wikiPattern = /!\[\[([^\]|]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif))(?:\|[^\]]*)?\]\]/gi;
  // Standard markdown: ![alt](path)
  const mdPattern = /!\[.*?\]\(([^)]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif))\)/gi;

  const paths = new Set<string>();
  let match;

  while ((match = wikiPattern.exec(selection)) !== null) {
    paths.add(match[1]);
  }
  while ((match = mdPattern.exec(selection)) !== null) {
    paths.add(match[1]);
  }

  for (const imgPath of paths) {
    const mediaType = getMediaType(imgPath);
    if (!mediaType) continue;

    // Resolve file in vault
    const file = app.metadataCache.getFirstLinkpathDest(imgPath, "");
    if (!file || !(file instanceof TFile)) continue;

    try {
      const buffer = await app.vault.readBinary(file);
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      images.push({ base64, mediaType });
      imagePaths.push(file.path);
    } catch {
      console.warn(`Failed to read image: ${file.path}`);
    }
  }

  return { images, imagePaths };
}

// ─── Multimodal Message ──────────────────────────────────────────────────────

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: ImageData };

interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

interface LlmResponse {
  content: string;
}

// ─── LLM API Calls ──────────────────────────────────────────────────────────

async function callLlm(
  settings: AskLlmLinkSettings,
  messages: LlmMessage[],
  signal?: AbortSignal
): Promise<LlmResponse> {
  switch (settings.provider) {
    case "openai":
      return callOpenAI(settings, messages, signal);
    case "anthropic":
      return callAnthropic(settings, messages, signal);
    case "ollama":
      return callOllama(settings, messages, signal);
  }
}

/** 将 ContentBlock[] 转为 OpenAI 格式 */
function toOpenAIContent(blocks: ContentBlock[]) {
  return blocks.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    return {
      type: "image_url",
      image_url: { url: `data:${b.data.mediaType};base64,${b.data.base64}` },
    };
  });
}

/** 将 ContentBlock[] 转为 Anthropic 格式 */
function toAnthropicContent(blocks: ContentBlock[]) {
  return blocks.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: b.data.mediaType,
        data: b.data.base64,
      },
    };
  });
}

function formatMessagesForAPI(
  provider: Provider,
  messages: LlmMessage[]
): any[] {
  return messages.map((m) => {
    const role = m.role;
    if (typeof m.content === "string") {
      if (provider === "ollama") return { role, content: m.content };
      return { role, content: m.content };
    }
    // Multimodal content
    if (provider === "ollama") {
      // Ollama: images as top-level array
      const textParts = m.content.filter((b) => b.type === "text") as Extract<ContentBlock, { type: "text" }>[];
      const imgParts = m.content.filter((b) => b.type === "image") as Extract<ContentBlock, { type: "image" }>[];
      return {
        role,
        content: textParts.map((t) => t.text).join("\n"),
        images: imgParts.map((i) => i.data.base64),
      };
    }
    if (provider === "anthropic") {
      return { role, content: toAnthropicContent(m.content) };
    }
    // openai
    return { role, content: toOpenAIContent(m.content) };
  });
}

async function callOpenAI(
  settings: AskLlmLinkSettings,
  messages: LlmMessage[],
  signal?: AbortSignal
): Promise<LlmResponse> {
  const url = `${settings.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const formatted = formatMessagesForAPI("openai", messages);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({ model: settings.model, messages: formatted }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return { content: data.choices[0].message.content };
}

async function callAnthropic(
  settings: AskLlmLinkSettings,
  messages: LlmMessage[],
  signal?: AbortSignal
): Promise<LlmResponse> {
  const url = `${settings.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const formatted = formatMessagesForAPI("anthropic", messages);
  const systemMsg = formatted.find((m: any) => m.role === "system");
  const nonSystem = formatted.filter((m: any) => m.role !== "system");

  const body: Record<string, any> = {
    model: settings.model,
    max_tokens: 4096,
    messages: nonSystem,
  };
  if (systemMsg) body.system = systemMsg.content;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return { content: data.content[0].text };
}

async function callOllama(
  settings: AskLlmLinkSettings,
  messages: LlmMessage[],
  signal?: AbortSignal
): Promise<LlmResponse> {
  const url = `${settings.baseUrl.replace(/\/+$/, "")}/api/chat`;
  const formatted = formatMessagesForAPI("ollama", messages);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      messages: formatted,
      stream: false,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return { content: data.message.content };
}

// ─── Prompt Modal ────────────────────────────────────────────────────────────

class PromptModal extends Modal {
  selection: string;
  contentTypes: string[];
  promptText: string;
  onSubmit: (prompt: string) => void;

  constructor(
    app: App,
    selection: string,
    contentTypes: string[],
    onSubmit: (prompt: string) => void
  ) {
    super(app);
    this.selection = selection;
    this.contentTypes = contentTypes;
    this.promptText = "";
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ask-llm-link-modal");

    contentEl.createEl("div", { cls: "modal-title", text: "Ask LLM & Link" });

    // Show detected content types
    contentEl.createEl("div", {
      text: `检测到内容类型: ${this.contentTypes.join(", ")}`,
      cls: "selection-preview",
    });

    // Preview of selected content
    const preview = this.selection.length > 300
      ? this.selection.slice(0, 300) + "..."
      : this.selection;
    contentEl.createEl("div", {
      cls: "selection-preview",
      text: preview,
    });

    // Prompt input
    contentEl.createEl("label", { text: "提问内容:" });
    const textarea = contentEl.createEl("textarea");
    textarea.value = this.promptText;
    textarea.placeholder = "输入你的问题（Cmd/Ctrl + Enter 发送）...";
    textarea.addEventListener("input", () => {
      this.promptText = textarea.value;
    });

    // Buttons
    const btnRow = contentEl.createEl("div", { cls: "modal-button-container" });

    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = btnRow.createEl("button", {
      text: "发送",
      cls: "mod-cta",
    });
    submitBtn.addEventListener("click", () => {
      if (!this.promptText.trim()) {
        new Notice("请输入提问内容");
        return;
      }
      this.close();
      this.onSubmit(this.promptText);
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitBtn.click();
      }
    });

    textarea.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Save Modal ──────────────────────────────────────────────────────────────

class SaveModal extends Modal {
  folder: string;
  fileName: string;
  onSubmit: (folder: string, fileName: string) => void;

  constructor(
    app: App,
    defaultFolder: string,
    defaultFileName: string,
    onSubmit: (folder: string, fileName: string) => void
  ) {
    super(app);
    this.folder = defaultFolder;
    this.fileName = defaultFileName;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ask-llm-link-modal");
    contentEl.createEl("div", { cls: "modal-title", text: "保存笔记" });

    contentEl.createEl("label", { text: "保存目录:" });
    const folderInput = contentEl.createEl("input", {
      type: "text",
      value: this.folder,
      placeholder: "LLM-Answers",
    });
    folderInput.style.width = "100%";
    folderInput.addEventListener("input", () => {
      this.folder = folderInput.value;
    });

    contentEl.createEl("label", { text: "文件名:" });
    const fileInput = contentEl.createEl("input", {
      type: "text",
      value: this.fileName,
    });
    fileInput.style.width = "100%";
    fileInput.addEventListener("input", () => {
      this.fileName = fileInput.value;
    });

    const btnRow = contentEl.createEl("div", { cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = btnRow.createEl("button", {
      text: "创建笔记并插入链接",
      cls: "mod-cta",
    });
    submitBtn.addEventListener("click", () => {
      if (!this.fileName.trim()) {
        new Notice("请输入文件名");
        return;
      }
      this.close();
      this.onSubmit(this.folder, this.fileName);
    });

    fileInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitBtn.click();
      }
    });

    fileInput.focus();
    fileInput.select();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

class AskLlmLinkSettingTab extends PluginSettingTab {
  plugin: AskLlmLinkPlugin;

  constructor(app: App, plugin: AskLlmLinkPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Ask LLM & Link 设置" });

    new Setting(containerEl)
      .setName("AI Provider")
      .setDesc("选择 LLM 服务提供商")
      .addDropdown((dd) =>
        dd
          .addOption("openai", "OpenAI / OpenRouter")
          .addOption("anthropic", "Anthropic (Claude)")
          .addOption("ollama", "Ollama (本地)")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value: string) => {
            this.plugin.settings.provider = value as Provider;
            const defaults = PROVIDER_DEFAULTS[this.plugin.settings.provider];
            this.plugin.settings.baseUrl = defaults.baseUrl;
            this.plugin.settings.model = defaults.model;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Ollama 可留空")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("API 基础地址")
      .addText((text) =>
        text
          .setPlaceholder(PROVIDER_DEFAULTS[this.plugin.settings.provider].baseUrl)
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("模型")
      .setDesc("模型名称，如 gpt-4o, claude-sonnet-4-6, llama3")
      .addText((text) =>
        text
          .setPlaceholder(PROVIDER_DEFAULTS[this.plugin.settings.provider].model)
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("系统提示词")
      .setDesc("指导 LLM 如何结合笔记全文回答问题")
      .addTextArea((text) =>
        text
          .setPlaceholder(DEFAULT_SYSTEM_PROMPT)
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认保存目录")
      .setDesc("回答笔记的根目录，实际路径会自动镜像源文件目录结构")
      .addText((text) =>
        text
          .setPlaceholder("LLM-Answers")
          .setValue(this.plugin.settings.defaultFolder)
          .onChange(async (value) => {
            this.plugin.settings.defaultFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("自动打开新笔记")
      .setDesc("创建后自动在新标签页打开笔记")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoOpenNote)
          .onChange(async (value) => {
            this.plugin.settings.autoOpenNote = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("笔记模板")
      .setDesc("可用变量: {{title}}, {{content}}, {{source}}, {{date}}")
      .addTextArea((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.noteTemplate)
          .setValue(this.plugin.settings.noteTemplate)
          .onChange(async (value) => {
            this.plugin.settings.noteTemplate = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

// ─── Main Plugin ─────────────────────────────────────────────────────────────

export default class AskLlmLinkPlugin extends Plugin {
  settings: AskLlmLinkSettings;

  async onload() {
    await this.loadSettings();
    console.log("Ask LLM & Link plugin loaded");

    this.addCommand({
      id: "ask-llm-link",
      name: "Ask LLM & Link",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.handleAsk(editor, view);
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selection = editor.getSelection();
        if (selection) {
          menu.addItem((item) => {
            item
              .setTitle("Ask LLM & Link")
              .setIcon("message-square")
              .onClick(() => this.handleAsk(editor, view));
          });
        }
      })
    );

    this.addSettingTab(new AskLlmLinkSettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  handleAsk(editor: Editor, view: MarkdownView) {
    const selection = editor.getSelection();
    if (!selection) {
      new Notice("请先选中内容");
      return;
    }

    // 在选区消失前记录位置
    const selFrom = editor.getCursor("from");
    const selTo = editor.getCursor("to");
    const contentTypes = detectContentTypes(selection);

    new PromptModal(this.app, selection, contentTypes, (prompt) => {
      this.executeAsk(editor, view, selection, prompt, selFrom, selTo);
    }).open();
  }

  /**
   * 计算镜像目录：defaultFolder + 源文件相对于 vault 根的父目录
   * 例：源文件在 "notes/project/a.md"，defaultFolder 为 "LLM-Answers"
   *   → 目标目录为 "LLM-Answers/notes/project"
   */
  getMirrorFolder(view: MarkdownView): string {
    const sourceFile = view.file;
    const root = this.settings.defaultFolder || "LLM-Answers";

    if (!sourceFile) return root;

    const parentPath = sourceFile.parent?.path || "";
    // parent.path 为 "" 表示 vault 根目录
    if (!parentPath || parentPath === "/") return root;

    return `${root}/${parentPath}`;
  }

  async executeAsk(
    editor: Editor,
    view: MarkdownView,
    selection: string,
    prompt: string,
    selFrom: { line: number; ch: number },
    selTo: { line: number; ch: number }
  ) {
    const controller = new AbortController();
    const notice = new Notice("正在调用 LLM...", 0);

    // Extract images from selection (if any)
    const { images, imagePaths } = await extractImages(this.app, selection);

    // Build context
    const fullText = editor.getValue();
    const sourceFileName = view.file?.basename || "untitled";
    const contentTypes = detectContentTypes(selection);

    // Text part of the user message
    const textContent = `## 笔记全文（文件名：${sourceFileName}）

${fullText}

---

## 用户选中的内容（类型：${contentTypes.join("、")}）

${selection}

---

## 用户的提问

${prompt}`;

    // Build multimodal or text-only user message
    let userContent: string | ContentBlock[];

    if (images.length > 0) {
      // Multimodal: text + images
      const blocks: ContentBlock[] = [{ type: "text", text: textContent }];
      for (const img of images) {
        blocks.push({ type: "image", data: img });
      }
      userContent = blocks;
      notice.setMessage(`正在调用 LLM（含 ${images.length} 张图片）...`);
    } else {
      userContent = textContent;
    }

    const messages: LlmMessage[] = [
      { role: "system", content: this.settings.systemPrompt },
      { role: "user", content: userContent },
    ];

    try {
      console.log("Calling LLM with", messages.length, "messages...");
      const response = await callLlm(this.settings, messages, controller.signal);
      console.log("LLM response received, length:", response.content?.length);
      notice.hide();

      // Generate default file name
      const date = new Date().toISOString().slice(0, 10);
      const sanitized = selection
        .replace(/!\[\[.*?\]\]/g, "") // remove image embeds
        .replace(/```[\s\S]*?```/g, "") // remove code blocks
        .replace(/[\[\]#^|`]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 50);
      const defaultName = `${date}_${sanitized || "query"}`;

      // Mirror source directory structure
      const defaultFolder = this.getMirrorFolder(view);

      new SaveModal(
        this.app,
        defaultFolder,
        defaultName,
        async (folder, fileName) => {
          try {
            await this.createNoteAndLink(
              editor,
              view,
              response.content,
              folder,
              fileName,
              selFrom,
              selTo
            );
          } catch (err: any) {
            const msg = err?.message || String(err);
            new Notice(`创建笔记失败: ${msg}`, 5000);
            console.error("createNoteAndLink error:", err);
          }
        }
      ).open();
    } catch (err: any) {
      notice.hide();
      const msg = err?.message || String(err);
      new Notice(`LLM 调用失败: ${msg}`, 5000);
      console.error("Ask LLM error:", err);
    }
  }

  async createNoteAndLink(
    editor: Editor,
    view: MarkdownView,
    content: string,
    folder: string,
    fileName: string,
    selFrom: { line: number; ch: number },
    selTo: { line: number; ch: number }
  ) {
    console.log("createNoteAndLink called:", { folder, fileName, selFrom, selTo });

    const date = new Date().toISOString().slice(0, 10);
    const sourceName = view.file?.basename || "unknown";

    // Build note content from template
    let noteContent = this.settings.noteTemplate
      .replace(/\{\{title\}\}/g, fileName)
      .replace(/\{\{content\}\}/g, content)
      .replace(/\{\{source\}\}/g, sourceName)
      .replace(/\{\{date\}\}/g, date);

    // Ensure folder exists (create intermediate directories)
    if (folder) {
      const parts = folder.split("/");
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!this.app.vault.getAbstractFileByPath(current)) {
          await this.app.vault.createFolder(current);
        }
      }
    }

    const filePath = folder ? `${folder}/${fileName}.md` : `${fileName}.md`;

    if (this.app.vault.getAbstractFileByPath(filePath)) {
      new Notice(`文件已存在: ${filePath}`);
      return;
    }

    await this.app.vault.create(filePath, noteContent);
    console.log("Note created:", filePath);

    // 用单次 replaceRange 替换整个选区：高亮原文 + 链接
    const originalText = editor.getRange(selFrom, selTo);
    if (originalText) {
      const replacement = `==${originalText}== [[${fileName}]]`;
      editor.replaceRange(replacement, selFrom, selTo);
    } else {
      // 选区已丢失，退回到在当前位置插入链接
      const cursor = editor.getCursor();
      editor.replaceRange(` [[${fileName}]]`, cursor);
    }

    new Notice(`已创建 ${filePath}，链接已插入`);

    if (this.settings.autoOpenNote) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file) {
        await this.app.workspace.openLinkText(filePath, "", true);
      }
    }
  }
}
