# ⚡ 9Router 24/7 — Production Enterprise Server & Source Engine

Self-hosted deployment suite dan patch engine lengkap untuk **[9Router](https://9router.com)**:
- **Server Deployment**: Docker Compose, Native Systemd, dan Automated Process Supervisor.
- **Patched Source Engine**: Source code `patched-src/` teroptimasi untuk high-throughput AI API routing, tool calling rescue, multi-provider OAuth, dan bypass model limits.
- **Zero-Refusal Guardrail Patch**: Bypass limitasi filter Gemini / LLM internal (`BLOCK_NONE` mode).
- **Credentials Injector**: Sinkronisasi massal token & API keys (Grok CLI, TokenHarbor, Cloudflare AI, Ollama, dll.) langsung ke SQLite DB.
- **Auto-Healing & Backup**: Snapshot online-consistent SQLite database dan Cloudflare tunnel watchdog.

---

## 📂 Struktur Repositori

```text
├── Dockerfile              # Container Node 22 + Python3 + TTY script fix
├── docker-compose.yml      # Service docker 9Router 24/7
├── 9router.service         # Systemd unit daemon untuk Linux VPS
├── supervisor.py           # Watchdog supervisor, health monitor & CF tunnel
├── patch_safety.py         # Zero-Refusal safety filter patcher (Gemini BLOCK_NONE)
├── inject_credentials.py   # Token/Key batch injector ke SQLite data.sqlite
├── backup.sh               # Local database backup engine
├── patched-src/            # 🛠️ Patched internal sources (Open-SSE, Translators, OAuth)
│   ├── src/                # Core stores, services, handlers & models
│   ├── open-sse/           # Provider registry, transformers, stream converters
│   └── ...
├── BUILD_ID.txt            # Target build identifier (serenhope engine)
├── .env.example            # Template variabel lingkungan aman
└── README.md
```

---

## 🚀 Panduan Menjalankan

### Opsi 1: Docker Compose (Disarankan)

```bash
git clone https://github.com/zonesky-1/9router-server.git
cd 9router-server

cp .env.example .env
# Sesuaikan port atau token jika diperlukan

docker compose up -d --build
docker compose logs -f
```

Akses dashboard di: `http://<ip-server>:20128`

---

### Opsi 2: Standalone Linux VPS (Systemd)

1. Pasang dependensi:
   ```bash
   sudo apt update && sudo apt install -y python3 nodejs npm
   sudo npm install -g 9router
   ```

2. Jalankan Safety Patcher (Zero-Refusal):
   ```bash
   python3 patch_safety.py
   ```

3. Pasang Systemd Service:
   ```bash
   sudo cp supervisor.py /opt/9router-server/
   sudo cp 9router.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now 9router
   ```

---

## 🔑 Injeksi Kredensial Otomatis

Untuk memasukkan ratusan/ribuan akun dari harvest/farming ke database 9Router:
```bash
python3 inject_credentials.py grok_credentials.json
```
Mendukung auto-detect database baik di Docker (`/data/db/data.sqlite`), sistem Linux (`~/.config/9router/`), maupun custom path via `ROUTER_DATA`.

---

## 🛡️ Zero-Refusal Patching

Modul `patch_safety.py` secara otomatis mencari chunk instalasi 9Router dan mematikan guardrail konten berbahaya:
* Mengganti `threshold: "OFF"` menjadi `threshold: "BLOCK_NONE"`.
* Mengaktifkan client pass-through untuk `body.safetySettings`.

---

## 🔒 Catatan Keamanan
* File sensitif (`.env`, `data.sqlite`, log runtime, dan file backup `.tar.gz`) telah diproteksi di `.gitignore` agar tidak pernah ter-commit ke public/private repository.
