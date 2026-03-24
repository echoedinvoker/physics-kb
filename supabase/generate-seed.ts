/**
 * Generate seed.sql from notes/ directory
 * Run: bun run supabase/generate-seed.ts > supabase/seed.sql
 */

import { resolve, basename } from "path";
import { Glob } from "bun";
import matter from "gray-matter";
import { readFileSync } from "fs";

const NOTES_PATH = resolve(import.meta.dir, "../notes");

function escapeSQL(s: string): string {
  return s.replace(/'/g, "''");
}

// Strip [[...]] wikilinks → plain text
function stripWikilinks(s: string): string {
  return s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias ?? target);
}

interface ConceptData {
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
}

interface QuestionData {
  id: string;
  conceptId: string;
  body: {
    stem: string;
    choices: string[];
    answer: string;
    explanation: string;
  };
  difficulty: string;
}

async function loadConcepts(): Promise<ConceptData[]> {
  const concepts: ConceptData[] = [];
  const glob = new Glob("*.md");

  for (const dir of ["concepts", "applications"]) {
    const dirPath = resolve(NOTES_PATH, dir);
    for await (const file of glob.scan({ cwd: dirPath, absolute: true })) {
      try {
        const raw = readFileSync(file, "utf-8");
        const { data, content } = matter(raw);
        const title = (data.title as string) ?? basename(file, ".md");

        let prereqs: string[] = [];
        if (Array.isArray(data.prerequisites)) {
          prereqs = data.prerequisites.map(String).filter((s: string) => s.length > 0);
        }

        // First meaningful line as description
        const lines = content
          .split("\n")
          .filter((l: string) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
        const firstLine = lines[0]?.trim() ?? "";
        // Strip markdown quote prefix and wikilinks
        const description = stripWikilinks(firstLine.replace(/^>\s*/, "")).slice(0, 200);

        concepts.push({ id: title, name: title, description, prerequisites: prereqs });
      } catch {
        // skip
      }
    }
  }

  return concepts;
}

async function loadQuestions(conceptIds: Set<string>): Promise<QuestionData[]> {
  const questions: QuestionData[] = [];
  const glob = new Glob("Q-*.md");
  const dirPath = resolve(NOTES_PATH, "questions");

  for await (const file of glob.scan({ cwd: dirPath, absolute: true })) {
    try {
      const raw = readFileSync(file, "utf-8");
      const { data, content } = matter(raw);
      const title = (data.title as string) ?? basename(file, ".md");

      // Extract concept from tests_concepts field: ["[[概念名]]"]
      const testsRaw = data.tests_concepts as string[] | undefined;
      if (!testsRaw || testsRaw.length === 0) continue;

      // Strip [[ ]] from concept name
      const conceptName = testsRaw[0].replace(/\[\[|\]\]/g, "").trim();
      if (!conceptIds.has(conceptName)) {
        console.error(`-- WARNING: Question ${title} references unknown concept "${conceptName}"`);
        continue;
      }

      // Parse question body
      const answer = (data.answer as string) ?? "";
      const difficulty = extractDifficulty(data.tags as string[] | undefined);

      // Extract stem (題目 section)
      const stemMatch = content.match(/## 題目\s*\n([\s\S]*?)(?=\n## |$)/);
      const stem = stemMatch ? stripWikilinks(stemMatch[1].trim()) : "";

      // Extract choices from stem (A)...(B)...(C)...
      const choices = extractChoices(stem);

      // Extract explanation (解析 section)
      const explMatch = content.match(/## 解析\s*\n([\s\S]*?)(?=\n## |$)/);
      const explanation = explMatch ? stripWikilinks(explMatch[1].trim()) : "";

      questions.push({
        id: title,
        conceptId: conceptName,
        body: { stem: stripWikilinks(stem), choices, answer, explanation },
        difficulty,
      });
    } catch {
      // skip
    }
  }

  return questions;
}

function extractDifficulty(tags: string[] | undefined): string {
  if (!tags) return "basic";
  for (const t of tags) {
    if (t.startsWith("difficulty/")) return t.replace("difficulty/", "");
  }
  return "basic";
}

function extractChoices(stem: string): string[] {
  // Match (A)...(B)...(C)...(D)...(E)...
  const matches = stem.match(/\([A-E]\)[^(]*/g);
  if (!matches) return [];
  return matches.map((m) => m.trim());
}

// ============================================================
// Main
// ============================================================

const concepts = await loadConcepts();
const conceptIds = new Set(concepts.map((c) => c.id));
const questions = await loadQuestions(conceptIds);

const lines: string[] = [];

lines.push("-- Auto-generated seed data from notes/");
lines.push(`-- Generated: ${new Date().toISOString()}`);
lines.push(`-- Concepts: ${concepts.length}, Questions: ${questions.length}`);
lines.push("");

// Insert concepts
lines.push("-- ============================================================");
lines.push("-- Concepts");
lines.push("-- ============================================================");
for (const c of concepts) {
  lines.push(
    `INSERT INTO public.concepts (id, name, description, prerequisites) VALUES ('${escapeSQL(c.id)}', '${escapeSQL(c.name)}', '${escapeSQL(c.description)}', ARRAY[${c.prerequisites.map((p) => `'${escapeSQL(p)}'`).join(",")}]::TEXT[]) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, prerequisites = EXCLUDED.prerequisites;`
  );
}

// Insert concept_prerequisites
lines.push("");
lines.push("-- ============================================================");
lines.push("-- Concept Prerequisites");
lines.push("-- ============================================================");
for (const c of concepts) {
  for (const prereq of c.prerequisites) {
    if (conceptIds.has(prereq)) {
      lines.push(
        `INSERT INTO public.concept_prerequisites (concept_id, prerequisite_id) VALUES ('${escapeSQL(c.id)}', '${escapeSQL(prereq)}') ON CONFLICT DO NOTHING;`
      );
    } else {
      lines.push(`-- SKIP: "${c.id}" → "${prereq}" (prerequisite not found in concepts)`);
    }
  }
}

// Insert questions
lines.push("");
lines.push("-- ============================================================");
lines.push("-- Questions");
lines.push("-- ============================================================");
for (const q of questions) {
  const bodyJson = JSON.stringify(q.body);
  lines.push(
    `INSERT INTO public.questions (id, concept_id, body, difficulty) VALUES ('${escapeSQL(q.id)}', '${escapeSQL(q.conceptId)}', '${escapeSQL(bodyJson)}'::JSONB, '${escapeSQL(q.difficulty)}') ON CONFLICT (id) DO UPDATE SET concept_id = EXCLUDED.concept_id, body = EXCLUDED.body, difficulty = EXCLUDED.difficulty;`
  );
}

// Validation query
lines.push("");
lines.push("-- ============================================================");
lines.push("-- Validation: check for orphan questions");
lines.push("-- ============================================================");
lines.push("SELECT q.id, q.concept_id FROM public.questions q WHERE q.concept_id NOT IN (SELECT id FROM public.concepts);");

console.log(lines.join("\n"));
