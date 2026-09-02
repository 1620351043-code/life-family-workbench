#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly RESTORE_CONFIRMATION='I_UNDERSTAND_THIS_RESTORES_ENCRYPTED_POSTGRES_BACKUP'
readonly BACKUP_ALLOWED_TABLE='^[a-z_][a-z0-9_]*$'

die() {
  printf 'life-postgres-restore: %s\n' "$*" >&2
  exit 1
}

required() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "$value" ]] || die "缺少 $name"
  printf '%s' "$value"
}

require_private_file() {
  local path="$1"
  [[ -f "$path" && -r "$path" ]] || die "私有文件不可读：$path"
  local mode
  mode="$(stat -c '%a' "$path")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "无法识别私有文件权限：$path"
  (( (8#$mode & 077) == 0 )) || die "私有文件不能对 group/other 开放：$path"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

if [[ "${LIFE_RESTORE_CONFIRM:-}" != "$RESTORE_CONFIRMATION" ]]; then
  die "LIFE_RESTORE_CONFIRM 必须为 $RESTORE_CONFIRMATION"
fi

artifact="$(required LIFE_RESTORE_ARTIFACT)"
sha_file="${LIFE_RESTORE_SHA256_FILE:-${artifact}.sha256}"
passphrase_file="$(required LIFE_RESTORE_PASSPHRASE_FILE)"
gpg_home="$(required LIFE_RESTORE_GNUPG_HOME)"
database_url="$(required LIFE_RESTORE_DATABASE_URL)"
target_db="$(required LIFE_RESTORE_TARGET_DB)"
allow_replace="${LIFE_RESTORE_ALLOW_REPLACE:-NO}"

[[ "$artifact" == *.tar.gz.gpg ]] || die 'LIFE_RESTORE_ARTIFACT 必须是 *.tar.gz.gpg 加密归档'
[[ -f "$artifact" && -r "$artifact" ]] || die "备份归档不可读：$artifact"
[[ "$target_db" =~ ^life_restore[0-9a-z_-]*$ ]] || die 'LIFE_RESTORE_TARGET_DB 必须以 life_restore 开头，禁止指向生产数据库'
[[ "$allow_replace" == 'NO' || "$allow_replace" == 'YES' ]] || die 'LIFE_RESTORE_ALLOW_REPLACE 只能为 NO 或 YES'
require_private_file "$passphrase_file"
require_private_file "$sha_file"
require_command gpg
require_command tar
require_command sha256sum
require_command pg_restore
require_command psql

work_dir="$(mktemp -d /tmp/life-postgres-restore.XXXXXX)"
cleanup() {
  local status=$?
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
  exit "$status"
}
trap cleanup EXIT
chmod 0700 "$work_dir"

expected_sha="$(awk 'NR == 1 { print $1 }' "$sha_file")"
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || die "备份 SHA-256 文件格式无效：$sha_file"
actual_sha="$(sha256sum "$artifact" | awk '{print $1}')"
[[ "$actual_sha" == "$expected_sha" ]] || die "备份归档 SHA-256 校验失败"

archive="$work_dir/restore.tar.gz"
gpg --batch --yes --homedir "$gpg_home" --pinentry-mode loopback --passphrase-file "$passphrase_file" \
  --decrypt --output "$archive" "$artifact"

entries="$(tar -tzf "$archive" | sort)"
expected_entries="database.dump
integrity.tsv
manifest.json"
[[ "$entries" == "$expected_entries" ]] || die "恢复包包含非预期条目：$entries"
tar -xzf "$archive" -C "$work_dir" database.dump integrity.tsv manifest.json
dump="$work_dir/database.dump"
integrity="$work_dir/integrity.tsv"
manifest="$work_dir/manifest.json"
[[ -s "$dump" && -s "$manifest" ]] || die '恢复包缺少 database.dump 或 manifest.json'
grep -q '"format":"pg_dump_custom"' "$manifest" || die 'manifest 不是 pg_dump_custom 备份'
pg_restore --list "$dump" >/dev/null

current_db="$(PGCONNECT_TIMEOUT=15 psql "$database_url" -X -v ON_ERROR_STOP=1 -Atqc 'SELECT current_database()')"
[[ "$current_db" == "$target_db" ]] || die "目标数据库身份不符：预期 $target_db，实际 $current_db"

if [[ "$allow_replace" != 'YES' ]]; then
  existing_tables="$(PGCONNECT_TIMEOUT=15 psql "$database_url" -X -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
  [[ "$existing_tables" == '0' ]] || die '目标数据库包含表；如需覆盖恢复请显式设置 LIFE_RESTORE_ALLOW_REPLACE=YES'
fi

pg_restore --dbname="$database_url" --no-owner --no-acl --clean --if-exists --exit-on-error "$dump"

checked=0
while IFS=$'\t' read -r table_name expected_count; do
  [[ "$table_name" == 'table' && "$expected_count" == 'count' ]] && continue
  [[ "$table_name" =~ $BACKUP_ALLOWED_TABLE ]] || die "integrity.tsv 包含非法表名：$table_name"
  [[ "$expected_count" =~ ^[0-9]+$ ]] || die "integrity.tsv 计数非法：$table_name"
  actual_count="$(PGCONNECT_TIMEOUT=15 psql "$database_url" -X -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM public.\"$table_name\"")"
  [[ "$actual_count" == "$expected_count" ]] || die "恢复计数不一致：$table_name 预期 $expected_count 实际 $actual_count"
  checked=$((checked + 1))
done < <(sed '1d' "$integrity")

[[ "$checked" -gt 0 ]] || die '没有校验任何核心表计数'
printf 'life-postgres-restore: success target_db=%s verified_tables=%s\n' "$target_db" "$checked"
