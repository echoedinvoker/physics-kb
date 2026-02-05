import { resolve } from "path";

export type SearchStrategyType = "grep" | "search" | "vsearch" | "query";

export interface Config {
  searchStrategy: SearchStrategyType;
  anthropicApiKey: string;
  maxIterations: number;
  maxContextNotes: number;
  notesPath: string;
  qmdBin: string;
  qmdCollection: string;
}

const validStrategies = new Set(["grep", "search", "vsearch", "query"]);

export function loadConfig(): Config {
  const strategy = process.env.SEARCH_STRATEGY ?? "grep";
  if (!validStrategies.has(strategy)) {
    throw new Error(
      `Invalid SEARCH_STRATEGY: ${strategy}. Must be one of: ${[...validStrategies].join(", ")}`
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required in .env");
  }

  return {
    searchStrategy: strategy as SearchStrategyType,
    anthropicApiKey: apiKey,
    maxIterations: parseInt(process.env.MAX_ITERATIONS ?? "5", 10),
    maxContextNotes: parseInt(process.env.MAX_CONTEXT_NOTES ?? "20", 10),
    notesPath: resolve(import.meta.dir, "../../notes"),
    qmdBin: resolve(process.env.HOME ?? "~", ".bun/bin/qmd"),
    qmdCollection: "physics",
  };
}
