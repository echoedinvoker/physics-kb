#!/usr/bin/env python3
"""自動化校驗腳本：檢查物理知識庫筆記品質

Usage:
    python3 scripts/verify.py                    # 檢查所有筆記
    python3 scripts/verify.py notes/concepts/    # 只檢查特定目錄

產出：verify-report.txt
"""

import os
import re
import sys
import glob
from collections import defaultdict
from datetime import datetime

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTES_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(PROJECT_DIR, "notes")
REPORT_PATH = os.path.join(PROJECT_DIR, "verify-report.txt")
KNOWN_MISSING_PATH = os.path.join(PROJECT_DIR, "notes", "known-missing-links.md")

# Collect all note titles
all_titles = set()
for f in glob.glob(os.path.join(PROJECT_DIR, "notes", "**", "*.md"), recursive=True):
    all_titles.add(os.path.splitext(os.path.basename(f))[0])

# Collect known-missing links
known_missing = set()
if os.path.exists(KNOWN_MISSING_PATH):
    with open(KNOWN_MISSING_PATH, "r") as fh:
        for m in re.finditer(r'\[\[([^\]]+)\]\]', fh.read()):
            known_missing.add(m.group(1).strip())

# Valid tag prefixes
VALID_PREFIXES = ["type/", "topic/", "chapter/", "difficulty/", "question-type/", "source/", "status/", "era/"]

# Results
errors = []
warnings = []
broken_links = []
duplicates = []

def parse_frontmatter(content):
    """Extract frontmatter as text between --- markers."""
    lines = content.split("\n")
    if not lines or lines[0].strip() != "---":
        return ""
    fm_lines = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        fm_lines.append(line)
    return "\n".join(fm_lines)

def get_note_type(fm_text):
    m = re.search(r"type/(\w+)", fm_text)
    return m.group(1) if m else None

# Find all notes to check
notes = glob.glob(os.path.join(NOTES_DIR, "**", "*.md"), recursive=True)

for filepath in sorted(notes):
    rel = os.path.relpath(filepath, PROJECT_DIR)
    with open(filepath, "r") as fh:
        content = fh.read()

    fm_text = parse_frontmatter(content)
    note_type = get_note_type(fm_text)

    # === Check 1: LaTeX syntax ===
    # Check $$ blocks: count standalone $$ delimiters (not single-line $$...$$)
    dd_open = 0
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped == "$$":
            dd_open += 1  # standalone delimiter
        elif stripped.startswith("$$") and stripped.endswith("$$") and len(stripped) > 4:
            pass  # single-line block math like $$F = ma$$, always balanced
        elif stripped.startswith("$$"):
            dd_open += 1  # opening only
        elif stripped.endswith("$$"):
            dd_open += 1  # closing only
    if dd_open % 2 != 0:
        errors.append(f"LaTeX: {rel} — 未閉合的 $$ ({dd_open} 個)")

    # Count \( and \)
    open_p = len(re.findall(r'(?<!\\)\\\(', content))
    close_p = len(re.findall(r'(?<!\\)\\\)', content))
    if open_p != close_p:
        errors.append(f"LaTeX: {rel} — \\( \\) 不匹配 (open={open_p}, close={close_p})")

    # === Check 2: Frontmatter completeness ===
    for field in ["id", "title", "created", "tags"]:
        if not re.search(rf'^{field}:', fm_text, re.MULTILINE):
            errors.append(f"Frontmatter: {rel} — 缺少 {field} 欄位")

    if note_type == "question":
        for field in ["tests_concepts", "answer"]:
            if not re.search(rf'^{field}:', fm_text, re.MULTILINE):
                warnings.append(f"Frontmatter: {rel} — 題目筆記缺少 {field}")

    if note_type == "scientist":
        for field in ["lifetime", "nationality", "fields"]:
            if not re.search(rf'^{field}:', fm_text, re.MULTILINE):
                warnings.append(f"Frontmatter: {rel} — 人物筆記缺少 {field}")

    if note_type and note_type != "moc" and "chapter/" not in fm_text:
        warnings.append(f"Frontmatter: {rel} — 缺少 chapter/ tag")

    # === Check 3: Wikilink completeness ===
    wikilinks = set(re.findall(r'(?<!!)\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]', content))
    for link in wikilinks:
        link = link.strip()
        if link not in all_titles and link not in known_missing:
            broken_links.append(f"{rel} → [[{link}]]")

    # === Check 4: Tag consistency ===
    # Extract tags from frontmatter
    in_tags = False
    for line in fm_text.split("\n"):
        if line.strip().startswith("tags:"):
            in_tags = True
            continue
        if in_tags:
            m = re.match(r'^\s+-\s+(.+)', line)
            if m:
                tag = m.group(1).strip()
                if not any(tag.startswith(p) for p in VALID_PREFIXES):
                    warnings.append(f"Tag: {rel} — 未知 tag: {tag}")
            elif not line.strip().startswith("-") and line.strip():
                in_tags = False

# === Check 5: Duplicate detection ===
# Filename duplicates
basenames = defaultdict(list)
for f in notes:
    bn = os.path.splitext(os.path.basename(f))[0]
    basenames[bn].append(os.path.relpath(f, PROJECT_DIR))
for bn, paths in basenames.items():
    if len(paths) > 1:
        duplicates.append(f"檔名重複: {bn}\n" + "\n".join(f"    - {p}" for p in paths))

# Title duplicates
titles_map = defaultdict(list)
for f in notes:
    with open(f, "r") as fh:
        fm = parse_frontmatter(fh.read())
    m = re.search(r'^title:\s*"?(.+?)"?\s*$', fm, re.MULTILINE)
    if m:
        titles_map[m.group(1).strip()].append(os.path.relpath(f, PROJECT_DIR))
for title, paths in titles_map.items():
    if len(paths) > 1:
        duplicates.append(f"標題重複: \"{title}\"\n" + "\n".join(f"    - {p}" for p in paths))

# === Write report ===
with open(REPORT_PATH, "w") as out:
    out.write("=== Summary ===\n")
    out.write(f"Total notes: {len(notes)}\n")
    out.write(f"Errors: {len(errors)}\n")
    out.write(f"Warnings: {len(warnings)}\n")
    out.write(f"Broken links: {len(broken_links)}\n")
    out.write(f"Duplicates: {len(duplicates)}\n")
    out.write("\n")
    out.write("=== Physics KB Verify Report ===\n")
    out.write(f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
    out.write(f"Target: {NOTES_DIR}\n\n")

    out.write("## 1. LaTeX 語法 + Frontmatter 完整性\n\n")
    for e in errors:
        out.write(f"  ERROR: {e}\n")
    if not errors:
        out.write("  (無錯誤)\n")
    out.write("\n")

    out.write("## 2. Warnings\n\n")
    for w in warnings:
        out.write(f"  WARN: {w}\n")
    if not warnings:
        out.write("  (無警告)\n")
    out.write("\n")

    out.write("## 3. Broken Links\n\n")
    for b in broken_links:
        out.write(f"  BROKEN: {b}\n")
    if not broken_links:
        out.write("  (無 broken links)\n")
    out.write("\n")

    out.write("## 4. 重複偵測\n\n")
    for d in duplicates:
        out.write(f"  DUPLICATE: {d}\n")
    if not duplicates:
        out.write("  (無重複)\n")
    out.write("\n")

print(f"Verify complete. Report: {REPORT_PATH}")
print(f"  Notes: {len(notes)} | Errors: {len(errors)} | Warnings: {len(warnings)} | Broken: {len(broken_links)} | Duplicates: {len(duplicates)}")
