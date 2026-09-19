# Repile — Rencana Produk

Dokumen perencanaan SaaS **Repile**: otomasi triage support ticket untuk WordPress plugin companies & agencies.

> Status: fondasi arsitektur terkunci + diverifikasi (2026-09-19). Yang belum diputuskan ditandai **TODO**.

---

## 1. Ringkasan produk

**Repile** adalah produk SaaS berbayar yang mengotomasi triage tiket support:

1. Tiket masuk dari helpdesk (FreeScout dulu, lalu Freshdesk, Thrivedesk, konektor extensible).
2. Agent AI men-triage: apakah bug atau bukan, dan mencoba mereplikasi issue di sandbox WordPress.
3. Hasil triage di-add sebagai note di helpdesk — **setelah human approve (HITL default)**.
4. Konteks percakapan (thread triage) disimpan di Repile untuk audit dan follow-up.

**Domain:** [repile.io](https://repile.io)

**Target pelanggan:** WordPress plugin companies dan agencies yang menangani volume tiket plugin/SaaS WordPress.

**Model bisnis:** subscription bulanan **per seat**, harga flat. MVP: **$149/bulan** include SandyWP Plus (10 sandbox).

**Keputusan arsitektur (2026-09-19):** Repile = **bb di-deploy ke server, apa adanya.** Bukan produk baru di atas bb — produknya ADALAH hosted bb workspace: `apps/app` + `apps/server` + `apps/host-daemon` + `apps/cli`, **1 VPS = 1 workspace** (model `.getbb.app`). Orchestration/session/plugin infra = kerjaan bb. Semua customization (triage flow, HITL, botch mode, connector) = **custom plugins/skills** — pola yang sama dengan setup triage yang sudah jalan di bb lokal Riza, tinggal dipindah. Fork tipis hanya untuk: auth di depan + provisioning + branding.

---

## 2. Diferensiator

| Aspek | Pendekatan Repile |
| --- | --- |
| UI | Web app bb (Vite + React 19), browser-native — **tanpa** desktop Electron / macOS app |
| UX khas | Custom plugin **"botch mode"**: tampilan percakapan mirip Grok bot — via custom bb plugin, bukan fork patch |
| AI | Customer BYO provider AI — provider **auto-detect dari CLI** yang terinstall di VPS (claude/codex); Repile tidak jual token model |
| Replicate | Sandbox WordPress via **SandyWP** (MCP/REST) — bukan WP/Docker di VPS |
| Model produk | bb core minimal (fork tipis) + **plugins** untuk semua fitur Repile |
| Domain fokus | Triage + replicate untuk ekosistem WordPress plugin (bukan general helpdesk AI) |

**TODO:** detail visual/spesifikasi "botch mode" (warna, layout, tone).

---

## 3. Alur produk (happy path)

```
FreeScout (helpdesk)
        │  webhook / poll
        ▼
Repile plugin (connector) → normalize tiket
        │  bb.sdk.threads.create/send
        ▼
Thread triage — agent AI (claude/codex di VPS)
        │  klasifikasi: bug? bukan?
        │  kalau bug → replicate via SandyWP tools
        ▼
Draft note → REVIEW QUEUE (HITL)
        │  human approve / edit
        ▼
Post note ke tiket FreeScout + simpan konteks di DB plugin
```

### Langkah detail

1. **Ingest** — tiket baru/updated masuk via webhook plugin route (`/api/v1/plugins/<id>/http/...`, auth `"none"` + verifikasi signature/token FreeScout sendiri) atau cron poll.
2. **Normalize** — payload → model internal (ticket id, subject, body, attachments meta, customer, tags) → tabel `tickets` di SQLite plugin.
3. **Triage agent** — `bb.sdk.threads.create/send` membuat thread; plugin inject instructions (`bb.agents.contributeInstructions`) + tools (`bb.agents.registerTool`). Agent memutuskan bug vs non-bug + reasoning singkat.
4. **Replicate** — jika kandidat bug dan SandyWP connected: agent panggil tool `sandywp_*` → sandbox WP dibuat → plugin dideploy → repro dicoba → hasil: replicated / partial / tidak bisa + alasan.
5. **Write-back (HITL)** — draft note masuk `notes_outbox` status `pending` → tampil di review queue UI → human approve/edit → status `approved` → worker post ke FreeScout → `posted`.
6. **Persist** — thread + events + ticket rows di SQLite untuk riwayat/QA.

**Keputusan write-back:** HITL default di MVP. Setting per workspace untuk auto nanti (kandidat: auto untuk klasifikasi non-bug / confidence tinggi saja).

---

## 4. Arsitektur teknis

### Komponen (hasil audit `bb`, 2026-09-19)

| bb app | Keputusan | Peran di Repile |
| --- | --- | --- |
| `apps/app` | ✅ Ambil | Web client React 19 → `dist` statis. Browser-native: feature-detect `window.bbDesktop`, tanpa Electron API di bundle. |
| `apps/server` | ✅ Ambil | Hono + better-sqlite3/Drizzle. Serve app + `/api/v1/*` + WebSocket di satu port (`:38886`). |
| `apps/host-daemon` | ✅ Ambil | Spawn/manage provider AI (claude/codex CLI via node-pty/agent-runtime). Port `:38887`, enroll loopback ke server. |
| `apps/cli` | ✅ Ambil | `bb` CLI untuk admin/ops. |
| `apps/desktop` | ❌ Skip | Electron shell — tidak dibutuhkan di server. |
| `apps/mobile` | ❌ Skip | Expo app. |
| `apps/web` | ❌ Skip | Situs marketing getbb.app (TanStack Start), bukan produk. |
| `apps/connect` | ❌ Skip | Hosted tunnel (Cloudflare Worker) — Repile pakai reverse proxy sendiri. |
| `apps/demo-server` | ❌ Skip | Demo saja. |

`pnpm start` (`scripts/start-bb.mjs`) sudah web-only: hanya build bundled-plugins, plugin-sdk, app, server, host-daemon — desktop tidak disentuh.

### Batasan penting dari bb

- Ambil pola: server / daemon / thread / provider bridge / plugin UI.
- **Jangan** tarik dependency Electron API ke web client atau server. (Status audit: `apps/app` hanya `import type` dari `@bb/desktop-contract`; runtime pakai `window.bbDesktop` feature-detection.)
- Lisensi sumber bb: **MIT** — boleh dipakai; simpan notice di repo sumber.

### Strategi fork (keputusan 2026-09-20, final)

- Repo `bb/` = fork `rizaardiyanto1412/bb`, branch kerja **`repile`**. Snapshot penuh dari upstream. Remote upstream dihapus agar tidak ada merge tidak sengaja.
- **Tidak pernah sync upstream.** Semua issue di-fix sendiri. Kebijakan sadar, bukan kelalaian.
- **Bebas customize core.** Bukan cuma plugin.
- **CLI provider di-pin versinya** (`codex 0.155.1`, `claude-code 2.1.278`) agar tidak berubah di bawah kaki. Upgrade disengaja, bukan otomatis.
- Update file ini di `repo/docs/repile-plan.md` bila keputusan berubah. Salinan lokal di folder ini bisa tertinggal.

### Urutan develop (keputusan)

1. **Develop lokal di `bb/`** — branding pass (bb→repile) + struktur fork. Dev loop `pnpm dev` langsung keliatan.
2. **Provisioning** — script clone repo fork → `pnpm install && build` di VPS (atau build lokal, rsync `dist/`). Tidak perlu npm.
3. **npm publish** — opsional/nanti (`@repile/app` atau `repile-app`), saat ergonomi `npm i -g` penting. Catatan: official `bb-app@0.43.3` di npm sudah prebuilt penuh (app/server/daemon dist + bins) — referensi cara packaging mereka.

### Bentuk produk: plugin-first

Repile = deploy bb ke server → interface diakses via browser + auth → semua logika produk hidup di **custom bb plugins**. Fork/core seminimal mungkin (auth gateway + provisioning + branding).

Plugin Repile yang direncanakan:

| Plugin | Isi |
| --- | --- |
| `repile-connector-freescout` | Webhook route + poll, normalize tiket, write-back note, mapping status/tag |
| `repile-triage` | Dispatch thread per tiket, instructions triage, tools, HITL review queue UI |
| `repile-sandywp` | OAuth connect flow, simpan token, `registerTool` wrapper `sandywp_*` untuk agent |
| `repile-botch` | UI skin ala Grok bot |

### Audit Plugin SDK (2026-09-19) — SEMUA kebutuhan tercover

| Kebutuhan | API plugin | Keterangan |
| --- | --- | --- |
| Webhook masuk | `bb.http.route()` → `/api/v1/plugins/<id>/http/<path>` | auth `"none"` didesain untuk signature-verified webhooks; alternatif `"token"` (`bb plugin token <id>`) / `"local"` |
| Tabel produk | `bb.storage.database()` + `migrate()` | SQLite sendiri per plugin `<dataDir>/plugins/<id>/data.db`, better-sqlite3 WAL; migrate append-only by statement index |
| Config kecil | `bb.storage.kv` | JSON KV ≤256KB/value di bb.db |
| Cron + worker | `bb.background.schedule(name, cron, fn)` + `service(name, {start})` | cron durable (claim CAS `next_run_at`); service auto-restart backoff |
| Tiket → thread | `bb.sdk.threads.create` / `send` / `retry` / `list` | dispatch programmatic, `sendAt` untuk antre |
| Instruction + tool agent | `bb.agents.contributeInstructions` + `bb.agents.registerTool` | tool pakai zod schema; instructions ≤4096 char; per-session resolution; tool diproxy ke Claude/Codex via MCP bridge internal bb |
| Hook lifecycle | `bb.hooks` `message.dispatch` (admission checkpoint) + thread events (`message.queued/dispatched`, turn failed) | track hasil triage |
| UI surfaces | `app.slots.*` — nav panel/page (routing internal `subPath`), homepage section, thread panel actions | review queue = page/panel |
| Realtime ke UI | `bb.realtime.publish(channel, payload)` | ephemeral plugin-signal ke semua client |
| CLI ops | plugin CLI commands | `bb <plugin> ...` |
| Plugin RPC internal | `bb.rpc.register` typed contract | `/api/v1/plugins/<id>/rpc/<method>` auth local |

**Konsekuensi:** fork bb cuma perlu auth gateway + packaging/branding. Konektor, triage, HITL, botch mode = plugin.

### Single-tenant per VPS & provider AI

- **Model:** 1 VPS = 1 instance bb = 1 workspace. Isolasi antar customer = isolasi antar VPS.
- **Provider auto-detect (keputusan):** bb `provider-installation-gate` di host-daemon probe CLI provider di host (`provider.installation.status`, TTL 5 min). Install `claude`/`codex` CLI → detected → muncul `available: true`. Tidak ada config provider manual.
- **Verified:** instance test mendeteksi `claude-code`, `codex`, `pi`, `acp-cursor/opencode/omp/grok/hermes` semua `available: true` + capability metadata lengkap.
- **TODO:** auth CLI provider per workspace (login/API key) + provisioning-nya.

### Integrasi SandyWP (replication backend)

**Auth:** `Authorization: Bearer swp_...` — PAT atau scoped OAuth token.

- **OAuth LIVE di production** (verified 2026-09-19):
  - `/.well-known/oauth-authorization-server` → issuer `https://app.sandywp.com`
  - authorize: `https://app.sandywp.com/connect/authorize` (`authorization_code` + PKCE S256 wajib)
  - token: `https://app.sandywp.com/api/connect/token`
  - **dynamic registration:** `POST /api/connect/register` (RFC 7591)
  - `/.well-known/oauth-protected-resource` → resource `https://app.sandywp.com/mcp`
- Scoped token hanya boleh masuk `/mcp` + `/mcp/admin` + imports + `account/me` (deny-by-default di `enforceScopedTokenPath`). Tool MCP digate per-scope (`requireScope`).
- Scope yang perlu diminta Repile untuk loop replikasi: `sites:read sites:write sites:login deploy:write files:read files:write ssh:write php:write database:write` (opsional `templates:*`/`blueprints:*` untuk preset env).
- **MCP endpoint:** `https://app.sandywp.com/mcp` (Streamable HTTP). 401 tanpa auth.
- **Cara agent pakai:** Repile plugin `registerTool` wrap call SandyWP → **token swp_ tetap di server**, tidak masuk context agent. Alternatif: `.mcp.json` di workspace (provider-native, token di file).
- **Connectivity gating (keputusan):** workspace "Connect SandyWP" → OAuth → scoped token disimpan encrypted. Tidak connect = tidak bisa replicate (triage tetap jalan).
- **Billing:** bundle — $149 include SandyWP Plus (10 sandbox). **Repile auto-create akun SandyWP** saat provisioning workspace. TODO: overage >10 sandbox.
- **Tool SandyWP yang relevan replikasi:** `create_site` (WP 6.6–7.1 × PHP 7.4–8.5, multisite, debug preset + Query Monitor), `create_site_from_template`/`blueprint`, `deploy_plugin` (ZIP), `connect_repository`/`preview_github_pr`/`trigger_deployment`, `list_files`/`read_file`/`write_file`/`copy_path`/`move_path`/`delete_path`/`make_dir`, `database_access`, `issue_ephemeral_ssh_key`/`set_ssh_access`/`get_ssh` (WP-CLI via SSH), `read_debug_log`/`update_debug_options`, `switch_php_version`/`update_php_config`, `magic_login`, `reset_site`/`delete_site`/`restore_site`, `site_status`/`list_sites`, `search_plugins`.

### Integrasi helpdesk

| Konektor | Status |
| --- | --- |
| **FreeScout** | **MVP pertama (keputusan)** — dogfood ke tiket sendiri |
| Freshdesk | Berikutnya |
| Thrivedesk | Berikutnya |
| Lainnya | Extensible connector interface |

**TODO FreeScout:** verifikasi webhook module (atau polling API), API key auth (`X-FreeScout-API-Key`), endpoint note/thread post, mapping status/tag, rate limit & retry.

### Data model (sketsa)

Dengan model 1-VPS-1-workspace, tabel Repile tinggal di SQLite plugin per instance (`plugins/repile-*/data.db`). `tenants`/`seats` hanya relevan kalau nanti ada control plane pusat (billing/fleet).

- `tickets` (external id, subject, body, customer, tags, mirror ringkas)
- `notes_outbox` (draft note, status `pending → approved → posted`, thread ref)
- `triage_runs` (ticket → thread mapping, verdict, confidence)
- `sandywp_connection` (scoped token encrypted, account info)
- Thread + events: reuse schema bb.

**TODO:** skema final, retensi data, GDPR/export.

---

## 5. UI / UX

- **Stack UI:** bb app (Vite + React 19), TanStack Query, Tailwind.
- **Mode default:** dashboard tiket + detail thread triage + review queue (plugin page/panel).
- **Botch mode:** custom plugin — overlay/skin percakapan ala Grok bot.
- Responsive web; mobile browser cukup fase awal (app bb sudah mobile-aware).

Tanpa: Electron desktop app, macOS packaging, ketergantungan API Electron.

---

## 6. Deploy & operasi

**Topologi per VPS (keputusan):**

```
Internet → Cloudflare Access (auth) → Caddy (TLS) → :38886 bb server (app statis + /api/v1 + WS)
                                                    :38887 host-daemon (loopback only)
                                                    claude / codex CLI di PATH
                                                    BB_DATA_DIR → SQLite + plugin DBs + workspaces
```

- **⚠️ Risiko utama:** public API bb **tidak punya auth** — server warn: bind non-loopback = "unauthenticated, permits command execution and file reads". Wajib auth di depan.
- **Keputusan auth (2 fase):**
  - **Fase 0 (dogfood VPS):** Cloudflare Access (email OTP/Google) di depan subdomain per workspace. Zero kode, WS OK. Fallback: Caddy `basic_auth`.
  - **Fase 1 (produk):** Repile **auth gateway** — `better-auth` (sudah di deps `apps/server`) sebagai Hono shim: login + session + seat enforcement, proxy loopback ke bb server. Seat = user account per workspace.
- **Spek VPS:** 2 vCPU / 4 GB / 40–80 GB NVMe = sweet spot (2–4 sesi agent paralel; ~150–300 MB server, ~150–300 MB daemon, ~300–800 MB/sesi agent). Minimal 1 vCPU / 2 GB untuk 1 sesi.
- **Provider:** install Claude Code / Codex CLI; daemon auto-detect.
- **Env vars runtime:** `BB_DATA_DIR`, `BB_SERVER_PORT` (38886), `BB_HOST_DAEMON_PORT` (38887), `BB_SERVER_BIND_HOST` (127.0.0.1), `NODE_ENV=production`.
- **Build/run:** `NODE_ENV=production node --conditions=source --import tsx scripts/start-bb.mjs` (ensure-native-modules → turbo build 5 pkg → launcher start server+daemon). `--dryrun` untuk preflight saja.
- **Provisioning:** clone repo fork → build di VPS (atau rsync `dist/`). npm publish opsional nanti. Alternatif instan: official `bb-app` npm prebuilt.
- **Plugin install:** sources `builtin` (bundled), `npm`, `git`, `path`, marketplace. Repile plugins: repo terpisah, install via `git:`/`path:` saat provisioning.
- **TODO:** Docker Compose resmi (server + daemon + Caddy), provisioning script, healthcheck, backup `BB_DATA_DIR`, update path (server-move machinery bb sudah ada).

---

## 7. Lisensi & IP

| Lapisan | Kebijakan |
| --- | --- |
| Kode adaptasi get-bb/bb | MIT — patuhi syarat MIT; simpan notice di repo sumber |
| Produk Repile | Berbayar (subscription) |
| Distribusi | SaaS tidak distribusikan sumber → notice MIT tidak perlu di UI customer; simpan NOTICE di repo internal |

**TODO:** legal review singkat; NOTICE file; kebijakan brand "Repile".

---

## 8. Pricing

- **Model:** subscription **bulanan per seat**, flat.
- Bukan: pay-per-ticket, markup token AI (BYO key).

**Keputusan MVP:** satu harga **$149/bulan** include **SandyWP Plus (10 sandbox)** — auto-create akun SandyWP saat provisioning.

| Tier | Seat | Fitur | Harga / bulan |
| --- | --- | --- | --- |
| MVP | TODO | Triage + replicate (SandyWP Plus 10 sandbox) | **$149** |
| Growth | TODO | TODO | TODO |
| Agency | TODO | TODO | TODO |

**TODO:** jumlah seat di $149, annual discount, limit tiket/bulan (soft cap), onboarding fee, overage sandbox >10.

---

## 9. Target pasar & positioning

- **ICP:** tim support WordPress plugin (product companies) dan agencies yang manage banyak plugin/klien.
- **Pain:** tiket campur (how-to vs bug); engineer mahal untuk triage awal; konteks hilang antar tool.
- **Promise:** note triage + replicate otomatis di helpdesk yang sudah dipakai, BYO AI key, UI khas botch mode, sandbox WP beneran via SandyWP.

**TODO:** competitor map, messaging landing page.

---

## 10. Roadmap

| Fase | Isi | Status |
| --- | --- | --- |
| **Fase 0 (dev lokal)** | Branding pass bb→repile di `bb/`, struktur fork tipis, repo plugin `repile-*` skeleton | TODO |
| **Fase 0.5 (dogfood)** | Provisioning VPS pertama: clone+build fork, CF Access, claude/codex CLI, install plugins | PARTIAL 2026-09-19: VPS Debian 13 (2 vCPU/3 GB) live. `/opt/repile/bb` branch `repile` build 50/50 OK. `repile.service` systemd aktif, Caddy :80 + basic auth (user `riza`, password di `/root/.repile-basic-auth`), public tanpa auth = 401, dengan auth = 200 + `<title>Repile</title>`. Sisa: claude/codex CLI + API key, install plugins, Cloudflare Access ganti basic auth nanti |
- Domain LIVE 2026-09-20: `repile.rizamaulana.com` A record → VPS (via Erin). Caddy auto-TLS aktif, `https://repile.rizamaulana.com` tanpa auth = 401, dengan auth = 200 + `<title>Repile</title>`. Sertifikat valid.
- Deploy pipeline LIVE 2026-09-20: repo `rizaardiyanto1412/repile` (plugins + provisioning + workflow) push to main → Action SSH → `update.sh` (pull fork + build + reinstall plugins + restart). Deploy keys per repo aktif. Fork di `rizaardiyanto1412/bb` branch `repile`.
| **MVP** | Plugin connector FreeScout, triage bug/non-bug, HITL review queue, note write-back, SandyWP connect + replicate, $149 bundle | TODO |
| **v1** | Freshdesk + Thrivedesk connector, botch mode polish, auth gateway + multi-seat billing, auto-write-back setting | TODO |
| **v1.x** | Konektor tambahan, confidence gates, analytics triage | TODO |
| **v2** | Control plane fleet (ops multi-VPS, provisioning otomatis, billing terpusat), mobile PWA, CLI | TODO |

---

## 11. TODO terbuka (checklist)

### Keputusan sudah diambil ✅

- [x] Domain: **repile.io**
- [x] Arsitektur: ekstraksi web-only bb (app + server + host-daemon + cli)
- [x] Deploy: **1 VPS = 1 workspace** single-tenant
- [x] Replication backend: **SandyWP** (MCP/REST), gated on OAuth connection
- [x] Spek VPS: 2 vCPU / 4 GB / 40–80 GB NVMe
- [x] Auth: Fase 0 Cloudflare Access (fallback Caddy basic) → Fase 1 auth gateway better-auth + seats
- [x] Provider AI: **auto-detect CLI** (provider-installation-gate bb)
- [x] Produk logic: **custom bb plugins** (connector, triage+HITL, sandywp, botch)
- [x] Write-back: **HITL default** (approve queue) → auto nanti
- [x] Konektor MVP: **FreeScout** dulu
- [x] Harga MVP: **$149/bulan include SandyWP Plus 10 sandbox**, auto-create akun
- [x] Audit Plugin SDK: semua kebutuhan tercover (lihat §4)
- [x] Urutan develop: lokal dulu (branding+fork) → provisioning clone+build → npm publish nanti (opsional)
- [x] Upstream sync: remote upstream disimpan sebagai pintu darurat, sync hanya on demand via cherry-pick (revisi 2026-09-20, dulu per tag)

### Belum diputuskan / belum dikerjakan

- [ ] Jumlah seat di tier $149; tier Growth/Agency
- [ ] Overage sandbox >10
- [ ] Auto-provisioning akun SandyWP Plus (integrasi admin API SandyWP)
- [ ] FreeScout: webhook module vs polling; API key; mapping status/tag
- [ ] Auth CLI provider per workspace + provisioning credential
- [ ] Spesifikasi UI botch mode
- [ ] Subdomain & email operasional (app.repile.io, support@repile.io)
- [ ] Legal pass MIT + NOTICE file
- [ ] Nama npm package / Docker image registry
- [ ] Docker Compose + provisioning script VPS
- [ ] Plugin skeleton `repile-*` (structure, build via bb-plugin-build)
- [ ] Control plane fleet v2 (provisioning VPS per customer otomatis, billing)
- [ ] Roadmap tanggal & owner

### Risiko dari external review (Opus 5, @thread:thr_ynizdwep67) — catatan, bukan blocker

- **Prompt injection:** body tiket = input publik masuk ke agent dengan shell + tools. Mitigasi di level plugin: allowlist tools saja untuk triage session, wrap ticket text sebagai untrusted data, split classify→replicate. Di-handle saat bikin plugin triage.
- **BYO AI:** customer pakai API key, bukan login subscription (ToS consumer). Onboarding = "paste API key".
- **CF Access blokir webhook:** route `/api/v1/plugins/*/http/*` perlu bypass di Access policy; konfigurasi saat setup.
- **Unit economics $149:** hitung VPS + SandyWP Plus + ops sebelum publish; model per-seat vs volume tiket masih terbuka.
- **Replication rate:** belum terukur — ukur dari tiket historis saat dogfood.

---

## 12. Referensi teknis

- Repo sumber: `bb/` (checkout lokal [get-bb/bb](https://github.com/get-bb/bb), MIT) — versi `0.43.3`
- SandyWP codebase: `/Users/rizaardiyanto/Documents/SandyWP-Codex` (openapi.yaml + `src/lib/server/auth.ts` + `docs/mcp/`)
- Pola dipakai: Hono server, SQLite/Drizzle, host daemon, thread/events, provider bridges, plugin SDK, Vite+React 19
- Pola tidak dipakai: Electron desktop, macOS app, mobile, hosted Connect tunnel

### Catatan verifikasi (2026-09-19) — semua live-tested

- `pnpm install` sukses (99 workspace projects; Node 24, pnpm 9).
- `start-bb.mjs --dryrun` → turbo build **46/46 sukses** (app, server, host-daemon, plugin-sdk, bundled-plugins).
- **Full stack e2e:** `start-bb.mjs` di `BB_DATA_DIR=/tmp/repile-bb-test` `BB_SERVER_PORT=48986` `BB_HOST_DAEMON_PORT=48987` → server `200` app shell + assets + `/api/v1/system/version` JSON; daemon enroll → `GET /api/v1/hosts` → `"Mac mini" status: connected`; providers claude-code/codex/pi/acp `available: true`; bundled plugins loaded di `/api/v1/plugins`.
- `apps/app` → `dist` di-serve server di production; API same-origin (`window.location.origin`) → satu reverse proxy ke `:38886` cukup.
- Auth bb: `/internal/*` diproteksi daemon enrollment token; `/api/v1/*` tanpa auth → wajib proxy auth.
- SandyWP OAuth LIVE: discovery endpoints 200, `/api/connect/register` (RFC 7591), scopes lengkap, `/mcp` 401 unauthenticated.
- SandyWP ke agent: plugin `bb.agents.registerTool` diproxy via MCP bridge internal bb — token `swp_` tetap server-side.
- Plugin storage: `bb.storage.database()` = SQLite per plugin + `migrate()` append-only.
- Plugin routes: `bb.http.route` → `/api/v1/plugins/<id>/http/<path>` dengan auth `local|token|none`.
- Plugin install sources: `builtin`, `npm`, `git`, `path`, marketplace.

### File/line anchors penting di bb

- Launcher & resolve runtime: `packages/bb-app/src/launcher.ts` (`resolveBbAppStartContext` — ports/dataDir/dist paths)
- Server static app + warnings: `apps/server/src/start-server.ts` (`appDistDir`, security warning non-loopback)
- Daemon auth `/internal/*`: `apps/server/src/server.ts` (~line 607)
- Provider detection: `apps/host-daemon/src/provider-installation-gate.ts`
- Plugin SDK contract: `packages/plugin-sdk/src/backend-contract.ts` (http/storage/background/sdk threads/agents.registerTool)
- Plugin UI slots: `packages/plugin-sdk/src/app-contract.ts` (`app.slots.*`)
- Contoh plugin: `plugins/custom-instructions/server.ts` (`bb.agents.contributeInstructions`), `plugins/provider-claude-code/` (provider bridge + MCP bridge)

---

*Dokumen ini sumber kebenaran Repile. Update saat keputusan produk