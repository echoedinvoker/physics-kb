import { resolve } from "path";
import { Glob } from "bun";
import type { Config } from "./config";
import type { SearchStrategy, MetadataFilter } from "./search";
import { type NoteContent, readNote, buildNoteIndex, resolveLink } from "./notes";
import * as llm from "./llm";
import type { LLMCallMetrics } from "./llm";

export interface QueryMetrics {
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  breakdown: LLMCallMetrics[];
  mode: string;
}

type LogFn = (msg: string) => void;
let _log: LogFn = (msg) => process.stderr.write(`[agent] ${msg}\n`);

function log(msg: string) {
  _log(msg);
}

export function setLogFn(fn: LogFn) {
  _log = fn;
}

/** Detect if user is asking for random questions and extract count, difficulty, topic */
function detectQuestionRequest(question: string): { count: number; difficulty?: string; topic?: string } | null {
  // Match patterns like: 給我五個題目, 隨機三題, 出5個問題, 來個題目, 給我高階問題
  const patterns = [
    /(?:給我|來|出|抽|隨機)\s*([一二三四五六七八九十\d]+)?\s*(?:個|道|題)?\s*.{0,10}(?:題目|題|問題)/,
    /(?:隨機)\s*(?:出|給|抽)?\s*([一二三四五六七八九十\d]+)?\s*(?:個|道|題)?\s*.{0,10}(?:題目|題|問題)/,
    /(?:題目|練習題|問題)\s*(?:來)?([一二三四五六七八九十\d]+)?(?:個|道|題)?/,
  ];

  const cnNum: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  // Difficulty keywords mapping
  const difficultyMap: Record<string, string> = {
    簡單: "basic", 基礎: "basic", 基本: "basic", 初階: "basic", 入門: "basic",
    中等: "intermediate", 中階: "intermediate",
    困難: "advanced", 難: "advanced", 高階: "advanced", 進階: "advanced", 挑戰: "advanced",
  };

  for (const pat of patterns) {
    const m = question.match(pat);
    if (m) {
      let count = 5; // default
      if (m[1]) {
        count = cnNum[m[1]] ?? (parseInt(m[1], 10) || 5);
      }
      // Detect difficulty from full question
      let difficulty: string | undefined;
      let cleanedQ = question;
      for (const [keyword, level] of Object.entries(difficultyMap)) {
        if (cleanedQ.includes(keyword)) {
          difficulty = level;
          cleanedQ = cleanedQ.replace(keyword, "");
          break;
        }
      }

      // Remove matched pattern, filler words, and count words to get topic
      const topic = cleanedQ.replace(m[0], "")
        .replace(/[的給我來出抽隨機個道一二三四五六七八九十\d]/g, "")
        .replace(/題目|問題|練習題|題/g, "")
        .trim();

      return { count: Math.min(count, 10), difficulty, topic: topic || undefined };
    }
  }
  return null;
}

/** Pick random questions from the questions directory */
async function pickRandomQuestions(
  notesPath: string,
  count: number,
  difficulty?: string,
  topic?: string
): Promise<NoteContent[]> {
  const questionsDir = resolve(notesPath, "questions");
  const glob = new Glob("Q-*.md");
  const allFiles: string[] = [];
  for await (const file of glob.scan({ cwd: questionsDir, absolute: true })) {
    allFiles.push(file);
  }

  // Read all notes once for filtering
  const notes: { file: string; note: NoteContent }[] = [];
  for (const f of allFiles) {
    try {
      notes.push({ file: f, note: readNote(f) });
    } catch { /* skip */ }
  }

  let candidates = notes;

  // Filter by difficulty
  if (difficulty) {
    const diffTag = `difficulty/${difficulty}`;
    const filtered = candidates.filter(({ note }) => {
      const tags = (note.frontmatter.tags as string[]) ?? [];
      return tags.includes(diffTag);
    });
    if (filtered.length >= count) candidates = filtered;
    else log(`Only ${filtered.length} ${difficulty} questions, using all`);
  }

  // Filter by topic
  if (topic) {
    const topicLower = topic.toLowerCase();
    const filtered = candidates.filter(({ file, note }) => {
      const tags = (note.frontmatter.tags as string[]) ?? [];
      return file.toLowerCase().includes(topicLower) ||
        tags.some(t => t.toLowerCase().includes(topicLower)) ||
        note.title.toLowerCase().includes(topicLower);
    });
    if (filtered.length >= count) candidates = filtered;
  }

  // Shuffle and pick
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  return candidates.slice(0, count).map(c => c.note);
}

/** Format question notes into a readable quiz */
function formatQuiz(questions: NoteContent[]): string {
  const parts: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const body = q.body;
    // Extract 題目 section (between ## 題目 and ## 答案)
    const questionMatch = body.match(/##\s*題目\s*\n([\s\S]*?)(?=\n##\s*答案)/);
    const questionText = questionMatch ? questionMatch[1].trim() : body.split("\n").slice(0, 5).join("\n");

    const tags = (q.frontmatter.tags as string[]) ?? [];
    const difficulty = tags.find(t => t.startsWith("difficulty/"))?.replace("difficulty/", "") ?? "";
    const chapter = q.frontmatter.chapter as string ?? "";

    parts.push(`### 第 ${i + 1} 題${difficulty ? `（${difficulty}）` : ""}${chapter ? ` [Ch.${chapter}]` : ""}\n\n${questionText}`);
  }

  parts.push("\n---\n\n<details><summary>📝 點擊查看答案</summary>\n");
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = q.frontmatter.answer as string ?? "?";
    // Extract 解析 section
    const analysisMatch = q.body.match(/##\s*解析\s*\n([\s\S]*?)(?=\n##|$)/);
    const analysis = analysisMatch ? analysisMatch[1].trim() : "";
    parts.push(`**第 ${i + 1} 題：${answer}**${analysis ? `\n${analysis}` : ""}\n`);
  }
  parts.push("</details>");

  return parts.join("\n\n");
}

/** MOC-first routing: search MOC notes first, extract relevant topic_paths */
async function mocRouting(
  terms: string[],
  notesPath: string,
  search: SearchStrategy
): Promise<MetadataFilter | undefined> {
  const mocDir = resolve(notesPath, "moc");
  try {
    // Search MOC notes specifically
    const mocFiles: string[] = [];
    const glob = new Glob("*.md");
    for await (const file of glob.scan({ cwd: mocDir, absolute: true })) {
      mocFiles.push(file);
    }

    if (mocFiles.length === 0) return undefined;

    // Read MOCs and find relevant topic_paths
    const chapters = new Set<string>();
    for (const f of mocFiles) {
      const note = readNote(f);
      const content = note.body.toLowerCase();
      const fm = note.frontmatter;
      // Check if any search term appears in MOC content
      const isRelevant = terms.some(t => content.includes(t.toLowerCase()) || note.title.includes(t));
      if (isRelevant && fm.chapter) {
        chapters.add(fm.chapter as string);
        // Also include sub-chapters (e.g. chapter "1" → include 1-1, 1-2, 1-3)
        const ch = fm.chapter as string;
        if (!ch.includes("-")) {
          // Parent chapter MOC: include all sub-sections
          for (const mf of mocFiles) {
            const mNote = readNote(mf);
            const mCh = mNote.frontmatter.chapter as string;
            if (mCh?.startsWith(ch + "-")) {
              chapters.add(mCh);
            }
          }
        }
      }
    }

    if (chapters.size > 0) {
      log(`MOC routing → chapters: ${[...chapters].join(", ")}`);
      return { chapters: [...chapters] };
    }
  } catch {
    // MOC routing failed, fall through to normal search
  }
  return undefined;
}

export type AgentMode = "normal" | "socratic" | "misconception";

export interface AgentResult {
  text: string;
  context?: Map<string, NoteContent>;
  targetConcepts?: string[];
  metrics?: QueryMetrics;
}

export async function answer(
  question: string,
  config: Config,
  search: SearchStrategy,
  mode: AgentMode = "normal"
): Promise<AgentResult> {
  // Check if user is asking for random questions (normal mode only)
  if (mode === "normal") {
    const questionReq = detectQuestionRequest(question);
    if (questionReq) {
      log(`Question request detected: ${questionReq.count} questions${questionReq.difficulty ? ` (difficulty: ${questionReq.difficulty})` : ""}${questionReq.topic ? ` (topic: ${questionReq.topic})` : ""}`);
      const questions = await pickRandomQuestions(config.notesPath, questionReq.count, questionReq.difficulty, questionReq.topic);
      if (questions.length > 0) {
        log(`Picked ${questions.length} random questions`);
        return { text: formatQuiz(questions) };
      }
      log("No questions found, falling back to normal search");
    }
  }

  // Build note index for link resolution
  log("Loading note index...");
  const noteIndex = await buildNoteIndex(config.notesPath);
  log(`Indexed ${noteIndex.size} note titles`);

  // Metrics collection
  const breakdown: LLMCallMetrics[] = [];
  function collectMetrics(m: LLMCallMetrics) {
    breakdown.push(m);
    log(`[metrics] ${JSON.stringify(m)}`);
  }
  function buildQueryMetrics(): QueryMetrics {
    return {
      totalDurationMs: breakdown.reduce((s, m) => s + m.durationMs, 0),
      totalInputTokens: breakdown.reduce((s, m) => s + m.inputTokens, 0),
      totalOutputTokens: breakdown.reduce((s, m) => s + m.outputTokens, 0),
      totalCostUSD: breakdown.reduce((s, m) => s + m.costUSD, 0),
      breakdown,
      mode,
    };
  }

  // 1. Extract keywords
  log("Extracting keywords...");
  let terms: string[];
  let tags: string[];
  // For misconception mode, wrap student statement so extractKeywords recognizes it as physics
  const kwInput = mode === "misconception"
    ? `學生對以下物理概念的理解是否正確：「${question}」，請提取相關物理概念關鍵字`
    : question;
  try {
    const { terms: t, tags: tg, metrics: kwMetrics } = await llm.extractKeywords(kwInput);
    terms = t;
    tags = tg;
    collectMetrics(kwMetrics);
  } catch {
    log("無法拆解關鍵字（可能不是物理問題）");
    return { text: "抱歉，我是物理知識庫助教，只能回答高中物理相關的問題。請試試看問我物理概念、公式或科學家相關的問題！" };
  }
  log(`Keywords: ${terms.join(", ")}${tags.length ? ` | Tags: ${tags.join(", ")}` : ""}`);

  // 1.5 MOC-first routing (optional: when note count > 500)
  let metadataFilter: MetadataFilter | undefined;
  if (noteIndex.size > 500) {
    log("MOC routing (note count > 500)...");
    metadataFilter = await mocRouting(terms, config.notesPath, search);
  }

  // 2. Initial search
  log(`Searching (strategy: ${config.searchStrategy})...`);
  const files = await search.search(terms, metadataFilter);
  log(`Found ${files.length} files`);

  const context = new Map<string, NoteContent>();
  for (const f of files.slice(0, 10)) {
    try {
      context.set(f, readNote(f));
    } catch {
      // Skip unreadable files
    }
  }
  log(`Loaded ${context.size} notes into context`);

  // 3. Judge → Follow links loop (with traversal budget)
  const MAX_ROUNDS = 3;
  const MAX_LINKS_PER_ROUND = 3;
  for (let i = 0; i < Math.min(config.maxIterations, MAX_ROUNDS); i++) {
    log(`Judge iteration ${i + 1}/${MAX_ROUNDS}...`);
    const { sufficient, reason, followLinks, metrics: judgeMetrics } = await llm.judge(question, context);
    collectMetrics(judgeMetrics);
    log(`Sufficient: ${sufficient} — ${reason}`);

    if (sufficient) break;

    // Follow suggested links (budget: max MAX_LINKS_PER_ROUND per round, sorted by relevance)
    let added = 0;
    const sortedLinks = [...(followLinks ?? [])]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, MAX_LINKS_PER_ROUND);
    for (const linkObj of sortedLinks) {
      const link = linkObj.name;
      const path = resolveLink(noteIndex, link);
      if (path && !context.has(path)) {
        try {
          context.set(path, readNote(path));
          added++;
          log(`  + ${link}`);
        } catch {
          // Skip unreadable
        }
      }
    }

    if (added === 0) {
      log("No new notes to add, stopping iteration");
      break;
    }

    if (context.size >= config.maxContextNotes) {
      log(`Context limit reached (${config.maxContextNotes})`);
      break;
    }
  }

  log(`Context: ${context.size} notes total`);

  // --- Mode branching ---
  if (mode === "socratic") {
    log("Socratic mode: generating guiding questions...");
    const { text, metrics: sgMetrics } = await llm.socraticGuide(question, context, []);
    collectMetrics(sgMetrics);
    const targetConcepts = [...context.values()].map((n) => n.title);
    return { text, context, targetConcepts, metrics: buildQueryMetrics() };
  }

  if (mode === "misconception") {
    // Misconception mode expects question format: "question|||studentAnswer"
    const [originalQ, studentAnswer] = question.includes("|||")
      ? question.split("|||", 2)
      : [question, question];
    log("Misconception mode: detecting misconceptions...");
    const { misconceptions: rawMisconceptions, summary, metrics: mcMetrics } = await llm.detectMisconception(originalQ, studentAnswer, context);
    collectMetrics(mcMetrics);
    // Format as readable markdown
    let text = `## 概念診斷\n\n${summary}\n\n`;
    const misconceptions = Array.isArray(rawMisconceptions) ? rawMisconceptions : [];
    for (const m of misconceptions) {
      text += `### ${m.concept}\n\n`;
      text += `**你可能的想法**：${m.studentThinking}\n\n`;
      text += `**正確概念**：${m.correction}\n\n`;
      const notes = Array.isArray(m.suggestedNotes) ? m.suggestedNotes : [];
      if (notes.length > 0) {
        text += `**建議複習**：${notes.join("、")}\n\n`;
      }
    }
    return { text, metrics: buildQueryMetrics() };
  }

  // 4. Generate (normal mode)
  log("Generating answer...");
  let genResult = await llm.generate(question, context);
  collectMetrics(genResult.metrics);
  let result = genResult.text;

  // 5. Verify
  log("Verifying answer...");
  const { pass, reason: verifyReason, searchMore, metrics: verifyMetrics } = await llm.verify(question, result, context);
  collectMetrics(verifyMetrics);
  log(`Verification: ${pass ? "PASS" : "FAIL"} — ${verifyReason}`);

  if (!pass && searchMore.length > 0) {
    // One retry: supplementary search + re-generate
    log(`Supplementary search: ${searchMore.join(", ")}`);
    const moreFiles = await search.search(searchMore);
    for (const f of moreFiles.slice(0, 5)) {
      if (!context.has(f)) {
        try {
          context.set(f, readNote(f));
        } catch {
          // Skip
        }
      }
    }
    log("Re-generating answer...");
    genResult = await llm.generate(question, context);
    collectMetrics(genResult.metrics);
    result = genResult.text;
  }

  return { text: result, metrics: buildQueryMetrics() };
}
