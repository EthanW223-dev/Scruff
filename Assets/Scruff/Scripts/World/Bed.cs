using UnityEngine;

namespace Scruff
{
    /// <summary>Sleep to skip the night (after 6 PM). Sleeping saves the game.</summary>
    public class Bed : MonoBehaviour
    {
        PokeButton sleepButton;
        TextBlock hint;
        float refresh;

        public static Bed Create(Transform parent, Vector3 position, float yaw)
        {
            var root = new GameObject("Bed");
            root.transform.SetParent(parent, false);
            root.transform.localPosition = position;
            root.transform.localRotation = Quaternion.Euler(0f, yaw, 0f);
            var bed = root.AddComponent<Bed>();
            bed.Build();
            return bed;
        }

        void Build()
        {
            Geo.Mesh("Body", transform, b =>
            {
                // frame, mattress, blanket, pillow (bed runs along local Z)
                b.AddBox(new Vector3(0f, 0.12f, 0f), new Vector3(1.0f, 0.24f, 2.0f), Quaternion.identity, Palette.WoodDark, Palette.WoodDark);
                b.AddBox(new Vector3(0f, 0.3f, 0f), new Vector3(0.94f, 0.14f, 1.94f), Quaternion.identity, new Color(0.85f, 0.85f, 0.82f), new Color(0.9f, 0.9f, 0.88f));
                b.AddBox(new Vector3(0f, 0.38f, 0.25f), new Vector3(0.97f, 0.04f, 1.4f), Quaternion.identity, new Color(0.35f, 0.42f, 0.6f), new Color(0.4f, 0.48f, 0.68f));
                b.AddBox(new Vector3(0f, 0.41f, -0.72f), new Vector3(0.6f, 0.1f, 0.3f), new Color(0.95f, 0.95f, 0.93f));
                b.AddBox(new Vector3(0f, 0.45f, -0.99f), new Vector3(1.0f, 0.9f, 0.05f), Palette.WoodDark);
            });
            Geo.Solid(transform, new Vector3(0f, 0.2f, 0f), new Vector3(1.0f, 0.4f, 2.0f), SurfaceSound.Grass);
            Geo.Solid(transform, new Vector3(0f, 0.45f, -0.99f), new Vector3(1.0f, 0.9f, 0.05f), SurfaceSound.Wood);

            // Sign on the headboard
            var ui = Geo.UIRoot(transform, new Vector3(0f, 0.72f, -0.96f), 0f, "SleepUI");
            UIFactory.Panel(ui, new Vector2(0.4f, 0.2f), Palette.UIBackground, new Vector3(0f, 0f, 0.002f));
            UIFactory.Text(ui, "BED", 0.02f, Palette.UIAccent, new Vector3(0f, 0.07f, 0f));
            hint = UIFactory.Text(ui, "", 0.012f, Palette.UITextDim, new Vector3(0f, 0.035f, 0f), TextBlock.HAlign.Center, TextBlock.VAlign.Middle, 0.36f);
            sleepButton = UIFactory.Button(ui, "SLEEP", new Vector2(0.18f, 0.05f), Palette.UIButtonActive, new Vector3(0f, -0.04f, -0.004f), () => Game.Manager?.Sleep());
        }

        void Update()
        {
            refresh -= Time.deltaTime;
            if (refresh > 0f || Game.Clock == null) return;
            refresh = 0.5f;
            bool can = Game.Manager != null && Game.Manager.CanSleep;
            sleepButton.SetInteractable(can);
            hint.Text = can ? "Skip to morning and save" : "You can sleep after 6 PM";
        }
    }
}
