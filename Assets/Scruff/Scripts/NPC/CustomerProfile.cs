using System;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>Persistent data for one potential customer. The NPC in the world is just a body for this.</summary>
    [Serializable]
    public class CustomerProfile
    {
        public string id;
        public string name;
        public int appearanceSeed;
        public float voicePitch = 1f;
        public int homeIndex;

        public ProductFamily favoriteFamily;
        public List<string> favoriteEffects = new List<string>();
        /// <summary>Minimum quality tier they'll accept (0 trash .. 4 heavenly).</summary>
        public int standards;
        /// <summary>How much they're willing to spend, ~0.8 .. 1.5.</summary>
        public float wealth = 1f;

        public float addiction;
        /// <summary>-1 hates you .. 1 loves you.</summary>
        public float relationship;
        public bool isContact;

        public float lastPurchaseAbs = -99999f;
        public float sampleCooldownUntilAbs = -99999f;
        public float nextDealCheckAbs;
        public int dealsCompleted;
        public int unitsBought;

        public float Relationship01 => Mathf.InverseLerp(-1f, 1f, relationship);

        /// <summary>Minutes they wait between wanting to buy again - shorter the more hooked they are.</summary>
        public float CravingInterval => Mathf.Lerp(26f * 60f, 5f * 60f, Mathf.Clamp01(addiction));

        public bool IsCraving(float nowAbs) => nowAbs - lastPurchaseAbs >= CravingInterval;

        public string StandardsText => standards <= 0 ? "Low" : standards == 1 ? "Low" : standards == 2 ? "Medium" : "High";

        /// <summary>Highest per-unit price they'd pay for this product right now.</summary>
        public int MaxUnitPrice(ProductData p, Vector3 atPosition)
        {
            float value = ProductCatalog.UnitValue(p);
            float mult = wealth * (1f + 0.3f * relationship) * (1f + 0.35f * addiction);
            if (p.Family != favoriteFamily) mult *= 0.85f;
            if (p.effects != null)
                foreach (var e in p.effects)
                    if (favoriteEffects.Contains(e)) mult *= 1.12f;
            if (Game.Turf != null) mult *= Game.Turf.PriceMultiplierAt(atPosition);
            return Mathf.Max(1, Mathf.RoundToInt(value * mult * 1.1f));
        }

        public void AdjustRelationship(float delta) => relationship = Mathf.Clamp(relationship + delta, -1f, 1f);

        public static CustomerProfile Generate(System.Random rng, string name, int homeIndex)
        {
            var effects = new List<string>(ProductCatalog.Effects.Keys);
            effects.Remove("paranoid");
            var p = new CustomerProfile
            {
                id = Guid.NewGuid().ToString("N").Substring(0, 10),
                name = name,
                appearanceSeed = rng.Next(),
                voicePitch = 0.8f + (float)rng.NextDouble() * 0.6f,
                homeIndex = homeIndex,
                favoriteFamily = rng.NextDouble() < 0.7 ? ProductFamily.Green : ProductFamily.Crystal,
                standards = rng.Next(0, 3),
                wealth = 0.8f + (float)rng.NextDouble() * 0.7f,
                addiction = (float)rng.NextDouble() * 0.2f,
                nextDealCheckAbs = rng.Next(60, 240),
            };
            int favCount = 1 + rng.Next(2);
            for (int i = 0; i < favCount && effects.Count > 0; i++)
            {
                int idx = rng.Next(effects.Count);
                p.favoriteEffects.Add(effects[idx]);
                effects.RemoveAt(idx);
            }
            return p;
        }
    }
}
