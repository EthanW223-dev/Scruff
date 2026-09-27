using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>Pooled one-shot 3D audio plus helpers for looping sources. Call the static methods from anywhere.</summary>
    public class AudioManager : MonoBehaviour
    {
        static AudioManager instance;

        readonly List<AudioSource> pool = new List<AudioSource>();
        int next;

        const int PoolSize = 24;

        void Awake()
        {
            instance = this;
            for (int i = 0; i < PoolSize; i++)
            {
                var go = new GameObject("OneShot " + i);
                go.transform.SetParent(transform, false);
                var src = go.AddComponent<AudioSource>();
                Configure(src, 1f);
                pool.Add(src);
            }
        }

        void OnDestroy()
        {
            if (instance == this) instance = null;
        }

        static void Configure(AudioSource src, float spatial)
        {
            src.playOnAwake = false;
            src.spatialBlend = spatial;
            src.rolloffMode = AudioRolloffMode.Logarithmic;
            src.minDistance = 0.8f;
            src.maxDistance = 30f;
            src.dopplerLevel = 0f;
            src.spread = 0f;
        }

        public static void Play(string clipName, Vector3 position, float volume = 1f, float pitch = 1f)
        {
            if (instance == null || volume <= 0.001f) return;
            var clip = SoundLibrary.Get(clipName);
            if (clip == null) return;
            var src = instance.NextSource();
            src.transform.position = position;
            src.spatialBlend = 1f;
            src.clip = clip;
            src.volume = Mathf.Clamp01(volume);
            src.pitch = pitch;
            src.Play();
        }

        /// <summary>Non-spatial sound (UI feedback, notifications).</summary>
        public static void PlayUI(string clipName, float volume = 0.8f, float pitch = 1f)
        {
            if (instance == null) return;
            var clip = SoundLibrary.Get(clipName);
            if (clip == null) return;
            var src = instance.NextSource();
            src.transform.localPosition = Vector3.zero;
            src.spatialBlend = 0f;
            src.clip = clip;
            src.volume = Mathf.Clamp01(volume);
            src.pitch = pitch;
            src.Play();
        }

        /// <summary>Creates a looping, positional source parented to <paramref name="parent"/>. Starts silent.</summary>
        public static AudioSource CreateLoop(Transform parent, string clipName, float maxDistance = 12f)
        {
            var go = new GameObject("Loop " + clipName);
            go.transform.SetParent(parent, false);
            var src = go.AddComponent<AudioSource>();
            Configure(src, 1f);
            src.maxDistance = maxDistance;
            src.loop = true;
            src.clip = SoundLibrary.Get(clipName);
            src.volume = 0f;
            src.Play();
            return src;
        }

        AudioSource NextSource()
        {
            // Prefer a free source, otherwise steal the oldest.
            for (int i = 0; i < pool.Count; i++)
            {
                int idx = (next + i) % pool.Count;
                if (!pool[idx].isPlaying)
                {
                    next = (idx + 1) % pool.Count;
                    return pool[idx];
                }
            }
            var src = pool[next];
            next = (next + 1) % pool.Count;
            return src;
        }
    }
}
