# İstemci entegrasyonu (mobil / web)

Bu belge, **radio-server** ile kendi mobil veya web uygulamanızı nasıl konuşturacağınızı özetler. Resmi React Native uygulaması private repodadır; davranış olarak uyumlu bir istemci yazmak için bu akış yeterlidir.

## 1. Sunucuyu bulma (mDNS)

Kurulum sonrası sunucu Avahi ile yayınlanır:

| Alan | Değer |
|------|--------|
| Servis tipi | `_radio._tcp` |
| Host adı | `aksiyonsoft-radio-<6hex>` (ör. `aksiyonsoft-radio-a1b2c3`) |
| Tam ad | `<host>.local` |
| HTTP tabanı | `http://<host>.local:<PORT>` |

İsim filtresi: host veya servis adında **`aksiyonsoft`** geçmeli (resmi uygulama ile aynı).

Örnek keşif (Linux):

```bash
avahi-browse -r _radio._tcp
```

Mobil (iOS/Android): Bonjour / DNS-SD (`NSBonjourServices` / `react-native-zeroconf` vb.).

> **HTTPS:** LAN kurulumunda sunucu HTTP dinler. İstemci `http://….local:8080` kullanmalıdır; `https://` TLS hatası verir.

## 2. Sağlık kontrolü

```http
GET /health
```

Örnek yanıt alanları:

```json
{
  "ok": true,
  "service": "radio-server",
  "port": 8080,
  "voiceRtpPort": 5004,
  "mdnsHostname": "aksiyonsoft-radio-a1b2c3",
  "httpBaseUrl": "http://aksiyonsoft-radio-a1b2c3.local:8080",
  "features": {
    "voiceRtpRegister": true,
    "voiceRtpUdp": true
  }
}
```

Keşiften sonra istemci önce `GET {baseUrl}/health` ile `ok: true` doğrulamalıdır.

## 3. Kullanıcı senkronu ve JWT

Sunucu `JWT_SECRET` ile token imzalar; secret **istemcide tutulmaz**.

```http
POST /api/users/sync
Content-Type: application/json

{
  "name": "Ali",
  "email": "ali@example.com",
  "password": "plain-text-or-use-passwordHash-legacy",
  "role": "user"
}
```

Başarılı yanıt:

```json
{
  "token": "<JWT Bearer>",
  "user": { "id": 1, "name": "...", "email": "...", "role": "user" }
}
```

Sonraki istekler:

```http
Authorization: Bearer <token>
```

Örnek (curl):

```bash
BASE="http://aksiyonsoft-radio-a1b2c3.local:8080"
curl -sf "$BASE/health"
curl -sf -X POST "$BASE/api/users/sync" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","email":"t@example.com","password":"secret","role":"user"}'
```

## 4. WebSocket

```text
ws://<host>.local:<PORT>/ws?token=<JWT>
```

Token query parametresi veya sunucunun desteklediği diğer auth yollarına uygun olun.

## 5. REST API özeti

Tüm korumalı uçlar `Authorization: Bearer` gerektirir (sync hariç, rate limit uygulanır).

Tipik akış:

1. `GET /health`
2. `POST /api/users/sync` → token sakla
3. Sohbet / grup / mesaj API’leri (`/api/...`)
4. Ses için grup join + RTP kayıt (aşağı)

Ayrıntılı uç listesi için sunucu kaynak koduna (`src/index.ts`) ve resmi mobil `docs/api.md` (private) bakın.

## 6. Ses (RTP / UDP)

| Adım | Uç / işlem |
|------|------------|
| Gruba katıl | `POST /api/voice-groups/:id/join` |
| Durum | `GET /api/voice-groups/:id/state` → `rtp.udpPort` (sunucu UDP portu) |
| İstemci dinleme portu kaydı | `POST /api/voice-groups/:id/rtp/register` — `{ listenPort, clientHost? }` |
| Kontrol olayları (isteğe bağlı) | SSE `GET /api/voice/events?token=...` |

Sunucu UDP’yi `VOICE_RTP_PORT` (varsayılan **5004**) üzerinde dinler. Paket formatı ve NAT notları: [`VOICE_RTP.md`](VOICE_RTP.md).

## 7. Web istemci notları

- **CORS:** `CORS_ORIGINS` sunucu `.env` içinde; Pi kurulumunda `http://<MDNS_HOSTNAME>.local:<PORT>` otomatik yazılır. Geliştirmede `*` kullanılabilir (`.env.example`).
- **Cleartext:** Tarayıcıdan LAN HTTP için mixed content / güvenlik politikalarınızı yapılandırın.
- **WebSocket:** Aynı host/port; `ws://` şeması.

## 8. Mobil istemci notları (React Native örneği)

- Release’te sunucu URL’si **mDNS** ile `http://<hostname>.local:<port>` olarak doldurulur; sabit `192.168.x.x` gerekmez.
- Android/iOS cleartext: `*.local` ve geliştirme localhost’ları native allowlist’te tanımlıdır.
- Emülatör: Android’de host makine `10.0.2.2`; iOS simülatörde `127.0.0.1`.

Resmi APK: [mehmetdogandev.com/radio-mobile-apk/release/](https://mehmetdogandev.com/radio-mobile-apk/release/)

## 9. Minimal istemci pseudocode

```javascript
async function connectRadio() {
  const baseUrl = await discoverMdns('_radio._tcp', 'aksiyonsoft');
  const health = await fetch(`${baseUrl}/health`);
  if (!(await health.json()).ok) throw new Error('health failed');

  const sync = await fetch(`${baseUrl}/api/users/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password, role: 'user' }),
  });
  const { token } = await sync.json();

  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws?token=${token}`);
  // ... REST with Authorization: Bearer ${token}
}
```

## 10. Yük testi

Public repo **radio-stress-test**: sunucuya çoklu bot ile ses yükü. `.env` dosyası zorunlu değil; `SERVER_BASE_URL` ortam değişkeni yeterlidir.

```bash
SERVER_BASE_URL=http://aksiyonsoft-radio-xxxxxx.local:8080 npm start
```

---

Sorularınız için önce [`README.md`](../README.md) ve [`VOICE_RTP.md`](VOICE_RTP.md) dosyalarına bakın.
