using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// A physical, grabbable, saveable thing: tools, seeds, product, containers, ingredients.
    /// Behaviour lives in extra components (PlantPot, Pourable, ProductContainer...); this holds the shared data.
    /// </summary>
    public class Item : Grabbable
    {
        public static readonly List<Item> All = new List<Item>();

        public ItemDefinition Def { get; private set; }
        /// <summary>Loose product unit, or the contents of a container.</summary>
        public ProductData Product;
        public int Uses;
        public float Charge;

        public ProductContainer Container { get; private set; }
        public bool IsProductUnit => Def != null && Def.Category == ItemCategory.ProductUnit;
        public bool IsPackaged => Container != null && Product != null && Product.units > 0;
        public bool ContainsProduct => Product != null && Product.units > 0 && (IsProductUnit || Container != null);

        IItemState[] stateful;
        ILabelProvider[] labelProviders;
        float lastImpactTime;

        public void Setup(ItemDefinition def, ProductData product)
        {
            Def = def;
            Product = product?.Clone();
            Uses = def.StartUses;
            Charge = def.StartCharge;
            name = def.Name;
        }

        public void RefreshComponents()
        {
            Container = GetComponent<ProductContainer>();
            stateful = GetComponents<IItemState>();
            labelProviders = GetComponents<ILabelProvider>();
            CacheRenderers();
        }

        void OnEnable() => All.Add(this);

        void OnDisable() => All.Remove(this);

        public override string GetLabel()
        {
            if (labelProviders != null)
                foreach (var p in labelProviders)
                {
                    var s = p.GetLabel();
                    if (!string.IsNullOrEmpty(s)) return s;
                }
            if (Def == null) return null;

            switch (Def.Category)
            {
                case ItemCategory.ProductUnit when Product != null:
                    return $"{Product.DisplayName}\n{ProductCatalog.QualityTag(Product.quality)}  <#77ee77>~${ProductCatalog.AskingPrice(Product)}</>";
                case ItemCategory.Container:
                    if (Product == null || Product.units <= 0) return $"Empty {Def.Name}";
                    int ask = ProductCatalog.AskingPrice(Product) * Product.units;
                    return $"{Product.DisplayName} x{Product.units}\n{ProductCatalog.QualityTag(Product.quality)}  <#77ee77>${ask}</>";
                case ItemCategory.SeedPacket:
                    return Uses > 0 ? $"{Def.Name} ({Uses} left)\n<#aaaaaa>Tip over a pot of soil</>" : $"Empty {Def.Name}";
                case ItemCategory.Soil:
                    return Charge > 0.01f ? $"{Def.Name} ({Charge:0.#} pots)\n<#aaaaaa>Tip over an empty pot</>" : $"Empty {Def.Name}";
                case ItemCategory.Additive:
                    var e = ProductCatalog.Effect(Def.EffectId);
                    return e != null ? $"{Def.Name}\n<#{ColorUtility.ToHtmlStringRGB(e.Color)}>{e.Name}</> <#aaaaaa>({(e.ValueBonus >= 0 ? "+" : "")}{e.ValueBonus * 100f:0}%)</>" : Def.Name;
                case ItemCategory.Tool when Def.Id == "watering_can":
                    return $"{Def.Name} {Mathf.RoundToInt(Charge * 100f)}%" + (Charge < 0.05f ? "\n<#aaaaaa>Refill at the sink</>" : "");
                case ItemCategory.Tool when Def.Id == "fertilizer":
                    return $"{Def.Name} {Mathf.RoundToInt(Charge * 100f)}%";
                case ItemCategory.Seed:
                    return Def.Name;
                default:
                    return Def.Name;
            }
        }

        void OnCollisionEnter(Collision c)
        {
            float speed = c.relativeVelocity.magnitude;
            if (speed < 1.1f || Time.time - lastImpactTime < 0.12f) return;
            lastImpactTime = Time.time;
            float massPitch = Mathf.Lerp(1.5f, 0.7f, Mathf.InverseLerp(0.02f, 3f, Body != null ? Body.mass : 0.3f));
            AudioManager.Play("thud", c.contactCount > 0 ? c.GetContact(0).point : transform.position, Mathf.Clamp(speed / 7f, 0.05f, 0.6f), massPitch * Random.Range(0.9f, 1.1f));
        }

        public ItemSaveData Capture()
        {
            var d = new ItemSaveData
            {
                id = Def.Id,
                position = transform.position,
                rotation = transform.rotation,
                hasProduct = Product != null,
                product = Product != null ? Product.Clone() : null,
                uses = Uses,
                charge = Charge,
                socketKey = Socket != null ? Socket.saveKey : null,
            };
            if (stateful != null && stateful.Length > 0) d.extra = stateful[0].CaptureState();
            return d;
        }

        public static Item Restore(ItemSaveData d)
        {
            var item = ItemFactory.Spawn(d.id, d.position, d.rotation, d.hasProduct ? d.product : null);
            if (item == null) return null;
            item.Uses = d.uses;
            item.Charge = d.charge;
            if (!string.IsNullOrEmpty(d.extra) && item.stateful != null)
                foreach (var s in item.stateful) s.RestoreState(d.extra);
            item.Container?.UpdateVisual();
            if (!string.IsNullOrEmpty(d.socketKey))
            {
                foreach (var socket in ItemSocket.All)
                {
                    if (socket.saveKey == d.socketKey && socket.Accepts(item))
                    {
                        socket.Insert(item, true);
                        break;
                    }
                }
            }
            return item;
        }
    }
}
