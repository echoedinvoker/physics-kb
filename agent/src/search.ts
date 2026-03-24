import type { Config, SearchStrategyType } from "./config";

export interface SearchStrategy {
  search(terms: string[], metadataFilter?: MetadataFilter): Promise<string[]>;
}

export interface MetadataFilter {
  chapters?: string[];      // e.g. ["1-1", "2-3"]
  topicPaths?: string[];    // e.g. ["力學/牛頓運動定律"]
}

// Split compound CJK terms into shorter substrings (e.g. "光纖傳輸" → ["光纖傳輸", "光纖", "傳輸"])
function expandTerms(terms: string[]): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    expanded.add(term);
    // If term is 4+ CJK chars, also try splitting into 2-char substrings
    if (term.length >= 4 && /^[\u4e00-\u9fff]+$/.test(term)) {
      for (let i = 0; i <= term.length - 2; i += 2) {
        expanded.add(term.slice(i, i + 2));
      }
    }
  }
  return [...expanded];
}

/** Pre-filter notes by frontmatter metadata using grep */
async function filterByMetadata(notesPath: string, filter: MetadataFilter): Promise<Set<string> | null> {
  if (!filter.chapters?.length && !filter.topicPaths?.length) return null;

  let candidates: Set<string> | null = null;

  // Filter by chapter
  if (filter.chapters?.length) {
    const chapterFiles = new Set<string>();
    for (const ch of filter.chapters) {
      const proc = Bun.spawn(
        ["grep", "-rl", "--include=*.md", `chapter: "${ch}"`, notesPath],
        { stdout: "pipe", stderr: "ignore" }
      );
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      for (const line of output.trim().split("\n")) {
        if (line) chapterFiles.add(line);
      }
    }
    candidates = chapterFiles;
  }

  // Filter by topic_path
  if (filter.topicPaths?.length) {
    const topicFiles = new Set<string>();
    for (const tp of filter.topicPaths) {
      const proc = Bun.spawn(
        ["grep", "-rl", "--include=*.md", `topic_path: "${tp}`, notesPath],
        { stdout: "pipe", stderr: "ignore" }
      );
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      for (const line of output.trim().split("\n")) {
        if (line) topicFiles.add(line);
      }
    }
    if (candidates) {
      // Intersect with chapter filter
      candidates = new Set([...candidates].filter(f => topicFiles.has(f)));
    } else {
      candidates = topicFiles;
    }
  }

  return candidates;
}

/** Apply metadata filter to search results */
function applyFilter(files: string[], allowed: Set<string> | null): string[] {
  if (!allowed) return files;
  return files.filter(f => allowed.has(f));
}

class GrepSearch implements SearchStrategy {
  constructor(private notesPath: string) {}

  async search(terms: string[], metadataFilter?: MetadataFilter): Promise<string[]> {
    const allowed = metadataFilter ? await filterByMetadata(this.notesPath, metadataFilter) : null;
    const allFiles = new Set<string>();
    for (const term of terms) {
      const proc = Bun.spawn(["grep", "-rl", "--include=*.md", term, this.notesPath], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      for (const line of output.trim().split("\n")) {
        if (line) allFiles.add(line);
      }
    }

    // Fallback: if original terms found very few results, retry with expanded shorter terms
    if (allFiles.size < 3) {
      const shorter = expandTerms(terms).filter(t => !terms.includes(t));
      for (const term of shorter) {
        const proc = Bun.spawn(["grep", "-rl", "--include=*.md", term, this.notesPath], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        for (const line of output.trim().split("\n")) {
          if (line) allFiles.add(line);
        }
      }
    }

    return applyFilter([...allFiles], allowed);
  }
}

class QmdSearch implements SearchStrategy {
  constructor(
    private qmdBin: string,
    private collection: string,
    private notesPath: string
  ) {}

  async search(terms: string[], metadataFilter?: MetadataFilter): Promise<string[]> {
    const allowed = metadataFilter ? await filterByMetadata(this.notesPath, metadataFilter) : null;
    const allFiles = new Set<string>();
    // qmd search works best with single terms
    for (const term of terms) {
      const proc = Bun.spawn([this.qmdBin, "search", term, "-c", this.collection, "--files"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      for (const line of output.trim().split("\n")) {
        if (line) allFiles.add(line);
      }
    }
    return applyFilter([...allFiles], allowed);
  }
}

class QmdVSearch implements SearchStrategy {
  constructor(
    private qmdBin: string,
    private collection: string,
    private notesPath: string
  ) {}

  async search(terms: string[], metadataFilter?: MetadataFilter): Promise<string[]> {
    const allowed = metadataFilter ? await filterByMetadata(this.notesPath, metadataFilter) : null;
    // vsearch takes a semantic query — join terms into one query
    const query = terms.join(" ");
    const proc = Bun.spawn([this.qmdBin, "vsearch", query, "-c", this.collection, "--files", "-n", "20"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const files = output.trim().split("\n").filter((l) => l.length > 0);
    return applyFilter(files, allowed);
  }
}

class QmdQuerySearch implements SearchStrategy {
  constructor(
    private qmdBin: string,
    private collection: string,
    private notesPath: string
  ) {}

  async search(terms: string[], metadataFilter?: MetadataFilter): Promise<string[]> {
    const allowed = metadataFilter ? await filterByMetadata(this.notesPath, metadataFilter) : null;
    const query = terms.join(" ");
    const proc = Bun.spawn([this.qmdBin, "query", query, "-c", this.collection, "--files"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const files = output.trim().split("\n").filter((l) => l.length > 0);
    return applyFilter(files, allowed);
  }
}

/** Hybrid search: parallel BM25 + vsearch, fused with Reciprocal Rank Fusion */
class HybridSearch implements SearchStrategy {
  constructor(
    private qmdBin: string,
    private collection: string,
    private notesPath: string
  ) {}

  async search(terms: string[], metadataFilter?: MetadataFilter): Promise<string[]> {
    const allowed = metadataFilter ? await filterByMetadata(this.notesPath, metadataFilter) : null;

    // Run BM25 and vsearch in parallel
    const bm25Promise = this.runBM25(terms);
    const vsearchPromise = this.runVSearch(terms);
    const [bm25Results, vsearchResults] = await Promise.all([bm25Promise, vsearchPromise]);

    // RRF fusion: score(d) = Σ 1/(k + rank_i(d)), k=60
    const k = 60;
    const scores = new Map<string, number>();

    for (let i = 0; i < bm25Results.length; i++) {
      const file = bm25Results[i];
      scores.set(file, (scores.get(file) ?? 0) + 1 / (k + i + 1));
    }
    for (let i = 0; i < vsearchResults.length; i++) {
      const file = vsearchResults[i];
      scores.set(file, (scores.get(file) ?? 0) + 1 / (k + i + 1));
    }

    // Sort by fused score descending
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([file]) => file);

    return applyFilter(ranked, allowed);
  }

  private async runBM25(terms: string[]): Promise<string[]> {
    const allFiles: string[] = [];
    const seen = new Set<string>();
    for (const term of terms) {
      const proc = Bun.spawn(
        [this.qmdBin, "search", term, "-c", this.collection, "--files", "-n", "20"],
        { stdout: "pipe", stderr: "ignore" }
      );
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      for (const line of output.trim().split("\n")) {
        if (line && !seen.has(line)) {
          seen.add(line);
          allFiles.push(line);
        }
      }
    }
    return allFiles;
  }

  private async runVSearch(terms: string[]): Promise<string[]> {
    const query = terms.join(" ");
    const proc = Bun.spawn(
      [this.qmdBin, "vsearch", query, "-c", this.collection, "--files", "-n", "20"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim().split("\n").filter(l => l.length > 0);
  }
}

export function createSearchStrategy(config: Config): SearchStrategy {
  const strategies: Record<SearchStrategyType, () => SearchStrategy> = {
    grep: () => new GrepSearch(config.notesPath),
    search: () => new QmdSearch(config.qmdBin, config.qmdCollection, config.notesPath),
    vsearch: () => new QmdVSearch(config.qmdBin, config.qmdCollection, config.notesPath),
    query: () => new QmdQuerySearch(config.qmdBin, config.qmdCollection, config.notesPath),
    hybrid: () => new HybridSearch(config.qmdBin, config.qmdCollection, config.notesPath),
  };
  return strategies[config.searchStrategy]();
}
