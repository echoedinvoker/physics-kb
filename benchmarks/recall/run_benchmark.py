#!/usr/bin/env python3
"""
Physics KB Recall Benchmark
比較 qmd vec-only baseline vs full hybrid (expansion + LLM rerank).

Both run via `qmd query`, differing only in invocation form:
  baseline:  qmd query 'vec: <q>'   # single vector, no expansion, no rerank
  hybrid:    qmd query '<q>'        # auto query expansion + reranker
"""
import subprocess, json, yaml, statistics, time, os, sys
from pathlib import Path

BENCH_DIR = Path(__file__).parent
GT_PATH = BENCH_DIR / "ground_truth.yaml"
RESULTS_DIR = BENCH_DIR / "results"

# Verified qmd JSON schema (2026-04-07): top-level list, each dict has "file"
PATH_KEY = "file"
URI_PREFIX = "qmd://physics/"

# Two strategies — only the query form differs
STRATEGIES = {
    "vec_baseline":  lambda q: ["qmd", "query", f"vec: {q}", "-n", "20", "--json"],
    "hybrid_rerank": lambda q: ["qmd", "query", q, "-n", "20", "--json"],
}


def normalize(path: str) -> str:
    """Strip qmd:// prefix and any :LINE suffix; lowercase to match ground truth.
    qmd lowercases question filenames (Q-... -> q-...), so we lowercase both sides.
    """
    if path.startswith(URI_PREFIX):
        path = path[len(URI_PREFIX):]
    if ":" in path:
        path = path.split(":", 1)[0]
    return path.lower()


def extract_json(stdout: str):
    """Extract JSON from stdout polluted with CMake noise.
    Strategy: walk all '[' and '{' positions from the end, try parse each.
    """
    candidates = [i for i, c in enumerate(stdout) if c in "[{"]
    for idx in reversed(candidates):
        try:
            return json.loads(stdout[idx:])
        except json.JSONDecodeError:
            continue
    raise ValueError(f"No parseable JSON in stdout (len={len(stdout)})")


def run_qmd(strategy: str, query: str):
    """Run qmd, return (deduped_paths, elapsed_seconds, error_or_None)."""
    cmd = STRATEGIES[strategy](query)
    start = time.time()
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600,
            env={**os.environ, "NO_COLOR": "1"},
        )
    except subprocess.TimeoutExpired:
        return [], time.time() - start, "TIMEOUT"
    elapsed = time.time() - start
    if result.returncode != 0:
        return [], elapsed, f"exit {result.returncode}: {result.stderr[-300:]}"
    try:
        data = extract_json(result.stdout)
    except ValueError as e:
        return [], elapsed, f"{e}; tail 300: {result.stdout[-300:]}"
    items = data if isinstance(data, list) else data.get("results", [])
    raw_paths = [normalize(item[PATH_KEY]) for item in items if PATH_KEY in item]
    seen, deduped = set(), []
    for p in raw_paths:
        if p not in seen:
            seen.add(p)
            deduped.append(p)
    return deduped, elapsed, None


def recall_at_k(retrieved, relevant, k):
    if not relevant:
        return None
    top_k = set(retrieved[:k])
    return len(top_k & relevant) / len(relevant)


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None  # optional strategy filter
    gt_file = sys.argv[2] if len(sys.argv) > 2 else GT_PATH
    gt = yaml.safe_load(Path(gt_file).read_text())
    RESULTS_DIR.mkdir(exist_ok=True)
    strategies = [only] if only else list(STRATEGIES)
    for strategy in strategies:
        print(f"\n=== Running {strategy} ===", flush=True)
        results, failures = [], []
        for item in gt:
            qid, query = item["id"], item["query"]
            relevant = set(p.lower() for p in item["relevant"])
            print(f"  [{qid}] {query[:32]}", end=" ", flush=True)
            paths, elapsed, err = run_qmd(strategy, query)
            if err:
                print(f"FAILED ({err[:80]})")
                failures.append({"id": qid, "error": err})
                continue
            r5 = recall_at_k(paths, relevant, 5)
            r10 = recall_at_k(paths, relevant, 10)
            results.append({
                "id": qid, "query": query,
                "category": item.get("category"),
                "relevant": sorted(relevant),
                "retrieved": paths[:10],
                "recall_at_5": r5, "recall_at_10": r10,
                "elapsed_sec": round(elapsed, 2),
            })
            print(f"r@5={r5:.0%} r@10={r10:.0%} ({elapsed:.1f}s)")
        output = {"results": results, "failures": failures}
        out_path = RESULTS_DIR / f"{strategy}.json"
        out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False))
        valid5 = [r["recall_at_5"] for r in results if r["recall_at_5"] is not None]
        valid10 = [r["recall_at_10"] for r in results if r["recall_at_10"] is not None]
        if valid5:
            macro5 = statistics.mean(valid5)
            macro10 = statistics.mean(valid10)
            total_relevant = sum(len(set(r["relevant"])) for r in results)
            total_hits5 = sum(
                len(set(r["retrieved"][:5]) & set(r["relevant"])) for r in results
            )
            total_hits10 = sum(
                len(set(r["retrieved"][:10]) & set(r["relevant"])) for r in results
            )
            micro5 = total_hits5 / total_relevant if total_relevant else 0
            micro10 = total_hits10 / total_relevant if total_relevant else 0
            avg_t = statistics.mean(r["elapsed_sec"] for r in results)
            print(f"  → macro recall@5={macro5:.1%} @10={macro10:.1%}")
            print(f"  → micro recall@5={micro5:.1%} @10={micro10:.1%}")
            print(f"  → avg_time={avg_t:.1f}s | failures={len(failures)}")


if __name__ == "__main__":
    main()
