#!/usr/bin/env bash
# 重建 qmd 索引：建立 collection → 建立向量嵌入
#
# 使用方式：
#   bash scripts/index.sh          # 完整重建（移除舊 collection 再建新的）
#   bash scripts/index.sh --update # 只更新索引（不重建 collection）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
NOTES_DIR="$PROJECT_DIR/notes"
COLLECTION_NAME="physics"

# 檢查 qmd 是否安裝
if ! command -v qmd &> /dev/null; then
    echo "ERROR: qmd not found. Install with: bun install -g github:tobi/qmd"
    exit 1
fi

# 檢查 notes 目錄是否有檔案
NOTE_COUNT=$(find "$NOTES_DIR" -name "*.md" -type f | wc -l)
if [ "$NOTE_COUNT" -eq 0 ]; then
    echo "ERROR: No .md files found in $NOTES_DIR"
    exit 1
fi

echo "Found $NOTE_COUNT notes in $NOTES_DIR"

if [ "${1:-}" = "--update" ]; then
    # 更新模式：重新掃描現有 collection
    echo "Updating index..."
    qmd update
else
    # 完整重建模式：移除舊 collection 再建新的
    echo "Rebuilding collection '$COLLECTION_NAME'..."
    qmd collection remove "$COLLECTION_NAME" 2>/dev/null || true
    qmd collection add "$NOTES_DIR" --name "$COLLECTION_NAME" --mask "**/*.md"
fi

# 建立向量嵌入
echo "Building embeddings..."
qmd embed

# 重建 agent note index 快取
AGENT_DIR="$PROJECT_DIR/agent"
if [ -d "$AGENT_DIR/src" ]; then
    echo "Rebuilding agent note index cache..."
    rm -f "$AGENT_DIR/.note-index.json"
    # Next agent run will auto-rebuild the cache
fi

echo "Done. Index ready with $NOTE_COUNT notes."
echo ""
echo "Test with:"
echo "  qmd search \"萬有引力\" -c $COLLECTION_NAME     # BM25 關鍵字搜尋"
echo "  qmd vsearch \"兩物體間的力\" -c $COLLECTION_NAME  # 向量語意搜尋"
echo "  qmd query \"E=mc2\" -c $COLLECTION_NAME           # 組合搜尋 + re-ranking"
