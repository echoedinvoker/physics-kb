/**
 * Benchmark test suite for physics-kb agent
 * Usage: bun run benchmark.ts [strategy]
 * Default strategy: grep
 */

import { loadConfig } from "./src/config";
import { createSearchStrategy } from "./src/search";
import { answer } from "./src/agent";
import { initLLM } from "./src/llm";

interface TestCase {
  id: number;
  category: string;
  question: string;
  expectedKeywords: string[]; // Answer should contain these
}

const testCases: TestCase[] = [
  {
    id: 1,
    category: "單一概念",
    question: "庫侖定律的平方反比是什麼意思？",
    expectedKeywords: ["平方", "反比", "距離", "庫侖"],
  },
  {
    id: 2,
    category: "開放概念",
    question: "光纖通訊的原理是什麼？",
    expectedKeywords: ["全反射", "光纖"],
  },
  {
    id: 3,
    category: "人物",
    question: "法拉第對電磁學的貢獻有哪些？",
    expectedKeywords: ["法拉第", "電磁"],
  },
  {
    id: 4,
    category: "公式",
    question: "萬有引力公式是什麼？各個變數代表什麼意思？",
    expectedKeywords: ["萬有引力", "公式", "質量", "距離"],
  },
  {
    id: 5,
    category: "跨概念",
    question: "牛頓力學和萬有引力定律之間的關係是什麼？",
    expectedKeywords: ["牛頓", "萬有引力"],
  },
  {
    id: 6,
    category: "歷史演變",
    question: "從亞里斯多德到牛頓，力的概念發生了什麼變化？",
    expectedKeywords: ["亞里斯多德", "牛頓", "力"],
  },
];

async function runBenchmark(strategy: string) {
  const config = loadConfig();
  config.searchStrategy = strategy as any;
  initLLM(config.anthropicApiKey);

  console.log(`\n=== Benchmark: strategy=${strategy} ===\n`);

  const results: { id: number; category: string; pass: boolean; time: number; keywords: string[] }[] = [];

  for (const tc of testCases) {
    console.log(`[${tc.id}/${testCases.length}] ${tc.category}: ${tc.question}`);
    const start = Date.now();

    try {
      const search = createSearchStrategy(config);
      const result = await answer(tc.question, config, search);
      const elapsed = Date.now() - start;

      // Check if expected keywords are in the answer
      const found = tc.expectedKeywords.filter(kw => result.includes(kw));
      const pass = found.length >= tc.expectedKeywords.length * 0.5; // At least 50% keywords

      results.push({
        id: tc.id,
        category: tc.category,
        pass,
        time: elapsed,
        keywords: found,
      });

      console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"} (${(elapsed / 1000).toFixed(1)}s) keywords: ${found.join(", ")}`);
    } catch (err: any) {
      const elapsed = Date.now() - start;
      results.push({ id: tc.id, category: tc.category, pass: false, time: elapsed, keywords: [] });
      console.log(`  ❌ ERROR (${(elapsed / 1000).toFixed(1)}s): ${err.message}`);
    }
  }

  // Summary
  const passed = results.filter(r => r.pass).length;
  const totalTime = results.reduce((sum, r) => sum + r.time, 0);
  const avgTime = totalTime / results.length;

  console.log(`\n=== Summary ===`);
  console.log(`Strategy: ${strategy}`);
  console.log(`Pass: ${passed}/${results.length}`);
  console.log(`Avg time: ${(avgTime / 1000).toFixed(1)}s`);
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);

  return { strategy, passed, total: results.length, avgTime, totalTime, results };
}

const strategy = process.argv[2] ?? "grep";
runBenchmark(strategy).catch(console.error);
