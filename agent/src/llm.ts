import Anthropic from "@anthropic-ai/sdk";
import type { NoteContent } from "./notes";

const MODEL = "claude-haiku-4-5-20251001";
const VERIFY_MODEL = "claude-sonnet-4-5-20250929";

let client: Anthropic;

export function initLLM(apiKey: string) {
  client = new Anthropic({ apiKey });
}

function formatContext(context: Map<string, NoteContent>): string {
  const parts: string[] = [];
  for (const [, note] of context) {
    parts.push(`--- ${note.title} ---\n${note.body.slice(0, 2000)}`);
  }
  return parts.join("\n\n");
}

async function callJSON<T>(
  system: string,
  userMsg: string,
  maxTokens: number,
  model: string = MODEL
): Promise<T> {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMsg }],
  });
  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  // Extract JSON from potential markdown code fences
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [
    null,
    text,
  ];
  try {
    return JSON.parse(jsonMatch[1]!.trim()) as T;
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
): Promise<KeywordResult> {
  return callJSON<KeywordResult>(
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
}

export interface JudgeResult {
  sufficient: boolean;
  reason: string;
  followLinks: string[];
}

export async function judge(
  question: string,
  context: Map<string, NoteContent>
): Promise<JudgeResult> {
  const contextText = formatContext(context);
  return callJSON<JudgeResult>(
    `你是物理知識評估助手。判斷目前收集到的筆記內容是否足以回答使用者的問題。
規則：
- sufficient：true 表示已有足夠資料可以生成好的回答
- reason：簡述判斷理由
- followLinks：如果不足，建議追蹤的 [[連結]] 名稱（從筆記中出現的連結挑選），最多 5 個
- 如果 context 已經涵蓋核心概念，即使不完美也算足夠
- 回傳 JSON 格式：{ "sufficient": bool, "reason": "...", "followLinks": [...] }`,
    `問題：${question}\n\n已收集的筆記內容：\n${contextText}`,
    512
  );
}

export async function generate(
  question: string,
  context: Map<string, NoteContent>
): Promise<string> {
  const contextText = formatContext(context);
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
  return response.content[0].type === "text" ? response.content[0].text : "";
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
): Promise<VerifyResult> {
  const notesList = [...context.values()].map((n) => n.title).join(", ");
  return callJSON<VerifyResult>(
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
}
