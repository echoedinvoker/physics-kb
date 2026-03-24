import { resolve, basename } from "path";
import { Glob } from "bun";
import { loadConfig } from "../agent/src/config";
import { createSearchStrategy } from "../agent/src/search";
import { initLLM, socraticGuide, evaluateResponse, type SocraticMessage, type LLMCallMetrics } from "../agent/src/llm";
import { answer, setLogFn, type AgentMode, type QueryMetrics } from "../agent/src/agent";
import type { NoteContent } from "../agent/src/notes";
import type { SearchStrategy } from "../agent/src/search";
import type { Config } from "../agent/src/config";
import { getPrerequisiteTree, listConcepts, buildConceptGraph } from "../agent/src/prerequisites";
import { generateExam, evaluateExam, type ExamState } from "../agent/src/exam";
import { getDailyChallenge, checkDailyAnswer } from "../agent/src/daily-challenge";
import { supabaseAdmin, createUserClient } from "../agent/src/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const PORT = parseInt(process.env.PORT ?? "3456", 10);
const AGENT_DIR = resolve(import.meta.dir, "../agent");
const NOTES_DIR = resolve(import.meta.dir, "../notes");
const BUN = resolve(process.env.HOME!, ".bun/bin/bun");
const GARDEN_BASE = "https://physics-garden.pages.dev";

// --- Initialize agent modules for in-process calls ---
const config: Config = loadConfig();
initLLM(config.anthropicApiKey);
const searchStrategy: SearchStrategy = createSearchStrategy(config);

// --- Socratic session management ---
interface SocraticSession {
  context: Map<string, NoteContent>;
  conversationHistory: SocraticMessage[];
  targetConcepts: string[];
  hintLevel: number;
  createdAt: number;
}

const sessions = new Map<string, SocraticSession>();
const MAX_SESSIONS = 50;
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

// Clean expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// --- Exam state management ---
const exams = new Map<string, ExamState>();
const EXAM_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, exam] of exams) {
    if (now - exam.createdAt > EXAM_TTL) exams.delete(id);
  }
}, 5 * 60 * 1000);

// Build title → garden URL mapping on startup
async function buildNoteMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const glob = new Glob("**/*.md");
  for await (const file of glob.scan({ cwd: NOTES_DIR, absolute: false })) {
    const title = basename(file, ".md");
    const urlPath = file.replace(/\.md$/, "");
    map[title] = `${GARDEN_BASE}/${encodeURI(urlPath)}`;
  }
  return map;
}

const noteMap = await buildNoteMap();
console.log(`Loaded ${Object.keys(noteMap).length} note URLs`);

// --- Auth helpers ---
const CLERK_PK = process.env.CLERK_PUBLISHABLE_KEY ?? "";

function getUserClient(req: Request): SupabaseClient | null {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return createUserClient(auth.slice(7));
}

// UNVERIFIED: only for logging, not authorization. Auth goes through Supabase RLS.
function getUserId(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const payload = JSON.parse(atob(auth.slice(7).split(".")[1]));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

function serveHTML(filePath: string): Response {
  const html = Bun.file(filePath).text();
  return html.then((text) => {
    const injected = text.replace(/__CLERK_PK__/g, CLERK_PK);
    return new Response(injected, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }) as unknown as Response;
}

// Meta questions about the conversation itself — answer directly without agent
const META_PATTERNS = /^(剛才|上一個|之前|前面)(我)?(問了?|說了?)(什麼|啥|哪)/;

function isMetaQuestion(raw: string, history: string[]): string | null {
  if (history.length === 0) return null;
  if (META_PATTERNS.test(raw)) {
    return `你剛才問的是：「${history[history.length - 1]}」`;
  }
  return null;
}

function enrichQuestion(raw: string, history: string[], shown: string[]): string {
  const parts: string[] = [];
  if (history.length > 0) {
    const ctx = history.map((q, i) => `${i + 1}.「${q}」`).join(" ");
    parts.push(`背景：之前的對話依序討論了：${ctx}`);
  }
  if (shown.length > 0) {
    parts.push(`已出過的題目：${shown.join("、")}，請不要重複`);
  }
  if (parts.length === 0) return raw;
  return `（${parts.join("。")}）\n\n${raw}`;
}

function createSSEResponse(handler: (send: (obj: Record<string, unknown>) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      await handler(send);
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveHTML(resolve(import.meta.dir, "index.html"));
    }

    if (url.pathname === "/exam" || url.pathname === "/exam.html") {
      return serveHTML(resolve(import.meta.dir, "exam.html"));
    }

    if (url.pathname === "/benchmark" || url.pathname === "/benchmark.html") {
      return serveHTML(resolve(import.meta.dir, "benchmark.html"));
    }

    if (url.pathname === "/api/note-map") {
      return Response.json(noteMap);
    }

    if (url.pathname === "/api/prerequisites") {
      const concept = url.searchParams.get("concept");
      if (!concept) {
        return Response.json({ error: "concept parameter required" }, { status: 400 });
      }
      const tree = await getPrerequisiteTree(concept, config.notesPath);
      if (!tree) {
        return Response.json({ error: `Concept "${concept}" not found` }, { status: 404 });
      }
      return Response.json(tree);
    }

    if (url.pathname === "/api/concepts") {
      const concepts = await listConcepts(config.notesPath);
      return Response.json(concepts);
    }

    if (url.pathname === "/api/concept-graph") {
      const graph = await buildConceptGraph(config.notesPath);
      return Response.json(Object.fromEntries(graph));
    }

    if (url.pathname === "/concepts" || url.pathname === "/concepts.html") {
      return serveHTML(resolve(import.meta.dir, "concepts.html"));
    }

    if (url.pathname === "/api/ask" && req.method === "POST") {
      const body = (await req.json()) as {
        question: string;
        history?: string[];
        shownQuestions?: string[];
        mode?: AgentMode;
        sessionId?: string;
      };
      const trimmed = body.question?.trim();
      if (!trimmed) {
        return Response.json({ error: "question is required" }, { status: 400 });
      }

      const mode = body.mode ?? "normal";
      const hist = (body.history ?? []).slice(-5);
      const shown = body.shownQuestions ?? [];

      // Handle meta questions directly
      const metaAnswer = isMetaQuestion(trimmed, hist);
      if (metaAnswer) {
        return createSSEResponse(async (send) => {
          send({ type: "answer", text: metaAnswer });
        });
      }

      // --- Socratic mode: in-process with session ---
      if (mode === "socratic") {
        const sessionId = body.sessionId;
        if (!sessionId) {
          return Response.json({ error: "sessionId is required for socratic mode" }, { status: 400 });
        }

        const existingSession = sessions.get(sessionId);

        if (existingSession) {
          // Subsequent turn: reuse context, call evaluateResponse
          return createSSEResponse(async (send) => {
            send({ type: "log", text: "[agent] Socratic: evaluating student response..." });
            try {
              const { text: evalText, shouldLevelUp, metrics: evalMetrics } = await evaluateResponse(
                existingSession.conversationHistory[0]?.content ?? trimmed,
                trimmed,
                existingSession.context,
                existingSession.conversationHistory,
                existingSession.hintLevel
              );
              // Update session
              existingSession.conversationHistory.push(
                { role: "student", content: trimmed },
                { role: "tutor", content: evalText }
              );
              if (shouldLevelUp) {
                existingSession.hintLevel = Math.min(existingSession.hintLevel + 1, 4);
              }
              send({ type: "metrics", data: evalMetrics });
              send({ type: "metrics_summary", data: {
                totalDurationMs: evalMetrics.durationMs,
                totalInputTokens: evalMetrics.inputTokens,
                totalOutputTokens: evalMetrics.outputTokens,
                totalCostUSD: evalMetrics.costUSD,
                breakdown: [evalMetrics],
                mode: "socratic",
              } });
              send({ type: "answer", text: evalText });
            } catch (err) {
              send({ type: "error", text: `導師模式錯誤：${err instanceof Error ? err.message : String(err)}` });
            }
          });
        }

        // First turn: run full pipeline, create session
        return createSSEResponse(async (send) => {
          const logFn = (msg: string) => send({ type: "log", text: msg });
          setLogFn(logFn);
          try {
            const result = await answer(trimmed, config, searchStrategy, "socratic");
            // Restore default log
            setLogFn((msg) => process.stderr.write(`[agent] ${msg}\n`));

            if (result.context) {
              // Enforce session limit
              if (sessions.size >= MAX_SESSIONS) {
                // Remove oldest session
                let oldest: string | undefined;
                let oldestTime = Infinity;
                for (const [id, s] of sessions) {
                  if (s.createdAt < oldestTime) {
                    oldestTime = s.createdAt;
                    oldest = id;
                  }
                }
                if (oldest) sessions.delete(oldest);
              }

              sessions.set(sessionId, {
                context: result.context,
                conversationHistory: [{ role: "tutor", content: result.text }],
                targetConcepts: result.targetConcepts ?? [],
                hintLevel: 0,
                createdAt: Date.now(),
              });
            }
            if (result.metrics) {
              send({ type: "metrics_summary", data: result.metrics });
            }
            send({ type: "answer", text: result.text });
          } catch (err) {
            setLogFn((msg) => process.stderr.write(`[agent] ${msg}\n`));
            send({ type: "error", text: `Agent 執行失敗：${err instanceof Error ? err.message : String(err)}` });
          }
        });
      }

      // --- Normal / misconception mode: subprocess ---
      const enriched = enrichQuestion(trimmed, hist, shown);
      const modeArgs = mode !== "normal" ? ["--mode", mode] : [];

      const proc = Bun.spawn({
        cmd: [BUN, "run", "src/index.ts", ...modeArgs, enriched],
        cwd: AGENT_DIR,
        stdout: "pipe",
        stderr: "pipe",
      });

      return createSSEResponse(async (send) => {
        const collectedMetrics: LLMCallMetrics[] = [];

        const stderrDone = (async () => {
          const reader = proc.stderr.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop()!;
            for (const line of lines) {
              const t = line.trim();
              if (!t) continue;
              // Check for metrics line: [agent] [metrics] {JSON}
              const metricsMatch = t.match(/\[metrics\]\s*(.+)/);
              if (metricsMatch) {
                try {
                  const parsed = JSON.parse(metricsMatch[1]) as LLMCallMetrics;
                  collectedMetrics.push(parsed);
                  send({ type: "metrics", data: parsed });
                } catch { /* skip malformed */ }
              } else {
                send({ type: "log", text: t });
              }
            }
          }
          if (buffer.trim()) {
            const t = buffer.trim();
            const metricsMatch = t.match(/\[metrics\]\s*(.+)/);
            if (metricsMatch) {
              try {
                const parsed = JSON.parse(metricsMatch[1]) as LLMCallMetrics;
                collectedMetrics.push(parsed);
                send({ type: "metrics", data: parsed });
              } catch { /* skip */ }
            } else {
              send({ type: "log", text: t });
            }
          }
        })();

        const stdoutDone = new Response(proc.stdout).text();

        const TIMEOUT_MS = 90_000;
        const timeout = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), TIMEOUT_MS)
        );

        const race = await Promise.race([
          (async () => {
            await stderrDone;
            const answerText = await stdoutDone;
            const exitCode = await proc.exited;
            return { answer: answerText, exitCode } as const;
          })(),
          timeout,
        ]);

        if (race === "timeout") {
          proc.kill();
          send({ type: "error", text: "Agent 回應超時（90 秒），請重新發問" });
        } else if (race.exitCode !== 0 && !race.answer.trim()) {
          send({ type: "error", text: "Agent 執行失敗，請檢查 .env 設定或筆記索引" });
        } else {
          send({ type: "answer", text: race.answer });
          // Send aggregated metrics summary
          if (collectedMetrics.length > 0) {
            send({ type: "metrics_summary", data: {
              totalDurationMs: collectedMetrics.reduce((s, m) => s + m.durationMs, 0),
              totalInputTokens: collectedMetrics.reduce((s, m) => s + m.inputTokens, 0),
              totalOutputTokens: collectedMetrics.reduce((s, m) => s + m.outputTokens, 0),
              totalCostUSD: collectedMetrics.reduce((s, m) => s + m.costUSD, 0),
              breakdown: collectedMetrics,
              mode,
            } });
          }
        }
      });
    }

    // --- Daily Challenge endpoints ---
    if (url.pathname === "/api/daily-challenge" && req.method === "GET") {
      const challenge = await getDailyChallenge(config.notesPath);
      return Response.json({
        date: challenge.date,
        questionId: challenge.questionId,
        questionText: challenge.questionText,
        difficulty: challenge.difficulty,
        chapter: challenge.chapter,
      });
    }

    if (url.pathname === "/api/daily-challenge/check" && req.method === "POST") {
      const body = (await req.json()) as { answer: string };
      if (!body.answer) {
        return Response.json({ error: "answer is required" }, { status: 400 });
      }
      const result = await checkDailyAnswer(config.notesPath, body.answer);
      // Strip [[wiki-links]] from explanation
      result.explanation = result.explanation.replace(/\[\[([^\]]+)\]\]/g, "$1");
      return Response.json(result);
    }

    // --- Exam endpoints ---
    if (url.pathname === "/api/exam/generate" && req.method === "POST") {
      const body = (await req.json()) as {
        chapters?: string[];
        difficulty?: string;
        count?: number;
        timeLimit?: number;
      };
      const chapters = body.chapters ?? [];
      const difficulty = body.difficulty ?? "";
      const count = Math.min(body.count ?? 10, 20);
      const timeLimit = body.timeLimit ?? 1200;

      const { questions, state } = await generateExam(
        config.notesPath, chapters, difficulty, count, timeLimit
      );

      const examId = `exam-${Date.now()}`;
      exams.set(examId, state);

      return Response.json({ examId, questions, timeLimit });
    }

    if (url.pathname === "/api/exam/evaluate" && req.method === "POST") {
      const body = (await req.json()) as {
        examId: string;
        answers: Record<string, string>;
      };
      const state = exams.get(body.examId);
      if (!state) {
        return Response.json({ error: "考卷不存在或已過期" }, { status: 404 });
      }
      const result = evaluateExam(state, body.answers);
      exams.delete(body.examId); // one-time use
      return Response.json(result);
    }

    // --- User system API endpoints ---

    // POST /api/attempt — record a single question attempt
    if (url.pathname === "/api/attempt" && req.method === "POST") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const body = (await req.json()) as { questionId: string; isCorrect: boolean };
      if (!body.questionId) return Response.json({ error: "questionId required" }, { status: 400 });

      // Look up concept_id from questions table (admin client, no RLS)
      const { data: q } = await supabaseAdmin
        .from("questions")
        .select("concept_id")
        .eq("id", body.questionId)
        .single();
      if (!q) return Response.json({ error: "Question not found" }, { status: 404 });

      const userId = getUserId(req);
      const { error } = await client.from("question_attempts").insert({
        user_id: userId,
        question_id: body.questionId,
        concept_id: q.concept_id,
        is_correct: body.isCorrect,
      });
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ success: true });
    }

    // POST /api/attempts — batch record (exam results)
    if (url.pathname === "/api/attempts" && req.method === "POST") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const body = (await req.json()) as { attempts: { questionId: string; isCorrect: boolean }[] };
      if (!body.attempts?.length) return Response.json({ error: "attempts required" }, { status: 400 });

      const userId = getUserId(req);
      const questionIds = body.attempts.map((a) => a.questionId);

      // Batch lookup concept_ids
      const { data: questions } = await supabaseAdmin
        .from("questions")
        .select("id, concept_id")
        .in("id", questionIds);
      const conceptMap = new Map((questions ?? []).map((q) => [q.id, q.concept_id]));

      const rows = body.attempts
        .filter((a) => conceptMap.has(a.questionId))
        .map((a) => ({
          user_id: userId,
          question_id: a.questionId,
          concept_id: conceptMap.get(a.questionId),
          is_correct: a.isCorrect,
        }));

      const { error } = await client.from("question_attempts").insert(rows);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ success: true, count: rows.length });
    }

    // GET /api/mastery — get user's concept mastery
    if (url.pathname === "/api/mastery" && req.method === "GET") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const { data: mastery } = await client.from("concept_mastery").select("*");
      const { data: prereqs } = await supabaseAdmin.from("concept_prerequisites").select("*");
      const { data: allConcepts } = await supabaseAdmin.from("concepts").select("id");

      // Build mastery map
      const masteryMap: Record<string, { correctCount: number; isMastered: boolean; masteredAt: string | null }> = {};
      for (const m of mastery ?? []) {
        masteryMap[m.concept_id] = {
          correctCount: m.correct_count,
          isMastered: m.is_mastered,
          masteredAt: m.mastered_at,
        };
      }

      // Calculate unlocked concepts (all prerequisites mastered)
      const prereqMap = new Map<string, string[]>();
      for (const p of prereqs ?? []) {
        if (!prereqMap.has(p.concept_id)) prereqMap.set(p.concept_id, []);
        prereqMap.get(p.concept_id)!.push(p.prerequisite_id);
      }

      const unlocked: string[] = [];
      const total = allConcepts?.length ?? 0;
      let masteredCount = 0;

      for (const c of allConcepts ?? []) {
        if (masteryMap[c.id]?.isMastered) masteredCount++;
        const deps = prereqMap.get(c.id) ?? [];
        const allDepsMet = deps.every((d) => masteryMap[d]?.isMastered);
        if (allDepsMet) unlocked.push(c.id);
      }

      return Response.json({
        mastery: masteryMap,
        unlocked,
        stats: { mastered: masteredCount, total },
      });
    }

    // POST /api/daily-challenge/attempt — record daily challenge attempt
    if (url.pathname === "/api/daily-challenge/attempt" && req.method === "POST") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const body = (await req.json()) as { isCorrect: boolean; date: string };
      const userId = getUserId(req);

      // ON CONFLICT DO NOTHING (one attempt per day)
      const { error } = await client.from("daily_challenge_attempts").insert({
        user_id: userId,
        challenge_date: body.date || new Date().toISOString().split("T")[0],
        is_correct: body.isCorrect,
      });
      // Ignore unique constraint violations (duplicate submission)
      if (error && !error.message.includes("duplicate")) {
        return Response.json({ error: error.message }, { status: 500 });
      }
      return Response.json({ success: true });
    }

    // GET /api/user/streak — get user's daily challenge streak
    if (url.pathname === "/api/user/streak" && req.method === "GET") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const { data } = await client.from("user_streaks").select("*").single();
      return Response.json(data ?? { current_streak: 0, longest_streak: 0, last_correct_date: null });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`\n  物理知識庫 Demo → http://localhost:${PORT}\n`);
