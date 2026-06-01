/** Env VOICE_RTP_METRICS=1 iken VoiceRtpServer tarafından doldurulur; /health ile sunulabilir. */
export class VoiceMediaMetrics {
  incomingMediaPackets = 0;
  lockDeniedPackets = 0;
  fanoutDatagramsSent = 0;
  rxProbesSeen = 0;

  recordIncomingMedia(): void {
    this.incomingMediaPackets += 1;
  }

  recordLockDenied(): void {
    this.lockDeniedPackets += 1;
  }

  recordFanout(sent: number): void {
    this.fanoutDatagramsSent += sent;
  }

  recordRxProbe(): void {
    this.rxProbesSeen += 1;
  }

  snapshot(): {
    incomingMediaPackets: number;
    lockDeniedPackets: number;
    fanoutDatagramsSent: number;
    rxProbesSeen: number;
  } {
    return {
      incomingMediaPackets: this.incomingMediaPackets,
      lockDeniedPackets: this.lockDeniedPackets,
      fanoutDatagramsSent: this.fanoutDatagramsSent,
      rxProbesSeen: this.rxProbesSeen,
    };
  }
}
