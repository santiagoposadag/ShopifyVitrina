#!/usr/bin/env bash
# Validates docs/: code fences, Mermaid colors, relative links, page length,
# prose density and file:line citations. Run from anywhere.
#
# Deliberately bash 3.2 compatible (no mapfile, no associative arrays, no
# ${var,,}): macOS ships bash 3.2, and a check nobody can run is not a check.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1

RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
errors=0
warnings=0
MAX_LINES=120

fail()  { printf '%sFAIL%s  %s\n' "$RED" "$OFF" "$1"; errors=$((errors + 1)); }
warn()  { printf '%sWARN%s  %s\n' "$YEL" "$OFF" "$1"; warnings=$((warnings + 1)); }
pass()  { printf '%s  ok%s  %s\n' "$GRN" "$OFF" "$1"; }
head_() { printf '\n%s-- %s%s\n' "$DIM" "$1" "$OFF"; }

# find, not `git ls-files`: the check must work on pages not committed yet.
DOCS=$(find docs -type f -name '*.md' | sort)
[ -z "$DOCS" ] && { echo "no markdown found under docs/"; exit 1; }

# The wiki is the five meta pages plus the three axes. The other files under
# docs/ are runbooks and proposals that predate these conventions: they are held
# to the universal checks (fences, links, citations) but exempted from the style
# ones (colors, length, prose density). The exemption is listed, not silent —
# see docs/DEUDA.md #10 for the one that is a real rendering bug.
is_wiki() {
  case "$1" in
    docs/README.md|docs/CONTRIBUTING.md|docs/ONBOARDING.md|docs/REVISION.md|docs/DEUDA.md) return 0 ;;
    docs/0[123]-*/*) return 0 ;;
    *) return 1 ;;
  esac
}
count=$(printf '%s\n' "$DOCS" | wc -l | tr -d ' ')

# -- 1. Balanced code fences ---------------------------------------------------
head_ "code fences"
bad=0
for f in $DOCS; do
  n=$(grep -c '^```' "$f")
  if [ $((n % 2)) -ne 0 ]; then fail "$f: $n fences (odd — one is unclosed)"; bad=1; fi
done
[ $bad -eq 0 ] && pass "all fences balanced"

# -- 2. Hardcoded colors inside mermaid blocks ---------------------------------
# GitHub renders in light AND dark; a fixed color breaks one of them. Only lines
# INSIDE ```mermaid count — prose may legitimately mention `fill:`.
head_ "mermaid colors (wiki pages)"
bad=0
for f in $DOCS; do
  is_wiki "$f" || continue
  hits=$(awk '
    /^```mermaid$/ { inb=1; next }
    /^```/         { inb=0; next }
    inb && /^[[:space:]]*(style|classDef|linkStyle)[[:space:]]|fill:|stroke:|%%\{[[:space:]]*init/ {
      printf "%d: %s\n", NR, $0
    }' "$f")
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | while IFS= read -r h; do printf '%sFAIL%s  %s:%s\n' "$RED" "$OFF" "$f" "$h"; done
    bad=1
    errors=$((errors + 1))
  fi
done
[ $bad -eq 0 ] && pass "no hardcoded colors or init directives inside mermaid"

# -- 3. Relative links resolve -------------------------------------------------
head_ "relative links"
bad=0
for f in $DOCS; do
  dir=$(dirname "$f")
  # Strip fenced blocks AND inline code spans: `(\w+)` inside a command is not a link.
  links=$(awk '/^```/ { inb = !inb; next } !inb' "$f" \
    | sed 's/`[^`]*`//g' \
    | grep -oE '\]\([^)]+\)' | sed -E 's/^\]\(//; s/\)$//')
  for link in $links; do
    case "$link" in http*|\#*|mailto:*) continue ;; esac
    target="${link%%#*}"
    [ -z "$target" ] && continue
    resolved="$dir/$target"
    if [ -d "$resolved" ]; then
      [ -f "$resolved/README.md" ] || { fail "$f -> $link (directory has no README.md)"; bad=1; }
    elif [ ! -e "$resolved" ]; then
      fail "$f -> $link"; bad=1
    fi
  done
done
[ $bad -eq 0 ] && pass "all relative links resolve"

# -- 4. Page length ------------------------------------------------------------
head_ "page length (wiki pages)"
bad=0
for f in $DOCS; do
  is_wiki "$f" || continue
  n=$(wc -l < "$f" | tr -d ' ')
  if [ "$n" -gt "$MAX_LINES" ]; then warn "$f: $n lines (limit $MAX_LINES — split it)"; bad=1; fi
done
[ $bad -eq 0 ] && pass "every page within $MAX_LINES lines"

# -- 5. Prose density ----------------------------------------------------------
# Flags 4+ consecutive lines that are neither blank, heading, table, list, fence,
# quote nor HTML — i.e. a wall of prose where a table or a callout belongs.
head_ "prose density (wiki pages)"
bad=0
for f in $DOCS; do
  is_wiki "$f" || continue
  hit=$(awk '
    /^```/ { inb = !inb; run = 0; next }
    inb    { next }
    /^[[:space:]]*$/ || /^#/ || /^\|/ || /^[-*>]/ || /^</ { run = 0; next }
    { run++; if (run == 4) { print NR; exit } }' "$f")
  [ -n "$hit" ] && { warn "$f:$hit — 4+ consecutive prose lines"; bad=1; }
done
[ $bad -eq 0 ] && pass "no prose walls"

# -- 6. Citations resolve ------------------------------------------------------
# Every `path/file.ext:N` must name a real file with at least N lines. This
# proves the citation RESOLVES; it cannot prove the line still says what the
# page claims. That is level 3 in docs/REVISION.md, and it is done by hand.
head_ "citations"
bad=0
total=0
for f in $DOCS; do
  cites=$(grep -oE '[A-Za-z0-9_./-]+\.(ts|go|js|mjs|yaml|yml|sh|json):[0-9]+' "$f" | sort -u)
  for cite in $cites; do
    path="${cite%:*}"
    line="${cite##*:}"
    total=$((total + 1))
    if [ ! -f "$path" ]; then
      fail "$f: $cite -> no such file"; bad=1; continue
    fi
    have=$(wc -l < "$path" | tr -d ' ')
    if [ "$line" -gt "$have" ]; then
      fail "$f: $cite -> file has only $have lines"; bad=1
    fi
  done
done
[ $bad -eq 0 ] && pass "$total citation(s) resolve to a real file and line"

# -- Summary -------------------------------------------------------------------
printf '\n%s------%s\n' "$DIM" "$OFF"
printf '%s files · ' "$count"
if [ $errors -gt 0 ]; then printf '%s%d errors%s · ' "$RED" "$errors" "$OFF"; else printf '%s0 errors%s · ' "$GRN" "$OFF"; fi
if [ $warnings -gt 0 ]; then printf '%s%d warnings%s\n' "$YEL" "$warnings" "$OFF"; else printf '%s0 warnings%s\n' "$GRN" "$OFF"; fi
printf '%sNot automated: open the pages on GitHub and confirm every diagram renders\nin BOTH light and dark theme.%s\n' "$DIM" "$OFF"

[ $errors -gt 0 ] && exit 1
exit 0
