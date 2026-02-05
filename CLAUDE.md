# 物理知識庫（physics-kb）

用 qmd + 原子化增強筆記建構的高中物理知識系統。支援學生解題、概念查詢、老師出題。

## 兩種使用模式

### 建構模式

觸發方式：使用者輸入「處理教材：<PDF 絕對路徑>」

**流程：**

1. **盤點現有筆記**：掃描 `notes/` 所有子目錄，建立現有筆記清單（標題 + 路徑），供後續步驟比對
2. **讀取 PDF**：用 multimodal 讀取掃描 PDF 全部頁面
3. **識別知識單元**：掃描所有頁面，按以下分類列出清單：
   - 概念（定律、理論、現象）
   - 人物（科學家及其貢獻）
   - 公式（方程式、計算公式）
   - 應用（技術應用）
   - 題目（例題 + 類題）
   - MOC（章節地圖）
4. **跨章節比對**：將新清單與步驟 1 的現有筆記比對，標記三種狀態：
   - 🆕 **新增**：現有筆記中不存在，需新建
   - 🔄 **合併**：已有同名筆記，需讀取舊筆記後合併新內容（加入新章節的補充、新連結）
   - ⏭️ **跳過**：已有且無新資訊可補充
5. **確認清單**：列出標記後的清單讓使用者確認，可調整每項的處理方式
6. **批量生成 / 更新筆記**：
   - 🆕 新增：按 `templates/` 模板生成，`[[連結]]` 優先指向已存在的筆記
   - 🔄 合併：讀取舊筆記，在對應段落追加新內容（新的相關概念、新連結、新章節標籤），保留舊內容不刪除
   - **必須一次處理所有筆記**，確保新舊之間的 `[[連結]]` 一致
7. **回填舊筆記連結**：檢查現有筆記中的 `[[連結]]`，若指向的筆記在這次新建了，回到舊筆記補上相關段落的連結（例如 Ch1 的概念筆記現在可以連到 Ch2 新建的延伸概念）
8. **空連結修復報告**：列出所有仍然存在的空連結（`[[X]]` 但 `X.md` 不存在），讓使用者知道哪些概念尚未建筆記
9. **提取圖片**：從 PDF 中提取圖片存入 `attachments/`，並在對應筆記中補充文字等效描述
10. **建索引**：執行 `bash scripts/index.sh`

**筆記生成規則：**

- 嚴格按照 `templates/` 中的模板格式
- ID 用 `date +%Y%m%d%H%M` 產生，批量生成時遞增分鐘數
- 每則筆記至少 3 個 `[[連結]]`，方向包含：向上（prerequisites）、平行（related）、向下（applied_in / tested_by）
- **`[[連結]]` 必須指向實際存在（或本次將新建）的筆記**，不要憑空創造連結目標
- 公式必須三層表達：LaTeX + 純文字描述 + 變數表
- 圖片必須有文字等效描述（qmd 搜尋不到圖片內容）
- 題目答案和解析中的每個概念都要連結到對應的概念筆記
- 人物筆記：一人一檔，跨領域用分段處理。若人物已存在，**追加新領域段落**而非新建檔案
- 題目筆記：每題一檔

**合併規則（🔄 處理已有筆記）：**

- 讀取舊筆記完整內容，理解現有結構
- 在適當段落追加新資訊，不刪除或覆蓋舊內容
- 新增的 `[[連結]]` 加在對應段落（相關概念、相關題目等）
- 若新章節提供了更深入的解釋，加為新段落，標註章節來源
- 更新 frontmatter：追加新的 `chapter/*` 和 `topic/*` 標籤
- 更新 `updated` 日期

**LLM 增強內容（教材原文沒有但應補充的）：**

- 常見錯誤 / 易混淆概念
- 解題策略和容易踩的坑
- 背景知識連結（理解此概念前需要先懂什麼）
- 跨概念的交叉引用

### 查詢模式

觸發方式：使用者直接提問物理問題（非「處理教材」指令的任何問題）

**搜尋策略（三層）：**

| 層級 | 工具 | 用途 | 速度 |
|------|------|------|------|
| 語意搜尋 | `qmd vsearch "<語意描述>" -c physics` | 理解意圖，找語意相關筆記 | ~10s（需載入 embedding 模型） |
| 關鍵字搜尋 | `qmd search "<單一關鍵字>" -c physics` | 精確匹配，找包含特定詞的筆記 | 即時 |
| 標籤全量搜尋 | `grep -rl "<tag>" notes/` | 保證全量召回，按標籤篩選 | 即時 |

> **重要**：`qmd search` 的 BM25 對多詞查詢做 AND 匹配，容易零結果。務必用**單一關鍵字**搜尋（如 `全反射`），不要用多詞（如 `全反射 原理 條件`）。
>
> **注意**：`qmd query`（combined search + reranking）在無 GPU 筆電上需 ~5 分鐘，不建議使用。改用上述三層策略。

**流程：**

1. **搜尋**：根據問題類型選擇搜尋策略
   - 概念 / 解題問題 → `qmd vsearch` + `qmd search`（單一關鍵字）
   - 「找所有 X 主題題目」→ `grep -rl "topic/X" notes/questions/`
   - 「找所有 X 難度題目」→ `grep -rl "difficulty/X" notes/questions/`
   - 複合條件（主題 + 難度 + 題型）→ `grep -rl "topic/X" notes/questions/ | xargs grep -l "difficulty/Y" | xargs grep -l "question-type/Z"`
2. **讀取**：讀取搜尋結果中最相關的筆記
3. **擴展**：沿筆記中的 `[[連結]]` 追蹤相關概念，用 `qmd search` 或直接讀取檔案
4. **迭代**：重複步驟 3，直到 context 足夠回答問題（通常 2-3 輪）
5. **回答**：組合所有 context，生成結構化回答

**回答格式依使用者角色調整：**

- **學生問概念**：解釋清楚 + 補充背景知識 + 推薦相關題目練習
- **學生問解題**：引用公式 + 逐步解析 + 標註易錯點
- **老師搜題**：列出符合條件的**所有**題目 + 標註難度和測試概念（必須用 grep 保證全量召回）
- **老師出題**：參考知識庫中的相似題目，生成新題 + 附解析

**搜尋技巧：**

- 概念問題：`qmd search "概念名稱"` + `qmd vsearch "概念的語意描述"`
- 人物問題：`qmd search "科學家姓名"`
- 找特定主題所有題目：`grep -rl "topic/主題" notes/questions/`
- 找特定章節所有內容：`grep -rl "chapter/章號" notes/`
- 連結追蹤：直接讀取 `notes/子目錄/筆記名.md`，不需再搜尋
- 搜不到時：換同義詞、拆解問題分段搜尋、用 grep 搜正文

## 資料夾結構

```
notes/
├── concepts/      # 概念筆記（定律、理論、現象）
├── scientists/    # 人物筆記（科學家）
├── formulas/      # 公式筆記（方程式、計算）
├── applications/  # 應用筆記（技術應用）
├── questions/     # 題目筆記（每題一檔）
└── moc/           # 章節地圖
templates/         # 六種筆記模板
attachments/       # 從 PDF 提取的圖片
sources/           # 原始 PDF
scripts/           # 自動化腳本
```

## 檔案命名規範

| 類型 | 命名格式 | 範例 |
|------|---------|------|
| 概念 | `概念名稱.md` | `光的波粒二象性.md` |
| 人物 | `人名.md` | `牛頓.md` |
| 公式 | `公式名稱.md` | `質能互換公式.md` |
| 應用 | `應用名稱.md` | `光纖通訊.md` |
| 題目 | `Q-主題-簡述-序號.md` | `Q-光學-波粒二象性判斷-01.md` |
| MOC | `Ch章號 章節名 MOC.md` | `Ch1 物理學與人類生活 MOC.md` |

## 標籤系統

```yaml
# 類型（必填，每則筆記只有一個）
type/concept | type/scientist | type/formula | type/application | type/question | type/moc

# 物理主題（必填，可多個）
topic/astronomy          # 天文學
topic/mechanics          # 力學
topic/optics             # 光學
topic/thermodynamics     # 熱學
topic/electromagnetism   # 電磁學
topic/modern-physics     # 近代物理
topic/measurement        # 測量
topic/technology         # 科技應用

# 章節（必填）
chapter/1-1   # 物理學簡史
chapter/1-2   # 物理學對人類生活的影響
chapter/1-3   # 物理學與測量

# 難度（概念和題目必填）
difficulty/basic           # 記憶、定義
difficulty/intermediate    # 理解、應用
difficulty/advanced        # 分析、綜合判斷

# 題型（題目必填）
question-type/multiple-choice    # 選擇題
question-type/fill-in-blank      # 填空題
question-type/calculation        # 計算題

# 來源
source/108-textbook   # 108課綱教材

# 狀態
status/evergreen   # 校驗完成
status/draft       # 尚未校驗
```

## 連結規範

每則筆記的連結遵循三個方向：

| 方向 | 意義 | 放置位置 |
|------|------|---------|
| 向上 | 理解此筆記需要的前置知識 | frontmatter `prerequisites` 或正文「背景知識」段落 |
| 平行 | 同層級的相關概念 | 正文「相關概念」段落 |
| 向下 | 此知識被應用或被測試的地方 | 正文「應用」或「相關題目」段落 |

連結格式：`[[筆記標題]]`（標題即檔案名稱去掉 .md）

## 模板位置

- 概念筆記：`templates/concept.md`
- 人物筆記：`templates/scientist.md`
- 公式筆記：`templates/formula.md`
- 應用筆記：`templates/application.md`
- 題目筆記：`templates/question.md`
- MOC 筆記：`templates/moc.md`
