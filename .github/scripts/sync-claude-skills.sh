#!/usr/bin/env bash
# Synchronizes the Claude Code skills and agents selected in CONFIG_FILE from a
# checkout of the source skills repository into CLAUDE_DIR, and records what was
# synchronized in MANIFEST_FILE.
#
#   claude/skills/<name>/    -> CLAUDE_DIR/skills/<name>/
#   claude/agents/<name>.md  -> CLAUDE_DIR/agents/<name>.md
#
# This script only reads and copies files. It never executes anything from the
# source checkout.
#
# - Selected items are replaced by an exact copy of the source, so files deleted
#   in the source are deleted here too.
# - Items listed in the previous manifest but no longer selected are removed.
# - Anything else in CLAUDE_DIR/skills or CLAUDE_DIR/agents (project-specific
#   skills and agents) is left alone; a selected item whose name collides with
#   one is an error.
# - The manifest is only rewritten when the synchronized content or selection
#   changes, so re-running against unchanged sources produces no changes even if
#   the source repository has newer, unrelated commits.
#
# Usage:
#   sync-claude-skills.sh SOURCE_DIR SOURCE_REPOSITORY SOURCE_COMMIT CONFIG_FILE CLAUDE_DIR MANIFEST_FILE

set -euo pipefail

fail() {
  echo "error: $*" >&2
  exit 1
}

if [ "$#" -ne 6 ]; then
  echo "usage: $0 SOURCE_DIR SOURCE_REPOSITORY SOURCE_COMMIT CONFIG_FILE CLAUDE_DIR MANIFEST_FILE" >&2
  exit 2
fi

source_dir=$1
source_repository=$2
source_commit=$3
config_file=$4
claude_dir=$5
manifest_file=$6

name_pattern='^[A-Za-z0-9][A-Za-z0-9._-]*$'

[ -d "$source_dir/claude" ] || fail "no claude directory in source checkout $source_dir"
[ -f "$config_file" ] || fail "selection file not found: $config_file"
[[ $source_repository =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || fail "invalid source repository: $source_repository"
[[ $source_commit =~ ^[0-9a-f]{40}$ ]] || fail "source commit must be a full 40-character SHA: $source_commit"

contains() {
  local needle=$1
  shift
  local item
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

# Items are "skill:<name>" or "agent:<name>".
source_path() {
  case "$1" in
    skill:*) echo "$source_dir/claude/skills/${1#skill:}" ;;
    agent:*) echo "$source_dir/claude/agents/${1#agent:}.md" ;;
  esac
}

dest_path() {
  case "$1" in
    skill:*) echo "$claude_dir/skills/${1#skill:}" ;;
    agent:*) echo "$claude_dir/agents/${1#agent:}.md" ;;
  esac
}

source_label() {
  case "$1" in
    skill:*) echo "claude/skills/${1#skill:}" ;;
    agent:*) echo "claude/agents/${1#agent:}.md" ;;
  esac
}

# Selected items, in config order. A bare name is a skill; "agent:<name>" is an agent.
selected=()
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%%#*}
  line=$(printf '%s' "$line" | tr -d '[:space:]')
  [ -z "$line" ] && continue
  case "$line" in
    agent:*) item=$line ;;
    *) item="skill:$line" ;;
  esac
  name=${item#*:}
  [[ $name =~ $name_pattern ]] || fail "invalid name in $config_file: $line"
  if [ "${#selected[@]}" -gt 0 ] && contains "$item" "${selected[@]}"; then
    fail "listed more than once in $config_file: $line"
  fi
  selected+=("$item")
done < "$config_file"

# Previously synchronized items and source, from the manifest.
previous=()
previous_source=""
if [ -f "$manifest_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      skill=* | agent=*)
        name=${line#*=}
        [[ $name =~ $name_pattern ]] || fail "invalid name in $manifest_file: $line"
        previous+=("${line%%=*}:$name")
        ;;
      source=*)
        previous_source=${line#source=}
        ;;
    esac
  done < "$manifest_file"
fi

# Validate everything before changing any files.
for item in ${selected[@]+"${selected[@]}"}; do
  src=$(source_path "$item")
  label=$(source_label "$item")
  case "$item" in
    skill:*)
      [ -d "$src" ] && [ ! -L "$src" ] || fail "skill not found in $source_repository: $label"
      [ -f "$src/SKILL.md" ] || fail "skill has no SKILL.md in $source_repository: $label"
      ;;
    agent:*)
      [ -f "$src" ] && [ ! -L "$src" ] || fail "agent not found in $source_repository: $label"
      ;;
  esac
  unexpected=$(find "$src" ! -type f ! -type d -print -quit)
  [ -z "$unexpected" ] || fail "$label contains a symlink or special file, which is not synchronized: ${unexpected#"$source_dir/"}"
  dest=$(dest_path "$item")
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ "${#previous[@]}" -eq 0 ] || ! contains "$item" "${previous[@]}"; then
      fail "$dest already exists and is not managed by this sync; rename or remove it, or deselect it"
    fi
  fi
done

changed=false
[ -f "$manifest_file" ] || changed=true
[ "$previous_source" = "$source_repository" ] || changed=true
sorted_selected=$(printf '%s\n' ${selected[@]+"${selected[@]}"} | sort)
sorted_previous=$(printf '%s\n' ${previous[@]+"${previous[@]}"} | sort)
[ "$sorted_selected" = "$sorted_previous" ] || changed=true

for item in ${previous[@]+"${previous[@]}"}; do
  if [ "${#selected[@]}" -eq 0 ] || ! contains "$item" "${selected[@]}"; then
    rm -rf -- "$(dest_path "$item")"
    echo "removed:   $item"
  fi
done

for item in ${selected[@]+"${selected[@]}"}; do
  src=$(source_path "$item")
  dest=$(dest_path "$item")
  if [ -e "$dest" ] && diff -r -q -- "$src" "$dest" > /dev/null; then
    echo "unchanged: $item"
    continue
  fi
  changed=true
  rm -rf -- "$dest"
  mkdir -p -- "$(dirname -- "$dest")"
  cp -R -- "$src" "$dest"
  echo "updated:   $item"
done

if [ "$changed" = true ]; then
  mkdir -p -- "$(dirname -- "$manifest_file")"
  {
    echo "# Managed by .github/workflows/sync-claude-skills.yml. Do not edit by hand."
    echo "source=$source_repository"
    echo "commit=$source_commit"
    for item in ${selected[@]+"${selected[@]}"}; do
      echo "${item%%:*}=${item#*:}"
    done
  } > "$manifest_file"
  echo "Synchronized ${#selected[@]} item(s) from $source_repository@$source_commit."
else
  echo "No changes: selected skills and agents already match $source_repository@$source_commit."
fi
