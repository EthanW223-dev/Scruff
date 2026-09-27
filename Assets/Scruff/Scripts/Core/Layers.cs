using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Physics layers. Names are defined in ProjectSettings/TagManager.asset (and re-applied by the editor
    /// setup script), but everything works off the indices so it keeps working even if the names are missing.
    /// </summary>
    public static class Layers
    {
        public const int Default = 0;          // Solid world geometry. The only layer gorilla locomotion pushes off.
        public const int IgnoreRaycast = 2;
        public const int PlayerBody = 8;       // Local player's head/body colliders.
        public const int PlayerHand = 9;       // Reserved for hand visuals (no colliders by default).
        public const int Item = 10;            // Physical, grabbable items.
        public const int NPC = 11;             // NPC bodies.
        public const int Interactable = 12;    // Query-only volumes: buttons, dispensers, dials, trade zones.

        public const int EnvironmentMask = 1 << Default;
        public const int LocomotionMask = 1 << Default;
        public const int ItemMask = 1 << Item;
        public const int GrabMask = (1 << Item) | (1 << Interactable);
        public const int NPCMask = 1 << NPC;
        public const int SightBlockMask = 1 << Default;

        public static void ConfigurePhysics()
        {
            // The player's body must never be shoved by things it holds or by NPCs.
            Physics.IgnoreLayerCollision(PlayerBody, Item, true);
            Physics.IgnoreLayerCollision(PlayerBody, NPC, true);
            Physics.IgnoreLayerCollision(PlayerBody, PlayerBody, true);

            // Hands and interactables are query-only; they never take part in the simulation.
            for (int i = 0; i < 32; i++)
            {
                Physics.IgnoreLayerCollision(PlayerHand, i, true);
                Physics.IgnoreLayerCollision(Interactable, i, true);
            }
        }

        public static void SetLayerRecursively(GameObject go, int layer)
        {
            go.layer = layer;
            foreach (Transform child in go.transform)
                SetLayerRecursively(child.gameObject, layer);
        }
    }
}
