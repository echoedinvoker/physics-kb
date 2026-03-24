import Anthropic from "@anthropic-ai/sdk";
import type { NoteContent } from "./notes";

const MODEL = "claude-haiku-4-5-20251001";
const VERIFY_MODEL = "claude-sonnet-4-5-20250929";

// --- Metrics ---
export interface LLMCallMetrics {
  phase: string;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

const PRICING: Record<string, { input: number; output: number }> = {
  haiku: { input: 0.80, output: 4.00 },
  sonnet: { input: 3.00, output: 15.00 },
};

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const tier = model.includes("haiku") ? "haiku" : "sonnet";
  const p = PRICING[tier];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

let client: Anthropic;

export function initLLM(apiKey: string) {
  client = new Anthropic({ apiKey, timeout: 60_000 });
}

function formatContext(context: Map<string, NoteContent>): string {
  const parts: string[] = [];
  for (const [, note] of context) {
    parts.push(`--- ${note.title} ---\n${note.body.slice(0, 2000)}`);
  }
  return parts.join("\n\n");
}

async function callJSON<T>(
  phase: string,
  system: string,
  userMsg: string,
  maxTokens: number,
  model: string = MODEL
): Promise<{ result: T; metrics: LLMCallMetrics }> {
  const start = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMsg }],
  });
  const durationMs = Date.now() - start;
  const { input_tokens, output_tokens } = response.usage;
  const metrics: LLMCallMetrics = {
    phase,
    model,
    durationMs,
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    costUSD: computeCost(model, input_tokens, output_tokens),
  };

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  // Extract JSON from potential markdown code fences
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [
    null,
    text,
  ];
  try {
    return { result: JSON.parse(jsonMatch[1]!.trim()) as T, metrics };
  } catch {
    throw new Error(`LLM 回傳非 JSON：${text.slice(0, 200)}`);
  }
}

export interface KeywordResult {
  terms: string[];
  tags: string[];
}

export async function extractKeywords(
  question: string
): Promise<KeywordResult & { metrics: LLMCallMetrics }> {
  const { result, metrics } = await callJSON<KeywordResult>(
    "extractKeywords",
    `你是物理知識庫搜尋助手。根據使用者的物理問題，拆解出最有效的搜尋關鍵字。

輸入可能包含「（背景：之前的對話依序討論了：...）」前綴，表示對話脈絡。請結合背景和當前問題來判斷使用者想找什麼物理內容。

規則：
- terms：用於 grep 精確匹配搜尋的繁體中文關鍵字，3-6 個
- 每個關鍵字應為 2-3 個字的短詞（如「光纖」「全反射」「折射」），不要用長複合詞（如「光纖傳輸訊號」「全內反射原理」）
- 同時包含核心概念詞和相關概念詞，提高召回率
- 如果當前問題是「給我題目」「再一個」等後續請求，從背景中提取物理主題作為關鍵字
- tags：可能相關的 topic 標籤（如 topic/optics, topic/mechanics），0-2 個
- 關鍵字要精確，避免太泛的詞（如「物理」）
- 一律回傳 JSON 格式：{ "terms": [...], "tags": [...] }`,
    question,
    256
  );
  return { ...result, metrics };
}

export interface JudgeResult {
  sufficient: boolean;
  reason: string;
  followLinks: { name: string; relevance: number }[];
}

export async function judge(
  question: string,
  context: Map<string, NoteContent>
): Promise<JudgeResult & { metrics: LLMCallMetrics }> {
  const contextText = formatContext(context);
  const { result, metrics } = await callJSON<JudgeResult>(
    "judge",
    `你是物理知識評估助手。判斷目前收集到的筆記內容是否足以回答使用者的問題。
規則：
- sufficient：true 表示已有足夠資料可以生成好的回答
- reason：簡述判斷理由
- followLinks：如果不足，建議追蹤的 [[連結]]，每個附 relevance 分數（1-5）
  - 5 = 幾乎確定能直接補充缺失資訊
  - 3 = 可能有幫助
  - 1 = 不太確定
  - 最多列 5 個，只列 relevance ≥ 3 的
- 如果 context 已經涵蓋核心概念，即使不完美也算足夠
- 回傳 JSON：{ "sufficient": bool, "reason": "...", "followLinks": [{ "name": "連結名", "relevance": 5 }, ...] }`,
    `問題：${question}\n\n已收集的筆記內容：\n${contextText}`,
    512
  );

  // Filter: only follow links with relevance >= 3
  if (result.followLinks) {
    result.followLinks = result.followLinks.filter(l => l.relevance >= 3);
  }

  return { ...result, metrics };
}

export async function generate(
  question: string,
  context: Map<string, NoteContent>
): Promise<{ text: string; metrics: LLMCallMetrics }> {
  const contextText = formatContext(context);
  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `你是物理知識庫助手。根據提供的筆記內容回答物理問題。
規則：
- 只根據提供的筆記內容回答，不要憑空捏造
- 如果筆記中有提到相關科學家、公式，務必引用
- 嚴格區分不同的實驗、事件、理論，不要把不同的工作混為一談（例如同一位科學家的不同實驗是獨立的貢獻）
- 如果筆記資料不足以建立明確的因果關係，誠實說明「筆記中未直接記載此關聯」，不要硬湊
- 用繁體中文回答
- 使用 Markdown 格式
- 在回答末尾列出引用的筆記標題`,
    messages: [
      {
        role: "user",
        content: `問題：${question}\n\n參考筆記：\n${contextText}`,
      },
    ],
  });
  const durationMs = Date.now() - start;
  const { input_tokens, output_tokens } = response.usage;
  const metrics: LLMCallMetrics = {
    phase: "generate",
    model: MODEL,
    durationMs,
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    costUSD: computeCost(MODEL, input_tokens, output_tokens),
  };
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return { text, metrics };
}

export interface RerankResult {
  ranked: { title: string; score: number }[];
}

/** LLM-based re-ranking: given top-N candidates, re-rank by relevance to query */
export async function rerank(
  question: string,
  candidates: { title: string; contextHeader: string; snippet: string }[]
): Promise<RerankResult & { metrics: LLMCallMetrics }> {
  const candidateText = candidates
    .map((c, i) => `[${i + 1}] ${c.title}\n    ${c.contextHeader}\n    ${c.snippet}`)
    .join("\n");

  const { result, metrics } = await callJSON<RerankResult>(
    "rerank",
    `你是筆記相關性評分助手。根據使用者的物理問題，對候選筆記按相關性評分（1-5）。
規則：
- 5 = 直接回答問題的核心筆記
- 4 = 高度相關，提供重要背景
- 3 = 部分相關
- 2 = 邊緣相關
- 1 = 不相關
- ranked：按分數降序排列，每項含 title 和 score
- 回傳 JSON：{ "ranked": [{ "title": "...", "score": N }, ...] }`,
    `問題：${question}\n\n候選筆記：\n${candidateText}`,
    1024
  );
  return { ...result, metrics };
}

export interface VerifyResult {
  pass: boolean;
  reason: string;
  searchMore: string[];
}

export async function verify(
  question: string,
  answer: string,
  context: Map<string, NoteContent>
): Promise<VerifyResult & { metrics: LLMCallMetrics }> {
  const notesList = [...context.values()].map((n) => n.title).join(", ");
  const { result, metrics } = await callJSON<VerifyResult>(
    "verify",
    `你是物理答案品質檢查助手。檢查生成的答案是否正確回答了問題。
規則：
- pass：答案品質是否合格（回答了核心問題、沒有明顯錯誤）
- reason：簡述判斷理由
- searchMore：如果不合格，建議補充搜尋的關鍵字，最多 3 個
- 特別注意：是否混淆了不同的實驗、事件或理論？同一科學家的不同貢獻是否被錯誤合併？
- 特別注意：因果關係是否有筆記內容支撐？還是答案在硬湊關聯？
- 回傳 JSON 格式：{ "pass": bool, "reason": "...", "searchMore": [...] }`,
    `問題：${question}\n\n生成的答案：\n${answer}\n\n引用的筆記：${notesList}`,
    512,
    VERIFY_MODEL
  );
  return { ...result, metrics };
}

// --- Socratic tutor functions ---

export interface SocraticMessage {
  role: "tutor" | "student";
  content: string;
}

export async function socraticGuide(
  question: string,
  context: Map<string, NoteContent>,
  conversationHistory: SocraticMessage[]
): Promise<{ text: string; metrics: LLMCallMetrics }> {
  const contextText = formatContext(context);
  const historyText = conversationHistory
    .map((m) => `${m.role === "tutor" ? "導師" : "學生"}：${m.content}`)
    .join("\n");

  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: `你是蘇格拉底式的物理導師。不要直接回答問題，而是用提問引導學生自己發現答案。

規則：
- 根據提供的筆記，識別這個問題涉及的核心概念
- 從學生可能已知的基礎出發，用循序漸進的問題引導
- 一輪最多問 2 個問題，不要一次問太多
- 如果這是多輪對話的後續輪，根據學生的回答調整方向
- 用繁體中文，語氣親切但不浮誇
- 使用 Markdown 格式`,
    messages: [
      {
        role: "user",
        content: `學生的問題：${question}\n\n${historyText ? `對話歷史：\n${historyText}\n\n` : ""}參考筆記（不要直接透露內容，用來引導方向）：\n${contextText}`,
      },
    ],
  });
  const durationMs = Date.now() - start;
  const { input_tokens, output_tokens } = response.usage;
  const metrics: LLMCallMetrics = {
    phase: "socraticGuide",
    model: MODEL,
    durationMs,
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    costUSD: computeCost(MODEL, input_tokens, output_tokens),
  };
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return { text, metrics };
}

export async function evaluateResponse(
  originalQuestion: string,
  studentAnswer: string,
  context: Map<string, NoteContent>,
  conversationHistory: SocraticMessage[],
  hintLevel: number
): Promise<{ text: string; shouldLevelUp: boolean; metrics: LLMCallMetrics }> {
  const contextText = formatContext(context);
  const historyText = conversationHistory
    .map((m) => `${m.role === "tutor" ? "導師" : "學生"}：${m.content}`)
    .join("\n");

  const hintInstruction =
    hintLevel === 0
      ? "學生剛開始嘗試。如果回答有誤，不直接糾正，用反例或實驗引導重新思考。"
      : hintLevel === 1
        ? "學生已嘗試但卡住。提供概念層級的提示（點出相關的物理概念名稱）。"
        : hintLevel === 2
          ? "學生多次卡住。提供結構層級的提示（說明推理的步驟框架）。"
          : hintLevel === 3
            ? "學生持續卡住。提供逐步提示，帶著學生一步一步推導。"
            : "學生已多次嘗試仍無法理解。直接揭曉答案並詳細解釋。";

  const { result, metrics } = await callJSON<{ text: string; shouldLevelUp: boolean }>(
    "evaluateResponse",
    `你是蘇格拉底式的物理導師。評估學生的回答，決定下一步行動。

規則：
- 如果學生回答正確：確認理解，推進到下一個子問題或總結
- 如果學生回答有誤：${hintInstruction}
- 如果學生說「不知道」或要求提示：升級提示深度
- text：你的回應（繁體中文，Markdown 格式，語氣親切）
- shouldLevelUp：如果學生卡住或回答錯誤，設為 true（將升級提示深度）
- 回傳 JSON：{ "text": "...", "shouldLevelUp": false }`,
    `原始問題：${originalQuestion}\n\n對話歷史：\n${historyText}\n\n學生最新回答：${studentAnswer}\n\n參考筆記：\n${contextText}`,
    1024
  );
  return { ...result, metrics };
}

// --- Misconception detection ---

export interface MisconceptionResult {
  misconceptions: Array<{
    concept: string;
    studentThinking: string;
    correction: string;
    suggestedNotes: string[];
  }>;
  summary: string;
}

export async function detectMisconception(
  question: string,
  studentAnswer: string,
  context: Map<string, NoteContent>
): Promise<MisconceptionResult & { metrics: LLMCallMetrics }> {
  const contextText = formatContext(context);

  const { result, metrics } = await callJSON<MisconceptionResult>(
    "detectMisconception",
    `你是物理概念診斷專家。分析學生的回答，找出具體的概念錯誤。

規則：
- 仔細比對學生的回答和筆記中的正確概念
- 特別注意筆記中的「常見錯誤」段落
- misconceptions：每個錯誤概念包含：
  - concept：錯誤涉及的概念名稱
  - studentThinking：推測學生的思考方式（為什麼會這樣想）
  - correction：正確的概念解釋（簡短）
  - suggestedNotes：建議複習的筆記標題
- summary：整體診斷摘要（1-2 句，繁體中文）
- 如果學生回答正確，misconceptions 為空陣列，summary 說明回答正確
- 回傳 JSON：{ "misconceptions": [...], "summary": "..." }`,
    `問題：${question}\n\n學生回答：${studentAnswer}\n\n參考筆記：\n${contextText}`,
    1024
  );
  return { ...result, metrics };
}
