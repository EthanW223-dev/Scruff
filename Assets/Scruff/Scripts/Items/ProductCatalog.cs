using System;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    public enum ProductFamily { Green, Crystal }

    /// <summary>A product line: a plant strain you grow, or a cook recipe.</summary>
    public class StrainDef
    {
        public string Id;
        public string Name;
        public ProductFamily Family;
        public float BaseValue;          // $ per unit at 50% quality with no effects
        public Color Color;
        public float GrowMinutes;        // in-game minutes from seed to harvest (plants)
        public int MinYield;
        public int MaxYield;
        public float Addictiveness;      // 0..1, how fast customers get hooked
        public string SeedItemId;
        public string SeedPacketId;
    }

    /// <summary>An effect that mixing can add (Schedule One style). Bonuses stack additively on value.</summary>
    public class EffectDef
    {
        public string Id;
        public string Name;
        public string Adjective;         // used to name mixed products
        public float ValueBonus;         // +0.2 = +20% value
        public Color Color;
    }

    /// <summary>Mixing rule: adding <see cref="Additive"/> to a product that has <see cref="From"/> turns it into <see cref="To"/>.</summary>
    public struct MixRule
    {
        public string From;
        public string Additive;
        public string To;
    }

    /// <summary>
    /// Product data tables and the value/mixing math. All the game's "what is this worth" logic lives here, so
    /// it's easy to rebalance in one place.
    /// </summary>
    public static class ProductCatalog
    {
        public const int MaxEffects = 4;

        public static readonly Dictionary<string, StrainDef> Strains = new Dictionary<string, StrainDef>();
        public static readonly Dictionary<string, EffectDef> Effects = new Dictionary<string, EffectDef>();
        public static readonly List<MixRule> Rules = new List<MixRule>();

        static bool initialized;

        public static void Init()
        {
            if (initialized) return;
            initialized = true;

            AddStrain(new StrainDef
            {
                Id = "backyard_green", Name = "Backyard Green", Family = ProductFamily.Green, BaseValue = 18f,
                Color = new Color(0.45f, 0.68f, 0.30f), GrowMinutes = 300f, MinYield = 4, MaxYield = 6, Addictiveness = 0.15f,
                SeedItemId = "seed_backyard", SeedPacketId = "seeds_backyard",
            });
            AddStrain(new StrainDef
            {
                Id = "alley_purple", Name = "Alley Purple", Family = ProductFamily.Green, BaseValue = 28f,
                Color = new Color(0.55f, 0.40f, 0.65f), GrowMinutes = 420f, MinYield = 4, MaxYield = 7, Addictiveness = 0.2f,
                SeedItemId = "seed_purple", SeedPacketId = "seeds_purple",
            });
            AddStrain(new StrainDef
            {
                Id = "midnight_gold", Name = "Midnight Gold", Family = ProductFamily.Green, BaseValue = 42f,
                Color = new Color(0.78f, 0.68f, 0.30f), GrowMinutes = 540f, MinYield = 5, MaxYield = 8, Addictiveness = 0.25f,
                SeedItemId = "seed_gold", SeedPacketId = "seeds_gold",
            });
            AddStrain(new StrainDef
            {
                Id = "blue_crystal", Name = "Blue Crystal", Family = ProductFamily.Crystal, BaseValue = 55f,
                Color = new Color(0.45f, 0.75f, 0.95f), MinYield = 5, MaxYield = 5, Addictiveness = 0.5f,
            });

            AddEffect("energizing", "Energizing", "Zippy", 0.22f, new Color(1f, 0.9f, 0.3f));
            AddEffect("chill", "Chill", "Mellow", 0.10f, new Color(0.55f, 0.85f, 1f));
            AddEffect("spicy", "Spicy", "Fire", 0.18f, new Color(1f, 0.4f, 0.25f));
            AddEffect("giggly", "Giggly", "Goofy", 0.15f, new Color(1f, 0.55f, 0.75f));
            AddEffect("sparkly", "Sparkly", "Disco", 0.32f, new Color(0.85f, 0.6f, 1f));
            AddEffect("glowing", "Glowing", "Neon", 0.45f, new Color(0.4f, 1f, 0.6f));
            AddEffect("munchies", "Munchies", "Snacky", 0.08f, new Color(0.9f, 0.7f, 0.4f));
            AddEffect("paranoid", "Paranoid", "Sketchy", -0.12f, new Color(0.6f, 0.6f, 0.6f));
            AddEffect("sleepy", "Sleepy", "Dozy", 0.05f, new Color(0.5f, 0.5f, 0.85f));
            AddEffect("smooth", "Smooth", "Silky", 0.28f, new Color(0.95f, 0.85f, 0.7f));
            AddEffect("euphoric", "Euphoric", "Cloud", 0.38f, new Color(1f, 0.8f, 0.95f));

            // Hidden interactions - players discover these by experimenting.
            AddRule("chill", "energizing", "paranoid");
            AddRule("paranoid", "chill", "chill");
            AddRule("giggly", "chill", "smooth");
            AddRule("energizing", "giggly", "euphoric");
            AddRule("spicy", "chill", "munchies");
            AddRule("sleepy", "energizing", "energizing");
            AddRule("smooth", "sparkly", "euphoric");
            AddRule("munchies", "spicy", "sleepy");
            AddRule("euphoric", "spicy", "paranoid");
        }

        static void AddStrain(StrainDef s) => Strains[s.Id] = s;

        static void AddEffect(string id, string name, string adjective, float bonus, Color color)
        {
            Effects[id] = new EffectDef { Id = id, Name = name, Adjective = adjective, ValueBonus = bonus, Color = color };
        }

        static void AddRule(string from, string additive, string to) => Rules.Add(new MixRule { From = from, Additive = additive, To = to });

        public static StrainDef Strain(string id)
        {
            Init();
            return id != null && Strains.TryGetValue(id, out var s) ? s : null;
        }

        public static EffectDef Effect(string id)
        {
            Init();
            return id != null && Effects.TryGetValue(id, out var e) ? e : null;
        }

        public static float QualityMultiplier(float quality) => 0.6f + 0.8f * Mathf.Clamp01(quality);

        public static int QualityTier(float quality)
        {
            if (quality < 0.2f) return 0;
            if (quality < 0.4f) return 1;
            if (quality < 0.6f) return 2;
            if (quality < 0.8f) return 3;
            return 4;
        }

        public static readonly string[] TierNames = { "Trash", "Poor", "Standard", "Premium", "Heavenly" };

        public static readonly Color[] TierColors =
        {
            new Color(0.6f, 0.55f, 0.5f),
            new Color(0.85f, 0.65f, 0.45f),
            new Color(0.9f, 0.9f, 0.9f),
            new Color(0.5f, 0.85f, 1f),
            new Color(1f, 0.85f, 0.35f),
        };

        public static string QualityName(float quality) => TierNames[QualityTier(quality)];

        public static string QualityTag(float quality) => $"<#{ColorUtility.ToHtmlStringRGB(TierColors[QualityTier(quality)])}>{QualityName(quality)}</>";

        public static float EffectBonus(ProductData p)
        {
            float bonus = 0f;
            if (p?.effects == null) return 0f;
            foreach (var id in p.effects)
            {
                var e = Effect(id);
                if (e != null) bonus += e.ValueBonus;
            }
            return bonus;
        }

        /// <summary>Street value of one unit.</summary>
        public static float UnitValue(ProductData p)
        {
            var s = Strain(p?.strain);
            if (s == null) return 0f;
            return s.BaseValue * QualityMultiplier(p.quality) * Mathf.Max(0.3f, 1f + EffectBonus(p));
        }

        /// <summary>What you're asking per unit, given your markup setting for that product family.</summary>
        public static int AskingPrice(ProductData p)
        {
            var s = Strain(p?.strain);
            if (s == null) return 0;
            float markup = Game.State != null ? Game.State.GetMarkup(s.Family) : 1f;
            return Mathf.Max(1, Mathf.RoundToInt(UnitValue(p) * markup));
        }

        public static string DisplayName(ProductData p)
        {
            var s = Strain(p?.strain);
            if (s == null) return "Unknown";
            if (p.effects == null || p.effects.Count == 0) return s.Name;
            EffectDef top = null;
            foreach (var id in p.effects)
            {
                var e = Effect(id);
                if (e != null && (top == null || e.ValueBonus > top.ValueBonus)) top = e;
            }
            return top != null ? $"{top.Adjective} {s.Name}" : s.Name;
        }

        public static string EffectsText(ProductData p)
        {
            if (p?.effects == null || p.effects.Count == 0) return "No effects";
            var parts = new List<string>();
            foreach (var id in p.effects)
            {
                var e = Effect(id);
                if (e != null) parts.Add($"<#{ColorUtility.ToHtmlStringRGB(e.Color)}>{e.Name}</>");
            }
            return string.Join(", ", parts);
        }

        /// <summary>Returns a new product with the additive's effect applied (rules first, then the new effect if there's room).</summary>
        public static ProductData Mix(ProductData p, string additiveEffect)
        {
            var result = p.Clone();
            if (string.IsNullOrEmpty(additiveEffect)) return result;
            for (int i = 0; i < result.effects.Count; i++)
            {
                foreach (var rule in Rules)
                {
                    if (rule.From == result.effects[i] && rule.Additive == additiveEffect)
                    {
                        result.effects[i] = rule.To;
                        break;
                    }
                }
            }
            // remove duplicates created by rules
            var seen = new HashSet<string>();
            for (int i = result.effects.Count - 1; i >= 0; i--)
                if (!seen.Add(result.effects[i])) result.effects.RemoveAt(i);

            if (!result.effects.Contains(additiveEffect) && result.effects.Count < MaxEffects)
                result.effects.Add(additiveEffect);
            return result;
        }
    }

    /// <summary>A quantity of product: what strain, how good, which effects, how many units.</summary>
    [Serializable]
    public class ProductData
    {
        public string strain;
        public float quality = 0.5f;
        public List<string> effects = new List<string>();
        public int units = 1;

        public StrainDef Strain => ProductCatalog.Strain(strain);
        public ProductFamily Family => Strain != null ? Strain.Family : ProductFamily.Green;
        public string DisplayName => ProductCatalog.DisplayName(this);
        public float UnitValue => ProductCatalog.UnitValue(this);

        public ProductData Clone()
        {
            return new ProductData
            {
                strain = strain,
                quality = quality,
                effects = effects != null ? new List<string>(effects) : new List<string>(),
                units = units,
            };
        }

        /// <summary>Same strain and same set of effects (quality can differ; it gets averaged when combined).</summary>
        public bool SameProductAs(ProductData other)
        {
            if (other == null || other.strain != strain) return false;
            int a = effects?.Count ?? 0, b = other.effects?.Count ?? 0;
            if (a != b) return false;
            if (a == 0) return true;
            foreach (var e in effects)
                if (!other.effects.Contains(e)) return false;
            return true;
        }
    }
}
