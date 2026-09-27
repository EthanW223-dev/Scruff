using System;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Every sound effect is synthesised at startup, so the project has zero audio files to import.
    /// Swap any of these for real recordings later by returning your own AudioClip from <see cref="Get"/>.
    /// </summary>
    public static class SoundLibrary
    {
        const int Rate = 22050;
        const float TwoPi = Mathf.PI * 2f;

        static Dictionary<string, AudioClip> clips;

        public static AudioClip Get(string name)
        {
            if (clips == null) Init();
            return clips.TryGetValue(name, out var c) ? c : null;
        }

        public static void Init()
        {
            if (clips != null) return;
            clips = new Dictionary<string, AudioClip>();

            // Gorilla-style hand taps, one per surface feel.
            Add("tap", 0.09f, NoiseLP(0.25f, 1), (t, n) => n * 0.7f * Mathf.Exp(-t * 60f) + Mathf.Sin(TwoPi * 140f * t) * 0.6f * Mathf.Exp(-t * 40f));
            Add("tap_wood", 0.1f, NoiseLP(0.35f, 2), (t, n) => Mathf.Sin(TwoPi * 420f * t) * 0.45f * Mathf.Exp(-t * 35f) + n * 0.4f * Mathf.Exp(-t * 80f));
            Add("tap_metal", 0.3f, NoiseLP(0.6f, 3), (t, n) => (Mathf.Sin(TwoPi * 900f * t) + 0.5f * Mathf.Sin(TwoPi * 1370f * t)) * 0.3f * Mathf.Exp(-t * 16f) + n * 0.25f * Mathf.Exp(-t * 90f));
            Add("tap_grass", 0.1f, NoiseLP(0.5f, 4), (t, n) => n * 0.45f * Mathf.Exp(-t * 45f));

            // UI
            Add("click", 0.05f, null, (t, n) => Mathf.Sin(TwoPi * 1800f * t) * 0.5f * Mathf.Exp(-t * 170f) + Mathf.Sin(TwoPi * 600f * t) * 0.35f * Mathf.Exp(-t * 60f));
            Add("hover", 0.03f, null, (t, n) => Mathf.Sin(TwoPi * 2400f * t) * 0.15f * Mathf.Exp(-t * 200f));
            Add("pop", 0.09f, null, Sweep(380f, 760f, 0.09f, 35f, 0.55f));
            Add("drop", 0.11f, null, Sweep(560f, 260f, 0.11f, 30f, 0.45f));
            Add("error", 0.32f, null, (t, n) =>
            {
                float gate = (t < 0.12f || (t > 0.17f && t < 0.3f)) ? 1f : 0f;
                return Mathf.Sign(Mathf.Sin(TwoPi * 165f * t)) * 0.18f * gate;
            });
            Add("notify", 0.36f, null, (t, n) =>
            {
                float f = t < 0.12f ? 880f : 1320f;
                float local = t < 0.12f ? t : t - 0.12f;
                return Mathf.Sin(TwoPi * f * t) * 0.35f * Mathf.Exp(-local * 9f) * Mathf.Clamp01(local * 200f);
            });
            Add("success", 0.5f, null, Arpeggio(new[] { 523.25f, 659.25f, 783.99f, 1046.5f }, 0.09f, 0.35f));
            Add("rankup", 1.1f, null, Arpeggio(new[] { 392f, 523.25f, 659.25f, 783.99f, 1046.5f, 1318.5f }, 0.08f, 0.35f, 0.5f));

            // Money
            Add("cash", 0.6f, NoiseLP(0.7f, 5), (t, n) =>
            {
                float v = n * 0.25f * Mathf.Exp(-t * 50f);
                v += (Mathf.Sin(TwoPi * 1318.5f * t) + 0.35f * Mathf.Sin(TwoPi * 2637f * t)) * 0.28f * Mathf.Exp(-t * 7f);
                if (t > 0.09f)
                {
                    float u = t - 0.09f;
                    v += (Mathf.Sin(TwoPi * 1760f * u) + 0.3f * Mathf.Sin(TwoPi * 3520f * u)) * 0.28f * Mathf.Exp(-u * 6f);
                }
                return v;
            });
            Add("coin", 0.35f, null, (t, n) =>
            {
                float v = Mathf.Sin(TwoPi * 1568f * t) * 0.3f * Mathf.Exp(-t * 12f);
                if (t > 0.06f) v += Mathf.Sin(TwoPi * 2093f * (t - 0.06f)) * 0.3f * Mathf.Exp(-(t - 0.06f) * 10f);
                return v;
            });

            // Physical stuff
            Add("thud", 0.16f, NoiseLP(0.2f, 6), (t, n) => Mathf.Sin(TwoPi * 90f * t) * 0.6f * Mathf.Exp(-t * 25f) + n * 0.35f * Mathf.Exp(-t * 60f));
            Add("rustle", 0.28f, NoiseHP(7), (t, n) => n * 0.3f * (0.5f + 0.5f * Mathf.Sin(TwoPi * 22f * t)) * Mathf.Exp(-t * 9f) * Mathf.Clamp01(t * 60f));
            Add("door", 0.7f, NoiseLP(0.3f, 8), (t, n) =>
            {
                float f = 170f + 40f * Mathf.Sin(TwoPi * 3f * t) + 25f * Mathf.Sin(TwoPi * 11f * t);
                float saw = 2f * ((f * t) % 1f) - 1f;
                return (saw * 0.15f + n * 0.1f) * Mathf.Sin(Mathf.PI * Mathf.Clamp01(t / 0.7f));
            });
            Add("snap", 0.07f, NoiseHP(9), (t, n) => n * 0.5f * Mathf.Exp(-t * 90f) + Mathf.Sin(TwoPi * 1200f * t) * 0.2f * Mathf.Exp(-t * 120f));

            // Loops (level controlled by the owner)
            Add("pour_water", 1f, null, BubblyNoise(10, 0.07f, 0.35f, 900f, 1800f, 14f));
            Add("pour_soil", 1f, null, Crackle(11));
            Add("bubble", 1.2f, null, BubblyNoise(12, 0.02f, 0.1f, 260f, 620f, 6f));
            Add("whir", 0.5f, NoiseLP(0.3f, 13), (t, n) =>
            {
                float saw = 2f * ((110f * t) % 1f) - 1f;
                float saw2 = 2f * ((220f * t) % 1f) - 1f;
                return saw * 0.12f + saw2 * 0.06f + n * 0.12f;
            });
            Add("sizzle", 1f, NoiseHP(14), (t, n) => n * 0.18f * (0.7f + 0.3f * Mathf.Sin(TwoPi * 7f * t)));

            // Voices
            Add("blip", 0.075f, null, (t, n) =>
            {
                float env = Mathf.Clamp01(t * 250f) * Mathf.Exp(-t * 30f);
                float tri = 1f - 4f * Mathf.Abs(((330f * t) % 1f) - 0.5f);
                float sq = Mathf.Sign(Mathf.Sin(TwoPi * 330f * t));
                return (tri * 0.3f + sq * 0.08f) * env;
            });
            Add("whistle", 0.95f, null, (t, n) =>
            {
                float f = ((int)(t / 0.075f)) % 2 == 0 ? 2300f : 1900f;
                float env = Mathf.Clamp01(t * 30f) * Mathf.Clamp01((0.95f - t) * 12f);
                return Mathf.Sin(TwoPi * f * t) * 0.25f * env;
            });
        }

        // ------------------------------------------------------------------ synthesis helpers

        delegate float Synth(float t, float noise);

        static void Add(string name, float seconds, Func<float> noise, Synth synth)
        {
            int n = Mathf.Max(1, Mathf.RoundToInt(seconds * Rate));
            var data = new float[n];
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                float nz = noise != null ? noise() : 0f;
                data[i] = Mathf.Clamp(synth(t, nz), -1f, 1f);
            }
            // tiny fade in/out to avoid clicks
            int fade = Mathf.Min(n / 4, 64);
            for (int i = 0; i < fade; i++)
            {
                float k = i / (float)fade;
                data[i] *= k;
                data[n - 1 - i] *= k;
            }
            var clip = AudioClip.Create(name, n, 1, Rate, false);
            clip.SetData(data, 0);
            clips[name] = clip;
        }

        static Func<float> NoiseLP(float alpha, int seed)
        {
            var rng = new System.Random(seed);
            float state = 0f;
            return () =>
            {
                float white = (float)(rng.NextDouble() * 2.0 - 1.0);
                state += alpha * (white - state);
                return state * (1.5f / Mathf.Sqrt(alpha));
            };
        }

        static Func<float> NoiseHP(int seed)
        {
            var rng = new System.Random(seed);
            float prev = 0f;
            return () =>
            {
                float white = (float)(rng.NextDouble() * 2.0 - 1.0);
                float v = white - prev;
                prev = white;
                return v * 0.6f;
            };
        }

        static Synth Sweep(float from, float to, float duration, float decay, float gain)
        {
            return (t, n) =>
            {
                float k = Mathf.Clamp01(t / duration);
                // integrate the linearly changing frequency for a clean chirp
                float phase = TwoPi * (from * t + 0.5f * (to - from) / duration * t * t);
                return Mathf.Sin(phase) * gain * Mathf.Exp(-t * decay) * (1f - k * 0.3f);
            };
        }

        static Synth Arpeggio(float[] notes, float step, float gain, float chordTail = 0f)
        {
            return (t, n) =>
            {
                float v = 0f;
                for (int i = 0; i < notes.Length; i++)
                {
                    float start = i * step;
                    if (t < start) break;
                    float u = t - start;
                    float decay = i == notes.Length - 1 && chordTail > 0f ? 3f : 10f;
                    v += Mathf.Sin(TwoPi * notes[i] * u) * gain * Mathf.Exp(-u * decay) * Mathf.Clamp01(u * 300f);
                }
                return v * 0.6f;
            };
        }

        static Synth BubblyNoise(int seed, float noiseAlpha, float noiseGain, float bubbleLow, float bubbleHigh, float bubblesPerSecond)
        {
            var rng = new System.Random(seed);
            var noise = NoiseLP(noiseAlpha, seed + 100);
            // pre-place bubbles
            int count = Mathf.CeilToInt(bubblesPerSecond * 1.5f);
            var starts = new float[count];
            var freqs = new float[count];
            for (int i = 0; i < count; i++)
            {
                starts[i] = (float)rng.NextDouble() * 1.2f;
                freqs[i] = Mathf.Lerp(bubbleLow, bubbleHigh, (float)rng.NextDouble());
            }
            return (t, n) =>
            {
                float v = noise() * noiseGain * 0.4f;
                for (int i = 0; i < count; i++)
                {
                    float u = t - starts[i];
                    if (u < 0f || u > 0.05f) continue;
                    float f = freqs[i] * (1f + u * 12f);
                    v += Mathf.Sin(TwoPi * f * u) * 0.18f * Mathf.Exp(-u * 70f);
                }
                return v;
            };
        }

        static Synth Crackle(int seed)
        {
            var rng = new System.Random(seed);
            var lp = NoiseLP(0.3f, seed + 1);
            float burst = 0f;
            return (t, n) =>
            {
                if (rng.NextDouble() < 0.004) burst = 1f;
                burst *= 0.995f;
                return lp() * (0.08f + 0.35f * burst);
            };
        }
    }
}
