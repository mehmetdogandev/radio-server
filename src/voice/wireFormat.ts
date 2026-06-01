/**
 * Ses UDP wire sözleşmesi (istemeden “Opus” sanılmasın diye ayrı dosya).
 *
 * Şu an istemci (Android) PCM16 mono little-endian gönderir; sunucu aynı baytları fan-out eder.
 * Gelecekte gerçek Opus veya versiyonlu başlık eklenecekse buradan sabitler tekilleşir.
 */
export const VOICE_WIRE_HEADER_BYTES = 20;
/** Gelecek uyumluluk için ayrılmış; şu an tüm paketler fiilen v0 (başlıkta alan yok). */
export const VOICE_WIRE_VERSION = 0 as const;

export const VOICE_WIRE_PAYLOAD_ENCODING = 'pcm_s16le' as const;
export const VOICE_WIRE_SAMPLE_RATE_HZ = 16_000;
export const VOICE_WIRE_CHANNELS = 1;
export const VOICE_WIRE_FRAME_MS = 20;
