// Push-to-talk recording for Scruff's local speech-to-text: 16 kHz mono PCM, what Whisper expects.

const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

export const MAX_SECONDS = 30;

/** Starts recording; resolves to a stop() that returns the audio as base64 16-bit PCM. */
export async function startRecording(onAutoStop) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  // A context made outside a click (e.g. from a hotkey) can start suspended and record nothing.
  await ctx.resume();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const source = ctx.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(ctx, "pcm-capture");
  const mute = ctx.createGain();
  mute.gain.value = 0;
  const chunks = [];
  let samples = 0;
  let stopped = false;
  capture.port.onmessage = (e) => {
    chunks.push(e.data);
    samples += e.data.length;
    if (samples >= 16000 * MAX_SECONDS && !stopped) onAutoStop?.();
  };
  // Routed to a muted output so the browser keeps pulling audio through the capture node.
  source.connect(capture).connect(mute).connect(ctx.destination);

  return async function stop() {
    stopped = true;
    source.disconnect();
    capture.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    const pcm = new Int16Array(Math.min(samples, 16000 * MAX_SECONDS));
    let offset = 0;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length && offset < pcm.length; i++) {
        pcm[offset++] = Math.max(-32768, Math.min(32767, Math.round(chunk[i] * 32767)));
      }
    }
    return toBase64(new Uint8Array(pcm.buffer));
  };
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
