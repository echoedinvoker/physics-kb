# Physics KB Recall Benchmark

A spot-check recall benchmark for the Physics KB RAG system, comparing pure
vector search against the full hybrid pipeline (query expansion + LLM rerank).

**Date**: 2026-04-07
**Corpus**: 342 atomic markdown notes (高一物理 Ch1 — 物理學簡史、測量、應用)
**Test set**: 20 hand-curated queries with hand-labeled relevant docs

## Why this exists

Previously the Physics KB had been benchmarked for **speed** and **cost** but
not **retrieval quality**. This benchmark fills that gap.

## What it measures

| Strategy        | Mechanism                                                            |
|-----------------|----------------------------------------------------------------------|
| `vec_baseline`  | `qmd query 'vec: <q>'` — single vector, no expansion, no rerank      |
| `hybrid_rerank` | `qmd query '<q>'` — auto query expansion + LLM reranker (Qwen3 0.6B) |

Note: pure BM25 (`qmd search`) was excluded — it has no Chinese tokenizer
and returns "No results found" for every Chinese query. That finding itself
is reported in the methodology section as a known limitation of off-the-shelf
BM25 for CJK corpora.

## Files

```
benchmarks/recall/
├── ground_truth.yaml          # 20 queries × 3-5 relevant docs each (63 labels)
├── run_benchmark.py           # Runs both strategies, computes recall@5/@10
├── README.md                  # This file
└── results/
    ├── vec_baseline.json      # Per-query results for baseline
    ├── hybrid_rerank.json     # Per-query results for hybrid
    ├── raw_log.txt            # tee'd stdout from full run
    └── report.md              # Human-readable summary
```

## Running

```bash
cd ~/Documents/physics-kb/benchmarks/recall

# Pre-flight: ensure index is fresh and all chunks have embeddings
qmd update
qmd embed     # important — missing embeddings will silently bias vec_baseline down

# Full run (~25-40 min on CPU; 20 queries × 2 strategies)
python3 run_benchmark.py 2>&1 | tee results/raw_log.txt

# Or run a single strategy
python3 run_benchmark.py vec_baseline
python3 run_benchmark.py hybrid_rerank

# Or run against a smaller test ground-truth file
python3 run_benchmark.py "" path/to/ground_truth_test.yaml
```

## Dependencies

- Python 3.11+
- PyYAML (`pip install --user pyyaml`)
- `qmd` CLI on `$PATH` (https://github.com/tobi/qmd)

## Methodology

### Recall calculation

For each query:

```
relevant_set = ground_truth[query]
retrieved    = qmd_results[:k]
recall@k     = |relevant_set ∩ retrieved| / |relevant_set|
```

Reported metrics:
- **macro recall** = mean of per-query recall (each query weighted equally)
- **micro recall** = sum of hits / sum of relevant (each relevant doc weighted equally)
- K = 5 (matches typical RAG context budget) and K = 10 (loose recall)

### Ground truth labeling

- 20 queries split across 5 categories (5/5/5/3/2):
  - A: direct concept name lookup
  - B: natural-language description (semantic understanding)
  - C: cross-concept composition (multi-doc retrieval)
  - D: short Chinese keyword (BM25-failure stress)
  - E: edge case / cold corpus area
- Conservative labeling: only docs that are clearly relevant. Borderline docs
  are excluded (the goal is to measure recall honestly, not inflate it).
- 63 total labels, mean 3.1 relevant docs per query (range 2-5).

### Engineering gotchas (worth knowing)

1. **CMake noise pollutes stdout** — `node-llama-cpp` (qmd's runtime) attempts
   to compile a CUDA backend on every invocation, fails, then falls back to
   CPU. The CMake error output goes to **stdout**, not stderr. The benchmark
   uses an `extract_json()` helper that scans the polluted stdout from the
   end to find a parseable JSON block. Setting
   `CMAKE_DISABLE_FIND_PACKAGE_CUDAToolkit=ON` does **not** suppress this.

2. **Question filenames get lowercased** — qmd JSON output reports
   `questions/q-history-newton-giants-01.md` even though the file on disk is
   `Q-history-newton-giants-01.md`. The benchmark normalizes both sides
   (qmd output and ground truth) to lowercase before comparison.

3. **Missing embeddings silently bias baseline** — before running this
   benchmark, 84 of 342 documents (25%) had no vector embeddings. Pure
   vector search would systematically miss them. Running `qmd embed` first
   is required for fair measurement.

4. **JSON schema** — top-level list, each item is `{docid, score, file, title, snippet}`.
   The path lives in `file` (not `path`/`uri`/`url`).

## Results

See `results/report.md` for the human-readable summary with qualitative
analysis of the most interesting per-query findings.
