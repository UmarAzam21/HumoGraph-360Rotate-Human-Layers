const BASE = "/api/v1";

async function parse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || body?.detail?.[0]?.msg || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

export async function transcribe(blob, filename, { language, prompt, model }) {
  const form = new FormData();
  form.append("file", blob, filename);
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);
  if (model) form.append("model", model);
  return parse(await fetch(`${BASE}/stt/transcribe`, { method: "POST", body: form }));
}

export async function prepareSpeech(text, language, engine) {
  return parse(
    await fetch(`${BASE}/tts/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language, engine }),
    }),
  );
}

export async function neuralVoices() {
  return parse(await fetch(`${BASE}/tts/voices`));
}

/** Synthesize one chunk with the neural voice; resolves to a WAV Blob. */
export async function synthesize(text, voice, signal) {
  const response = await fetch(`${BASE}/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal,
  });
  if (!response.ok) await parse(response);
  return response.blob();
}
