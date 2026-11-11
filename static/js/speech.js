// Two speakers with the same interface (speak / pause / resume / stop / paused):
//  - NeuralSpeaker plays server-synthesized audio (Groq Orpheus) chunk by chunk.
//  - Speaker uses the browser's built-in Web Speech API (speechSynthesis).
const synth = window.speechSynthesis;

/** How many chunks to synthesize ahead of the one playing, so playback has no gaps. */
const PREFETCH = 2;

export class NeuralSpeaker {
  constructor({ synthesize, onChunk, onEnd, onError } = {}) {
    Object.assign(this, { synthesize, onChunk, onEnd, onError });
    this.audio = new Audio();
  }

  speak(chunks, { voice, rate = 1, volume = 1 }) {
    this.stop();
    this.controller = new AbortController();
    const { signal } = this.controller;
    const pending = new Map();
    const load = (i) => {
      if (i < chunks.length && !pending.has(i)) {
        const promise = this.synthesize(chunks[i], voice, signal);
        promise.catch(() => {}); // prefetches may be aborted before anyone awaits them
        pending.set(i, promise);
      }
      return pending.get(i);
    };

    const play = async (i) => {
      if (signal.aborted) return;
      if (i >= chunks.length) return this.onEnd?.();
      for (let k = 1; k <= PREFETCH; k++) load(i + k);
      try {
        const blob = await load(i);
        if (signal.aborted) return;
        URL.revokeObjectURL(this.audio.src);
        this.audio.src = URL.createObjectURL(blob);
        this.audio.playbackRate = rate;
        this.audio.volume = volume;
        this.audio.onended = () => play(i + 1);
        this.onChunk?.(chunks[i]);
        await this.audio.play();
      } catch (err) {
        if (signal.aborted || err.name === "AbortError") return;
        this.onError?.(err.message);
        this.onEnd?.();
      }
    };
    play(0);
  }

  pause() { this.audio.pause(); }
  resume() { this.audio.play(); }
  get paused() { return this.audio.paused && !!this.audio.src && !this.audio.ended; }

  stop() {
    this.controller?.abort();
    this.audio.pause();
    this.audio.onended = null;
  }
}

export function isSupported() {
  return "speechSynthesis" in window;
}

/** Resolve the voice list; Chrome loads it asynchronously. */
export function loadVoices() {
  return new Promise((resolve) => {
    const voices = synth.getVoices();
    if (voices.length) return resolve(voices);
    synth.addEventListener("voiceschanged", () => resolve(synth.getVoices()), { once: true });
    setTimeout(() => resolve(synth.getVoices()), 1500);
  });
}

/** Sort so higher-quality voices (network/neural, local default) come first. */
export function rankVoices(voices) {
  const score = (v) =>
    (/natural|neural|online|premium|enhanced/i.test(v.name) ? 4 : 0) +
    (/google|microsoft|apple|siri/i.test(v.name) ? 2 : 0) +
    (v.default ? 1 : 0);
  return [...voices].sort((a, b) => score(b) - score(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

export class Speaker {
  constructor({ onChunk, onEnd, onError } = {}) {
    Object.assign(this, { onChunk, onEnd, onError });
    this.queue = [];
    this.active = false;
  }

  /** Speak chunks sequentially; one utterance per chunk avoids browser cut-offs. */
  speak(chunks, { voice, rate = 1, pitch = 1, volume = 1 }) {
    this.stop();
    this.queue = [...chunks];
    this.settings = { voice, rate, pitch, volume };
    this.active = true;
    this.#next();
  }

  #next() {
    if (!this.active) return;
    const text = this.queue.shift();
    if (text === undefined) {
      this.active = false;
      this.onEnd?.();
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const { voice, rate, pitch, volume } = this.settings;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    Object.assign(u, { rate, pitch, volume });
    u.onstart = () => this.onChunk?.(text);
    u.onend = () => this.#next();
    u.onerror = (e) => {
      // "interrupted"/"canceled" are expected when the user presses Stop.
      if (e.error !== "interrupted" && e.error !== "canceled") this.onError?.(e.error);
      this.#next();
    };
    synth.speak(u);
  }

  pause() { synth.pause(); }
  resume() { synth.resume(); }
  get paused() { return synth.paused; }

  stop() {
    this.active = false;
    this.queue = [];
    synth.cancel();
  }
}
