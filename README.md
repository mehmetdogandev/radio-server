# AksiyonSoft Radio Server

Yerel ağda (LAN) çalışan **sesli iletişim**, **mesajlaşma** ve **WebSocket** sunucusu. Şirketler ve geliştiriciler bu repoyu klonlayıp kendi donanımlarında (Raspberry Pi, Linux sunucu vb.) host edebilir; ardından kendi mobil veya web istemcilerini bağlayabilir.

> **Resmi mobil uygulama** ayrı bir **private** repodadır. APK indirmek için: [mehmetdogandev.com/radio-mobile-apk/release/](https://mehmetdogandev.com/radio-mobile-apk/release/)  
> Kendi istemcinizi yazmak için: [`docs/ISTEMCI_ENTEGRASYONU.md`](docs/ISTEMCI_ENTEGRASYONU.md)

## Özellikler

- HTTP REST API + WebSocket (`/ws`)
- UDP üzerinden ses (RTP / Opus) — `VOICE_RTP_PORT`
- mDNS ile keşif: `aksiyonsoft-radio-<id>.local`, servis `_radio._tcp`
- JWT ile oturum (secret yalnızca sunucuda; istemciler Bearer token kullanır)
- Raspberry Pi için tek komut kurulum: `sudo ./setup.sh`

## Hızlı kurulum (Raspberry Pi / Debian)

```bash
git clone https://github.com/mehmetdogandev/radio-server.git
cd radio-server
sudo ./setup.sh
```

`setup.sh` sırasıyla: Node 24 (nvm), Avahi mDNS, `.env` (JWT + portlar), `npm ci` + build, systemd, health watchdog, isteğe bağlı ufw kuralları.

Node zaten kuruluysa: `sudo ./setup.sh --skip-node`

Kurulum sonrası örnek adres:

```text
http://aksiyonsoft-radio-a1b2c3.local:8080/health
```

## Portlar

| Port / protokol | Değişken | Açıklama |
|-----------------|----------|----------|
| TCP (varsayılan 8080) | `PORT` | HTTP API, WebSocket |
| UDP (varsayılan 5004) | `VOICE_RTP_PORT` | Ses RTP |
| UDP 5353 | — | mDNS (Avahi); kurulumda ufw açılır |

Dinleme adresi: `HTTP_LISTEN_HOST=0.0.0.0` (LAN erişimi).

## JWT ve güvenlik

- `JWT_SECRET` yalnızca **sunucu** `.env` dosyasında tutulur; mobil veya web istemciye gömülmez.
- Kurulum (`scripts/02-env.sh`) geçerli bir secret yoksa `openssl rand -base64 48` üretir; **mevcut güçlü secret korunur** (yeniden kurulumda kullanıcı token’ları düşmez).
- İstemciler `POST /api/users/sync` ile Bearer token alır; API ve WS bu token ile çalışır.
- **Golden image** (aynı imajı çoğaltma): Kurulumdan **önce** `.env` içine kalıcı `JWT_SECRET` yazabilirsiniz; aksi halde her cihaz kendi secret’ına sahip olur (önerilen).

Play Store’daki resmi uygulama her evdeki Pi’ye ayrı bağlanır; tüm kullanıcıların tek bir global `JWT_SECRET` paylaşması gerekmez.

## Kurulum doğrulama (ürün hazır)

```bash
# Health
curl -sf http://127.0.0.1:8080/health | jq .ok

# Servisler
systemctl is-active radio-server radio-watchdog.timer avahi-daemon

# mDNS (isteğe bağlı)
avahi-browse -r _radio._tcp

# RTP UDP
ss -lunp | grep 5004
```

Loglar: `/var/log/radio/server.log`, watchdog: `/var/log/radio/watchdog.log`  
Durum: `systemctl status radio-server`

## Geliştirme (yerel makine)

```bash
cp .env.example .env
# JWT_SECRET en az 32 karakter; geliştirmede placeholder değiştirin
npm ci
npm run dev
```

Üretim çalıştırma: `npm run build` → `npm start` (`node dist/index.js`).

## Kalite kontrolü (CI)

Yerel (lint + typecheck + build):

```bash
npm ci
npm run ci
```

GitHub Actions: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — `push` / `pull_request` → `main` veya `master` dallarında çalışır. Deploy yok.

İsteğe bağlı: repo **Settings → Branches → Branch protection** altında `quality` işini zorunlu check yapın.

Sunucu bağımlılıkları **npm** ve `package-lock.json` ile yönetilir. Pi kurulumunda **pnpm** de corepack ile kurulur (isteğe bağlı araçlar için); `npm ci` değişmez.

## Script yapısı

| Dosya | Görev |
|-------|--------|
| [`setup.sh`](setup.sh) | Tüm adımları sırayla çalıştırır |
| [`scripts/01-node.sh`](scripts/01-node.sh) | nvm, Node 24, pnpm |
| [`scripts/06-mdns.sh`](scripts/06-mdns.sh) | Avahi, `aksiyonsoft-radio-*` |
| [`scripts/02-env.sh`](scripts/02-env.sh) | openssl, `.env`, JWT |
| [`scripts/03-deps-build.sh`](scripts/03-deps-build.sh) | `npm ci`, build |
| [`scripts/04-systemd.sh`](scripts/04-systemd.sh) | `radio-server.service` |
| [`scripts/05-watchdog.sh`](scripts/05-watchdog.sh) | 30 sn `/health` kontrolü |
| [`scripts/07-firewall.sh`](scripts/07-firewall.sh) | ufw TCP/UDP/mDNS |

Detaylı Pi notları: mobil repodaki [`docs/deployment.md`](../radio-mobile/docs/deployment.md) yalnızca istemci derlemesine odaklanır; sunucu kurulumu **bu README** tek kaynaktır.

## İlgili repolar

| Repo | Görünürlük | Açıklama |
|------|------------|----------|
| **radio-server** (bu repo) | Public | Sunucu |
| **radio-mobile** | Private | Resmi React Native uygulama |
| **radio-stress-test** | Public | Ses yük test botları |

## Sorun giderme

| Belirti | Olası çözüm |
|---------|-------------|
| Telefon cihazı bulamıyor | Pi ve telefon aynı Wi‑Fi; misafir ağ / AP isolation mDNS’i engelleyebilir |
| `health` başarısız | `journalctl -u radio-server -n 50` |
| RTP kayıt hatası | `npm run build` + `systemctl restart radio-server` |
| 8080 dinlemiyor | `ss -ltnp \| grep 8080` |

Ses / RTP ayrıntıları: [`docs/VOICE_RTP.md`](docs/VOICE_RTP.md)  
İstemci entegrasyonu: [`docs/ISTEMCI_ENTEGRASYONU.md`](docs/ISTEMCI_ENTEGRASYONU.md)

## Flutter

Bu projede **Flutter desteklenmez**. İstemci örnekleri React Native (resmi uygulama) veya kendi web/mobil istemciniz üzerinden [`ISTEMCI_ENTEGRASYONU.md`](docs/ISTEMCI_ENTEGRASYONU.md) ile yapılır.
