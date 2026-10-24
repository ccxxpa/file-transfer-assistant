#!/bin/sh
set -eu
umask 077

data_dir=${DATA_DIR:-/data}
app_uid=${PUID:-1000}
app_gid=${PGID:-1000}
for value in "$app_uid" "$app_gid"; do
  case "$value" in
    ''|*[!0-9]*) echo "PUID and PGID must be numeric." >&2; exit 1 ;;
  esac
done

mkdir -p "$data_dir" "$data_dir/files" "$data_dir/tmp"
if [ "$(id -u)" = "0" ]; then
  # Do not recursively traverse every attachment on each NAS startup.
  chown "$app_uid:$app_gid" "$data_dir" "$data_dir/files" "$data_dir/tmp"
  for file in "$data_dir/assistant.sqlite" "$data_dir/assistant.sqlite-wal" "$data_dir/assistant.sqlite-shm"; do
    if [ -f "$file" ]; then chown "$app_uid:$app_gid" "$file"; fi
  done
  exec su-exec "$app_uid:$app_gid" "$@"
fi
exec "$@"
