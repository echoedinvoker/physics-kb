#!/usr/bin/env bash
# Wrapper for verify.py
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/verify.py" "$@"
