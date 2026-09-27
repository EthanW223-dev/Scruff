using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Every item in the game, with its model, physics, shop price and unlock rank. Add new items here.
    /// </summary>
    public static class ItemDatabase
    {
        static readonly Dictionary<string, ItemDefinition> defs = new Dictionary<string, ItemDefinition>();
        static readonly List<ItemDefinition> ordered = new List<ItemDefinition>();
        static bool initialized;

        public static IReadOnlyList<ItemDefinition> All
        {
            get
            {
                Init();
                return ordered;
            }
        }

        public static ItemDefinition Get(string id)
        {
            Init();
            return id != null && defs.TryGetValue(id, out var d) ? d : null;
        }

        static void Register(ItemDefinition d)
        {
            defs[d.Id] = d;
            ordered.Add(d);
        }

        static void Mesh(GameObject go, Mesh mesh) => MeshBuilder.AddRenderer(go, mesh);

        static Transform Child(GameObject go, string name, Vector3 pos) => Util.CreateChild(go.transform, name, pos);

        public static void Init()
        {
            if (initialized) return;
            initialized = true;
            ProductCatalog.Init();

            // ------------------------------------------------------------------ Growing
            Register(new ItemDefinition
            {
                Id = "pot", Name = "Plant Pot", Category = ItemCategory.Tool, Catalog = ShopCatalog.Supplies, Price = 30, Mass = 2.5f,
                Description = "Fill with soil, drop a seed in, keep it watered.",
                Build = (go, p) =>
                {
                    Mesh(go, ModelFactory.Pot());
                    ModelFactory.Box(go, new Vector3(0f, 0.1f, 0f), new Vector3(0.27f, 0.2f, 0.27f));
                },
                Configure = item => item.gameObject.AddComponent<PlantPot>(),
            });

            Register(new ItemDefinition
            {
                Id = "soil_bag", Name = "Soil Bag", Category = ItemCategory.Soil, Catalog = ShopCatalog.Supplies, Price = 20, Mass = 3f, StartCharge = 3f,
                Description = "Fills three pots. Tip it over an empty pot.",
                Build = (go, p) =>
                {
                    Mesh(go, ModelFactory.SoilBag());
                    ModelFactory.Box(go, new Vector3(0f, 0.13f, 0f), new Vector3(0.19f, 0.26f, 0.085f));
                },
                Configure = item => AddPourable(item, PourType.Soil, new Vector3(0f, 0.27f, 0f), 100f, 0.6f, new Color(0.35f, 0.25f, 0.17f)),
            });

            Register(new ItemDefinition
            {
                Id = "watering_can", Name = "Watering Can", Category = ItemCategory.Tool, Catalog = ShopCatalog.Supplies, Price = 25, Mass = 1.2f, StartCharge = 1f,
                Description = "Tilt to water plants. Refill at a sink.",
                Build = (go, p) =>
                {
                    Mesh(go, ModelFactory.WateringCan());
                    ModelFactory.Box(go, new Vector3(0f, 0.08f, 0f), new Vector3(0.14f, 0.16f, 0.14f));
                    ModelFactory.Box(go, new Vector3(0f, 0.18f, -0.06f), new Vector3(0.03f, 0.09f, 0.07f));
                },
                Configure = item => AddPourable(item, PourType.Water, new Vector3(0f, 0.215f, 0.205f), 45f, 0.3f, new Color(0.45f, 0.7f, 0.95f)),
            });

            Register(new ItemDefinition
            {
                Id = "fertilizer", Name = "Fertilizer", Category = ItemCategory.Tool, Catalog = ShopCatalog.Supplies, Price = 35, UnlockRank = 1, Mass = 0.6f, StartCharge = 1f,
                Description = "Pour a splash into a pot for better quality.",
                Build = (go, p) =>
                {
                    Mesh(go, ModelFactory.Bottle(new Color(0.35f, 0.62f, 0.45f), new Color(0.9f, 0.9f, 0.9f), 0.035f, 0.15f));
                    ModelFactory.Capsule(go, new Vector3(0f, 0.075f, 0f), 0.036f, 0.15f);
                },
                Configure = item => AddPourable(item, PourType.Fertilizer, new Vector3(0f, 0.15f, 0f), 100f, 0.25f, new Color(0.5f, 0.85f, 0.4f)),
            });

            foreach (var strain in ProductCatalog.Strains.Values)
            {
                if (string.IsNullOrEmpty(strain.SeedPacketId)) continue;
                var s = strain;
                int price = s.Id == "backyard_green" ? 15 : s.Id == "alley_purple" ? 30 : 55;
                int rank = s.Id == "backyard_green" ? 0 : s.Id == "alley_purple" ? 1 : 3;
                Register(new ItemDefinition
                {
                    Id = s.SeedPacketId, Name = s.Name + " Seeds", Category = ItemCategory.SeedPacket, Catalog = ShopCatalog.Supplies,
                    Price = price, UnlockRank = rank, Mass = 0.05f, StartUses = 3, StrainId = s.Id,
                    Description = $"3 seeds. Grows in ~{Mathf.RoundToInt(s.GrowMinutes / 60f)}h. Base ${s.BaseValue:0}/unit.",
                    Build = (go, p) =>
                    {
                        Mesh(go, ModelFactory.SeedPacket(s.Color));
                        ModelFactory.Box(go, new Vector3(0f, 0.045f, 0f), new Vector3(0.065f, 0.09f, 0.012f));
                    },
                    Configure = item =>
                    {
                        var pour = AddPourable(item, PourType.Seeds, new Vector3(0f, 0.095f, 0f), 110f, 0f, Color.white);
                        pour.seedItemId = s.SeedItemId;
                    },
                });
                Register(new ItemDefinition
                {
                    Id = s.SeedItemId, Name = s.Name + " Seed", Category = ItemCategory.Seed, Mass = 0.01f, StrainId = s.Id,
                    Build = (go, p) =>
                    {
                        Mesh(go, ModelFactory.Seed());
                        ModelFactory.Sphere(go, new Vector3(0f, 0.007f, 0f), 0.009f);
                    },
                });
            }

            // ------------------------------------------------------------------ Product
            Register(new ItemDefinition
            {
                Id = "bud", Name = "Bud", Category = ItemCategory.ProductUnit, Mass = 0.02f,
                Build = (go, p) =>
                {
                    var color = p?.Strain != null ? p.Strain.Color : new Color(0.45f, 0.68f, 0.3f);
                    Mesh(go, ModelFactory.Bud(color));
                    ModelFactory.Sphere(go, new Vector3(0f, 0.025f, 0f), 0.026f);
                },
            });
            Register(new ItemDefinition
            {
                Id = "crystal", Name = "Crystal", Category = ItemCategory.ProductUnit, Mass = 0.03f,
                Build = (go, p) =>
                {
                    var color = p?.Strain != null ? p.Strain.Color : new Color(0.45f, 0.75f, 0.95f);
                    Mesh(go, ModelFactory.Crystal(color));
                    ModelFactory.Box(go, new Vector3(0f, 0.03f, 0f), new Vector3(0.045f, 0.06f, 0.04f));
                },
            });

            // ------------------------------------------------------------------ Packaging
            Register(new ItemDefinition
            {
                Id = "baggie", Name = "Baggie", Category = ItemCategory.Container, Mass = 0.01f,
                Build = (go, p) =>
                {
                    Mesh(go, ModelFactory.Baggie());
                    ModelFactory.Box(go, new Vector3(0f, 0.045f, 0f), new Vector3(0.07f, 0.09f, 0.016f));
                    var fill = Child(go, "Fill", new Vector3(0f, 0.008f, 0f));
                    MeshBuilder.AddRenderer(fill.gameObject, ModelFactory.BagContents());
                    fill.localScale = new Vector3(0.056f, 0.06f, 0.0165f);
                },
                Configure = item => AddContainer(item, 1, new Vector3(0f, 0.095f, 0f), 0.07f),
            });
            Register(new ItemDefinition
            {
                Id = "jar", Name = "Jar", Category = ItemCategory.Container, Mass = 0.25f,
                Build = (go, p) =>
                {
                    Mesh(go, ModelFactory.JarLid());
                    var fill = Child(go, "Fill", new Vector3(0f, 0.008f, 0f));
                    MeshBuilder.AddRenderer(fill.gameObject, ModelFactory.JarContents());
                    fill.localScale = new Vector3(0.036f, 0.085f, 0.036f);
                    var glass = Child(go, "Glass", Vector3.zero);
                    MeshBuilder.AddRenderer(glass.gameObject, ModelFactory.JarGlass(), ScruffMaterials.Transparent);
                    ModelFactory.Box(go, new Vector3(0f, 0.059f, 0f), new Vector3(0.086f, 0.118f, 0.086f));
                },
                Configure = item => AddContainer(item, 5, new Vector3(0f, 0.125f, 0f), 0.085f),
            });

            // ------------------------------------------------------------------ Mixing additives (corner store)
            AddAdditive("energy_drink", "Energy Drink", "energizing", 6, 0, ModelFactory.Can(new Color(0.95f, 0.85f, 0.2f), new Color(0.12f, 0.12f, 0.14f)), 0.029f, 0.105f);
            AddAdditive("mint_gum", "Mint Gum", "chill", 4, 0, ModelFactory.SmallBox(new Color(0.55f, 0.9f, 0.75f), Color.white, new Vector3(0.07f, 0.02f, 0.035f)), 0.02f, 0.035f, true);
            AddAdditive("chili_flakes", "Chili Flakes", "spicy", 5, 0, ModelFactory.Bottle(new Color(0.85f, 0.22f, 0.15f), new Color(0.95f, 0.9f, 0.85f), 0.025f, 0.08f), 0.026f, 0.08f);
            AddAdditive("candy", "Candy", "giggly", 3, 0, ModelFactory.Candy(), 0.025f, 0.045f);
            AddAdditive("glitter", "Glitter", "sparkly", 12, 2, ModelFactory.GlitterTube(), 0.016f, 0.11f);
            AddAdditive("glow_juice", "Glow Juice", "glowing", 20, 3, ModelFactory.GlowBottle(), 0.031f, 0.125f);

            // ------------------------------------------------------------------ Chem ingredients
            Register(new ItemDefinition
            {
                Id = "blue_syrup", Name = "Blue Syrup", Category = ItemCategory.Ingredient, Catalog = ShopCatalog.Supplies, Price = 40, UnlockRank = 2, Mass = 0.8f,
                Description = "Chem station ingredient.",
                Build = (go, p) =>
                {
                    Mesh(go, ModelFactory.Bottle(new Color(0.3f, 0.5f, 0.95f), new Color(0.15f, 0.15f, 0.18f), 0.037f, 0.16f));
                    ModelFactory.Capsule(go, new Vector3(0f, 0.08f, 0f), 0.038f, 0.16f);
                },
            });
            Register(new ItemDefinition
            {
                Id = "fizz_salt", Name = "Fizz Salt", Category = ItemCategory.Ingredient, Catalog = ShopCatalog.Supplies, Price = 25, UnlockRank = 2, Mass = 0.5f,
                Description = "Chem station ingredient.",
                Build = (go, p) =>
                {
                    Mesh(go, ModelFactory.SmallBox(new Color(0.95f, 0.95f, 0.92f), new Color(0.95f, 0.55f, 0.25f), new Vector3(0.08f, 0.1f, 0.05f)));
                    ModelFactory.Box(go, new Vector3(0f, 0.05f, 0f), new Vector3(0.08f, 0.1f, 0.05f));
                },
            });

            // ------------------------------------------------------------------ Non-physical shop entries
            Register(new ItemDefinition
            {
                Id = "baggies_10", Name = "Baggies", ShopName = "Baggies x10", Category = ItemCategory.Supply, Catalog = ShopCatalog.Supplies, Price = 10,
                Description = "Restocks the baggie box on your packing table.",
                OnPurchase = () => Game.State.baggieStock += 10,
            });
            Register(new ItemDefinition
            {
                Id = "jars_5", Name = "Jars", ShopName = "Jars x5", Category = ItemCategory.Supply, Catalog = ShopCatalog.Supplies, Price = 20, UnlockRank = 1,
                Description = "Jars hold 5 units. Restocks the jar crate.",
                OnPurchase = () => Game.State.jarStock += 5,
            });
            Register(new ItemDefinition
            {
                Id = "unlock_mixer", Name = "Mixing Station", ShopName = "Mixing Station", Category = ItemCategory.Unlock, Catalog = ShopCatalog.Supplies, Price = 250, UnlockRank = 1,
                Description = "Mix product with additives to add effects and raise its value.",
                OnPurchase = () => Game.Manager.UnlockStation("mixer"),
                CanPurchase = () => Game.State != null && !Game.State.HasUnlock("mixer"),
            });
            Register(new ItemDefinition
            {
                Id = "unlock_chem", Name = "Chem Station", ShopName = "Chem Station", Category = ItemCategory.Unlock, Catalog = ShopCatalog.Supplies, Price = 600, UnlockRank = 2,
                Description = "Cook Blue Crystal from Blue Syrup + Fizz Salt.",
                OnPurchase = () => Game.Manager.UnlockStation("chem"),
                CanPurchase = () => Game.State != null && !Game.State.HasUnlock("chem"),
            });
        }

        static void AddAdditive(string id, string name, string effect, int price, int rank, Mesh mesh, float radius, float height, bool box = false)
        {
            Register(new ItemDefinition
            {
                Id = id, Name = name, Category = ItemCategory.Additive, Catalog = ShopCatalog.CornerStore, Price = price, UnlockRank = rank,
                Mass = 0.2f, EffectId = effect,
                Description = "Mixing additive: " + (ProductCatalog.Effect(effect)?.Name ?? effect),
                Build = (go, p) =>
                {
                    Mesh(go, mesh);
                    if (box) ModelFactory.Box(go, new Vector3(0f, height * 0.5f, 0f), new Vector3(0.07f, height, 0.035f));
                    else ModelFactory.Capsule(go, new Vector3(0f, height * 0.5f, 0f), radius, Mathf.Max(height, radius * 2f));
                },
            });
        }

        static Pourable AddPourable(Item item, PourType type, Vector3 spoutPos, float angle, float flow, Color color)
        {
            var spout = Util.CreateChild(item.transform, "Spout", spoutPos);
            var p = item.gameObject.AddComponent<Pourable>();
            p.type = type;
            p.spout = spout;
            p.pourAngle = angle;
            p.flowRate = flow;
            p.streamColor = color;
            return p;
        }

        static void AddContainer(Item item, int capacity, Vector3 openingPos, float fillMax)
        {
            var c = item.gameObject.AddComponent<ProductContainer>();
            c.capacity = capacity;
            c.opening = Util.CreateChild(item.transform, "Opening", openingPos);
            c.fill = item.transform.Find("Fill");
            c.fillMaxHeight = fillMax;
            c.openingRadius = 0.05f;
        }
    }
}
