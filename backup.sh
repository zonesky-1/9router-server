#!/usr/bin/env bash
set -e

# Backup directory
BACKUP_DIR="${HOME}/9router-backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
TARGET_ZIP="${BACKUP_DIR}/9router_backup_${TIMESTAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

# Cari path data 9router
DATA_PATH=""
if [ -d "/data" ]; then
    DATA_PATH="/data"
elif [ -d "${HOME}/.config/9router" ]; then
    DATA_PATH="${HOME}/.config/9router"
elif [ -d "${HOME}/.9router" ]; then
    DATA_PATH="${HOME}/.9router"
fi

if [ -z "$DATA_PATH" ]; then
    echo "[-] Direktori database 9Router tidak ditemukan."
    exit 1
fi

echo "[*] Membuat backup 9Router dari ${DATA_PATH}..."
tar -czvf "$TARGET_ZIP" -C "$(dirname "$DATA_PATH")" "$(basename "$DATA_PATH")"

echo "[🎉] Backup selesai: $TARGET_ZIP"
ls -lh "$TARGET_ZIP"
