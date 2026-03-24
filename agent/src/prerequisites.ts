import { resolve, basename } from "path";
import { Glob } from "bun";
import { readNote, type NoteContent } from "./notes";

export interface PrerequisiteNode {
  name: string;
  depth: number;
  description?: string;
  prerequisites: PrerequisiteNode[];
}

export interface ConceptInfo {
  title: string;
  prerequisites: string[];
  description: string; // first line of body as summary
}

// Build concept → prerequisites map from notes
export async function buildConceptGraph(
  notesPath: string
): Promise<Map<string, ConceptInfo>> {
  const graph = new Map<string, ConceptInfo>();
  const glob = new Glob("*.md");

  for (const dir of ["concepts", "applications"]) {
    const dirPath = resolve(notesPath, dir);
    for await (const file of glob.scan({ cwd: dirPath, absolute: true })) {
      try {
        const note = readNote(file);
        const title = note.title;
        let prereqs: string[] = [];

        const raw = note.frontmatter.prerequisites;
        if (Array.isArray(raw)) {
          prereqs = raw.map(String).filter((s) => s.length > 0);
        }

        // Extract first meaningful line as description
        const lines = note.body
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
        const description = lines[0]?.trim().slice(0, 100) ?? "";

        graph.set(title, { title, prerequisites: prereqs, description });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return graph;
}

export async function getPrerequisiteTree(
  conceptName: string,
  notesPath: string,
  maxDepth: number = 3
): Promise<PrerequisiteNode | null> {
  const graph = await buildConceptGraph(notesPath);

  function buildTree(
    name: string,
    depth: number,
    visited: Set<string>
  ): PrerequisiteNode {
    const info = graph.get(name);
    const node: PrerequisiteNode = {
      name,
      depth,
      description: info?.description,
      prerequisites: [],
    };

    if (depth >= maxDepth || visited.has(name)) {
      return node;
    }

    visited.add(name);

    if (info?.prerequisites) {
      for (const prereq of info.prerequisites) {
        node.prerequisites.push(buildTree(prereq, depth + 1, new Set(visited)));
      }
    }

    return node;
  }

  if (!graph.has(conceptName)) {
    // Try fuzzy match
    for (const [title] of graph) {
      if (title.includes(conceptName) || conceptName.includes(title)) {
        return buildTree(title, 0, new Set());
      }
    }
    return null;
  }

  return buildTree(conceptName, 0, new Set());
}

// Get flat list of all concept names (for frontend autocomplete)
export async function listConcepts(
  notesPath: string
): Promise<string[]> {
  const graph = await buildConceptGraph(notesPath);
  return [...graph.keys()].sort();
}
