using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// A computer screen that sells one catalog. Poke an item to buy it: physical items pop out at the delivery
    /// spot, restocks/unlocks apply immediately. Items above your rank show as locked.
    /// </summary>
    public class ShopTerminal : MonoBehaviour
    {
        const int RowsPerPage = 5;

        public ShopCatalog catalog;
        public Transform deliveryPoint;
        public string title = "SHOP";

        Transform ui;
        Transform listRoot;
        TextBlock header;
        TextBlock footer;
        TextBlock pageLabel;
        int page;
        readonly List<ItemDefinition> entries = new List<ItemDefinition>();
        int deliveryIndex;
        int lastCash = -1;
        int lastRank = -1;

        public static ShopTerminal Create(Transform parent, Vector3 position, float yaw, ShopCatalog catalog, string title, Transform delivery, bool standing)
        {
            var root = new GameObject(title + " Terminal");
            root.transform.SetParent(parent, false);
            root.transform.localPosition = position;
            root.transform.localRotation = Quaternion.Euler(0f, yaw, 0f);
            var t = root.AddComponent<ShopTerminal>();
            t.catalog = catalog;
            t.title = title;
            t.deliveryPoint = delivery;
            t.Build(standing);
            return t;
        }

        void Build(bool standing)
        {
            float screenY;
            if (standing)
            {
                // kiosk on a post
                Geo.Mesh("Kiosk", transform, b =>
                {
                    b.AddBox(new Vector3(0f, 0.5f, -0.05f), new Vector3(0.2f, 1.0f, 0.15f), Quaternion.identity, new Color(0.3f, 0.5f, 0.75f), new Color(0.3f, 0.5f, 0.75f));
                    b.AddBox(new Vector3(0f, 1.05f, -0.08f), new Vector3(0.72f, 0.55f, 0.08f), Quaternion.Euler(-10f, 0f, 0f), new Color(0.2f, 0.22f, 0.26f), new Color(0.2f, 0.22f, 0.26f));
                    b.AddBox(new Vector3(0f, 0.02f, -0.05f), new Vector3(0.4f, 0.04f, 0.3f), new Color(0.2f, 0.22f, 0.26f));
                });
                Geo.Solid(transform, new Vector3(0f, 0.5f, -0.05f), new Vector3(0.2f, 1.0f, 0.15f), SurfaceSound.Metal);
                screenY = 1.05f;
            }
            else
            {
                // desk + chunky monitor (big enough to poke comfortably)
                Geo.Mesh("Desk", transform, b =>
                {
                    Geo.Table(b, transform, Vector3.zero, new Vector2(0.9f, 0.55f), 0.6f, Palette.WoodDark, Palette.MetalDark);
                    b.AddBox(new Vector3(0f, 0.63f, -0.12f), new Vector3(0.2f, 0.03f, 0.15f), Palette.MetalDark);
                    b.AddBox(new Vector3(0f, 0.72f, -0.16f), new Vector3(0.05f, 0.18f, 0.04f), Palette.MetalDark);
                    b.AddBox(new Vector3(0f, 0.95f, -0.15f), new Vector3(0.72f, 0.5f, 0.06f), Quaternion.Euler(-8f, 0f, 0f), new Color(0.16f, 0.17f, 0.2f), new Color(0.16f, 0.17f, 0.2f));
                    b.AddBox(new Vector3(0.05f, 0.615f, 0.12f), new Vector3(0.36f, 0.02f, 0.13f), new Color(0.25f, 0.26f, 0.3f));
                });
                screenY = 0.95f;
            }

            ui = Geo.UIRoot(transform, new Vector3(0f, screenY, standing ? -0.035f : -0.115f), standing ? 10f : 8f);
            UIFactory.Panel(ui, new Vector2(0.68f, 0.47f), Palette.UIBackground, new Vector3(0f, 0f, 0.002f));
            header = UIFactory.Text(ui, title, 0.022f, Palette.UIAccent, new Vector3(-0.32f, 0.205f, 0f), TextBlock.HAlign.Left);
            footer = UIFactory.Text(ui, "", 0.014f, Palette.UIText, new Vector3(0.32f, 0.205f, 0f), TextBlock.HAlign.Right);
            listRoot = Util.CreateChild(ui, "List");
            pageLabel = UIFactory.Text(ui, "", 0.013f, Palette.UITextDim, new Vector3(0f, -0.205f, 0f));
            UIFactory.Button(ui, "< PREV", new Vector2(0.12f, 0.04f), Palette.UIButton, new Vector3(-0.26f, -0.205f, -0.004f), () => ChangePage(-1), 0.014f);
            UIFactory.Button(ui, "NEXT >", new Vector2(0.12f, 0.04f), Palette.UIButton, new Vector3(0.26f, -0.205f, -0.004f), () => ChangePage(1), 0.014f);
            Rebuild();
        }

        void ChangePage(int delta)
        {
            int pages = Mathf.Max(1, Mathf.CeilToInt(entries.Count / (float)RowsPerPage));
            page = (page + delta + pages) % pages;
            Rebuild();
        }

        void Update()
        {
            if (Game.State == null) return;
            int rank = Game.Progression != null ? Game.Progression.Rank : 0;
            if (Game.State.cash != lastCash || rank != lastRank) Rebuild();
        }

        void Rebuild()
        {
            entries.Clear();
            foreach (var d in ItemDatabase.All)
                if (d.Catalog == catalog) entries.Add(d);

            lastCash = Game.State != null ? Game.State.cash : 0;
            lastRank = Game.Progression != null ? Game.Progression.Rank : 0;
            footer.Text = $"Cash <#77ee77>{Util.Money(lastCash)}</>";

            for (int i = listRoot.childCount - 1; i >= 0; i--) Destroy(listRoot.GetChild(i).gameObject);

            int pages = Mathf.Max(1, Mathf.CeilToInt(entries.Count / (float)RowsPerPage));
            page = Mathf.Clamp(page, 0, pages - 1);
            pageLabel.Text = $"Page {page + 1}/{pages}";

            for (int row = 0; row < RowsPerPage; row++)
            {
                int index = page * RowsPerPage + row;
                if (index >= entries.Count) break;
                var def = entries[index];
                float y = 0.14f - row * 0.07f;
                bool rankLocked = def.UnlockRank > lastRank;
                bool owned = def.CanPurchase != null && !def.CanPurchase();
                bool affordable = lastCash >= def.Price;

                UIFactory.Panel(listRoot, new Vector2(0.64f, 0.062f), Palette.UIPanel, new Vector3(0f, y, 0.001f), 0.002f);
                string name = rankLocked ? $"<#888888>{def.DisplayShopName}</>" : def.DisplayShopName;
                UIFactory.Text(listRoot, name, 0.016f, Palette.UIText, new Vector3(-0.305f, y + 0.012f, 0f), TextBlock.HAlign.Left);
                string desc = rankLocked ? $"<#ffaa55>Needs rank: {Progression.RankNames[Mathf.Min(def.UnlockRank, Progression.RankNames.Length - 1)]}</>" : def.Description;
                UIFactory.Text(listRoot, desc, 0.0105f, Palette.UITextDim, new Vector3(-0.305f, y - 0.015f, 0f), TextBlock.HAlign.Left, TextBlock.VAlign.Middle, 0.42f);

                string label = owned ? "OWNED" : rankLocked ? "LOCKED" : $"${def.Price}";
                Color color = owned || rankLocked ? Palette.UIButtonDisabled : affordable ? Palette.UIButtonActive : Palette.UIButtonDanger;
                var d = def;
                var button = UIFactory.Button(listRoot, label, new Vector2(0.12f, 0.046f), color, new Vector3(0.245f, y, -0.004f), () => Buy(d), 0.017f);
                button.SetInteractable(!owned && !rankLocked);
            }
        }

        void Buy(ItemDefinition def)
        {
            if (Game.State == null) return;
            if (def.UnlockRank > (Game.Progression?.Rank ?? 0)) return;
            if (def.CanPurchase != null && !def.CanPurchase()) return;
            if (!Game.Wallet.TrySpend(def.Price))
            {
                AudioManager.Play("error", ui.position, 0.5f);
                Game.UI?.Notify("Can't afford that", $"{def.DisplayShopName} costs ${def.Price}", Palette.UIDanger);
                return;
            }

            if (def.IsPhysical)
            {
                Vector3 p = deliveryPoint != null ? deliveryPoint.position : transform.position + transform.forward * 0.5f + Vector3.up;
                // spread deliveries out so they don't spawn inside each other
                float a = deliveryIndex++ * 2.39996f;
                p += new Vector3(Mathf.Cos(a), 0f, Mathf.Sin(a)) * 0.12f * Mathf.Min(3, deliveryIndex % 6) + Vector3.up * 0.05f;
                ItemFactory.Spawn(def.Id, p, Quaternion.Euler(0f, Random.Range(0f, 360f), 0f));
                FX.Burst(p, Palette.UIAccent, 10, 0.8f);
                AudioManager.Play("pop", p, 0.6f);
            }
            else
            {
                def.OnPurchase?.Invoke();
            }
            AudioManager.Play("coin", ui.position, 0.6f);
            GameEvents.Raise(GameEventType.ItemPurchased, def);
            Rebuild();
        }
    }
}
