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
export function playVoiceSample(voiceId, text) {
  const audio = new Audio(`/voice/say?voice=${encodeURIComponent(voiceId)}&text=${encodeURIComponent(text)}`);
  applySpeaker(audio, getSpeakerId()).finally(() => audio.play().catch(() => {}));
  return audio;
}

export function onDeviceChange(cb) {
  navigator.mediaDevices.addEventListener("devicechange", cb);
  return () => navigator.mediaDevices.removeEventListener("devicechange", cb);
}
