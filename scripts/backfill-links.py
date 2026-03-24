#!/usr/bin/env python3
"""回填連結腳本：找出舊筆記中提到但未連結到新筆記的概念

Usage:
    python3 scripts/backfill-links.py <new_titles_file>
    python3 scripts/backfill-links.py --auto  # 自動從 git diff 偵測新筆記

<new_titles_file> 格式：每行一個筆記標題

產出：backfill-suggestions.txt
"""

import os
import re
import sys
import glob

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTES_DIR = os.path.join(PROJECT_DIR, "notes")
OUTPUT = os.path.join(PROJECT_DIR, "backfill-suggestions.txt")

def get_all_note_titles():
    """Get all existing note titles."""
    titles = set()
    for f in glob.glob(os.path.join(NOTES_DIR, "**", "*.md"), recursive=True):
        titles.add(os.path.splitext(os.path.basename(f))[0])
    return titles

def get_new_titles(arg):
    """Get list of new titles from file or git diff."""
    if arg == "--auto":
        # Detect new files from git
        import subprocess
        result = subprocess.run(
            ["git", "diff", "--name-only", "--diff-filter=A", "HEAD~1"],
            capture_output=True, text=True, cwd=PROJECT_DIR
        )
        return [
            os.path.splitext(os.path.basename(f))[0]
            for f in result.stdout.strip().split("\n")
            if f.startswith("notes/") and f.endswith(".md")
        ]
    else:
        with open(arg) as fh:
            return [line.strip() for line in fh if line.strip()]

def find_mentions_in_note(filepath, new_titles):
    """Find new titles mentioned in a note's body but not as wikilinks."""
    with open(filepath) as fh:
        content = fh.read()

    # Get existing wikilinks
    existing_links = set(re.findall(r'(?<!!)\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]', content))

    suggestions = []
    for title in new_titles:
        # Skip if already linked
        if title in existing_links:
            continue
        # Skip self-reference
        if os.path.splitext(os.path.basename(filepath))[0] == title:
            continue
        # Check if title text appears in body (case-sensitive for Chinese)
        if title in content:
            suggestions.append(title)

    return suggestions

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/backfill-links.py <new_titles_file|--auto>")
        sys.exit(1)

    new_titles = get_new_titles(sys.argv[1])
    if not new_titles:
        print("No new titles to check.")
        return

    print(f"Checking {len(new_titles)} new titles against existing notes...")

    all_suggestions = []
    for filepath in sorted(glob.glob(os.path.join(NOTES_DIR, "**", "*.md"), recursive=True)):
        rel = os.path.relpath(filepath, PROJECT_DIR)
        suggestions = find_mentions_in_note(filepath, new_titles)
        if suggestions:
            for title in suggestions:
                all_suggestions.append((rel, title))

    # Write report
    with open(OUTPUT, "w") as out:
        out.write(f"# Backfill Link Suggestions\n")
        out.write(f"# New titles checked: {len(new_titles)}\n")
        out.write(f"# Suggestions found: {len(all_suggestions)}\n\n")
        for note_path, title in sorted(all_suggestions):
            out.write(f"在 {note_path} 中加入 [[{title}]] 連結\n")

    print(f"Done. {len(all_suggestions)} suggestions → {OUTPUT}")

if __name__ == "__main__":
    main()
