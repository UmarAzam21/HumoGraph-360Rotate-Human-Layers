# Humograph Voice Agent

FastAPI voice agent with a holographic 3D human (`human.glb`) and two modes:

- **Voice → Text** — browser records audio, backend transcribes it with **Groq Whisper (`whisper-large-v3`)**.
- **Text → Voice** — natural **neural voice (Groq Orpheus)** by default, with the browser's built-in voice as an offline fallback.

## Project structure

```
humograph/
├── app/
│   ├── main.py              # App factory: lifespan, routers, static files, error handlers
│   ├── core/
│   │   ├── config.py        # Settings from .env (pydantic-settings)
│   │   ├── exceptions.py    # Typed app errors + JSON error handler
│   │   └── logging.py
│   ├── api/
│   │   ├── router.py        # Mounts all route modules under /api/v1
│   │   ├── deps.py          # Dependency injection (services)
│   │   └── routes/
│   │       ├── health.py    # GET  /api/v1/health
│   │       ├── stt.py       # POST /api/v1/stt/transcribe
│   │       └── tts.py       # GET /tts/voices, POST /tts/prepare, POST /tts/synthesize
│   ├── schemas/             # Pydantic request/response models
│   ├── services/            # Business logic (no HTTP/FastAPI concerns)
│   │   ├── groq_client.py   # Shared Groq HTTP client: auth, retries, error mapping
│   │   ├── stt_service.py   # Whisper transcription + hallucination filtering
│   │   └── tts_service.py   # Text normalization, chunking, Orpheus synthesis
│   └── utils/
│       └── audio.py         # Audio format / size validation
├── static/                  # Frontend (plain HTML/CSS/JS modules, no build step)
│   ├── index.html
│   ├── models/human.glb     # 3D anatomy model (meshopt-compressed)
│   ├── css/style.css
│   └── js/
│       ├── app.js           # UI wiring
│       ├── avatar.js        # Three.js avatar engine: rendering, jaw, layers, picking, section, explode
│       ├── avatar-controls.js # Binds the HTML control panel + keyboard shortcuts to the avatar
│       ├── api.js           # Backend calls
│       ├── recorder.js      # Mic capture (MediaRecorder)
│       └── speech.js        # Browser speechSynthesis wrapper
├── tests/
├── requirements.txt
└── .env.example
```

Layers: **routes** (HTTP in/out) → **services** (logic) → external API. Routes never talk to Groq directly, and services never import FastAPI. Each part can be tested and replaced on its own.

## Setup (Windows)

```powershell
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements-dev.txt
copy .env.example .env      # then put your GROQ_API_KEY in .env
uvicorn app.main:app --reload
```

Open http://localhost:8000. API docs: http://localhost:8000/docs.

Run tests: `pytest`

## 3D avatar

`static/models/human.glb` is an anatomical model (1,233 parts, no rig), rendered with Three.js:

- **Hologram skin:** the skin is a translucent fresnel shader, so the anatomy shows through.
- **Talking:** the mandible, lower teeth, tongue and floor-of-mouth muscles rotate around the jaw joint. With the neural voice the jaw follows the real audio loudness (Web Audio analyser). With the browser voice it follows a speech-like rhythm, because browsers don't expose speechSynthesis audio. The larynx glows while speaking.
- **Listening:** the hologram turns green with the microphone level while recording.
- **Controls** (panel under the viewer):
  - **Toolbar:** zoom in/out, reset view, auto-rotate, fullscreen, screenshot (PNG).
  - **View:** front, back, left, right, top, full body, upper body and head presets; field of view; brightness; auto-rotate speed; wireframe; hover labels.
  - **Skin:** hologram, solid or hidden; hologram colour; glow intensity.
  - **Layers:** each of the 14 categories (bone, organ, muscle, nerve, vessel and so on) has show/hide, an opacity slider and Solo, plus Show all, Hide all and Reset. Muscle, tendon and cartilage start hidden so the jaw is visible.
  - **Parts:** search all 1,233 parts by name. Click a part (or a search result) to select it, then Focus, Hide, Isolate, Speak its name, or Deselect. Show hidden parts brings back anything hidden.
  - **Cross-section:** cut horizontally, sagittally or coronally at any position, with flip.
  - **Explode:** pull parts apart from the body centre.
  - **Mouth & voice:** lip-sync sensitivity, max jaw opening, manual mouth opening, test talking.
  - **Shortcuts:** `F` focus, `H` hide, `I` isolate, `A` show hidden, `Esc` deselect, `R` reset, `O` auto-rotate, `+`/`-` zoom, `P` screenshot, `Shift+F` fullscreen, `1`–`8` view presets. Double-click focuses a part. Shortcuts are ignored while typing in a field.

The file is 96 MB, so the first load takes a while; after that the browser caches it. To swap models, replace the file or change `MODEL_URL` in `static/js/app.js`.

## How accuracy is maximized

**Speech-to-text**
| Measure | Why |
|---|---|
| `whisper-large-v3` default | Most accurate Whisper model on Groq (turbo is selectable but less accurate). |
| `temperature=0` | Deterministic, highest-likelihood decoding. |
| Language selector | Telling Whisper the language avoids mis-detection, which is the biggest single cause of garbage output. |
| Vocabulary hint (`prompt`) | Steers spelling of names, brands, jargon. |
| Mic: mono, 48 kHz, noise suppression, echo cancel, auto gain, Opus @128 kbps | Clean, high-bitrate input. |
| Segment filtering | Drops segments with `no_speech_prob > 0.6` **and** `avg_logprob < -1.0` (Whisper's own thresholds) to remove hallucinations like "Thank you for watching" on silence. |
| Confidence + flags | Each segment gets a confidence; low-confidence or repetitive (`compression_ratio > 2.4`) segments are highlighted for review. |
| Retries with backoff | Rate limits / transient 5xx don't lose a recording. |

**Text-to-speech**
- Default engine is Groq's **Orpheus** neural model (`canopylabs/orpheus-v1-english`), which sounds human, unlike robotic OS voices. **One-time setup:** accept the model terms at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english
- Orpheus takes ≤200 characters per request, so text is split at sentence boundaries; the browser synthesizes the next chunks while the current one plays, so there are no gaps.
- Text is normalized (`50%` → "50 percent", `&` → "and", `e.g.` → "for example", URLs/markdown removed) so the voice pronounces it correctly.
- Text is spoken in sentence-aligned chunks; browsers (especially Chrome) cut off long single utterances.
- Voices are ranked so neural/"Natural"/online voices come first. Microsoft Edge's "Natural" voices are the most realistic.

## API

```bash
curl -F "file=@sample.wav" -F "language=en" -F "prompt=Humograph, FastAPI" \
     http://localhost:8000/api/v1/stt/transcribe

curl -X POST http://localhost:8000/api/v1/tts/prepare \
     -H "Content-Type: application/json" -d '{"text":"Hello there.","language":"en-US"}'
```

Errors are returned as `{"error": {"code": "...", "message": "..."}}`.

## Notes
- Mic access needs `localhost` or HTTPS.
- Max upload is 25 MB (Groq's limit for direct uploads).
