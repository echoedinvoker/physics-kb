#!/usr/bin/env bash
# 匯出所有筆記的標題清單，供生成新章節時注入 prompt
# 格式：title | type | chapter | topic_path
#
# Usage: bash scripts/export-titles.sh [notes_dir]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
NOTES_DIR="${1:-$PROJECT_DIR/notes}"

python3 -c "
import os, re, glob

notes_dir = '$NOTES_DIR'
for f in sorted(glob.glob(os.path.join(notes_dir, '**/*.md'), recursive=True)):
    with open(f) as fh:
        content = fh.read()
    # Extract frontmatter fields
    title = os.path.splitext(os.path.basename(f))[0]
    fm_title = re.search(r'^title:\s*\"?(.+?)\"?\s*$', content, re.MULTILINE)
    if fm_title:
        title = fm_title.group(1)

    note_type = 'unknown'
    m = re.search(r'type/(\w+)', content)
    if m:
        note_type = m.group(1)

    chapter = ''
    m = re.search(r'^chapter:\s*\"?([^\"\\n]+)\"?\s*$', content, re.MULTILINE)
    if not m:
        m = re.search(r'chapter/([\w-]+)', content)
    if m:
        chapter = m.group(1)

    topic_path = ''
    m = re.search(r'^topic_path:\s*\"?(.+?)\"?\s*$', content, re.MULTILINE)
    if m:
        topic_path = m.group(1)

    print(f'{title} | {note_type} | {chapter} | {topic_path}')
"
