import type { Config, SearchStrategyType } from "./config";

export interface SearchStrategy {
  search(terms: string[]): Promise<string[]>;
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

class GrepSearch implements SearchStrategy {
  constructor(private notesPath: string) {}

  async search(terms: string[]): Promise<string[]> {
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

    return [...allFiles];
  }
}

class QmdSearch implements SearchStrategy {
  constructor(
    private qmdBin: string,
    private collection: string
  ) {}

  async search(terms: string[]): Promise<string[]> {
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
    return [...allFiles];
  }
}

class QmdVSearch implements SearchStrategy {
  constructor(
    private qmdBin: string,
    private collection: string
  ) {}

  async search(terms: string[]): Promise<string[]> {
    // vsearch takes a semantic query — join terms into one query
    const query = terms.join(" ");
    const proc = Bun.spawn([this.qmdBin, "vsearch", query, "-c", this.collection, "--files"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
  }
}

class QmdQuerySearch implements SearchStrategy {
  constructor(
    private qmdBin: string,
    private collection: string
  ) {}

  async search(terms: string[]): Promise<string[]> {
    const query = terms.join(" ");
    const proc = Bun.spawn([this.qmdBin, "query", query, "-c", this.collection, "--files"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
  }
}

export function createSearchStrategy(config: Config): SearchStrategy {
  const strategies: Record<SearchStrategyType, () => SearchStrategy> = {
    grep: () => new GrepSearch(config.notesPath),
    search: () => new QmdSearch(config.qmdBin, config.qmdCollection),
    vsearch: () => new QmdVSearch(config.qmdBin, config.qmdCollection),
    query: () => new QmdQuerySearch(config.qmdBin, config.qmdCollection),
  };
  return strategies[config.searchStrategy]();
}
