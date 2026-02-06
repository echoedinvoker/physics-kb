# physics-kb

高中物理知識庫 — 用原子化增強筆記 + Agentic Flow 建構的學科知識系統。

## 概覽

將 108 課綱高中物理教材（全圖掃描 PDF）透過 Claude (Opus 4.5, multimodal) 轉化為原子化增強筆記，搭配 agentic flow CLI 工具，實現：

- **學生端**：輸入物理問題 → 自動搜尋筆記 → 追蹤連結擴展 context → LLM 生成答案
- **老師端**：按概念/難度搜題、生成相似題
- **技術驗證**：證明「高品質筆記 + `[[連結]]` 遍歷 + LLM」的可行性

## 架構

```
Question
  → Haiku 拆解搜尋關鍵字
  → Search（grep / qmd search / vsearch / query）
  → 讀取筆記 + 提取 [[連結]]
  → Judge：context 足夠嗎？
    ├─ No → 追蹤 [[連結]] 讀取更多筆記 → 回到 Judge（最多 5 輪）
    └─ Yes → Generate 答案
  → Verify：答案品質檢查（Sonnet 4.5）
    ├─ No → 補充搜尋 → 重新 Generate
    └─ Yes → 輸出最終答案
```

每次問答 3× Haiku + 1× Sonnet ≈ $0.01。

## 目錄結構

```
physics-kb/
├── notes/                 # 原子化增強筆記（307 篇，Ch1）
│   ├── concepts/          # 概念（定律、理論、現象）
│   ├── scientists/        # 人物（科學家）
│   ├── formulas/          # 公式
│   ├── applications/      # 應用（光纖、雷射、半導體...）
│   ├── questions/         # 題目（每題一檔）
│   └── moc/               # 章節地圖
├── agent/                 # Agentic Flow CLI
│   ├── src/
│   │   ├── index.ts       # CLI 入口
│   │   ├── agent.ts       # Agent loop（state machine）
│   │   ├── search.ts      # 搜尋策略（Strategy Pattern × 4）
│   │   ├── notes.ts       # 讀筆記、提取連結、note index
│   │   ├── llm.ts         # Anthropic API（4 個 prompt）
│   │   └── config.ts      # .env 載入
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── demo/                  # Web Demo UI
│   ├── server.ts          # Bun HTTP server（SSE 串流）
│   └── index.html         # 單頁面（Markdown + LaTeX 渲染）
├── templates/             # 6 種筆記模板
├── scripts/
│   └── index.sh           # qmd 索引建構腳本
├── CLAUDE.md              # Claude Code 建構/查詢模式指令
└── sources/               # 原始 PDF
```

## 快速開始

### 環境需求

| 項目 | 需求 |
|------|------|
| OS | Linux / macOS |
| RAM | 8GB+（qmd embed 需載入 embedding 模型 ~300MB） |
| Runtime | [Bun](https://bun.sh/) |
| 搜尋引擎 | [qmd](https://github.com/tobi/qmd) |
| API Key | [Anthropic API Key](https://console.anthropic.com/) |

### 安裝

```bash
git clone https://github.com/echoedinvoker/physics-kb.git
cd physics-kb

# 安裝 Bun（如未安裝）
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# 安裝 qmd 搜尋引擎
bun install -g github:tobi/qmd

# 建立索引 + 向量嵌入（首次會自動下載 embedding 模型 ~300MB）
bash scripts/index.sh

# 安裝 agent 依賴
cd agent
bun install

# 設定 API key
cp .env.example .env
# 編輯 .env，填入 ANTHROPIC_API_KEY
```

### 發問

```bash
cd agent

# 預設使用 grep 策略
bun run src/index.ts "光纖為什麼能傳輸訊號？"
bun run src/index.ts "愛因斯坦有哪些重要貢獻？"
bun run src/index.ts "庫侖定律的平方反比是什麼意思？"

# 切換搜尋策略
SEARCH_STRATEGY=search bun run src/index.ts "兩物體間的交互作用力"
```

輸出結構：
- `stderr` → agent loop 日誌（搜尋、Judge、連結追蹤過程）
- `stdout` → 最終答案（Markdown）

```bash
# 只看答案
bun run src/index.ts "問題" 2>/dev/null

# 答案存檔
bun run src/index.ts "問題" > answer.md
```

### Web Demo

不需要額外安裝，直接啟動：

```bash
cd demo
bun run server.ts
# → http://localhost:3456
```

功能：
- 瀏覽器問答介面，點擊或輸入物理問題
- 即時顯示 Agent 思考過程（搜尋 → Judge → 連結追蹤 → 生成 → 驗證）
- Markdown + LaTeX 公式渲染
- 多輪對話：追問「有相關題目嗎」「再給我一個」自動帶入上文
- 出題去重：連續出題不會重複

## .env 設定

```env
SEARCH_STRATEGY=grep          # grep | search | vsearch | query
ANTHROPIC_API_KEY=sk-ant-...  # 必填
MAX_ITERATIONS=5              # Judge 最多迭代輪數
MAX_CONTEXT_NOTES=20          # context 最多筆記數
```

| 策略 | 說明 | 適用場景 |
|------|------|----------|
| `grep` | 關鍵字精確匹配，即時，預設 | 日常使用、標籤全量召回 |
| `search` | qmd BM25 排序 | 需要相關性排序時 |
| `vsearch` | qmd 向量語意搜尋 | 語意模糊的問題 |
| `query` | BM25 + 向量 + reranking | 最佳品質（CPU-only 很慢，建議有 GPU） |

## Model 選擇

| 步驟 | Model | 理由 |
|------|-------|------|
| extractKeywords | Haiku 4.5 | 簡單的關鍵字拆解 |
| judge | Haiku 4.5 | 判斷 context 充足性 |
| generate | Haiku 4.5 | 根據筆記生成答案 |
| verify | Sonnet 4.5 | 品質把關需要更強判斷力 |

## 增加知識庫內容

### 用 Claude Code 建構模式

```bash
cd ~/path-to/physics-kb
claude
> 處理教材：/path/to/教材.pdf
```

建構模式會：盤點現有筆記 → 讀取 PDF → 跨章節比對（新增/合併/跳過）→ 生成筆記 → 回填舊筆記連結 → 空連結報告。

### 手動新增

1. 從 `templates/` 複製對應模板
2. `date +%Y%m%d%H%M` 產生 ID
3. 存入 `notes/` 對應子目錄
4. 確保至少 3 個 `[[連結]]`（向上、平行、向下）

### 更新索引

新增筆記後務必重新索引，確保所有搜尋策略都能找到新內容：

```bash
bash scripts/index.sh          # 完整重建（含 BM25 + 向量嵌入）
bash scripts/index.sh --update # 僅更新（較快）
```

## 規模化考量

目前為 Ch1（307 篇筆記）的 demo。完整 25 章預估 6,000-7,500 篇。

| 問題 | 嚴重度 | 狀態 |
|------|--------|------|
| grep 搜尋無排序，規模化後精準度下降 | 高 | 待處理（規模化後改預設為 `search`） |
| noteIndex 重建效能 | 中 | 已修復（JSON 快取） |
| 檔名碰撞風險 | 中 | 已修復（碰撞檢測 + 啟發式解析） |
| qmd embed 建構時間 | 低 | 一次性操作，可接受 |

## License

MIT
