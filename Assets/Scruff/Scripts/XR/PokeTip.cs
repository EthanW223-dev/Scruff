using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>A fingertip that can press <see cref="PokeButton"/>s. Registered globally so buttons can query tips cheaply.</summary>
    public class PokeTip : MonoBehaviour
    {
        public static readonly List<PokeTip> All = new List<PokeTip>();

        public float radius = 0.014f;
        public PlayerHand hand;

        public Vector3 Position => transform.position;

        void OnEnable() => All.Add(this);

        void OnDisable() => All.Remove(this);

        public void Haptic(float amplitude, float duration)
        {
            if (hand != null) hand.Haptic(amplitude, duration);
        }
    }
}
