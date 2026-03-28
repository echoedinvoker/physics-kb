import { initLLM } from "./llm";
import { createSearchStrategy, type SearchStrategy } from "./search";
import { readNote, type NoteContent } from "./notes";
import { loadConfig, type Config } from "./config";
import Anthropic from "@anthropic-ai/sdk";
import type { LLMCallMetrics } from "./llm";

const MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic;

export function initNoteProcessor(apiKey: string) {
  client = new Anthropic({ apiKey });
}

export interface NoteProcessResult {
  matched: Array<{ knowledge: string; baseConcept: string }>;
  newNotes: Array<{ title: string; body: string; relatedConcepts: string[] }>;
  corrections: Array<{ knowledge: string; baseConcept: string; correction: string }>;
  metrics: LLMCallMetrics[];
}

interface ExtractedKnowledge {
  points: Array<{
    content: string;
    relatedConcept: string;
  }>;
}

interface ComparisonResult {
  comparisons: Array<{
    knowledge: string;
    status: "matched" | "supplement" | "new" | "incorrect";
    baseConcept?: string;
    correction?: string;
    suggestedTitle?: string;
  }>;
}

const PRICING: Record<string, { input: number; output: number }> = {
  haiku: { input: 0.80, output: 4.00 },
};

function computeCost(inputTokens: number, outputTokens: number): number {
  const p = PRICING.haiku;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

async function callJSON<T>(
  phase: string,
  system: string,
  userMsg: string,
  maxTokens: number
): Promise<{ result: T; metrics: LLMCallMetrics }> {
  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMsg }],
  });
  const durationMs = Date.now() - start;
  const { input_tokens, output_tokens } = response.usage;
  const metrics: LLMCallMetrics = {
    phase,
    model: MODEL,
    durationMs,
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    costUSD: computeCost(input_tokens, output_tokens),
  };
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  try {
    return { result: JSON.parse(jsonMatch[1]!.trim()) as T, metrics };
  } catch {
    throw new Error(`LLM 回傳非 JSON：${text.slice(0, 200)}`);
  }
}

export async function processStudentNotes(
  highlights: string[],
  annotations: string[],
  relatedConcepts: string[],
  search: SearchStrategy,
  notesPath: string
): Promise<NoteProcessResult> {
  const allMetrics: LLMCallMetrics[] = [];
  const input = [
    ...highlights.map((h) => `[重點] ${h}`),
    ...annotations.map((a) => `[註釋] ${a}`),
  ].join("\n");

  // Step 1: Extract atomic knowledge points
  const { result: extracted, metrics: m1 } = await callJSON<ExtractedKnowledge>(
    "extract_knowledge",
    `你是一位物理知識提取專家。從學生的筆記中提取原子化知識點。
每個知識點應該是一個獨立的物理概念、公式、或事實。
回傳 JSON：{ "points": [{ "content": "知識點內容", "relatedConcept": "最相關的物理概念名稱" }] }`,
    `學生筆記：\n${input}\n\n相關概念提示：${relatedConcepts.join("、")}`,
    1024
  );
  allMetrics.push(m1);

  if (!extracted.points?.length) {
    return { matched: [], newNotes: [], corrections: [], metrics: allMetrics };
  }

  // Step 2: Search base knowledge for each concept
  const conceptContexts = new Map<string, string>();
  const searchedConcepts = new Set<string>();

  for (const point of extracted.points) {
    const concept = point.relatedConcept;
    if (searchedConcepts.has(concept)) continue;
    searchedConcepts.add(concept);

    const files = await search.search([concept]);
    for (const f of files.slice(0, 3)) {
      try {
        const note = readNote(f);
        conceptContexts.set(concept, (conceptContexts.get(concept) ?? "") + `\n---\n${note.title}:\n${note.body}`);
      } catch { /* skip */ }
    }
  }

  // Step 3: Compare each knowledge point against base
  const baseContext = [...conceptContexts.entries()]
    .map(([concept, content]) => `## ${concept}\n${content}`)
    .join("\n\n");

  const { result: comparison, metrics: m2 } = await callJSON<ComparisonResult>(
    "compare_knowledge",
    `你是物理知識比對專家。比較學生的知識點和知識庫內容，分類每個知識點：
- "matched"：知識庫中已存在且一致
- "supplement"：知識庫中有相關概念但學生有新的補充觀點
- "new"：知識庫中找不到相關內容
- "incorrect"：與知識庫內容矛盾

回傳 JSON：{ "comparisons": [{ "knowledge": "知識點", "status": "matched|supplement|new|incorrect", "baseConcept": "對應的base概念名（matched/supplement/incorrect時）", "correction": "正確內容（incorrect時）", "suggestedTitle": "建議的筆記標題（supplement/new時）" }] }`,
    `學生知識點：\n${extracted.points.map((p, i) => `${i + 1}. ${p.content}`).join("\n")}\n\n知識庫內容：\n${baseContext}`,
    2048
  );
  allMetrics.push(m2);

  // Step 4: Build result
  const result: NoteProcessResult = { matched: [], newNotes: [], corrections: [], metrics: allMetrics };

  for (const comp of comparison.comparisons ?? []) {
    if (comp.status === "matched") {
      result.matched.push({ knowledge: comp.knowledge, baseConcept: comp.baseConcept ?? "" });
    } else if (comp.status === "supplement" || comp.status === "new") {
      result.newNotes.push({
        title: comp.suggestedTitle ?? comp.knowledge.slice(0, 30),
        body: comp.knowledge,
        relatedConcepts: comp.baseConcept ? [comp.baseConcept] : relatedConcepts,
      });
    } else if (comp.status === "incorrect") {
      result.corrections.push({
        knowledge: comp.knowledge,
        baseConcept: comp.baseConcept ?? "",
        correction: comp.correction ?? "",
      });
    }
  }

  return result;
}
