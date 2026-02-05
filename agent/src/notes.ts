import { readFileSync, existsSync, writeFileSync } from "fs";
import { basename, resolve, relative } from "path";
import { Glob } from "bun";
import matter from "gray-matter";

export interface NoteContent {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  links: string[];
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export function extractWikilinks(markdown: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(WIKILINK_RE)) {
    const target = match[1].trim();
    if (!seen.has(target)) {
      seen.add(target);
      links.push(target);
    }
  }
  return links;
}

export function readNote(filePath: string): NoteContent {
  const raw = readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  return {
    path: filePath,
    title: (data.title as string) ?? basename(filePath, ".md"),
    frontmatter: data,
    body: content,
    links: extractWikilinks(content),
  };
}

// NoteIndex: title → path(s). Most titles map to one path, but collisions are possible.
export type NoteIndex = Map<string, string[]>;

const CACHE_FILENAME = ".note-index.json";

function getCachePath(notesPath: string): string {
  return resolve(notesPath, "..", "agent", CACHE_FILENAME);
}

export function resolveLink(index: NoteIndex, linkTarget: string): string | undefined {
  const paths = index.get(linkTarget);
  if (!paths || paths.length === 0) return undefined;
  // If only one match, return it directly
  if (paths.length === 1) return paths[0];
  // Multiple matches: prefer non-question notes (concepts > questions for link resolution)
  const nonQuestion = paths.find((p) => !p.includes("/questions/"));
  return nonQuestion ?? paths[0];
}

export async function buildNoteIndex(
  notesPath: string
): Promise<NoteIndex> {
  // Try loading from cache first
  const cachePath = getCachePath(notesPath);
  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, string[]>;
      const index: NoteIndex = new Map(Object.entries(raw));
      return index;
    } catch {
      // Cache corrupted, rebuild
    }
  }

  // Rebuild by scanning
  return rebuildNoteIndex(notesPath);
}

export async function rebuildNoteIndex(
  notesPath: string
): Promise<NoteIndex> {
  const index: NoteIndex = new Map();
  const glob = new Glob("**/*.md");
  const collisions: string[] = [];

  for await (const file of glob.scan({ cwd: notesPath, absolute: false })) {
    const title = basename(file, ".md");
    const fullPath = resolve(notesPath, file);
    const existing = index.get(title);
    if (existing) {
      existing.push(fullPath);
      if (existing.length === 2) {
        // Report collision on first duplicate
        collisions.push(title);
      }
    } else {
      index.set(title, [fullPath]);
    }
  }

  if (collisions.length > 0) {
    process.stderr.write(
      `[notes] Warning: ${collisions.length} filename collision(s) detected:\n`
    );
    for (const title of collisions) {
      const paths = index.get(title)!;
      const relPaths = paths.map((p) => relative(notesPath, p));
      process.stderr.write(`  "${title}" → ${relPaths.join(", ")}\n`);
    }
  }

  // Write cache
  const cachePath = getCachePath(notesPath);
  const obj: Record<string, string[]> = {};
  for (const [k, v] of index) {
    obj[k] = v;
  }
  writeFileSync(cachePath, JSON.stringify(obj), "utf-8");

  return index;
}
