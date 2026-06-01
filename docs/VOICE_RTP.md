# Voice RTP (UDP) — istemci ve NAT notları

## Akış

1. `POST /api/voice-groups/:id/join` — grupta olma zorunluluğu.
2. `GET /api/voice-groups/:id/state` — `rtp.udpPort` sunucunun dinlediği UDP port.
3. İstemci yerel bir UDP soketi açar ve `POST /api/voice-groups/:id/rtp/register` ile `{ listenPort, clientHost? }` gönderir.
4. İstemci RX soketi, aynı soketten sunucu RTP portuna kısa bir UDP probe yollar (`seq=0`, boş payload).
5. Sunucu probe gördüğünde kullanıcı için gerçek geri-dönüş UDP kaynağını (NAT dış portu dahil) kısa süreli saklar.
6. `rtp/register` çağrısında probe varsa fanout hedefinde probe adres/portu tercih edilir; yoksa `normalizeRemoteAddress` + isteğe bağlı `clientHost` fallback kullanılır.
7. Opus paketleri `server/src/voice/opusPacketizer.ts` biçimindedir.

## Simülatör / Android emülatör

- **iOS Simulator**, API tabanı `http://127.0.0.1:8080` ise Flutter/RN istemcileri `clientHost` için `127.0.0.1` önerebilir.
- **Android Emulator**, API `http://10.0.2.2:8080` üzerinden host makineye gider; RTP için Flutter `ApiService.voiceRtpServerHost()` Android’de localhost’u `10.0.2.2` yapar.
- Sunucu URL tabanı **yalnızca host:port** olmalıdır (örn. `http://10.0.2.2:8080`); sona `/api` eklenmemelidir.

## Sunucu ortam değişkenleri

- `VOICE_NO_PACKET_SPEAKER_TIMEOUT_MS` (varsayılan **300000** = 5 dk): Aktif konuşmacı için RTP `lastPacketAt` bu süreden eskiyse kilit otomatik kalkar. **0** yazarsanız bu zaman aşımı kapatılır (yalnızca PTT kapatma / `leave`). Çok kısa değer (ör. 7000) sessizlikte yanlışlıkla kilidi düşürüp istemciyi “kilit reddi” durumuna sokabilir.
- `VOICE_LOCK_TTL_MS` (varsayılan **60000**): `voice_speaker_locks` satırının ömrü; RTP ile periyodik yenileme olmadan eski **12 sn** değeri uzun PTT’de kilidi düşürüyordu.
- `VOICE_LOCK_RTP_RENEW_MS` (varsayılan **4000**): Geçerli konuşmacıdan gelen RTP ile kilit `expiresAt` en az bu aralıkta bir kez uzatılır (DB yazımı sınırlı).

## Hata ayıklama

- RTP kayıt logları: sunucuda `VOICE_RTP_LOG_REGISTER=1` ile `/rtp/register` çağrıları konsola yazılır.
- Deploy parity kontrolü: `GET /health` yanıtında `service`, `version`, `gitSha`, `features.voiceRtpRegister` alanlarını doğrulayın.
- Register hata kodları:
  - `401`: token/yetki sorunu
  - `403`: kullanıcı voice gruba dahil değil
  - `400`: geçersiz `listenPort`, geçersiz `voiceGroupId` veya çözümlenemeyen istemci adresi
- Android Emulator odaklı hızlı kontrol:
  1. Join çağrısının başarılı döndüğünü doğrula (`/join`).
  2. `/rtp/register` yanıtında HTTP status + `error` alanını kontrol et.
  3. Sunucu logunda `[voice:rtp:register]` satırındaki `reason`, `remoteAddress`, `candidateHost` alanlarını karşılaştır.
