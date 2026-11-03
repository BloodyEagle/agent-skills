#!/bin/sh
# Регрессионные прогоны token-economy-php на трёх фикстурах.
# Использование: sh run-golden.sh before|after
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
WDIR="$(cygpath -m "$DIR")"
BX="node $WDIR/../../skills/token-economy-php/scripts/bx.js"
TAG="${1:-before}"
OUT="$DIR/golden/$TAG"
mkdir -p "$OUT"
export MSYS_NO_PATHCONV=1

run() { # run <fixture-root> <файл вывода> <op> [параметры...]
  local root="$1" file="$2" op="$3"; shift 3
  echo "\$ op=$op $*" >> "$file"
  $BX op="$op" root="$root" "$@" >> "$file" 2>&1
  echo "exit=$?" >> "$file"
  echo >> "$file"
}

B="$WDIR/bitrix-site"; L="$WDIR/laravel-app"; M="$WDIR/modx-site"
rm -f "$OUT/bitrix.txt" "$OUT/laravel.txt" "$OUT/modx.txt"

# --- Битрикс ---
run "$B" "$OUT/bitrix.txt" info
run "$B" "$OUT/bitrix.txt" symbol name=DemoListComponent
run "$B" "$OUT/bitrix.txt" symbol name='CIBlockElement::GetList'
run "$B" "$OUT/bitrix.txt" outline file='Demo\Helper'
run "$B" "$OUT/bitrix.txt" component id=demo:list
run "$B" "$OUT/bitrix.txt" events query=OnAfterItemAdd
run "$B" "$OUT/bitrix.txt" search query=includeModule
run "$B" "$OUT/bitrix.txt" rdeps file='Demo\Helper'
run "$B" "$OUT/bitrix.txt" route url=/catalog/item-1/
run "$B" "$OUT/bitrix.txt" table name=b_demo_item
run "$B" "$OUT/bitrix.txt" lang query=Новости

# --- Laravel ---
run "$L" "$OUT/laravel.txt" info
run "$L" "$OUT/laravel.txt" routes
run "$L" "$OUT/laravel.txt" model name=Post
run "$L" "$OUT/laravel.txt" container type='App\Contracts\PaymentGateway'
run "$L" "$OUT/laravel.txt" blade name=posts.index
run "$L" "$OUT/laravel.txt" console
run "$L" "$OUT/laravel.txt" route url=/posts
run "$L" "$OUT/laravel.txt" lang query=Записи
run "$L" "$OUT/laravel.txt" symbol name='App\Models\Post'
run "$L" "$OUT/laravel.txt" deps file=app/Http/Controllers/PostController.php

# --- MODX (универсальный режим) ---
run "$M" "$OUT/modx.txt" info
run "$M" "$OUT/modx.txt" symbol name=modX
run "$M" "$OUT/modx.txt" outline file=core/model/modx/modx.class.php
run "$M" "$OUT/modx.txt" search query=runSnippet
run "$M" "$OUT/modx.txt" component id=bitrix:menu
run "$M" "$OUT/modx.txt" routes
run "$M" "$OUT/modx.txt" route url=/about/

echo "golden [$TAG] готов: $OUT"
