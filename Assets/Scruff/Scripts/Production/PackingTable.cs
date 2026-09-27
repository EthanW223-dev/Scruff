using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Work table with a baggie box and a jar crate. Grab from them to take an empty container
    /// (stock is bought on the laptop). Drop buds/crystals into the container to package them.
    /// </summary>
    public class PackingTable : MonoBehaviour
    {
        TextBlock baggieLabel;
        TextBlock jarLabel;
        float refresh;

        public static PackingTable Create(Transform parent, Vector3 position, float yaw)
        {
            var root = new GameObject("Packing Table");
            root.transform.SetParent(parent, false);
            root.transform.localPosition = position;
            root.transform.localRotation = Quaternion.Euler(0f, yaw, 0f);
            var t = root.AddComponent<PackingTable>();
            t.Build();
            return t;
        }

        void Build()
        {
            const float h = 0.62f;
            Geo.Mesh("Body", transform, b =>
            {
                Geo.Table(b, transform, Vector3.zero, new Vector2(1.1f, 0.6f), h, Palette.Wood, Palette.WoodDark);
                // cutting mat
                b.AddBox(new Vector3(0.05f, h + 0.003f, 0.05f), new Vector3(0.45f, 0.006f, 0.32f), Quaternion.identity, new Color(0.2f, 0.45f, 0.35f), new Color(0.25f, 0.55f, 0.42f));
                // baggie box (open top, baggies poking out)
                b.AddBox(new Vector3(-0.38f, h + 0.06f, -0.1f), new Vector3(0.2f, 0.12f, 0.14f), Quaternion.identity, new Color(0.85f, 0.8f, 0.7f), new Color(0.3f, 0.28f, 0.25f));
                for (int i = 0; i < 4; i++)
                    b.AddBox(new Vector3(-0.44f + i * 0.04f, h + 0.13f, -0.1f), new Vector3(0.035f, 0.05f, 0.1f), Quaternion.Euler(0f, 0f, (i - 1.5f) * 6f), new Color(0.86f, 0.9f, 0.94f));
                // jar crate
                b.AddBox(new Vector3(0.4f, h + 0.05f, -0.12f), new Vector3(0.22f, 0.1f, 0.2f), Quaternion.identity, Palette.WoodDark, new Color(0.2f, 0.15f, 0.1f));
                for (int i = 0; i < 4; i++)
                    b.AddCylinder(new Vector3(0.35f + (i % 2) * 0.1f, h + 0.07f, -0.17f + (i / 2) * 0.1f), 0.035f, 0.08f, 8, new Color(0.7f, 0.82f, 0.9f), null, new Color(0.18f, 0.2f, 0.22f));
            });

            var baggies = Geo.Touch(transform, new Vector3(-0.38f, h + 0.1f, -0.1f), new Vector3(0.22f, 0.16f, 0.16f)).gameObject.AddComponent<ItemDispenser>();
            baggies.itemId = "baggie";
            baggies.CanDispense = () => Game.State != null && Game.State.baggieStock > 0;
            baggies.Dispensed = () => Game.State.baggieStock--;
            baggies.Label = () => Game.State == null ? "Baggies" : Game.State.baggieStock > 0 ? $"Baggies ({Game.State.baggieStock} left)\n<#aaaaaa>Holds 1 unit</>" : "Out of baggies\n<#aaaaaa>Buy more on the laptop</>";

            var jars = Geo.Touch(transform, new Vector3(0.4f, h + 0.1f, -0.12f), new Vector3(0.24f, 0.14f, 0.22f)).gameObject.AddComponent<ItemDispenser>();
            jars.itemId = "jar";
            jars.CanDispense = () => Game.State != null && Game.State.jarStock > 0;
            jars.Dispensed = () => Game.State.jarStock--;
            jars.Label = () => Game.State == null ? "Jars" : Game.State.jarStock > 0 ? $"Jars ({Game.State.jarStock} left)\n<#aaaaaa>Holds 5 units</>" : "Out of jars\n<#aaaaaa>Buy more on the laptop (Rank 1)</>";

            var ui = Geo.UIRoot(transform, new Vector3(0f, h + 0.42f, -0.29f), 0f);
            UIFactory.Panel(ui, new Vector2(0.62f, 0.2f), Palette.UIBackground, new Vector3(0f, 0f, 0.002f));
            UIFactory.Text(ui, "PACKING", 0.02f, Palette.UIAccent, new Vector3(0f, 0.07f, 0f));
            UIFactory.Text(ui, "Grab a baggie or jar, then drop buds/crystal into it.\nCustomers only buy packaged product.", 0.0125f, Palette.UIText, new Vector3(0f, 0.02f, 0f), TextBlock.HAlign.Center, TextBlock.VAlign.Middle, 0.58f);
            baggieLabel = UIFactory.Text(ui, "", 0.014f, Palette.UIText, new Vector3(-0.15f, -0.06f, 0f));
            jarLabel = UIFactory.Text(ui, "", 0.014f, Palette.UIText, new Vector3(0.15f, -0.06f, 0f));
            // back board holding the sign
            Geo.Mesh("SignPost", transform, b => b.AddBox(new Vector3(0f, h + 0.21f, -0.3f), new Vector3(0.05f, 0.42f, 0.02f), Palette.WoodDark));
        }

        void Update()
        {
            refresh -= Time.deltaTime;
            if (refresh > 0f || Game.State == null) return;
            refresh = 0.5f;
            baggieLabel.Text = $"Baggies: {(Game.State.baggieStock > 0 ? Game.State.baggieStock.ToString() : "<#ff6655>0</>")}";
            jarLabel.Text = $"Jars: {(Game.State.jarStock > 0 ? Game.State.jarStock.ToString() : "<#ff6655>0</>")}";
        }
    }
}
