using System;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    public enum DealState { Offered, Accepted, Completed, Failed, Declined, Expired }

    [Serializable]
    public class Deal
    {
        public int id;
        public string customerId;
        public ProductFamily family;
        public int units;
        public int minTier;
        public int unitPrice;
        public int meetSpot;
        public DealState state;
        public float createdAbs;
        public float respondByAbs;
        public float meetEndAbs;
        public int unitsDelivered;

        public int Total => units * unitPrice;
        public bool IsOpen => state == DealState.Offered || state == DealState.Accepted;
    }

    /// <summary>
    /// Customers text you asking for product. Accept on your phone, then meet them at the spot before time runs
    /// out and hand them the goods. Also owns the phone's message inbox.
    /// </summary>
    public class DealSystem : MonoBehaviour
    {
        const int MaxOpenOffers = 3;
        const float ResponseWindow = 90f;
        const float MeetWindow = 180f;

        public event Action Changed;

        readonly Dictionary<int, Beacon> beacons = new Dictionary<int, Beacon>();
        float checkTimer;

        List<Deal> Deals => Game.State.deals;

        void Awake()
        {
            Game.Deals = this;
        }

        void Start()
        {
            if (Game.Clock != null) Game.Clock.MinuteTick += OnMinute;
        }

        void OnDestroy()
        {
            if (Game.Clock != null) Game.Clock.MinuteTick -= OnMinute;
        }

        public void OnGameLoaded()
        {
            foreach (var b in beacons.Values)
                if (b != null) Destroy(b.gameObject);
            beacons.Clear();
            SyncBeacons();
            Changed?.Invoke();
        }

        public Deal ActiveDealFor(string customerId)
        {
            if (Game.State == null) return null;
            foreach (var d in Deals)
                if (d.customerId == customerId && d.state == DealState.Accepted) return d;
            return null;
        }

        public Deal OpenDealFor(string customerId)
        {
            if (Game.State == null) return null;
            foreach (var d in Deals)
                if (d.customerId == customerId && d.IsOpen) return d;
            return null;
        }

        public List<Deal> OpenDeals()
        {
            var list = new List<Deal>();
            if (Game.State == null) return list;
            foreach (var d in Deals)
                if (d.IsOpen) list.Add(d);
            return list;
        }

        public static PointOfInterest MeetSpot(int index)
        {
            var spots = PointOfInterest.OfType(PoiType.MeetSpot);
            if (spots.Count == 0) return null;
            return spots[Mathf.Abs(index) % spots.Count];
        }

        void OnMinute()
        {
            if (Game.State == null || !Game.IsPlaying) return;
            float now = Game.State.AbsoluteMinutes;
            bool changed = false;

            foreach (var d in Deals)
            {
                if (d.state == DealState.Offered && now > d.respondByAbs)
                {
                    d.state = DealState.Expired;
                    var c = Game.NPCs?.Profile(d.customerId);
                    if (c != null) AddMessage(c.name, "nvm, found someone else", d.id);
                    changed = true;
                }
                else if (d.state == DealState.Accepted && now > d.meetEndAbs)
                {
                    Fail(d);
                    changed = true;
                }
            }

            checkTimer -= 1f;
            if (checkTimer <= 0f)
            {
                checkTimer = 15f;
                changed |= TryGenerateOffers(now);
            }

            // keep history short
            for (int i = Deals.Count - 1; i >= 0 && Deals.Count > 25; i--)
                if (!Deals[i].IsOpen) Deals.RemoveAt(i);

            if (changed)
            {
                SyncBeacons();
                Changed?.Invoke();
            }
        }

        bool TryGenerateOffers(float now)
        {
            int open = 0;
            foreach (var d in Deals)
                if (d.IsOpen) open++;
            if (open >= MaxOpenOffers) return false;

            float hour = Game.Clock.MinuteOfDay / 60f;
            float dayFactor = hour >= 8f && hour < 21f ? 1f : hour >= 21f && hour < 23.5f ? 0.35f : 0f;
            if (dayFactor <= 0f) return false;

            bool generated = false;
            foreach (var c in Game.State.customers)
            {
                if (!c.isContact || now < c.nextDealCheckAbs || OpenDealFor(c.id) != null) continue;
                c.nextDealCheckAbs = now + UnityEngine.Random.Range(60f, 150f);
                if (!c.IsCraving(now)) continue;
                float chance = (0.25f + 0.6f * c.addiction) * dayFactor * (0.7f + 0.3f * c.Relationship01);
                if (UnityEngine.Random.value > chance) continue;
                CreateOffer(c, now);
                generated = true;
                if (++open >= MaxOpenOffers) break;
            }
            return generated;
        }

        public Deal CreateOffer(CustomerProfile c, float now)
        {
            var family = c.favoriteFamily;
            if (family == ProductFamily.Crystal && !Game.State.HasUnlock("chem")) family = ProductFamily.Green;

            int units = 1 + Mathf.Clamp(Mathf.FloorToInt((c.wealth - 0.7f) * 3f * UnityEngine.Random.value + c.addiction * 2f), 0, 3);
            int tier = Mathf.Clamp(c.standards, 0, 3);
            float typical = TypicalUnitValue(family, tier) * Game.State.GetMarkup(family) * UnityEngine.Random.Range(0.95f, 1.12f);
            var sample = new ProductData { strain = CheapestStrain(family).Id, quality = TierMidpoint(tier) };
            int cap = c.MaxUnitPrice(sample, transform.position);
            int unitPrice = Mathf.Max(1, Mathf.RoundToInt(Mathf.Min(typical, cap * 1.05f)));

            var spots = PointOfInterest.OfType(PoiType.MeetSpot);
            var deal = new Deal
            {
                id = Game.State.nextDealId++,
                customerId = c.id,
                family = family,
                units = units,
                minTier = tier,
                unitPrice = unitPrice,
                meetSpot = spots.Count > 0 ? UnityEngine.Random.Range(0, spots.Count) : 0,
                state = DealState.Offered,
                createdAbs = now,
                respondByAbs = now + ResponseWindow,
            };
            Deals.Add(deal);

            string familyName = family == ProductFamily.Green ? "green" : "crystal";
            string quality = tier >= 2 ? $" ({ProductCatalog.TierNames[tier]}+)" : "";
            var spot = MeetSpot(deal.meetSpot);
            string[] openers = { "yo", "hey", "u around?", "sup", "psst" };
            string text = $"{openers[UnityEngine.Random.Range(0, openers.Length)]} can u bring {units}x {familyName}{quality}? I'll pay ${deal.Total}. meet @ {(spot != null ? spot.displayName : "the usual")}";
            AddMessage(c.name, text, deal.id);
            Game.UI?.Notify("New message: " + c.name, text, Palette.UIAccent);
            Changed?.Invoke();
            return deal;
        }

        public void Accept(int dealId)
        {
            var d = Find(dealId);
            if (d == null || d.state != DealState.Offered) return;
            d.state = DealState.Accepted;
            d.meetEndAbs = Game.State.AbsoluteMinutes + MeetWindow;
            var c = Game.NPCs?.Profile(d.customerId);
            var spot = MeetSpot(d.meetSpot);
            AddMessage("You", $"bet. {(spot != null ? spot.displayName : "there")} in a bit", d.id);
            if (c != null) Game.UI?.Notify("Deal accepted", $"Meet {c.name} at {spot?.displayName} before {GameClock.FormatTime(d.meetEndAbs % 1440f)}", Palette.UIAccent);
            GameEvents.Raise(GameEventType.DealAccepted, d);
            SyncBeacons();
            Changed?.Invoke();
        }

        public void Decline(int dealId)
        {
            var d = Find(dealId);
            if (d == null || d.state != DealState.Offered) return;
            d.state = DealState.Declined;
            Game.NPCs?.Profile(d.customerId)?.AdjustRelationship(-0.02f);
            AddMessage("You", "can't rn, sorry", d.id);
            Changed?.Invoke();
        }

        /// <summary>Called by the customer when enough product has been handed over.</summary>
        public void Complete(Deal d)
        {
            if (d == null || d.state != DealState.Accepted) return;
            d.state = DealState.Completed;
            var c = Game.NPCs?.Profile(d.customerId);
            if (c != null)
            {
                c.dealsCompleted++;
                c.AdjustRelationship(0.08f);
                MaybeReferral(c);
            }
            Game.Progression?.AddXp(10);
            GameEvents.Raise(GameEventType.DealCompleted, d);
            SyncBeacons();
            Changed?.Invoke();
        }

        void Fail(Deal d)
        {
            d.state = DealState.Failed;
            var c = Game.NPCs?.Profile(d.customerId);
            if (c != null)
            {
                c.AdjustRelationship(-0.15f);
                AddMessage(c.name, "waited forever. not cool.", d.id);
                Game.UI?.Notify("Deal missed", $"{c.name} is annoyed you didn't show.", Palette.UIDanger);
            }
            GameEvents.Raise(GameEventType.DealFailed, d);
        }

        void MaybeReferral(CustomerProfile c)
        {
            if (c.relationship < 0.45f || UnityEngine.Random.value > 0.3f) return;
            foreach (var other in Game.State.customers)
            {
                if (other.isContact) continue;
                other.isContact = true;
                other.relationship = 0.05f;
                other.nextDealCheckAbs = Game.State.AbsoluteMinutes + UnityEngine.Random.Range(30f, 120f);
                AddMessage(c.name, $"my buddy {other.name} wants in. gave them ur number", 0);
                AddMessage(other.name, $"{c.name} says ur legit. hit me up", 0);
                Game.UI?.Notify("New customer!", $"{c.name} referred {other.name}.", Palette.UIAccent);
                GameEvents.Raise(GameEventType.CustomerGained, other);
                return;
            }
        }

        public Deal Find(int id)
        {
            if (Game.State == null) return null;
            foreach (var d in Deals)
                if (d.id == id) return d;
            return null;
        }

        public void AddMessage(string from, string text, int dealId)
        {
            if (Game.State == null) return;
            Game.State.messages.Add(new PhoneMessage
            {
                from = from,
                text = text,
                day = Game.State.day,
                minute = Game.State.minuteOfDay,
                dealId = dealId,
            });
            while (Game.State.messages.Count > 40) Game.State.messages.RemoveAt(0);
            Changed?.Invoke();
        }

        void SyncBeacons()
        {
            if (Game.State == null) return;
            var keep = new HashSet<int>();
            foreach (var d in Deals)
            {
                if (d.state != DealState.Accepted) continue;
                keep.Add(d.id);
                if (beacons.ContainsKey(d.id)) continue;
                var spot = MeetSpot(d.meetSpot);
                var c = Game.NPCs?.Profile(d.customerId);
                if (spot == null) continue;
                string familyName = d.family == ProductFamily.Green ? "Green" : "Crystal";
                beacons[d.id] = Beacon.Create(spot.transform.position, $"{c?.name ?? "Deal"}\n{d.units}x {familyName} - ${d.Total}", Palette.UIWarning);
            }
            var remove = new List<int>();
            foreach (var kv in beacons)
                if (!keep.Contains(kv.Key)) remove.Add(kv.Key);
            foreach (var id in remove)
            {
                if (beacons[id] != null) Destroy(beacons[id].gameObject);
                beacons.Remove(id);
            }
        }

        public static StrainDef CheapestStrain(ProductFamily family)
        {
            StrainDef best = null;
            foreach (var s in ProductCatalog.Strains.Values)
                if (s.Family == family && (best == null || s.BaseValue < best.BaseValue)) best = s;
            return best;
        }

        public static float TierMidpoint(int tier) => Mathf.Clamp01(tier * 0.2f + 0.1f);

        public static float TypicalUnitValue(ProductFamily family, int tier)
        {
            var s = CheapestStrain(family);
            return s == null ? 10f : s.BaseValue * ProductCatalog.QualityMultiplier(TierMidpoint(Mathf.Max(2, tier)));
        }
    }
}
