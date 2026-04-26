---
description: Plan
---

=======================================================
  KİŞİSEL DESKTOP MAIL UYGULAMASI — PROJE PLANI
=======================================================

PROJE ADI    : MailApp (ya da istediğin isim)
PLATFORM     : Windows Desktop
TEMA         : Koyu (Dark)
HEDEF        : Kişisel kullanım, Superhuman tarzı sade UI
DESTEKLENEN  : Gmail + Outlook / Hotmail

-------------------------------------------------------
TECH STACK
-------------------------------------------------------

FRAMEWORK    : Tauri v2 (Rust backend + WebView frontend)
FRONTEND     : React + TypeScript + Tailwind CSS + shadcn/ui
MAIL API     : Gmail REST API + Microsoft Graph API (Native HTTP API'ler)
STATE        : Zustand (hafif global state yönetimi)
ANIMASYON    : Framer Motion (akıcı geçişler için)
KLAVYE/UI    : react-hotkeys-hook (kısayollar) + cmdk (Command Palette)
STORAGE      : Rust tarafında rusqlite / sqlx (lokal mail cache)
OAUTH 2.0    : Rust tarafında lokal HTTP sunucusu veya Deep Linking ile callback yakalama
BUILD        : Tauri CLI + Vite

-------------------------------------------------------
KLASÖR YAPISI
-------------------------------------------------------

my-mail-app/
├── src-tauri/              → Rust backend
│   ├── src/
│   │   ├── main.rs         → Tauri uygulama giriş noktası
│   │   ├── auth.rs         → OAuth 2.0 Callback yakalama (Local HTTP server)
│   │   ├── gmail.rs        → Gmail REST API entegrasyonu
│   │   ├── outlook.rs      → Microsoft Graph API entegrasyonu
│   │   ├── db.rs           → rusqlite ile lokal cache işlemleri
│   │   └── commands.rs     → Frontend'e açılan Tauri komutları
│   └── tauri.conf.json     → Uygulama ayarları
│
├── src/                    → React frontend
│   ├── components/
│   │   ├── ui/             → shadcn/ui bileşenleri
│   │   ├── Sidebar.tsx     → Hesap ve klasör listesi
│   │   ├── MailList.tsx    → Mail listesi (sağ panel)
│   │   ├── MailDetail.tsx  → Açık mail görünümü
│   │   ├── Compose.tsx     → Mail yazma ekranı
│   │   └── CommandPalette.tsx → cmdk ile Superhuman tarzı komut menüsü
│   ├── hooks/
│   │   ├── useGmail.ts     → Gmail API hook'ları
│   │   └── useShortcuts.ts → react-hotkeys-hook yapılandırması
│   ├── store/
│   │   └── mailStore.ts    → Zustand global state
│   ├── pages/
│   │   ├── Inbox.tsx       → Ana ekran
│   │   └── Settings.tsx    → Hesap ayarları
│   └── App.tsx

-------------------------------------------------------
ARAYÜZ TASARIMI (Superhuman Tarzı Dark)
-------------------------------------------------------

LAYOUT       : 3 sütun — Sidebar | Mail Listesi | Mail Detay
RENK PALETİ :
  Arka plan    #0f0f0f (derin siyah)
  Panel        #1a1a1a
  Hover        #252525
  Accent       #4f8ef7 (mavi vurgu)
  Yazı         #e8e8e8 (açık gri)
  İkincil yazı #6b6b6b

FONT         : Inter (çok temiz, modern sans-serif)

ANIMASYONLAR :
  - Mail açılışı: slide-in (150ms ease-out)
  - Panel geçişi: fade (100ms)
  - Hover: scale 1.0 → 1.02 (80ms)
  - Bildirim: slide-down (200ms)

KİLAVYE KISAYOLLARI (react-hotkeys-hook ile) :
  Cmd/Ctrl + K → Komut Paleti (Arama, hızlı aksiyonlar)
  C → Yeni mail yaz
  E → Arşivle
  R → Yanıtla
  G + I → Inbox'a git
  / → Arama aç
  Esc → Kapat / Geri

-------------------------------------------------------
ÖZELLIKLER (MVP — İlk Sürüm)
-------------------------------------------------------

✅ Gmail OAuth 2.0 ile bağlantı (Lokal callback yakalama)
✅ Outlook OAuth 2.0 ile bağlantı
✅ Inbox görüntüleme (okundu/okunmadı)
✅ Mail okuma (HTML render)
✅ Mail yazma ve gönderme
✅ Yanıtla / Tümünü yanıtla / İlet
✅ Arşivle / Sil
✅ Arama (lokal cache üzerinden)
✅ Lokal SQLite cache (Rust backend ile yüksek performans)
✅ Bildirim (Windows native notification)
✅ Koyu tema

-------------------------------------------------------
ÖZELLIKLER (v2 — Sonraki Sürüm)
-------------------------------------------------------

⬜ Çoklu imza desteği
⬜ Taslak otomatik kaydetme
⬜ Etiket / klasör yönetimi
⬜ Snooze (ertele) özelliği
⬜ Thread görünümü
⬜ Hızlı filtreler (okunmamış, ekli, önemli)
⬜ Claude API ile AI mail özeti

-------------------------------------------------------
KURULUM ADIMLARI
-------------------------------------------------------

1. Rust kur → https://rustup.rs
2. Node.js 20+ kur → https://nodejs.org
3. Tauri CLI kur:
   npm install -g @tauri-apps/cli

4. Proje oluştur:
   npm create tauri-app@latest my-mail-app -- --manager npm --template react-ts

5. Bağımlılıkları kur:
   npm install zustand framer-motion react-hotkeys-hook cmdk
   npx shadcn@latest init
   npm install @tauri-apps/api

6. Rust bağımlılıkları (Cargo.toml):
   reqwest (HTTP istekleri için), rusqlite (DB), tokio, serde

7. Google Cloud Console'da proje aç:
   → Gmail API'yi aktifleştir
   → OAuth 2.0 Client ID oluştur (Desktop app)
   → client_id ve client_secret al

8. Microsoft Azure Portal'da uygulama kaydet:
   → Microsoft Graph API → Mail.Read, Mail.Send izinleri
   → client_id al

9. Geliştirme modunda çalıştır:
   npm run tauri dev

10. Windows için build al:
    npm run tauri build
    → Çıktı: src-tauri/target/release/bundle/

-------------------------------------------------------
TAHMİNİ SÜRE
-------------------------------------------------------

Kurulum + OAuth ayarları    : 1-2 gün
Temel arayüz (layout)       : 2-3 gün
Gmail entegrasyonu          : 2-3 gün
Outlook entegrasyonu        : 1-2 gün
Mail okuma/yazma            : 2-3 gün
Animasyon & polish          : 1-2 gün
-------------------------------------------
TOPLAM (MVP)                : ~2-3 hafta

-------------------------------------------------------
KAYNAKLAR
-------------------------------------------------------

Tauri Docs     → https://tauri.app/v2/guide/
Gmail API      → https://developers.google.com/gmail/api
Microsoft Graph→ https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview
Framer Motion  → https://www.framer.com/motion/
shadcn/ui      → https://ui.shadcn.com/
cmdk           → https://cmdk.paco.me/

=======================================================