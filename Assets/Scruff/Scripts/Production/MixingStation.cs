using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Put up to four loose units of product on the tray and one additive in the cup, check the preview on the
    /// screen, hit MIX. Each additive adds an effect (and can transform existing effects) which raises value.
    /// </summary>
    public class MixingStation : MonoBehaviour
    {
        ItemSocket[] productSlots;
        ItemSocket additiveSlot;
        PokeButton mixButton;
        TextBlock title;
        TextBlock body;
        Transform bowl;
        ParticleSystem sparkles;
        AudioSource whir;
        GameObject lockedCover;
        float mixTimer = -1f;
        float refreshTimer;

        public bool Unlocked { get; private set; }

        public static MixingStation Create(Transform parent, Vector3 position, float yaw)
        {
            var root = new GameObject("Mixing Station");
            root.transform.SetParent(parent, false);
            root.transform.localPosition = position;
            root.transform.localRotation = Quaternion.Euler(0f, yaw, 0f);
            var station = root.AddComponent<MixingStation>();
            station.Build();
            return station;
        }

        void Build()
        {
            const float h = 0.62f;
            Geo.Mesh("Body", transform, b =>
            {
                Geo.Table(b, transform, Vector3.zero, new Vector2(0.95f, 0.55f), h, Palette.WoodLight, Palette.WoodDark);
                // tray
                b.AddBox(new Vector3(-0.2f, h + 0.008f, 0.1f), new Vector3(0.48f, 0.016f, 0.16f), Quaternion.identity, Palette.MetalDark, Palette.Metal);
                // additive cup pad
                b.AddCylinder(new Vector3(0.3f, h, 0.12f), 0.06f, 0.012f, 10, Palette.MetalDark);
                // machine body + console
                b.AddBox(new Vector3(0.05f, h + 0.13f, -0.15f), new Vector3(0.32f, 0.26f, 0.2f), Quaternion.identity, new Color(0.75f, 0.35f, 0.3f), new Color(0.8f, 0.4f, 0.35f));
                b.AddBox(new Vector3(0.32f, h + 0.17f, -0.17f), new Vector3(0.28f, 0.34f, 0.06f), Quaternion.Euler(-12f, 0f, 0f), Palette.MetalDark, Palette.MetalDark);
            });
            Geo.Solid(transform, new Vector3(0.05f, h + 0.13f, -0.15f), new Vector3(0.32f, 0.26f, 0.2f), SurfaceSound.Metal);

            bowl = Geo.Mesh("Bowl", transform, b =>
            {
                b.AddFrustum(Vector3.zero, 0.07f, 0.1f, 0.08f, 10, Palette.Metal, capTop: false);
                b.AddBox(new Vector3(0f, 0.05f, 0f), new Vector3(0.12f, 0.01f, 0.02f), Palette.MetalDark);
            }, new Vector3(0.05f, h + 0.26f, -0.15f)).transform;

            productSlots = new ItemSocket[4];
            for (int i = 0; i < 4; i++)
            {
                var slot = Util.CreateChild(transform, "ProductSlot" + i, new Vector3(-0.38f + i * 0.12f, h + 0.017f, 0.1f)).gameObject.AddComponent<ItemSocket>();
                slot.radius = 0.07f;
                slot.saveKey = "mixer_product_" + i;
                slot.Filter = g => g is Item it && it.IsProductUnit;
                slot.Inserted += _ => Refresh();
                slot.Removed += _ => Refresh();
                productSlots[i] = slot;
            }
            additiveSlot = Util.CreateChild(transform, "AdditiveSlot", new Vector3(0.3f, h + 0.012f, 0.12f)).gameObject.AddComponent<ItemSocket>();
            additiveSlot.radius = 0.1f;
            additiveSlot.saveKey = "mixer_additive";
            additiveSlot.Filter = g => g is Item it && it.Def != null && it.Def.Category == ItemCategory.Additive;
            additiveSlot.Inserted += _ => Refresh();
            additiveSlot.Removed += _ => Refresh();

            var ui = Geo.UIRoot(transform, new Vector3(0.32f, h + 0.17f, -0.135f), 12f);
            UIFactory.Panel(ui, new Vector2(0.26f, 0.3f), Palette.UIBackground, new Vector3(0f, 0f, 0.002f));
            title = UIFactory.Text(ui, "MIXER", 0.018f, Palette.UIAccent, new Vector3(0f, 0.125f, 0f));
            body = UIFactory.Text(ui, "", 0.0125f, Palette.UIText, new Vector3(0f, 0.1f, 0f), TextBlock.HAlign.Center, TextBlock.VAlign.Top, 0.24f);
            mixButton = UIFactory.Button(ui, "MIX", new Vector2(0.14f, 0.045f), Palette.UIButtonActive, new Vector3(0f, -0.115f, -0.004f), OnMixPressed, 0.02f);

            sparkles = FX.CreateAmbient(bowl, new Color(1f, 0.85f, 1f), 30f, 0.01f, 0.6f, -0.1f);
            sparkles.transform.localPosition = new Vector3(0f, 0.08f, 0f);
            whir = AudioManager.CreateLoop(bowl, "whir", 6f);

            lockedCover = BuildLockedCover(transform, "Mixing Station", "Buy on the laptop (Rank 1)", h);
            SetUnlocked(false);
        }

        public static GameObject BuildLockedCover(Transform parent, string name, string hint, float h)
        {
            var cover = new GameObject("LockedCover");
            cover.transform.SetParent(parent, false);
            Geo.Mesh("Tarp", cover.transform, b =>
            {
                Color tarp = new Color(0.25f, 0.35f, 0.55f);
                b.AddBox(new Vector3(0f, h + 0.2f, -0.02f), new Vector3(1.0f, 0.42f, 0.6f), Quaternion.identity, tarp, Color.Lerp(tarp, Color.white, 0.1f));
            });
            var ui = Geo.UIRoot(cover.transform, new Vector3(0f, h + 0.25f, 0.285f));
            UIFactory.Panel(ui, new Vector2(0.5f, 0.14f), Palette.UIBackground, new Vector3(0f, 0f, 0.002f));
            UIFactory.Text(ui, name, 0.024f, Palette.UIWarning, new Vector3(0f, 0.03f, 0f));
            UIFactory.Text(ui, hint, 0.016f, Palette.UITextDim, new Vector3(0f, -0.025f, 0f));
            return cover;
        }

        public void SetUnlocked(bool value)
        {
            Unlocked = value;
            lockedCover.SetActive(!value);
            foreach (var s in productSlots) s.enabled = value;
            additiveSlot.enabled = value;
            mixButton.gameObject.SetActive(value);
            Refresh();
        }

        Item Additive => additiveSlot.Occupant as Item;

        void Update()
        {
            refreshTimer -= Time.deltaTime;
            if (refreshTimer <= 0f)
            {
                refreshTimer = 0.5f;
                Refresh();
            }

            if (mixTimer >= 0f)
            {
                mixTimer += Time.deltaTime;
                bowl.localRotation = Quaternion.Euler(0f, mixTimer * 900f, 0f);
                whir.volume = Mathf.MoveTowards(whir.volume, 0.5f, Time.deltaTime * 3f);
                if (mixTimer >= 2.2f) FinishMix();
            }
            else if (whir.volume > 0f)
            {
                whir.volume = Mathf.MoveTowards(whir.volume, 0f, Time.deltaTime * 2f);
            }
        }

        void Refresh()
        {
            if (!Unlocked || body == null) return;
            if (mixTimer >= 0f)
            {
                body.Text = "\nMixing...";
                mixButton.SetInteractable(false);
                return;
            }
            Item first = null;
            int count = 0;
            foreach (var s in productSlots)
            {
                if (s.Occupant is Item it && it.Product != null)
                {
                    count++;
                    if (first == null) first = it;
                }
            }
            var additive = Additive;
            if (first == null)
            {
                body.Text = "Put loose product (buds or crystal) on the tray.\n\nThen add a mixer from the corner store.";
                mixButton.SetInteractable(false);
                return;
            }
            if (additive == null)
            {
                body.Text = $"{first.Product.DisplayName} x{count}\n{ProductCatalog.EffectsText(first.Product)}\n\nAdd a mixer to the cup.";
                mixButton.SetInteractable(false);
                return;
            }
            var result = ProductCatalog.Mix(first.Product, additive.Def.EffectId);
            int before = ProductCatalog.AskingPrice(first.Product);
            int after = ProductCatalog.AskingPrice(result);
            string delta = after >= before ? $"<#77ee77>+${after - before}</>" : $"<#ff6655>-${before - after}</>";
            body.Text = $"{first.Product.DisplayName}\n<#aaaaaa>becomes</>\n<#ffdd77>{result.DisplayName}</>\n{ProductCatalog.EffectsText(result)}\n\n${before} -> ${after} each ({delta})";
            mixButton.SetInteractable(true);
        }

        void OnMixPressed()
        {
            if (mixTimer >= 0f || Additive == null) return;
            bool any = false;
            foreach (var s in productSlots)
                if (s.Occupant is Item it && it.Product != null) any = true;
            if (!any) return;
            mixTimer = 0f;
            FX.SetEmitting(sparkles, true);
            Refresh();
        }

        void FinishMix()
        {
            mixTimer = -1f;
            FX.SetEmitting(sparkles, false);
            var additive = Additive;
            if (additive == null)
            {
                Refresh();
                return;
            }
            string effect = additive.Def.EffectId;
            int mixed = 0;
            foreach (var s in productSlots)
            {
                if (s.Occupant is Item it && it.Product != null)
                {
                    it.Product = ProductCatalog.Mix(it.Product, effect);
                    FX.Burst(it.transform.position + Vector3.up * 0.03f, ProductCatalog.Effect(effect)?.Color ?? Color.white, 6, 0.5f);
                    mixed++;
                }
            }
            additiveSlot.Remove(additive);
            Destroy(additive.gameObject);
            AudioManager.Play("success", transform.position, 0.5f);
            Game.Progression?.AddXp(3 * mixed);
            GameEvents.Raise(GameEventType.ProductMixed, mixed);
            Refresh();
        }
    }
}
