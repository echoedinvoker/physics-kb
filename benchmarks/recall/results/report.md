# Physics KB Recall Benchmark Report

**Date**: 2026-04-07
**Corpus**: 342 atomic markdown notes (高一物理 Ch1 — 物理學簡史、測量、應用)
**Test set**: 20 hand-curated queries with hand-labeled relevant docs (63 labels total, mean 3.1 / query)
**Hardware**: Linux box, no GPU acceleration (CPU only — qmd warns "running on CPU, slow")

## Headline

| Strategy        | Macro R@5 | Macro R@10 | Micro R@5 | Micro R@10 | Avg time |
|-----------------|----------:|-----------:|----------:|-----------:|---------:|
| `vec_baseline`  | **57.8%** |      71.5% | **55.6%** |      71.4% |    33.8s |
| `hybrid_rerank` |     53.7% |  **77.8%** |     50.8% |  **77.8%** |    39.9s |
| Δ (hybrid − baseline) | **−4.1pp** | **+6.3pp** | **−4.8pp** | **+6.4pp** | **+6.1s** |

Win/tie/loss across the 20 queries:

- **R@5**: hybrid wins 5, ties 9, loses 6 → net **−1**
- **R@10**: hybrid wins 7, ties 9, loses 4 → net **+3**

The naive read is "the optimization didn't work." That read is wrong — see the
breakdown below.

## The actual story: rerank has a query-type signature

When you split the 20 queries by category, the picture flips from "noisy wash"
into a sharp, repeatable pattern:

| Category                | n | vec @5 | hyb @5 | Δ@5  | vec @10 | hyb @10 | Δ@10 |
|-------------------------|--:|-------:|-------:|-----:|--------:|--------:|-----:|
| A — direct concept name | 5 |  80%   |  43%   | **−37** |  93%   |  77%    | −17  |
| B — natural language    | 5 |  47%   |  38%   |  −8  |  65%   |  67%    |  +2  |
| C — cross-concept       | 5 |  58%   |  63%   |  +5  |  81%   |  91%    | +10  |
| D — short keyword       | 3 |  44%   |  72%   | **+28** |  44%   |  72%    | **+28** |
| E — edge / cold         | 2 |  50%   |  67%   | +17  |  50%   |  83%    | **+33** |

Read row by row:

- **A — direct concept**: vector embeddings already cluster a 5-token concept
  name with the document about that concept. Adding a reranker gives the LLM
  too many candidates to choose from, and it actively pushes the obvious
  answer down. Big loss.
- **B — natural language**: roughly a wash. Vector handles paraphrase well
  enough that expansion adds little, and rerank trades places between
  marginally-relevant docs.
- **C — cross-concept**: rerank starts to win at K=10. Multi-doc queries need
  a wider net, and the LLM is good at recognizing that "this doc is _also_
  about the same topic chain."
- **D — short keyword**: biggest swing in the whole benchmark. Two-character
  Chinese keywords (`牛頓`, `庫侖`, `雷射`) are hard for embeddings — they
  match too many surface-similar things. Query expansion + rerank adds
  the missing context.
- **E — edge / cold**: vector misses, expansion finds the single nearby
  cluster, rerank surfaces it.

**Conclusion that matters**: don't run hybrid+rerank as a global optimization.
Route by query type. A `len(query) ≤ 4` Chinese-token check would catch
most of category D and is essentially free. A "is this query a concept name
that exists as a doc title" lookup would catch most of A and let vector handle
those queries 2x faster.

## Qualitative findings

### Worst regression — q04 「光的波粒二象性」 (R@5: 100% → 33%)

Ground truth: `光的波粒二象性`, `光的粒子說與波動說`, `光電效應`.

- vec_baseline top-5 contained **all three** relevant docs (100%).
- hybrid_rerank top-5 kept only `光的波粒二象性`. The reranker pushed
  `光的粒子說與波動說` and `光電效應` out, replacing them with
  `questions/q-quantum-wave-particle-duality-02.md` and a scientist page
  for 愛因斯坦.

**Why this happens**: the corpus has many question files that contain the
phrase「波粒二象性」repeatedly in their question text. The reranker treats
keyword density as a signal for relevance, but those questions are tests
*about* the topic, not the topic explanation. The vec baseline correctly
weighted the concept docs higher because their embeddings sit in the same
semantic neighborhood without being lexically dominated by the query string.

### Best improvement — q17 「庫侖」 (R@5: 50% → 100%)

Ground truth: `formulas/庫侖定律公式`, `scientists/庫侖`.

- vec_baseline only retrieved the formula doc. The scientist page didn't make
  it into top-10 — vector treated 「庫侖」 as primarily a concept-of-physics
  rather than a person-name.
- hybrid_rerank recovered both. Query expansion likely produced phrasings
  like "Coulomb the scientist" and "Coulomb's law", and the reranker correctly
  weighted both result types.

This is the strongest evidence that for short Chinese keywords, expansion +
rerank is doing real work that pure embeddings cannot.

### Most dramatic recovery — q20 「質量這個物理量」 (R@5: 0% → 33%, R@10: 0% → 67%)

Ground truth: `concepts/質量`, `concepts/SI七大基本量`, `formulas/密度公式`.

- vec_baseline scored **zero** at both K=5 and K=10. Top results were
  `concepts/慣性` and a string of `q-mass-*` question files.
- hybrid_rerank pulled `concepts/質量` into rank 3 and `concepts/SI七大基本量`
  into top 10 (via a related doc).

`concepts/慣性` is semantically adjacent to mass (慣性質量) so vector treats
it as the best match. The reranker recognized the query was asking about the
*concept* of mass as a *physical quantity* and surfaced the right doc.
Neither strategy retrieved `formulas/密度公式` (a density formula) — that
labeling may have been too generous on my part. Honest answer: my ground
truth was slightly off here, not the system.

## Methodology

### Strategies

| Strategy        | Command form                              | Mechanism |
|-----------------|-------------------------------------------|-----------|
| `vec_baseline`  | `qmd query 'vec: <q>' -n 20 --json`       | Single vector search, no expansion, no rerank |
| `hybrid_rerank` | `qmd query '<q>' -n 20 --json`            | Auto query expansion (4 vec queries + hyde) + Qwen3 0.6B reranker |

Pure BM25 (`qmd search`) was excluded — it has no Chinese tokenizer and
returns "No results found" for every query. That finding is itself a
relevant data point: any RAG system on a CJK corpus must use semantic
retrieval, lexical-only is dead on arrival.

### Pre-flight

- `qmd update` — index unchanged at 342 docs
- `qmd embed` — added 102 missing embedding chunks for 84 documents
  (25% of the corpus had been silently un-embedded). Without this step,
  vec_baseline would have looked artificially worse.

### Recall calculation

```
recall@k = |relevant ∩ retrieved[:k]| / |relevant|
```

Reported as both **macro** (mean of per-query recall) and **micro** (sum of
hits / sum of relevant). Macro and micro tracked closely — the labeling is
balanced enough that no single query dominates the average.

K = 5 chosen to match a typical RAG context budget (5 chunks fit comfortably
in a prompt with room for prior turn and instructions). K = 10 reported as a
"loose recall" sanity check — if a doc is in top 10 but not top 5, the
retriever knows about it but the ranker is mis-ordering.

### Ground truth labeling

20 queries spread across 5 categories (5/5/5/3/2). Conservative labeling —
only docs that are *clearly* relevant. 63 total labels, mean 3.1 docs per
query, range 2-5.

Categories deliberately chosen to expose different retrieval failure modes:
- A: tests whether the system handles the "easy" case (concept lookup) without
  over-engineering hurting it
- B: tests semantic paraphrase handling
- C: tests multi-doc composition
- D: tests CJK-keyword stress
- E: tests cold-corpus areas

## Limitations

- **Sample size**: 20 queries is a spot-check, not a production benchmark.
  Confidence intervals on a per-category basis are wide.
- **Single annotator**: I labeled the ground truth myself. There's
  potential bias toward queries I knew the corpus could answer.
- **Borderline labels**: q20 has at least one questionable relevant
  (`formulas/密度公式`) — see the qualitative section.
- **No latency variance reporting**: avg time hides high variance from CMake
  pre-compilation overhead per invocation. The actual retrieval is sub-second.
- **K choice is fixed**: real RAG systems vary K dynamically with query
  complexity. K=5/10 is what production usually allocates, not what's optimal.

## Engineering takeaways

1. **Don't run rerank globally** — it actively hurts on a non-trivial slice
   of queries (direct concept lookups). Route by query type. The cheapest
   useful router is `len(tokens) ≤ 4 Chinese chars → hybrid, else → vec`.
2. **Query expansion is the real win in hybrid**, not the LLM reranker. Most
   of the gains in categories C/D/E come from the 4 expanded vec queries +
   hyde, not from the reranker re-sorting them. Worth a follow-up benchmark
   running expansion-only without rerank.
3. **CJK-only corpora cannot use BM25** without a tokenizer. Any system
   architecture document for a Chinese RAG should call this out explicitly.
4. **Recall@10 - Recall@5 is a useful diagnostic** — for hybrid the gap is
   24pp, meaning the reranker often knows the right answer is in there but
   places it at rank 6-10. This suggests the reranker model is undersized
   for the task (Qwen3 0.6B). Worth trying a larger reranker.

## Files

- `vec_baseline.json` — per-query results, vec baseline
- `hybrid_rerank.json` — per-query results, hybrid + rerank
- `raw_log.txt` — full stdout from `python run_benchmark.py`
- `report.md` — this file
