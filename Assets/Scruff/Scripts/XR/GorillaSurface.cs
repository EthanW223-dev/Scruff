using UnityEngine;

namespace Scruff
{
    public enum SurfaceSound { Default, Wood, Metal, Grass }

    /// <summary>
    /// Optional per-collider locomotion settings, equivalent to "Surface" in the original Gorilla Locomotion.
    /// Higher slipPercentage = hands slide more (ice); lower = grippier.
    /// </summary>
    public class GorillaSurface : MonoBehaviour
    {
        [Range(0f, 1f)] public float slipPercentage = 0.03f;
        public SurfaceSound sound = SurfaceSound.Default;
        public bool overrideSlip;
    }
}
