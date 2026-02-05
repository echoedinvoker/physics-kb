#!/usr/bin/env python3
"""
Fix broken LaTeX in Markdown files.

Python escape sequences corrupted LaTeX commands when strings were written
without raw strings or proper escaping. The backslash was consumed by the
Python escape, leaving the control character + remaining letters.

Corruption patterns found:
  \frac   -> 0x0C (form feed) + "rac"
  \right  -> 0x0D (carriage return) + "ight"
  \rho    -> 0x0D (carriage return) + "ho"
  \tau    -> 0x09 (tab) + "au"
  \times  -> 0x09 (tab) + "imes"
  \text{  -> 0x09 (tab) + "ext{"
  \textbf{-> 0x09 (tab) + "extbf{"
  \approx -> 0x07 (bell) + "pprox"
"""

import os
import glob

SCAN_DIR = "/home/matt/Documents/physics-kb/notes/"

# All replacement patterns: (broken_bytes, fixed_string)
# Order matters: longer patterns first to avoid partial matches
REPLACEMENTS = [
    ("\x0c" + "rac",    "\\frac"),     # form feed + "rac"    -> \frac
    ("\x0d" + "ight",   "\\right"),    # carriage return + "ight" -> \right
    ("\x0d" + "ho",     "\\rho"),      # carriage return + "ho"   -> \rho
    ("\x09" + "extbf{", "\\textbf{"),  # tab + "extbf{" -> \textbf{ (before \text)
    ("\x09" + "ext{",   "\\text{"),    # tab + "ext{"   -> \text{
    ("\x09" + "imes",   "\\times"),    # tab + "imes"   -> \times
    ("\x09" + "au",     "\\tau"),      # tab + "au"     -> \tau
    ("\x07" + "pprox",  "\\approx"),   # bell + "pprox" -> \approx
]

# ---- Phase 1: Fix ALL .md files under notes/ ----

print("=" * 60)
print("Phase 1: Fixing all corrupted .md files")
print("=" * 60)

all_files = sorted(glob.glob(os.path.join(SCAN_DIR, "**", "*.md"), recursive=True))
files_fixed = 0
total_replacements = 0

for filepath in all_files:
    with open(filepath, "rb") as f:
        raw = f.read()

    content = raw.decode("utf-8")
    original = content

    changes = []
    for broken, fixed in REPLACEMENTS:
        count = content.count(broken)
        if count > 0:
            changes.append((broken, fixed, count))
            content = content.replace(broken, fixed)

    if content != original:
        files_fixed += 1
        rel = os.path.relpath(filepath, SCAN_DIR)
        print(f"\n--- {rel} ---")
        print("Replacements made:")
        for broken, fixed, count in changes:
            total_replacements += count
            print(f"  {repr(broken)} -> {fixed} ({count}x)")

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        print("  -> File saved.")

        # Print lines containing LaTeX to verify
        print("  Verification (LaTeX lines):")
        latex_cmds = ["\\frac", "\\right", "\\rho", "\\tau", "\\times",
                      "\\text{", "\\textbf{", "\\approx", "\\left"]
        for i, line in enumerate(content.splitlines(), 1):
            if any(cmd in line for cmd in latex_cmds):
                print(f"    L{i}: {line.strip()}")

print(f"\n--- Summary: {files_fixed} file(s) fixed, {total_replacements} total replacement(s) ---")

# ---- Phase 2: Verify no remaining control characters ----

print("\n" + "=" * 60)
print("Phase 2: Scanning ALL .md files for remaining control chars")
print("         (0x07 bell, 0x09 tab, 0x0C form feed, 0x0D CR)")
print("=" * 60)

CONTROL_CHARS = {
    0x07: "bell (\\a)",
    0x09: "tab (\\t)",
    0x0C: "form feed (\\f)",
    0x0D: "carriage return (\\r)",
}

found_issues = []

for mdfile in sorted(glob.glob(os.path.join(SCAN_DIR, "**", "*.md"), recursive=True)):
    with open(mdfile, "rb") as f:
        raw = f.read()

    issues_in_file = []
    for byte_val, description in CONTROL_CHARS.items():
        positions = []
        idx = 0
        while True:
            idx = raw.find(bytes([byte_val]), idx)
            if idx == -1:
                break
            start = max(0, idx - 10)
            end = min(len(raw), idx + 10)
            context = raw[start:end]
            positions.append((idx, context))
            idx += 1

        if positions:
            issues_in_file.append((byte_val, description, positions))

    if issues_in_file:
        rel_path = os.path.relpath(mdfile, SCAN_DIR)
        found_issues.append((mdfile, rel_path, issues_in_file))

if found_issues:
    print(f"\nWARNING: Found {len(found_issues)} file(s) still with control characters:\n")
    for fullpath, relpath, issues in found_issues:
        print(f"  {relpath}:")
        for byte_val, desc, positions in issues:
            print(f"    0x{byte_val:02X} ({desc}): {len(positions)} occurrence(s)")
            for pos, ctx in positions[:5]:
                print(f"      offset {pos}: context = {repr(ctx)}")
else:
    print("\nAll clean! No remaining 0x07/0x09/0x0C/0x0D found in any .md file.")

print("\nDone.")
