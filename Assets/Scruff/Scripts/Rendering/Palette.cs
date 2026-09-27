using UnityEngine;

namespace Scruff
{
    /// <summary>The game's colour palette. Muted, slightly grimy, with punchy accents for money and product.</summary>
    public static class Palette
    {
        // World
        public static readonly Color Grass = new Color(0.36f, 0.52f, 0.28f);
        public static readonly Color GrassDark = new Color(0.29f, 0.43f, 0.23f);
        public static readonly Color Asphalt = new Color(0.22f, 0.22f, 0.24f);
        public static readonly Color RoadLine = new Color(0.92f, 0.82f, 0.35f);
        public static readonly Color Sidewalk = new Color(0.62f, 0.61f, 0.58f);
        public static readonly Color Curb = new Color(0.52f, 0.51f, 0.49f);
        public static readonly Color Brick = new Color(0.62f, 0.33f, 0.26f);
        public static readonly Color BrickDark = new Color(0.48f, 0.25f, 0.21f);
        public static readonly Color Concrete = new Color(0.58f, 0.57f, 0.55f);
        public static readonly Color ConcreteDark = new Color(0.40f, 0.40f, 0.40f);
        public static readonly Color Plaster = new Color(0.82f, 0.78f, 0.68f);
        public static readonly Color PlasterDirty = new Color(0.70f, 0.66f, 0.56f);
        public static readonly Color Siding = new Color(0.55f, 0.66f, 0.72f);
        public static readonly Color SidingYellow = new Color(0.86f, 0.78f, 0.52f);
        public static readonly Color SidingGreen = new Color(0.55f, 0.68f, 0.52f);
        public static readonly Color Roof = new Color(0.30f, 0.27f, 0.28f);
        public static readonly Color WindowDay = new Color(0.58f, 0.70f, 0.78f);
        public static readonly Color WindowNight = new Color(1.0f, 0.86f, 0.52f);
        public static readonly Color Door = new Color(0.36f, 0.24f, 0.17f);
        public static readonly Color Wood = new Color(0.62f, 0.45f, 0.30f);
        public static readonly Color WoodDark = new Color(0.42f, 0.30f, 0.20f);
        public static readonly Color WoodLight = new Color(0.78f, 0.62f, 0.44f);
        public static readonly Color Metal = new Color(0.55f, 0.58f, 0.62f);
        public static readonly Color MetalDark = new Color(0.25f, 0.27f, 0.30f);
        public static readonly Color Floor = new Color(0.55f, 0.44f, 0.33f);
        public static readonly Color Carpet = new Color(0.42f, 0.36f, 0.40f);
        public static readonly Color Wall = new Color(0.78f, 0.74f, 0.64f);
        public static readonly Color TreeTrunk = new Color(0.40f, 0.29f, 0.20f);
        public static readonly Color Leaves = new Color(0.30f, 0.50f, 0.25f);
        public static readonly Color LeavesLight = new Color(0.40f, 0.60f, 0.30f);
        public static readonly Color Dumpster = new Color(0.20f, 0.42f, 0.30f);
        public static readonly Color LampGlow = new Color(1.0f, 0.88f, 0.60f);

        // Player & UI
        public static readonly Color UIBackground = new Color(0.09f, 0.10f, 0.12f);
        public static readonly Color UIPanel = new Color(0.15f, 0.16f, 0.19f);
        public static readonly Color UIPanelLight = new Color(0.22f, 0.24f, 0.28f);
        public static readonly Color UIButton = new Color(0.26f, 0.28f, 0.33f);
        public static readonly Color UIButtonActive = new Color(0.30f, 0.62f, 0.40f);
        public static readonly Color UIButtonDanger = new Color(0.72f, 0.27f, 0.25f);
        public static readonly Color UIButtonDisabled = new Color(0.18f, 0.18f, 0.20f);
        public static readonly Color UIText = new Color(0.94f, 0.94f, 0.92f);
        public static readonly Color UITextDim = new Color(0.62f, 0.64f, 0.68f);
        public static readonly Color UIAccent = new Color(0.45f, 0.88f, 0.50f);
        public static readonly Color UIWarning = new Color(1.0f, 0.78f, 0.30f);
        public static readonly Color UIDanger = new Color(1.0f, 0.42f, 0.38f);
        public static readonly Color Money = new Color(0.45f, 0.85f, 0.45f);
        public static readonly Color Xp = new Color(0.55f, 0.75f, 1.0f);

        // Characters
        public static readonly Color[] SkinTones =
        {
            new Color(0.96f, 0.80f, 0.69f),
            new Color(0.91f, 0.72f, 0.57f),
            new Color(0.80f, 0.60f, 0.45f),
            new Color(0.63f, 0.45f, 0.32f),
            new Color(0.47f, 0.33f, 0.24f),
            new Color(0.36f, 0.25f, 0.18f),
        };

        public static readonly Color[] HairColors =
        {
            new Color(0.10f, 0.08f, 0.07f),
            new Color(0.28f, 0.18f, 0.10f),
            new Color(0.50f, 0.33f, 0.18f),
            new Color(0.80f, 0.65f, 0.38f),
            new Color(0.60f, 0.22f, 0.12f),
            new Color(0.70f, 0.70f, 0.72f),
        };

        public static readonly Color[] ClothingColors =
        {
            new Color(0.80f, 0.25f, 0.22f),
            new Color(0.22f, 0.40f, 0.72f),
            new Color(0.25f, 0.55f, 0.35f),
            new Color(0.92f, 0.75f, 0.25f),
            new Color(0.55f, 0.35f, 0.65f),
            new Color(0.90f, 0.90f, 0.88f),
            new Color(0.18f, 0.18f, 0.20f),
            new Color(0.95f, 0.55f, 0.25f),
            new Color(0.40f, 0.62f, 0.70f),
            new Color(0.70f, 0.40f, 0.45f),
        };

        public static readonly Color[] PantsColors =
        {
            new Color(0.22f, 0.28f, 0.42f),
            new Color(0.15f, 0.15f, 0.17f),
            new Color(0.45f, 0.40f, 0.32f),
            new Color(0.35f, 0.36f, 0.38f),
            new Color(0.30f, 0.36f, 0.26f),
        };

        public static readonly Color PoliceBlue = new Color(0.14f, 0.20f, 0.38f);
        public static readonly Color PoliceShirt = new Color(0.30f, 0.40f, 0.62f);
        public static readonly Color Badge = new Color(0.95f, 0.80f, 0.30f);
    }
}
