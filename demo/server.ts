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
import { generateExam, generateConceptPractice, evaluateExam, stripWikiLinks, type ExamState } from "../agent/src/exam";
import { initNoteProcessor, processStudentNotes } from "../agent/src/note-processor";
import { getDailyChallenge, checkDailyAnswer } from "../agent/src/daily-challenge";
import { supabaseAdmin, createUserClient } from "../agent/src/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const PORT = parseInt(process.env.PORT ?? "3456", 10);
const NOTES_DIR = resolve(import.meta.dir, "../notes");
const GARDEN_BASE = "https://physics-garden.pages.dev";

// --- Initialize agent modules for in-process calls ---
const config: Config = loadConfig();
initLLM(config.anthropicApiKey);
initNoteProcessor(config.anthropicApiKey);
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

async function computeUnlockedConcepts(client: SupabaseClient): Promise<string[]> {
  const { data: mastery } = await client.from("concept_mastery").select("*");
  const { data: prereqs } = await supabaseAdmin.from("concept_prerequisites").select("*");
  const { data: allConcepts } = await supabaseAdmin.from("concepts").select("id");
  const { data: questions } = await supabaseAdmin.from("questions").select("concept_id");

  // Concepts that have at least one question
  const conceptsWithQuestions = new Set((questions ?? []).map((q) => q.concept_id));

  const masteryMap = new Map<string, boolean>();
  for (const m of mastery ?? []) {
    masteryMap.set(m.concept_id, m.is_mastered);
  }

  // Concepts without questions are auto-mastered (can't be practiced, shouldn't block)
  const isMastered = (conceptId: string): boolean => {
    if (!conceptsWithQuestions.has(conceptId)) return true;
    return masteryMap.get(conceptId) === true;
  };

  const prereqMap = new Map<string, string[]>();
  for (const p of prereqs ?? []) {
    if (!prereqMap.has(p.concept_id)) prereqMap.set(p.concept_id, []);
    prereqMap.get(p.concept_id)!.push(p.prerequisite_id);
  }

  const unlocked: string[] = [];
  for (const c of allConcepts ?? []) {
    const deps = prereqMap.get(c.id) ?? [];
    if (deps.every((d) => isMastered(d))) unlocked.push(c.id);
  }
  return unlocked;
}

function isAdmin(req: Request): boolean {
  const userId = getUserId(req);
  const admins = (process.env.ADMIN_USER_IDS ?? "").split(",").filter(Boolean);
  return !!userId && admins.includes(userId);
}

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

    if (url.pathname === "/scan" || url.pathname === "/scan.html") {
      return serveHTML(resolve(import.meta.dir, "scan.html"));
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

    if (url.pathname === "/dashboard" || url.pathname === "/dashboard.html") {
      return serveHTML(resolve(import.meta.dir, "dashboard.html"));
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
            if (result.conceptHits?.length) {
              send({ type: "concept_hits", data: result.conceptHits });
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

      // --- Normal / misconception mode: in-process ---
      const enriched = enrichQuestion(trimmed, hist, shown);

      return createSSEResponse(async (send) => {
        const logFn = (msg: string) => send({ type: "log", text: msg });
        setLogFn(logFn);
        try {
          // Fetch user's overlay notes if logged in
          let overlayNotes: Array<{ title: string; body: string; related_concepts: string[] }> | undefined;
          const userId = getUserId(req);
          if (userId) {
            const { data } = await supabaseAdmin
              .from("user_notes")
              .select("title, body, related_concepts")
              .eq("user_id", userId);
            if (data?.length) overlayNotes = data;
          }

          // Timeout wrapper
          const TIMEOUT_MS = 90_000;
          const resultPromise = answer(enriched, config, searchStrategy, mode as AgentMode, overlayNotes, trimmed);
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)
          );

          const result = await Promise.race([resultPromise, timeout]);

          // Restore default log
          setLogFn((msg) => process.stderr.write(`[agent] ${msg}\n`));

          if (result.conceptHits?.length) {
            send({ type: "concept_hits", data: result.conceptHits });
          }
          if (result.metrics) {
            send({ type: "metrics_summary", data: result.metrics });
          }
          send({ type: "answer", text: result.text });
        } catch (err) {
          setLogFn((msg) => process.stderr.write(`[agent] ${msg}\n`));
          const msg = err instanceof Error && err.message === "timeout"
            ? "Agent 回應超時（90 秒），請重新發問"
            : `Agent 執行失敗：${err instanceof Error ? err.message : String(err)}`;
          send({ type: "error", text: msg });
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
        respectPrerequisites?: boolean;
      };
      const chapters = body.chapters ?? [];
      const difficulty = body.difficulty ?? "";
      const count = Math.min(body.count ?? 10, 20);
      const timeLimit = body.timeLimit ?? 1200;

      let unlockedConcepts: string[] | undefined;
      if (body.respectPrerequisites) {
        const client = getUserClient(req);
        if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });
        unlockedConcepts = await computeUnlockedConcepts(client);
      }

      const { questions, state } = await generateExam(
        config.notesPath, chapters, difficulty, count, timeLimit, unlockedConcepts
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

      // Collect edge snapshots (fire-and-forget, before deleting exam state)
      const userId = getUserId(req);
      if (userId && result.details) {
        (async () => {
          try {
            const { data: prereqs } = await supabaseAdmin.from("concept_prerequisites").select("*");
            const { data: mastery } = await supabaseAdmin.from("concept_mastery").select("*").eq("user_id", userId);

            const prereqMap = new Map<string, string[]>();
            for (const p of prereqs ?? []) {
              if (!prereqMap.has(p.concept_id)) prereqMap.set(p.concept_id, []);
              prereqMap.get(p.concept_id)!.push(p.prerequisite_id);
            }

            const masteryMap = new Map<string, { is_mastered: boolean; correct_count: number }>();
            for (const m of mastery ?? []) {
              masteryMap.set(m.concept_id, { is_mastered: m.is_mastered, correct_count: m.correct_count });
            }

            const source = body.examId.startsWith("practice-") ? "practice" : "exam";
            const rows: Array<Record<string, unknown>> = [];

            for (const detail of result.details) {
              for (const concept of detail.relatedConcepts) {
                const deps = prereqMap.get(concept) ?? [];
                for (const dep of deps) {
                  const m = masteryMap.get(dep);
                  rows.push({
                    user_id: userId,
                    exam_session_id: body.examId,
                    question_id: detail.id,
                    tested_concept: concept,
                    prerequisite_concept: dep,
                    prerequisite_mastered: m?.is_mastered ?? false,
                    prerequisite_correct_count: m?.correct_count ?? 0,
                    question_correct: detail.isCorrect,
                    source,
                  });
                }
              }
            }

            if (rows.length > 0) {
              await supabaseAdmin.from("exam_edge_snapshots").insert(rows);
            }
          } catch (err) {
            console.error("Edge snapshot collection failed:", err);
          }
        })();
      }

      exams.delete(body.examId); // one-time use
      return Response.json(result);
    }

    // POST /api/concept/practice — generate practice questions for a specific concept
    if (url.pathname === "/api/concept/practice" && req.method === "POST") {
      const body = (await req.json()) as { conceptId: string; count?: number };
      if (!body.conceptId) return Response.json({ error: "conceptId required" }, { status: 400 });

      const count = Math.min(body.count ?? 5, 20);
      const { questions, state } = await generateConceptPractice(
        config.notesPath, body.conceptId, count
      );

      if (questions.length === 0) {
        return Response.json({ error: "此概念沒有可用的練習題" }, { status: 404 });
      }

      const examId = `practice-${Date.now()}`;
      exams.set(examId, state);
      return Response.json({ examId, questions, timeLimit: state.timeLimit });
    }

    // --- Event Tracking API ---

    // POST /api/events — batch insert learning events
    if (url.pathname === "/api/events" && req.method === "POST") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const userId = getUserId(req);

      const body = (await req.json()) as {
        events: Array<{
          event_type: string;
          concept_id?: string;
          metadata?: Record<string, unknown>;
          session_id?: string;
        }>;
      };

      if (!body.events?.length) return Response.json({ error: "events array required" }, { status: 400 });

      const rows = body.events.map((e) => ({
        user_id: userId,
        event_type: e.event_type,
        concept_id: e.concept_id ?? null,
        metadata: e.metadata ?? {},
        session_id: e.session_id ?? null,
      }));

      const { error } = await client.from("learning_events").insert(rows);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ success: true, count: rows.length });
    }

    // GET /api/events/summary — personal learning summary
    if (url.pathname === "/api/events/summary" && req.method === "GET") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const { data: events } = await client.from("learning_events").select("*");
      const allEvents = events ?? [];

      // Basic stats
      const totalQueries = allEvents.filter((e) => e.event_type === "query").length;
      const conceptInteractions: Record<string, number> = {};
      const answerTimes: number[] = [];
      const conceptWrong: Record<string, number> = {};
      const conceptCorrect: Record<string, number> = {};
      const days = new Set<string>();

      for (const e of allEvents) {
        days.add(new Date(e.created_at).toISOString().split("T")[0]);

        if (e.concept_id) {
          conceptInteractions[e.concept_id] = (conceptInteractions[e.concept_id] ?? 0) + 1;
        }

        if (e.event_type === "answer_correct" || e.event_type === "answer_wrong") {
          const ms = (e.metadata as Record<string, unknown>)?.time_spent_ms;
          if (typeof ms === "number") answerTimes.push(ms);
        }

        if (e.event_type === "answer_wrong" && e.concept_id) {
          conceptWrong[e.concept_id] = (conceptWrong[e.concept_id] ?? 0) + 1;
        }
        if (e.event_type === "answer_correct" && e.concept_id) {
          conceptCorrect[e.concept_id] = (conceptCorrect[e.concept_id] ?? 0) + 1;
        }
      }

      // Stuck concepts: wrong >= 3 && correct == 0
      const stuckConcepts: Array<{ concept_id: string; wrong_count: number; first_seen: string; last_seen: string }> = [];
      for (const [cid, wrongCount] of Object.entries(conceptWrong)) {
        if (wrongCount >= 3 && (conceptCorrect[cid] ?? 0) === 0) {
          const conceptEvents = allEvents.filter((e) => e.concept_id === cid && e.event_type === "answer_wrong");
          stuckConcepts.push({
            concept_id: cid,
            wrong_count: wrongCount,
            first_seen: conceptEvents[0]?.created_at,
            last_seen: conceptEvents[conceptEvents.length - 1]?.created_at,
          });
        }
      }

      const avgAnswerTime = answerTimes.length > 0
        ? Math.round(answerTimes.reduce((a, b) => a + b, 0) / answerTimes.length)
        : null;

      return Response.json({
        totalQueries,
        conceptInteractions,
        avgAnswerTimeMs: avgAnswerTime,
        learningDays: days.size,
        stuckConcepts,
      });
    }

    // --- Admin Analytics API ---

    // GET /api/analytics/concept-weakness — global concept error rates
    if (url.pathname === "/api/analytics/concept-weakness" && req.method === "GET") {
      if (!isAdmin(req)) return Response.json({ error: "Forbidden" }, { status: 403 });

      const { data: attempts } = await supabaseAdmin.from("question_attempts").select("concept_id, is_correct");
      const conceptStats: Record<string, { correct: number; wrong: number }> = {};
      for (const a of attempts ?? []) {
        if (!a.concept_id) continue;
        if (!conceptStats[a.concept_id]) conceptStats[a.concept_id] = { correct: 0, wrong: 0 };
        if (a.is_correct) conceptStats[a.concept_id].correct++;
        else conceptStats[a.concept_id].wrong++;
      }

      const result = Object.entries(conceptStats)
        .map(([id, s]) => ({ concept_id: id, errorRate: s.wrong / (s.correct + s.wrong), total: s.correct + s.wrong, wrong: s.wrong }))
        .sort((a, b) => b.errorRate - a.errorRate);

      return Response.json(result);
    }

    // GET /api/analytics/stuck-signals — cross-user stuck signal aggregation
    if (url.pathname === "/api/analytics/stuck-signals" && req.method === "GET") {
      if (!isAdmin(req)) return Response.json({ error: "Forbidden" }, { status: 403 });

      const { data: events } = await supabaseAdmin
        .from("learning_events")
        .select("user_id, concept_id, event_type")
        .in("event_type", ["answer_correct", "answer_wrong"])
        .not("concept_id", "is", null);

      // Aggregate per user+concept
      const userConcept: Record<string, { wrong: number; correct: number; users: Set<string> }> = {};
      for (const e of events ?? []) {
        const key = e.concept_id;
        if (!userConcept[key]) userConcept[key] = { wrong: 0, correct: 0, users: new Set() };
        userConcept[key].users.add(e.user_id);
        if (e.event_type === "answer_wrong") userConcept[key].wrong++;
        else userConcept[key].correct++;
      }

      const result = Object.entries(userConcept)
        .filter(([, s]) => s.wrong >= 3)
        .map(([id, s]) => ({ concept_id: id, wrong: s.wrong, correct: s.correct, affectedUsers: s.users.size }))
        .sort((a, b) => b.wrong - a.wrong);

      return Response.json(result);
    }

    // GET /api/analytics/edge-analysis — structural edge transition analysis
    if (url.pathname === "/api/analytics/edge-analysis" && req.method === "GET") {
      if (!isAdmin(req)) return Response.json({ error: "Forbidden" }, { status: 403 });

      const minSamples = parseInt(url.searchParams.get("minSamples") ?? "5", 10);
      const source = url.searchParams.get("source") ?? "exam";

      let query = supabaseAdmin.from("exam_edge_snapshots").select("*");
      if (source !== "all") {
        query = query.eq("source", source);
      }
      const { data: snapshots } = await query;

      // Aggregate per edge
      const edges = new Map<string, {
        from: string; to: string;
        total: number; withPrereq: number; withoutPrereq: number;
        masteredFailed: number; notMasteredFailed: number;
      }>();

      for (const s of snapshots ?? []) {
        const key = `${s.prerequisite_concept}→${s.tested_concept}`;
        if (!edges.has(key)) {
          edges.set(key, {
            from: s.prerequisite_concept, to: s.tested_concept,
            total: 0, withPrereq: 0, withoutPrereq: 0,
            masteredFailed: 0, notMasteredFailed: 0,
          });
        }
        const e = edges.get(key)!;
        e.total++;
        if (s.prerequisite_mastered) {
          e.withPrereq++;
          if (!s.question_correct) e.masteredFailed++;
        } else {
          e.withoutPrereq++;
          if (!s.question_correct) e.notMasteredFailed++;
        }
      }

      const result = [...edges.values()]
        .filter((e) => e.total >= minSamples)
        .map((e) => {
          const transitionFailureRate = e.withPrereq > 0 ? e.masteredFailed / e.withPrereq : null;
          const baselineFailureRate = e.withoutPrereq > 0 ? e.notMasteredFailed / e.withoutPrereq : null;
          const effectiveness = transitionFailureRate !== null && baselineFailureRate !== null
            ? Math.round((baselineFailureRate - transitionFailureRate) * 100) / 100
            : null;
          return {
            from: e.from,
            to: e.to,
            total: e.total,
            withPrereq: e.withPrereq,
            masteredButFailed: e.masteredFailed,
            transitionFailureRate: transitionFailureRate !== null ? Math.round(transitionFailureRate * 100) / 100 : null,
            baselineFailureRate: baselineFailureRate !== null ? Math.round(baselineFailureRate * 100) / 100 : null,
            prerequisiteEffectiveness: effectiveness,
          };
        })
        .sort((a, b) => (b.transitionFailureRate ?? 0) - (a.transitionFailureRate ?? 0));

      return Response.json(result);
    }

    // --- User Notes (Overlay) API ---

    // GET /api/notes — list user's overlay notes
    if (url.pathname === "/api/notes" && req.method === "GET") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });

      let query = client.from("user_notes").select("*").order("created_at", { ascending: false });
      const concept = url.searchParams.get("concept");
      if (concept) {
        query = query.contains("related_concepts", [concept]);
      }
      const { data, error } = await query;
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json(data ?? []);
    }

    // POST /api/notes — create a new overlay note
    if (url.pathname === "/api/notes" && req.method === "POST") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const userId = getUserId(req);

      const body = (await req.json()) as {
        title: string;
        body: string;
        source_type?: string;
        related_concepts?: string[];
        source_context?: Record<string, unknown>;
      };
      if (!body.title || !body.body) return Response.json({ error: "title and body required" }, { status: 400 });

      const { data, error } = await client.from("user_notes").insert({
        user_id: userId,
        title: body.title,
        body: body.body,
        source_type: body.source_type ?? "study_note",
        related_concepts: body.related_concepts ?? [],
        source_context: body.source_context ?? {},
      }).select().single();
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json(data);
    }

    // POST /api/notes/import — AI process & import student notes
    if (url.pathname === "/api/notes/import" && req.method === "POST") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const userId = getUserId(req);

      const body = (await req.json()) as {
        highlights: string[];
        annotations: string[];
        relatedConcepts: string[];
      };

      const result = await processStudentNotes(
        body.highlights ?? [],
        body.annotations ?? [],
        body.relatedConcepts ?? [],
        searchStrategy,
        config.notesPath
      );

      // Save new notes to user_notes
      let importedCount = 0;
      for (const note of result.newNotes) {
        const { error } = await client.from("user_notes").insert({
          user_id: userId,
          title: note.title,
          body: note.body,
          source_type: "ai_extraction",
          related_concepts: note.relatedConcepts,
          source_context: {},
        });
        if (!error) importedCount++;
      }

      // Track import event
      await client.from("learning_events").insert({
        user_id: userId,
        event_type: "note_imported",
        metadata: {
          matched_base_concepts: result.matched.length,
          new_knowledge_count: importedCount,
          correction_count: result.corrections.length,
        },
      });

      return Response.json({
        matched: result.matched.length,
        imported: importedCount,
        corrections: result.corrections.length,
        details: {
          matched: result.matched,
          newNotes: result.newNotes,
          corrections: result.corrections,
        },
      });
    }

    // PUT /api/notes/:id — update an overlay note
    if (url.pathname.startsWith("/api/notes/") && req.method === "PUT") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const noteId = url.pathname.split("/").pop();

      const body = (await req.json()) as { title?: string; body?: string; related_concepts?: string[] };
      const { data, error } = await client.from("user_notes").update(body).eq("id", noteId).select().single();
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json(data);
    }

    // DELETE /api/notes/:id — delete an overlay note
    if (url.pathname.startsWith("/api/notes/") && req.method === "DELETE") {
      const client = getUserClient(req);
      if (!client) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const noteId = url.pathname.split("/").pop();

      const { error } = await client.from("user_notes").delete().eq("id", noteId);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ success: true });
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

      const unlocked = await computeUnlockedConcepts(client);
      const total = allConcepts?.length ?? 0;
      let masteredCount = 0;
      for (const c of allConcepts ?? []) {
        if (masteryMap[c.id]?.isMastered) masteredCount++;
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
