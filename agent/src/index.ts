import { loadConfig } from "./config";
import { createSearchStrategy } from "./search";
import { initLLM } from "./llm";
import { answer } from "./agent";

const question = process.argv[2];
if (!question) {
  console.error("Usage: bun run src/index.ts <question>");
  console.error('Example: bun run src/index.ts "光纖為什麼能傳輸訊號？"');
  process.exit(1);
}

try {
  const config = loadConfig();
  initLLM(config.anthropicApiKey);
  const search = createSearchStrategy(config);

  process.stderr.write(`\n[agent] Question: ${question}\n`);
  process.stderr.write(`[agent] Strategy: ${config.searchStrategy}\n\n`);

  const result = await answer(question, config, search);
  console.log(result);
} catch (err) {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
}
