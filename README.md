# AksiyonSoft Radio Server

Yerel ağda (LAN) çalışan **sesli iletişim**, **mesajlaşma** ve **WebSocket** sunucusu. Şirketler ve geliştiriciler bu repoyu klonlayıp kendi donanımlarında (Raspberry Pi, Linux sunucu vb.) host edebilir; ardından kendi mobil veya web istemcilerini bağlayabilir.

> **Resmi mobil uygulama** ayrı bir **private** repodadır. APK indirmek için: [aksiyonsoft.com/radio-mobile/android/release/](https://aksiyonsoft.com/radio-mobile/android/release/)  
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

Kurulum scripti her zaman **production** modunda çalışır.

Doğrudan `setup.sh` yazmak `PATH` içinde olmadığı için çalışmaz. Doğru kullanım:
- `sudo ./setup.sh`
- veya `sudo bash setup.sh`

`setup.sh` sırasıyla: Node 24 (nvm), Avahi mDNS, `.env` (JWT + portlar), `npm ci` + build, systemd, health watchdog, isteğe bağlı ufw kuralları.

Node zaten kuruluysa: `sudo ./setup.sh --skip-node`

## Platform desteği

| Platform | Durum | Not |
|---|---|---|
| Raspberry Pi OS Lite (Debian) | Destekli | Üretim için önerilen kurulum |
| Ubuntu Server (22/24+) | Destekli | Üretim için destekli |
| WSL2 + Ubuntu + systemd açık | Sınırlı destek | Test/dev için kullanılabilir; üretim önerilmez |
| WSL2 + systemd kapalı | Destek dışı | systemd/mDNS/watchdog akışı tamamlanamaz |

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

`PORT=80` kullanmak isterseniz desteklenir. Systemd unit düşük port bind capability ile ayarlanır.

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

# Status (runtime + host + udp/mdns)
curl -sf http://127.0.0.1:8080/status | jq .ok

# Servisler
systemctl is-active radio-server radio-watchdog.timer avahi-daemon

# mDNS (isteğe bağlı)
avahi-browse -r _radio._tcp

# RTP UDP
ss -lunp | grep 5004
```

Loglar: `/var/log/radio/log.txt`, watchdog: `/var/log/radio/watchdog.log`  
Durum: `systemctl status radio-server`

## Kurulum sonrası dış test (zorunlu öneri)

Bu testler **Pi/Ubuntu sunucu cihazında degil**, ayni LAN'daki veya dis agdaki **kendi bilgisayarinizda** calistirilir.

Test reposu: [github.com/mehmetdogandev/radio-stress-test](https://github.com/mehmetdogandev/radio-stress-test)

Ornek akış:

```bash
git clone https://github.com/mehmetdogandev/radio-stress-test.git
cd radio-stress-test
npm ci
npm run test:network
npm run test:voice-load -- --listeners 20 --duration-min 10 --status-interval-sec 5
```

Komutlar:
- `test:network`: mDNS `_radio._tcp` kesfi (`aksiyonsoft` filtre), `/health`, `/status`, TCP/UDP probe
- `test:voice-load`: 1 konusmaci + 20-30 dinleyici senaryosu, test boyunca `/status` sicaklik/memory/UDP metrikleri

Raporlar `radio-stress-test/reports/` altina JSON olarak yazilir.

### Ag degisimi senaryosu (B agi -> C agi)

Mobilde farkli aglara geciste mDNS tekrar kesfini dogrulamak icin:

1. Bilgisayarda B agina bagli iken `npm run test:network` calistirip mDNS sonuclarini al.
2. Bilgisayari C agina gecir.
3. Ayni komutu tekrar calistir ve "Ag degisimi karsilastirma modu"nu `E` sec.
4. Rapor ciktisinda `appeared/disappeared` cihazlari incele.
5. Yeni agdaki hedef cihazin `/status` cevabinda `network.mdnsHostname` ve `voiceRtpUdpListening=true` oldugunu dogrula.

## Log temizleme politikası (zaman bağımsız)

- Uygulama log hedefi: `/var/log/radio/log.txt`
- Dosya boyutu `1GB` eşiğini geçtiğinde otomatik prune çalışır.
- Prune işlemi tarih/saat kullanmaz (RTC saat kaymaları etkisizdir).
- Her prune döngüsünde dosyanın en eski `%2` satırı silinir, en yeni `%98` korunur.
- Zamanlayıcı: `radio-log-prune.timer` (2 dakikada bir)

Doğrulama komutları:

```bash
stat -c%s /var/log/radio/log.txt
wc -l /var/log/radio/log.txt
systemctl status radio-log-prune.timer --no-pager
journalctl -u radio-log-prune.service -n 50 --no-pager
```

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
| [`scripts/08-verify.sh`](scripts/08-verify.sh) | kurulum sonu katı doğrulama |
| [`scripts/09-log-prune.sh`](scripts/09-log-prune.sh) | 1GB üstünde log.txt dosyasının en eski %2 satırını temizler |

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

## Reboot ve dayanıklılık runbook

Kurulumdan sonra servislerin aç-kapa/reboot sonrası toparlanmasını test edin:

1. `sudo ./setup.sh`
2. `curl -sf http://127.0.0.1:${PORT:-8080}/health`
3. `curl -sf http://127.0.0.1:${PORT:-8080}/status`
4. `systemctl is-active radio-server radio-watchdog.timer avahi-daemon`
5. `sudo reboot`
6. Cihaz açılınca tekrar bağlanın:
   - `systemctl status radio-server --no-pager`
   - `curl -sf http://127.0.0.1:${PORT:-8080}/status`
   - `avahi-browse -r _radio._tcp`
7. Ağdan test:
   - `http://<mdns-host>.local:${PORT:-8080}/status`
8. Stres testi:
   - Gün içinde çoklu reboot/power-cycle sonrası `journalctl -u radio-server -u radio-watchdog.timer -u radio-log-prune.timer` kontrolü
9. Prune testi:
   - `sudo systemctl start radio-log-prune.service`
   - `stat -c%s /var/log/radio/log.txt` ve `wc -l /var/log/radio/log.txt` ile değişimi doğrulayın

UDP/TCP hızlı doğrulama:

```bash
ss -ltnup | grep -E '(:80|:8080|:5004|:5353)'
```

Ses / RTP ayrıntıları: [`docs/VOICE_RTP.md`](docs/VOICE_RTP.md)  
İstemci entegrasyonu: [`docs/ISTEMCI_ENTEGRASYONU.md`](docs/ISTEMCI_ENTEGRASYONU.md)

## Flutter

Bu projede **Flutter desteklenmez**. İstemci örnekleri React Native (resmi uygulama) veya kendi web/mobil istemciniz üzerinden [`ISTEMCI_ENTEGRASYONU.md`](docs/ISTEMCI_ENTEGRASYONU.md) ile yapılır.
