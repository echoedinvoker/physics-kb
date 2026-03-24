import { loadConfig } from "./config";
import { createSearchStrategy } from "./search";
import { initLLM } from "./llm";
import { answer, type AgentMode } from "./agent";

// Parse --mode flag from argv
let mode: AgentMode = "normal";
const args: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--mode" && i + 1 < process.argv.length) {
    mode = process.argv[++i] as AgentMode;
  } else {
    args.push(process.argv[i]);
  }
}

const question = args.join(" ");
if (!question) {
  console.error("Usage: bun run src/index.ts [--mode normal|socratic|misconception] <question>");
  console.error('Example: bun run src/index.ts "光纖為什麼能傳輸訊號？"');
  process.exit(1);
}

try {
  const config = loadConfig();
  initLLM(config.anthropicApiKey);
  const search = createSearchStrategy(config);

  process.stderr.write(`\n[agent] Question: ${question}\n`);
  process.stderr.write(`[agent] Strategy: ${config.searchStrategy}\n`);
  process.stderr.write(`[agent] Mode: ${mode}\n\n`);

  const result = await answer(question, config, search, mode);
  console.log(result.text);
} catch (err) {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
}
