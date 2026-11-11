import * as api from "./api.js";
import { Recorder } from "./recorder.js";
import * as speech from "./speech.js";
import { setAvatarState, setupAvatar } from "./avatar-controls.js";

const $ = (id) => document.getElementById(id);

/* ---------------- 3D avatar ---------------- */
// Stays null until the model loads (or if WebGL / the model fails); voice features work regardless.
let avatar = null;
setupAvatar({ speak: (text) => speak(text) }).then((a) => (avatar = a));

/* ---------------- Tabs ---------------- */
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${tab.dataset.tab}`));
  }),
);

function setStatus(el, message, isError = false) {
  el.textContent = message;
  el.classList.toggle("error", isError);
}

/* ---------------- Speech to text ---------------- */
const sttStatus = $("stt-status");
const recordBtn = $("record-btn");
const recorder = new Recorder({
  onLevel: (v) => {
    $("level-bar").style.width = `${Math.round(v * 100)}%`;
    avatar?.setListeningLevel(v);
  },
});
let timerId = null;

if (!Recorder.isSupported()) {
  recordBtn.disabled = true;
  setStatus(sttStatus, "Recording isn't supported in this browser. You can still upload a file.", true);
}

recordBtn.addEventListener("click", async () => {
  if (recordBtn.classList.contains("recording")) {
    clearInterval(timerId);
    recordBtn.classList.remove("recording");
    recordBtn.textContent = "● Start recording";
    setAvatarState("idle");
    const { blob, filename } = await recorder.stop();
    await runTranscription(blob, filename);
    return;
  }
  try {
    await recorder.start();
  } catch (err) {
    setStatus(sttStatus, `Microphone error: ${err.message}`, true);
    return;
  }
  recordBtn.classList.add("recording");
  recordBtn.textContent = "■ Stop & transcribe";
  setAvatarState("listening");
  setStatus(sttStatus, "Recording… speak clearly, close to the mic.");
  const started = Date.now();
  $("record-timer").textContent = "00:00";
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $("record-timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 250);
});

$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await runTranscription(file, file.name);
});

async function runTranscription(blob, filename) {
  const playback = $("playback");
  playback.src = URL.createObjectURL(blob);
  playback.hidden = false;

  recordBtn.disabled = true;
  setStatus(sttStatus, "Transcribing with Whisper…");
  try {
    const result = await api.transcribe(blob, filename, {
      language: $("stt-language").value,
      prompt: $("stt-prompt").value.trim(),
      model: $("stt-model").value,
    });
    renderTranscript(result);
    setStatus(sttStatus, "Done.");
  } catch (err) {
    setStatus(sttStatus, err.message, true);
  } finally {
    recordBtn.disabled = !Recorder.isSupported();
  }
}

function renderTranscript(result) {
  $("stt-result").hidden = false;
  $("stt-text").value = result.text;

  const meta = [result.model, result.language];
  if (result.duration != null) meta.push(`${result.duration.toFixed(1)}s`);
  if (result.confidence != null) meta.push(`confidence ${(result.confidence * 100).toFixed(0)}%`);
  $("stt-meta").textContent = meta.filter(Boolean).join(" · ");

  $("stt-warnings").replaceChildren(
    ...result.warnings.map((w) => Object.assign(document.createElement("li"), { textContent: w })),
  );

  $("stt-segments").replaceChildren(
    ...result.segments.map((seg) => {
      const li = document.createElement("li");
      li.classList.toggle("flagged", seg.flagged);
      const metaSpan = Object.assign(document.createElement("span"), {
        className: "seg-meta",
        textContent: `${seg.start.toFixed(1)}–${seg.end.toFixed(1)}s · ${(seg.confidence * 100).toFixed(0)}%`,
      });
      li.append(metaSpan, seg.text);
      return li;
    }),
  );
}

$("copy-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("stt-text").value);
  setStatus(sttStatus, "Copied to clipboard.");
});

$("speak-transcript-btn").addEventListener("click", () => {
  $("tts-text").value = $("stt-text").value;
  document.querySelector('.tab[data-tab="tts"]').click();
  $("speak-btn").click();
});

/* ---------------- Text to speech ---------------- */
const ttsStatus = $("tts-status");
const engineSelect = $("tts-engine");
const voiceSelect = $("tts-voice");
const speakBtn = $("speak-btn");
const pauseBtn = $("pause-btn");
const stopBtn = $("stop-btn");
let browserVoices = [];
let neural = { voices: [], default_voice: null };

const callbacks = {
  onChunk: (text) => {
    setStatus(ttsStatus, "Speaking…");
    $("tts-now").textContent = text;
    avatar?.setSpeaking(mouthMode);
    setAvatarState("speaking");
  },
  onEnd: () => setSpeaking(false),
  onError: (err) => setStatus(ttsStatus, `Speech error: ${err}`, true),
};
const speakers = {
  neural: new speech.NeuralSpeaker({ synthesize: api.synthesize, ...callbacks }),
  browser: new speech.Speaker(callbacks),
};
let speaker = speakers.neural;
// How the avatar's jaw is driven: real audio loudness (neural) or a procedural rhythm (browser TTS
// gives no access to its audio).
let mouthMode = "audio";

function setSpeaking(on) {
  speakBtn.disabled = on;
  pauseBtn.disabled = !on;
  stopBtn.disabled = !on;
  pauseBtn.textContent = "Pause";
  if (!on) {
    $("tts-now").textContent = "";
    avatar?.setSpeaking(null);
    setAvatarState("idle");
  }
}

for (const name of ["rate", "pitch", "volume"]) {
  const input = $(`tts-${name}`);
  input.addEventListener("input", () => ($(`${name}-out`).textContent = Number(input.value).toFixed(1)));
}

function renderVoiceOptions() {
  const engine = engineSelect.value;
  // The neural voice can't change pitch; only the browser engine supports it.
  $("tts-pitch").disabled = engine === "neural";

  if (engine === "neural") {
    voiceSelect.replaceChildren(
      ...neural.voices.map((v) => new Option(v[0].toUpperCase() + v.slice(1), v)),
    );
    if (neural.default_voice) voiceSelect.value = neural.default_voice;
    return;
  }

  voiceSelect.replaceChildren(
    ...browserVoices.map((v, i) => new Option(`${v.name} (${v.lang})${v.localService ? "" : " · online"}`, i)),
  );
  // Voices are ranked best-first, so the first one matching the user's language is the best match.
  const preferredLang = navigator.language || "en-US";
  let match = browserVoices.findIndex((v) => v.lang === preferredLang);
  if (match < 0) match = browserVoices.findIndex((v) => v.lang.startsWith(preferredLang.split("-")[0]));
  if (match >= 0) voiceSelect.value = String(match);
}

async function initVoices() {
  try {
    neural = await api.neuralVoices();
  } catch (err) {
    setStatus(ttsStatus, `Neural voices unavailable: ${err.message}`, true);
  }
  if (speech.isSupported()) {
    browserVoices = speech.rankVoices(await speech.loadVoices());
  } else {
    engineSelect.querySelector('option[value="browser"]').disabled = true;
  }
  renderVoiceOptions();
}
initVoices();

engineSelect.addEventListener("change", () => {
  speaker.stop();
  setSpeaking(false);
  speaker = speakers[engineSelect.value];
  renderVoiceOptions();
});

speakBtn.addEventListener("click", () => speak($("tts-text").value.trim()));

/** Speak text with the selected engine and voice (also used by the avatar's part labels). */
async function speak(text) {
  if (!text) return setStatus(ttsStatus, "Enter some text first.", true);

  const engine = engineSelect.value;
  mouthMode = engine === "neural" ? "audio" : "procedural";
  if (engine === "neural" && avatar) {
    // Must run inside the click gesture, before any await, or the browser keeps audio suspended.
    avatar.connectAudio(speakers.neural.audio).catch((err) => console.warn("Avatar audio:", err));
  }
  const voice = engine === "neural" ? voiceSelect.value : browserVoices[Number(voiceSelect.value)];
  const language = engine === "neural" ? "en-US" : voice?.lang || "en-US";
  setStatus(ttsStatus, "Preparing…");
  try {
    const { chunks } = await api.prepareSpeech(text, language, engine);
    setStatus(ttsStatus, engine === "neural" ? "Generating natural voice…" : `Speaking ${chunks.length} chunk(s).`);
    setSpeaking(true);
    speaker.speak(chunks, {
      voice,
      rate: Number($("tts-rate").value),
      pitch: Number($("tts-pitch").value),
      volume: Number($("tts-volume").value),
    });
  } catch (err) {
    setStatus(ttsStatus, err.message, true);
  }
}

pauseBtn.addEventListener("click", () => {
  if (speaker.paused) {
    speaker.resume();
    avatar?.setSpeaking(mouthMode);
    pauseBtn.textContent = "Pause";
  } else {
    speaker.pause();
    avatar?.setSpeaking(null);
    pauseBtn.textContent = "Resume";
  }
});

stopBtn.addEventListener("click", () => {
  speaker.stop();
  setSpeaking(false);
  setStatus(ttsStatus, "Stopped.");
});
