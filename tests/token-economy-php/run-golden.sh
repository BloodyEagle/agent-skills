#!/bin/sh
# Linux/macOS/Git Bash: генерация в tmp и сравнение трекнутых эталонов.
# before|after|другая-метка сохраняет новый снимок, не перезаписывая старые golden/.
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$DIR/run-golden.js" "$@"
