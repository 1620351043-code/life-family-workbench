#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly BACKUP_CONFIRMATION='I_UNDERSTAND_THIS_CREATES_ENCRYPTED_POSTGRES_BACKUPS'

die() {
  printf 'life-postgres-backup: %s\n' "$*" >&2
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

safe_backup_root() {
  case "$1" in
    /var/backups/life/*/postgres) ;;
    *) die "LIFE_BACKUP_ROOT 必须是 /var/backups/life/<environment>/postgres" ;;
  esac
}

safe_remote_root() {
  [[ "$1" =~ ^[^:]+:[^/]+/.+ ]] || die 'LIFE_BACKUP_RCLONE_REMOTE 必须是专用 rclone bucket/prefix，例如 life-cos:life-backups/staging/postgres'
}

positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] || die "保留天数必须为正整数：$1"
}

if [[ "${LIFE_BACKUP_CONFIRM:-}" != "$BACKUP_CONFIRMATION" ]]; then
  die "LIFE_BACKUP_CONFIRM 必须为 $BACKUP_CONFIRMATION"
fi

database_url="$(required DATABASE_URL)"
backup_root="$(required LIFE_BACKUP_ROOT)"
remote_root="$(required LIFE_BACKUP_RCLONE_REMOTE)"
passphrase_file="$(required LIFE_BACKUP_GPG_PASSPHRASE_FILE)"
gpg_home="$(required LIFE_BACKUP_GNUPG_HOME)"
local_retention_days="${LIFE_BACKUP_LOCAL_RETENTION_DAYS:-7}"
remote_retention_days="${LIFE_BACKUP_REMOTE_RETENTION_DAYS:-35}"
prune_remote="${LIFE_BACKUP_PRUNE_REMOTE:-false}"

safe_backup_root "$backup_root"
safe_remote_root "$remote_root"
positive_integer "$local_retention_days"
positive_integer "$remote_retention_days"
[[ "$prune_remote" == 'true' || "$prune_remote" == 'false' ]] || die 'LIFE_BACKUP_PRUNE_REMOTE 只能为 true 或 false'
require_private_file "$passphrase_file"
for command in pg_dump pg_restore psql gpg tar sha256sum flock rclone hostname; do require_command "$command"; done

mkdir -p "$backup_root" "$gpg_home"
chmod 0700 "$backup_root" "$gpg_home"

lock_file="$backup_root/.backup.lock"
exec 9>"$lock_file"
flock -n 9 || die '已有 PostgreSQL 备份正在执行'

work_dir=''
cleanup() {
  local status=$?
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
  exit "$status"
}
trap cleanup EXIT

backup_id="staging-postgres-$(date -u +%Y%m%dT%H%M%SZ)-$(hostname -s | tr -cd '[:alnum:]-')"
artifact_name="$backup_id.tar.gz.gpg"
artifact_dir="$backup_root/$backup_id"
remote_artifact_dir="${remote_root%/}/$backup_id"
work_dir="$(mktemp -d "$backup_root/.inflight.XXXXXX")"
raw_dump="$work_dir/database.dump"
integrity="$work_dir/integrity.tsv"
manifest="$work_dir/manifest.json"
package="$work_dir/$backup_id.tar.gz"
encrypted_artifact="$work_dir/$artifact_name"

PGCONNECT_TIMEOUT=15 pg_dump --dbname="$database_url" --format=custom --no-owner --no-acl --file="$raw_dump"
pg_restore --list "$raw_dump" >/dev/null

{
  printf 'table\tcount\n'
  for table_name in household app_user ledger_transaction source_record import_row finance_audit_log; do
    table_count="$(PGCONNECT_TIMEOUT=15 psql "$database_url" -X -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM public.${table_name}")"
    [[ "$table_count" =~ ^[0-9]+$ ]] || die "无法获取表计数：$table_name"
    printf '%s\t%s\n' "$table_name" "$table_count"
  done
} >"$integrity"

raw_dump_sha256="$(sha256sum "$raw_dump" | awk '{print $1}')"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
pg_dump_version="$(pg_dump --version | tr -d '\r')"
printf '{"backup_id":"%s","created_at":"%s","format":"pg_dump_custom","database_dump_sha256":"%s","pg_dump_version":"%s"}\n' \
  "$backup_id" "$created_at" "$raw_dump_sha256" "$pg_dump_version" >"$manifest"

tar --create --gzip --file="$package" -C "$work_dir" database.dump integrity.tsv manifest.json
gpg --batch --yes --homedir "$gpg_home" --pinentry-mode loopback --passphrase-file "$passphrase_file" \
  --symmetric --cipher-algo AES256 --output "$encrypted_artifact" "$package"

rm -f -- "$raw_dump" "$integrity" "$manifest" "$package"
printf '%s  %s\n' "$(sha256sum "$encrypted_artifact" | awk '{print $1}')" "$artifact_name" >"$work_dir/$artifact_name.sha256"

[[ ! -e "$artifact_dir" ]] || die "备份目录已存在：$artifact_dir"
mv "$work_dir" "$artifact_dir"
work_dir=''

rclone copy --checksum "$artifact_dir" "$remote_artifact_dir"
rclone check --checksum "$artifact_dir" "$remote_artifact_dir"
printf 'remote_verified_at=%s\nremote_path=%s\n' "$created_at" "$remote_artifact_dir" >"$artifact_dir/remote-verified.txt"

while IFS= read -r -d '' expired_dir; do
  [[ "$expired_dir" == "$backup_root"/staging-postgres-* ]] || die "拒绝删除非 Life 备份目录：$expired_dir"
  rm -rf -- "$expired_dir"
done < <(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name 'staging-postgres-*' -mtime "+$local_retention_days" -print0)

if [[ "$prune_remote" == 'true' ]]; then
  rclone delete --min-age "${remote_retention_days}d" --include 'staging-postgres-*/**' "$remote_root"
  rclone rmdirs --leave-root "$remote_root"
fi

printf 'life-postgres-backup: success backup_id=%s local=%s remote=%s\n' "$backup_id" "$artifact_dir" "$remote_artifact_dir"
