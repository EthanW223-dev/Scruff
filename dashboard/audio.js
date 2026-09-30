// Per-machine audio device selection for Telos: which microphone push-to-talk
// records from, and which speaker the neural voice replies play through.
// Selections live in localStorage (devices are local to the machine); the
// voice itself stays a hub setting. Nothing here starts recording.

const MIC_KEY = "telos.audio.mic";
const SPEAKER_KEY = "telos.audio.speaker";

/**
 * Pure: should this reply be spoken aloud with the neural voice? Needs the
 * human-voice toggle on (a hub setting) and the composer's read-aloud box
 * checked. The in-game overlay owns playback there, so an ordinary browser
 * dashboard tab must stay silent — never double-play.
 */
export function shouldSpeakReply({ replay, voiceEnabled, speakChecked, overlayMode, text }) {
  return !replay && voiceEnabled && speakChecked && !overlayMode && String(text ?? "").trim().length > 0;
}

export function getMicId() {
  try {
    return localStorage.getItem(MIC_KEY) || "";
  } catch {
    return "";
  }
}

export function getSpeakerId() {
  try {
    return localStorage.getItem(SPEAKER_KEY) || "";
  } catch {
    return "";
  }
}

export function setMicId(id) {
  try {
    if (id) localStorage.setItem(MIC_KEY, id);
    else localStorage.removeItem(MIC_KEY);
  } catch {
    /* storage unavailable; the choice just won't persist */
  }
}

export function setSpeakerId(id) {
  try {
    if (id) localStorage.setItem(SPEAKER_KEY, id);
    else localStorage.removeItem(SPEAKER_KEY);
  } catch {
    /* storage unavailable; the choice just won't persist */
  }
}

/** Numbered fallback when the browser won't reveal a device label (no mic permission yet). */
export function fallbackLabel(kind, index) {
  return kind === "audioinput" ? `Microphone ${index + 1}` : `Speaker ${index + 1}`;
}

/**
 * Returns the saved device when it's still plugged in, else the first device,
 * else "". Pure: easy to unit-test.
 */
export function resolveDeviceId(devices, savedId) {
  if (savedId && devices.some((d) => d.deviceId === savedId)) return savedId;
  return devices[0]?.deviceId ?? "";
}

/** getUserMedia audio constraints honoring the chosen microphone (or the default). */
export function micAudioConstraints() {
  const id = getMicId();
  return id ? { deviceId: { exact: id } } : undefined;
}

/**
 * Lists audio devices with usable labels. When labels are blank (mic permission
 * not granted yet), devices get numbered fallback names instead.
 */
export async function listAudioDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = [];
  const outputs = [];
  for (const d of all) {
    if (d.kind === "audioinput") inputs.push({ deviceId: d.deviceId, label: d.label || fallbackLabel("audioinput", inputs.length) });
    else if (d.kind === "audiooutput")
      outputs.push({ deviceId: d.deviceId, label: d.label || fallbackLabel("audiooutput", outputs.length) });
  }
  return { inputs, outputs };
}

/**
 * One-time mic permission so enumerateDevices returns real labels. Opens no
 * recorder and captures nothing: the stream is stopped immediately.
 */
export async function unlockDeviceLabels() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === "audioinput" && d.label)) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stream.getTracks().forEach((t) => t.stop());
}

/** setSinkId exists in Chromium/Electron; Firefox and others lack it. */
export function supportsSpeakerSelect() {
  try {
    return typeof document.createElement("audio").setSinkId === "function";
  } catch {
    return false;
  }
}

/** Routes an <audio> element to the chosen speaker. Silent no-op where unsupported. */
export async function applySpeaker(audio, speakerId) {
  if (!speakerId || typeof audio.setSinkId !== "function") return;
  try {
    await audio.setSinkId(speakerId);
  } catch {
    /* device vanished; fall back to the default output */
  }
}

/** Plays a neural-voice sample through /voice/say on the chosen speaker. */
export function playVoiceSample(engine, voiceId, text) {
  const audio = new Audio(
    `/voice/say?engine=${encodeURIComponent(engine)}&voice=${encodeURIComponent(voiceId)}&text=${encodeURIComponent(text)}`,
  );
  applySpeaker(audio, getSpeakerId()).finally(() => audio.play().catch(() => {}));
  return audio;
}

/**
 * Speaks a streaming reply sentence-by-sentence so the voice starts while the
 * text is still arriving, instead of waiting for the whole reply. Text deltas
 * go in via push(); finish() flushes the tail; stop() cancels everything.
 *
 * Each finished sentence becomes one /voice/say request; playback is strictly
 * sequential, and the next sentence is fetched while the current one plays, so
 * the voice keeps pace with the typing instead of lagging a full reply behind.
 */
export class SpeechStreamer {
  constructor({ makeUrl, onSpeaking }) {
    this.makeUrl = makeUrl; // (sentence) => /voice/say url
    this.onSpeaking = onSpeaking ?? (() => {}); // (bool) HUD "Speaking…" indicator
    this.buf = "";
    this.inCode = false; // inside a ``` fence: don't read code out loud
    this.queue = [];
    this.current = null;
    this.finished = false;
    this.active = false;
  }
  reset() {
    this.stop();
    this.buf = "";
    this.inCode = false;
    this.queue = [];
    this.current = null;
    this.finished = false;
  }
  start() {
    this.reset();
    this.active = true;
  }
  /** Feed a streamed text delta. Emits newly completed sentences into the queue. */
  push(delta) {
    if (!this.active) return;
    for (const sentence of SpeechStreamer.extract(this, String(delta ?? ""))) this.enqueue(sentence);
  }
  /** The reply is done: speak whatever is left, then go quiet. */
  finish() {
    if (!this.active) return;
    this.finished = true;
    const tail = this.buf.trim();
    this.buf = "";
    if (tail.length >= 2) this.enqueue(tail);
    this.pump();
  }
  stop() {
    this.active = false;
    this.finished = false;
    this.queue.length = 0;
    if (this.current) {
      this.current.pause();
      this.current = null;
    }
    this.onSpeaking(false);
  }
  get speaking() {
    return this.active && (this.current !== null || this.queue.length > 0 || !this.finished);
  }
  enqueue(sentence) {
    const text = sentence.trim();
    if (text.length < 2) return;
    this.queue.push(text);
    this.pump();
  }
  pump() {
    if (!this.active || this.current || !this.queue.length) {
      if (this.active && this.finished && !this.current && !this.queue.length) this.active = false;
      return;
    }
    const text = this.queue.shift();
    const audio = new Audio(this.makeUrl(text));
    this.current = audio;
    this.onSpeaking(true);
    // Prefetch the following sentence while this one plays, hiding TTS latency.
    if (this.queue.length) {
      const next = new Audio(this.makeUrl(this.queue[0]));
      next.preload = "auto";
      try {
        next.load();
      } catch {
        /* preload is best-effort */
      }
    }
    const done = () => {
      if (this.current === audio) {
        this.current = null;
        this.pump();
        if (!this.speaking) this.onSpeaking(false);
      }
    };
    audio.addEventListener("ended", done);
    audio.addEventListener("error", done); // a failed sentence shouldn't stall the rest
    applySpeaker(audio, getSpeakerId()).finally(() => audio.play().catch(done));
  }
  /**
   * Stateful sentence splitter. Tracks ``` fences on the streamer so code is
   * never spoken; returns the newly completed sentences for this delta.
   */
  static extract(st, delta) {
    st.buf += delta;
    const out = [];
    for (;;) {
      if (st.inCode) {
        const end = st.buf.indexOf("```");
        if (end < 0) {
          st.buf = ""; // swallow code until the fence closes
          return out;
        }
        st.buf = st.buf.slice(end + 3);
        st.inCode = false;
        continue;
      }
      const fence = st.buf.indexOf("```");
      const m = /[.!?…]["'”)]?\s+/.exec(st.buf);
      const cut = m ? m.index + m[0].length : -1;
      if (fence >= 0 && (cut < 0 || fence < cut)) {
        const head = st.buf.slice(0, fence).trim();
        if (head.length >= 2) out.push(head);
        st.buf = st.buf.slice(fence + 3);
        st.inCode = true;
        continue;
      }
      if (cut < 0) return out;
      out.push(st.buf.slice(0, cut).trim());
      st.buf = st.buf.slice(cut);
    }
  }
}

export function onDeviceChange(cb) {
  navigator.mediaDevices.addEventListener("devicechange", cb);
  return () => navigator.mediaDevices.removeEventListener("devicechange", cb);
}
