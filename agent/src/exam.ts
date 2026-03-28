import { resolve, basename } from "path";
import { Glob } from "bun";
import { readNote, type NoteContent } from "./notes";

export interface ExamQuestion {
  id: string;
  content: string;
  options?: string[];
  type: string;
  chapter: string;
  difficulty: string;
  isMultiSelect?: boolean;
}

export interface ExamState {
  questions: Array<{
    id: string;
    answer: string;
    analysis: string;
    relatedConcepts: string[];
  }>;
  createdAt: number;
  timeLimit: number;
}

// Read all question notes
async function loadQuestions(notesPath: string): Promise<NoteContent[]> {
  const questionsDir = resolve(notesPath, "questions");
  const glob = new Glob("Q-*.md");
  const notes: NoteContent[] = [];
  for await (const file of glob.scan({ cwd: questionsDir, absolute: true })) {
    try {
      notes.push(readNote(file));
    } catch { /* skip */ }
  }
  return notes;
}

/** Strip [[]] wiki-link brackets from concept names */
export function stripWikiLinks(s: string): string {
  return s.replace(/\[\[/g, "").replace(/\]\]/g, "");
}

export async function generateConceptPractice(
  notesPath: string,
  conceptId: string,
  count: number = 5
): Promise<{ questions: ExamQuestion[]; state: ExamState }> {
  const allNotes = await loadQuestions(notesPath);
  const filtered = allNotes.filter((n) => {
    const testsConcepts = (n.frontmatter.tests_concepts as string[]) ?? [];
    return testsConcepts.some((c) => stripWikiLinks(c) === conceptId);
  });

  if (filtered.length === 0) {
    return { questions: [], state: { questions: [], createdAt: Date.now(), timeLimit: 1200 } };
  }

  // Shuffle
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }

  const selected = filtered.slice(0, Math.min(count, filtered.length));
  const questions: ExamQuestion[] = [];
  const stateQuestions: ExamState["questions"] = [];

  for (const note of selected) {
    const tags = (note.frontmatter.tags as string[]) ?? [];
    const questionMatch = note.body.match(/##\s*題目\s*\n([\s\S]*?)(?=\n##\s*答案)/);
    const content = questionMatch ? questionMatch[1].trim() : note.body.split("\n").slice(0, 5).join("\n");
    let optionLines = content.match(/^\s*\(?[A-E][).）]\s*.+$/gm) ?? [];
    if (optionLines.length <= 1) {
      const inlineMatch = content.match(/\(?[A-E][).）][^(（]+/g);
      if (inlineMatch && inlineMatch.length >= 2) optionLines = inlineMatch.map((s) => s.trim());
    }
    const qType = tags.find((t) => t.startsWith("question-type/"))?.replace("question-type/", "") ?? "unknown";
    const chapter = (note.frontmatter.chapter as string) ?? "";
    const diff = tags.find((t) => t.startsWith("difficulty/"))?.replace("difficulty/", "") ?? "";
    const answer = (note.frontmatter.answer as string) ?? "";
    const analysisMatch = note.body.match(/##\s*解析\s*\n([\s\S]*?)(?=\n##|$)/);
    const analysis = analysisMatch ? analysisMatch[1].trim() : "";
    const testsConcepts = (note.frontmatter.tests_concepts as string[]) ?? [];
    const relatedConcepts = testsConcepts.map(stripWikiLinks);

    const isMulti = answer.length > 1 && /^[A-E]+$/i.test(answer);
    questions.push({ id: note.title, content, options: optionLines.length > 0 ? optionLines : undefined, type: qType, chapter, difficulty: diff, isMultiSelect: isMulti || undefined });
    stateQuestions.push({ id: note.title, answer, analysis, relatedConcepts });
  }

  return { questions, state: { questions: stateQuestions, createdAt: Date.now(), timeLimit: 1200 } };
}

export async function generateExam(
  notesPath: string,
  chapters: string[],
  difficulty: string,
  count: number,
  timeLimit: number,
  unlockedConcepts?: string[]
): Promise<{ questions: ExamQuestion[]; state: ExamState }> {
  const allNotes = await loadQuestions(notesPath);

  let candidates = allNotes;

  // Filter by unlocked concepts (prerequisite-aware mode)
  if (unlockedConcepts) {
    const unlocked = new Set(unlockedConcepts);
    const filtered = candidates.filter((n) => {
      const testsConcepts = (n.frontmatter.tests_concepts as string[]) ?? [];
      return testsConcepts.some((c) => unlocked.has(stripWikiLinks(c)));
    });
    if (filtered.length > 0) candidates = filtered;
  }

  // Filter by chapter
  if (chapters.length > 0) {
    const filtered = candidates.filter((n) => {
      const ch = n.frontmatter.chapter as string ?? "";
      return chapters.some((c) => ch === c || ch.startsWith(c + "-"));
    });
    if (filtered.length > 0) candidates = filtered;
  }

  // Filter by difficulty
  if (difficulty) {
    const diffTag = `difficulty/${difficulty}`;
    const filtered = candidates.filter((n) => {
      const tags = (n.frontmatter.tags as string[]) ?? [];
      return tags.includes(diffTag);
    });
    if (filtered.length >= count) candidates = filtered;
  }

  // Shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const selected = candidates.slice(0, Math.min(count, candidates.length));

  const questions: ExamQuestion[] = [];
  const stateQuestions: ExamState["questions"] = [];

  for (const note of selected) {
    const id = note.title;
    const tags = (note.frontmatter.tags as string[]) ?? [];

    // Extract 題目 section
    const questionMatch = note.body.match(/##\s*題目\s*\n([\s\S]*?)(?=\n##\s*答案)/);
    const content = questionMatch ? questionMatch[1].trim() : note.body.split("\n").slice(0, 5).join("\n");

    // Extract options - handle both one-per-line and inline formats
    let optionLines = content.match(/^\s*\(?[A-E][).）]\s*.+$/gm) ?? [];
    if (optionLines.length <= 1) {
      // Try inline format: "(A)foo (B)bar (C)baz" on a single line
      const inlineMatch = content.match(/\(?[A-E][).）][^(（]+/g);
      if (inlineMatch && inlineMatch.length >= 2) {
        optionLines = inlineMatch.map((s) => s.trim());
      }
    }

    // Determine question type
    const qType = tags.find((t) => t.startsWith("question-type/"))?.replace("question-type/", "") ?? "unknown";
    const chapter = (note.frontmatter.chapter as string) ?? "";
    const diff = tags.find((t) => t.startsWith("difficulty/"))?.replace("difficulty/", "") ?? "";

    // Extract answer
    const answer = (note.frontmatter.answer as string) ?? "";

    // Extract analysis
    const analysisMatch = note.body.match(/##\s*解析\s*\n([\s\S]*?)(?=\n##|$)/);
    const analysis = analysisMatch ? analysisMatch[1].trim() : "";

    // Extract related concepts from tests_concepts
    const testsConcepts = (note.frontmatter.tests_concepts as string[]) ?? [];
    const relatedConcepts = testsConcepts.map(stripWikiLinks);

    const isMulti = answer.length > 1 && /^[A-E]+$/i.test(answer);
    questions.push({
      id,
      content,
      options: optionLines.length > 0 ? optionLines : undefined,
      type: qType,
      chapter,
      difficulty: diff,
      isMultiSelect: isMulti || undefined,
    });

    stateQuestions.push({ id, answer, analysis, relatedConcepts });
  }

  return {
    questions,
    state: {
      questions: stateQuestions,
      createdAt: Date.now(),
      timeLimit,
    },
  };
}

export interface EvaluationResult {
  score: number;
  total: number;
  overtime: boolean;
  details: Array<{
    id: string;
    correct: string;
    submitted: string;
    isCorrect: boolean;
    analysis: string;
    relatedConcepts: string[];
  }>;
}

export function evaluateExam(
  state: ExamState,
  answers: Record<string, string>
): EvaluationResult {
  const details: EvaluationResult["details"] = [];
  let correct = 0;

  for (const q of state.questions) {
    const submitted = (answers[q.id] ?? "").trim();
    // Normalize: sort characters for multi-select comparison
    const normalizeAnswer = (a: string) =>
      a.toUpperCase().split("").filter((c) => /[A-E]/.test(c)).sort().join("");

    const isCorrect =
      normalizeAnswer(submitted) === normalizeAnswer(q.answer) ||
      submitted.trim() === q.answer.trim();

    if (isCorrect) correct++;

    details.push({
      id: q.id,
      correct: q.answer,
      submitted: submitted || "(未作答)",
      isCorrect,
      analysis: q.analysis,
      relatedConcepts: q.relatedConcepts,
    });
  }

  const total = state.questions.length;
  const overtime = Date.now() - state.createdAt > state.timeLimit * 1000;

  return {
    score: total > 0 ? Math.round((correct / total) * 100) : 0,
    total,
    overtime,
    details,
  };
}
