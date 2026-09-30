"""Persistent Kokoro TTS daemon for the Telos hub (ONNX runtime edition).

The hub spawns this once and talks to it over stdio with JSON lines, so the
model loads exactly once instead of on every spoken sentence.

Uses kokoro-onnx (no torch needed) + the pip-bundled espeak-ng. The model
files (~600MB) download once into the user's cache dir on first run.

Protocol (each message is one JSON object per line):
  -> {"id": 1, "text": "hello", "voice": "af_heart", "speed": 1.0, "file": "C:/.../x.wav"}
  <- {"id": 1, "ok": true, "file": "C:/.../x.wav", "seconds": 1.2}
  <- {"id": 1, "ok": false, "error": "..."}
  <- {"ready": true}                       (printed once at startup)
  <- {"ready": false, "error": "..."}       (startup failed; hub falls back)
  -> {"id": 2, "shutdown": true}            (polite exit)
"""

import json
import os
import sys
import traceback
import urllib.request
import wave

MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def download(url, path):
    tmp = path + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, path)


def main():
    # Phonemizer backend: prefer the pip-bundled espeak-ng, fall back to a
    # system install (espeak-ng on PATH or PHONEMIZER_ESPEAK_LIBRARY).
    try:
        import espeakng_loader

        espeakng_loader.load_library()
    except Exception:
        pass

    try:
        from kokoro_onnx import Kokoro
    except Exception as e:
        emit({"ready": False, "error": "kokoro_onnx import failed: %s" % e})
        return

    try:
        cache = os.path.join(os.path.expanduser("~"), ".cache", "telos-kokoro")
        os.makedirs(cache, exist_ok=True)
        model_path = os.path.join(cache, "kokoro-v1.0.onnx")
        voices_path = os.path.join(cache, "voices-v1.0.bin")
        if not os.path.exists(model_path):
            download(MODEL_URL, model_path)
        if not os.path.exists(voices_path):
            download(VOICES_URL, voices_path)
        kokoro = Kokoro(model_path, voices_path)
    except Exception as e:
        emit({"ready": False, "error": "kokoro init failed: %s" % e})
        return

    emit({"ready": True})

    import numpy as np

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        if req.get("shutdown"):
            emit({"id": rid, "ok": True, "bye": True})
            return
        try:
            text = str(req.get("text") or "")[:2000]
            if not text.strip():
                raise ValueError("empty text")
            voice = str(req.get("voice") or "af_heart")
            speed = float(req.get("speed") or 1.0)
            out_file = str(req.get("file") or "")
            if not out_file:
                raise ValueError("no output file given")
            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
            pcm = (np.clip(np.asarray(samples).flatten(), -1.0, 1.0) * 32767).astype(np.int16)
            os.makedirs(os.path.dirname(out_file), exist_ok=True)
            with wave.open(out_file, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(int(sample_rate))
                w.writeframes(pcm.tobytes())
            emit({"id": rid, "ok": True, "file": out_file, "seconds": round(len(pcm) / float(sample_rate), 2)})
        except Exception as e:
            emit({"id": rid, "ok": False, "error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit({"ready": False, "error": traceback.format_exc(limit=3)})
