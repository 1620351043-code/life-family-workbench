#!/usr/bin/env bash
# I-015 release rollback dry-run planner.
# This script validates a rollback pair and writes a plan; it never switches
# releases, restarts services, or deletes anything. Actual server execution
# remains a manual, audited operation after this contract succeeds.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly DRILL_CONFIRMATION='I_UNDERSTAND_THIS_PREPARES_RELEASE_ROLLBACK_DRILL'

die() {
  printf 'life-release-rollback: %s\n' "$*" >&2
  exit 1
}

required() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "$value" ]] || die "缺少 $name"
  printf '%s' "$value"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

if [[ "${LIFE_RELEASE_CONFIRM:-}" != "$DRILL_CONFIRMATION" ]]; then
  die "LIFE_RELEASE_CONFIRM 必须为 $DRILL_CONFIRMATION"
fi

dry_run="$(required LIFE_RELEASE_DRY_RUN)"
[[ "$dry_run" == 'YES' ]] || die 'LIFE_RELEASE_DRY_RUN 当前只能为 YES，暂不开放自动执行'
current_tag="$(required LIFE_RELEASE_CURRENT_TAG)"
previous_tag="$(required LIFE_RELEASE_PREVIOUS_TAG)"
worktree="$(required LIFE_RELEASE_WORKTREE)"
database_url="$(required LIFE_RELEASE_DATABASE_URL)"
plan_path="$(required LIFE_RELEASE_PLAN)"

[[ "$current_tag" != "$previous_tag" ]] || die '当前 Tag 与上一 Tag 不能相同'
[[ -d "$worktree" ]] || die "发布产物目录不存在：$worktree"
[[ -d "$worktree/$current_tag" ]] || die "当前版本发布目录不存在：$worktree/$current_tag"
[[ -d "$worktree/$previous_tag" ]] || die "上一版本发布目录不存在：$worktree/$previous_tag"
[[ -e "$plan_path" ]] && die "计划文件已存在，禁止覆盖：$plan_path"

require_command git
require_command psql
git show-ref --verify --quiet "refs/tags/$current_tag" || die "当前 Tag 不存在：$current_tag"
git show-ref --verify --quiet "refs/tags/$previous_tag" || die "上一 Tag 不存在：$previous_tag"
git merge-base --is-ancestor "$previous_tag" "$current_tag" || die '上一 Tag 必须是当前 Tag 的祖先'

current_commit="$(git rev-parse "$current_tag^{commit}")"
previous_commit="$(git rev-parse "$previous_tag^{commit}")"
current_migration="$(PGCONNECT_TIMEOUT=15 psql "$database_url" -X -v ON_ERROR_STOP=1 -Atqc \
  "SELECT filename FROM life_schema_migration ORDER BY applied_at DESC, filename DESC LIMIT 1" || true)"
plan_id="life-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf '{\n  "plan_id":"%s",\n  "created_at":"%s",\n  "dry_run":"YES",\n  "current_tag":"%s",\n  "current_commit":"%s",\n  "previous_tag":"%s",\n  "previous_commit":"%s",\n  "latest_migration":"%s"\n}\n' \
  "$plan_id" "$created_at" "$current_tag" "$current_commit" "$previous_tag" "$previous_commit" "$current_migration" >"$plan_path"
chmod 0600 "$plan_path"

printf 'life-release-rollback: dry-run passed plan=%s current=%s previous=%s\n' "$plan_path" "$current_tag" "$previous_tag"
