import type { Config } from "./config";
import type { SearchStrategy } from "./search";
import { type NoteContent, readNote, buildNoteIndex } from "./notes";
import * as llm from "./llm";

function log(msg: string) {
  process.stderr.write(`[agent] ${msg}\n`);
}

export async function answer(
  question: string,
  config: Config,
  search: SearchStrategy
): Promise<string> {
  // Build note index for link resolution
  log("Building note index...");
  const noteIndex = await buildNoteIndex(config.notesPath);
  log(`Indexed ${noteIndex.size} notes`);

  // 1. Extract keywords
  log("Extracting keywords...");
  const { terms, tags } = await llm.extractKeywords(question);
  log(`Keywords: ${terms.join(", ")}${tags.length ? ` | Tags: ${tags.join(", ")}` : ""}`);

  // 2. Initial search
  log(`Searching (strategy: ${config.searchStrategy})...`);
  const files = await search.search(terms);
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

  // 3. Judge → Follow links loop
  for (let i = 0; i < config.maxIterations; i++) {
    log(`Judge iteration ${i + 1}/${config.maxIterations}...`);
    const judgment = await llm.judge(question, context);
    log(`Sufficient: ${judgment.sufficient} — ${judgment.reason}`);

    if (judgment.sufficient) break;

    // Follow suggested links
    let added = 0;
    for (const link of judgment.followLinks) {
      const path = noteIndex.get(link);
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

  // 4. Generate
  log("Generating answer...");
  let result = await llm.generate(question, context);

  // 5. Verify
  log("Verifying answer...");
  const verification = await llm.verify(question, result, context);
  log(`Verification: ${verification.pass ? "PASS" : "FAIL"} — ${verification.reason}`);

  if (!verification.pass && verification.searchMore.length > 0) {
    // One retry: supplementary search + re-generate
    log(`Supplementary search: ${verification.searchMore.join(", ")}`);
    const moreFiles = await search.search(verification.searchMore);
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
    result = await llm.generate(question, context);
  }

  return result;
}
