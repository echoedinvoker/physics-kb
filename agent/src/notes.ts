import { readFileSync } from "fs";
import { basename, resolve } from "path";
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

export async function buildNoteIndex(
  notesPath: string
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const glob = new Glob("**/*.md");
  for await (const file of glob.scan({ cwd: notesPath, absolute: false })) {
    const title = basename(file, ".md");
    index.set(title, resolve(notesPath, file));
  }
  return index;
}
