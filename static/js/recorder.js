// Preferred containers, best first. Opus at 128 kbps is effectively lossless for speech.
const MIME_CANDIDATES = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/ogg;codecs=opus", "ogg"],
  ["audio/mp4", "m4a"],
  ["audio/webm", "webm"],
];

export class Recorder {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel;
    this.chunks = [];
  }

  static isSupported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const [mimeType, ext] = MIME_CANDIDATES.find(([type]) => MediaRecorder.isTypeSupported(type)) || ["", "webm"];
    this.extension = ext;
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream, {
      ...(mimeType && { mimeType }),
      audioBitsPerSecond: 128000,
    });
    this.mediaRecorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.mediaRecorder.start(250);
    this.#startMeter();
  }

  stop() {
    return new Promise((resolve) => {
      this.mediaRecorder.onstop = () => {
        const type = this.mediaRecorder.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type });
        this.#cleanup();
        resolve({ blob, filename: `recording.${this.extension}` });
      };
      this.mediaRecorder.stop();
    });
  }

  #startMeter() {
    if (!this.onLevel) return;
    this.audioCtx = new AudioContext();
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    this.audioCtx.createMediaStreamSource(this.stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      this.onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  #cleanup() {
    cancelAnimationFrame(this.raf);
    this.audioCtx?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.onLevel?.(0);
  }
}
