import { resolve } from "path";
import { Glob } from "bun";
import { readNote } from "./notes";

function getDailyIndex(date: string, total: number): number {
  let hash = 0;
  for (const ch of date) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % total;
}

export interface DailyChallengeResult {
  date: string;
  questionId: string;
  questionText: string;
  difficulty: string;
  chapter: string;
  relatedConcepts: string[];
  filePath: string;
}

export async function getDailyChallenge(notesPath: string): Promise<DailyChallengeResult> {
  const today = new Date().toISOString().split("T")[0];
  const questionsDir = resolve(notesPath, "questions");
  const glob = new Glob("Q-*.md");
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: questionsDir, absolute: true })) {
    files.push(f);
  }
  files.sort();
  if (files.length === 0) throw new Error("No question files found in " + questionsDir);

  const idx = getDailyIndex(today, files.length);
  const filePath = files[idx];
  const note = readNote(filePath);
  const questionMatch = note.body.match(/##\s*題目\s*\n([\s\S]*?)(?=\n##\s*答案)/);
  const questionText = questionMatch?.[1]?.trim() ?? note.body.slice(0, 500);
  const tags = (note.frontmatter.tags as string[]) ?? [];
  const difficulty = tags.find(t => t.startsWith("difficulty/"))?.replace("difficulty/", "") ?? "unknown";
  const chapter = (note.frontmatter.chapter as string) ?? "";
  const rawConcepts = note.frontmatter.tests_concepts;
  const relatedConcepts = Array.isArray(rawConcepts)
    ? rawConcepts.map((c: string) => String(c).replace(/\[\[|\]\]/g, ""))
    : tags.filter(t => t.startsWith("topic/")).map(t => t.replace("topic/", ""));

  return { date: today, questionId: note.title, questionText, difficulty, chapter, relatedConcepts, filePath };
}

export async function checkDailyAnswer(notesPath: string, userAnswer: string): Promise<{
  correct: boolean;
  correctAnswer: string;
  explanation: string;
  relatedConcepts: string[];
}> {
  const challenge = await getDailyChallenge(notesPath);
  const note = readNote(challenge.filePath);
  const correctAnswer = (note.frontmatter.answer as string) ?? "";
  const analysisMatch = note.body.match(/##\s*解析\s*\n([\s\S]*?)(?=\n##|$)/);
  const explanation = analysisMatch?.[1]?.trim() ?? "";
  const correct = userAnswer.trim().toUpperCase() === correctAnswer.trim().toUpperCase();
  return { correct, correctAnswer, explanation, relatedConcepts: challenge.relatedConcepts };
}
