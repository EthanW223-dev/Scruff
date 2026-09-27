using System.Collections;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// A customer's brain. Daytime: wanders between hangouts. Night: goes home. Accepted deal: walks to the meeting
    /// spot and waits. Hand them packaged product to sell (or a free sample if they don't know you yet).
    /// While you hold product near them they tell you whether they'd take it at your price.
    /// </summary>
    public class CustomerNPC : NPCAgent, IItemReceiver
    {
        enum State { Wander, Idle, GoingHome, AtHome, ToMeeting, Waiting, Trading, Fleeing }

        public CustomerProfile Profile { get; private set; }

        State state = State.Wander;
        float stateTimer;
        float greetCooldown;
        bool trading;
        CashPickup offeredCash;
        float cashOfferedAt;
        Item hoverItem;
        float fleeUntil;

        const float ReceiveRadiusMeters = 0.5f;

        public static CustomerNPC Spawn(CustomerProfile profile, Vector3 position, Transform parent)
        {
            var go = new GameObject("Customer " + profile.name);
            go.transform.SetParent(parent, false);
            go.transform.position = position;
            var npc = go.AddComponent<CustomerNPC>();
            npc.Profile = profile;
            var rng = new System.Random(profile.appearanceSeed);
            npc.InitAgent(profile.name, CharacterModel.RandomLook(rng), profile.voicePitch);
            npc.walkSpeed = 1.1f + (float)rng.NextDouble() * 0.35f;
            return npc;
        }

        protected override void OnEnable()
        {
            base.OnEnable();
            ItemReceivers.Register(this);
        }

        protected override void OnDisable()
        {
            base.OnDisable();
            ItemReceivers.Unregister(this);
            if (Game.IsQuitting) return;
            if (offeredCash != null) CollectOfferedCash();
            // Coroutines stop when disabled; finish anything half-pocketed.
            if (Model != null)
                foreach (var it in Model.LeftHandPoint.GetComponentsInChildren<Item>(true))
                    Destroy(it.gameObject);
            trading = false;
        }

        /// <summary>Called by the manager when they come back out in the morning.</summary>
        public void WakeUp()
        {
            state = State.Wander;
            stateTimer = 0f;
            PickNewHangout();
        }

        PointOfInterest Home
        {
            get
            {
                var homes = PointOfInterest.OfType(PoiType.Home);
                return homes.Count > 0 ? homes[Mathf.Abs(Profile.homeIndex) % homes.Count] : null;
            }
        }

        public bool ShouldBeHome
        {
            get
            {
                if (Game.Clock == null) return false;
                if (Game.Deals != null && Game.Deals.ActiveDealFor(Profile.id) != null) return false;
                float h = Game.Clock.MinuteOfDay / 60f;
                return h >= 22.5f || h < 7f;
            }
        }

        protected override void Update()
        {
            base.Update();
            greetCooldown -= Time.deltaTime;

            // Look at the player when they're close.
            float dist = DistanceToPlayer;
            Model.LookAt(dist < 4f ? PlayerHead : (Vector3?)null);

            if (offeredCash != null && (Time.time - cashOfferedAt > 15f || dist > 7f)) CollectOfferedCash();
            UpdateIcon(dist);
        }

        void UpdateIcon(float dist)
        {
            if (Speech == null) return;
            var deal = Game.Deals != null ? Game.Deals.ActiveDealFor(Profile.id) : null;
            if (offeredCash != null) Speech.SetIcon("$", Palette.Money);
            else if (deal != null) Speech.SetIcon("!", Palette.UIWarning);
            else if (Profile.isContact && dist < 10f && Game.State != null && Profile.IsCraving(Game.State.AbsoluteMinutes)) Speech.SetIcon("$", new Color(0.6f, 0.9f, 0.6f, 0.8f));
            else Speech.SetIcon("", Color.white);
        }

        protected override void Think()
        {
            if (trading) return;
            if (state == State.Fleeing)
            {
                if (Time.time > fleeUntil) SetState(State.Wander);
                return;
            }

            var deal = Game.Deals != null ? Game.Deals.ActiveDealFor(Profile.id) : null;
            if (deal != null)
            {
                var spot = DealSystem.MeetSpot(deal.meetSpot);
                if (spot != null)
                {
                    float d = Vector3.Distance(transform.position, spot.transform.position);
                    if (d > 2f)
                    {
                        if (state != State.ToMeeting || !Agent.hasPath) MoveTo(spot.transform.position, d > 25f);
                        state = State.ToMeeting;
                    }
                    else
                    {
                        if (state != State.Waiting) Stop();
                        state = State.Waiting;
                        if (DistanceToPlayer < 5f) Face(PlayerHead, 1f);
                        else Face(spot.transform.position + spot.transform.forward, 1f);
                    }
                    MaybeGreet(deal);
                    return;
                }
            }

            if (ShouldBeHome)
            {
                var home = Home;
                if (home == null) return;
                if (state != State.GoingHome && state != State.AtHome)
                {
                    state = State.GoingHome;
                    MoveTo(home.transform.position);
                }
                else if (state == State.GoingHome && HasArrived && Vector3.Distance(transform.position, home.transform.position) < 2.5f)
                {
                    state = State.AtHome;
                    Game.NPCs?.SendHome(this);
                }
                return;
            }

            // Chat with the player if they come close.
            if (DistanceToPlayer < 2.2f && PlayerIsLookingAtMe(35f))
            {
                if (state == State.Wander) Stop();
                state = State.Idle;
                stateTimer = Mathf.Max(stateTimer, 3f);
                Face(PlayerHead, 1f);
                MaybeGreet(null);
                return;
            }

            stateTimer -= thinkInterval;
            switch (state)
            {
                case State.Wander:
                case State.ToMeeting:
                case State.Waiting:
                case State.GoingHome:
                case State.AtHome:
                    if (!Agent.hasPath || HasArrived || state != State.Wander)
                    {
                        if (state == State.Wander && HasArrived)
                        {
                            state = State.Idle;
                            stateTimer = Random.Range(6f, 20f);
                        }
                        else
                        {
                            PickNewHangout();
                        }
                    }
                    break;
                case State.Idle:
                    if (stateTimer <= 0f) PickNewHangout();
                    break;
            }
        }

        void SetState(State s)
        {
            state = s;
            if (s == State.Wander) PickNewHangout();
        }

        void PickNewHangout()
        {
            var spots = PointOfInterest.OfType(PoiType.Hangout);
            if (spots.Count == 0) return;
            var spot = spots[Random.Range(0, spots.Count)];
            state = State.Wander;
            MoveTo(spot.RandomPointNear());
        }

        void MaybeGreet(Deal deal)
        {
            if (greetCooldown > 0f || DistanceToPlayer > 3f) return;
            greetCooldown = 25f;
            if (deal != null)
            {
                string fam = deal.family == ProductFamily.Green ? "green" : "crystal";
                Say($"You got my {deal.units}x {fam}?");
            }
            else if (!Profile.isContact)
            {
                string[] lines = { "Can I help you?", "...Hey.", "Nice day, huh?", "You need something?" };
                Say(lines[Random.Range(0, lines.Length)]);
            }
            else if (Game.State != null && Profile.IsCraving(Game.State.AbsoluteMinutes))
            {
                string[] lines = { "Yo! You holding?", "Hey, got anything for me?", "Perfect timing, I need a fix." };
                Say(lines[Random.Range(0, lines.Length)]);
            }
            else
            {
                string[] lines = { "Hey!", "What's up?", "Good to see you.", "Still good from last time." };
                Say(lines[Random.Range(0, lines.Length)]);
                Model.Wave();
            }
        }

        protected override void OnHitByItem(Item item, float speed)
        {
            Profile.AdjustRelationship(-0.05f);
            if (recentHits >= 3)
            {
                Say("I'm outta here!", 2f);
                state = State.Fleeing;
                fleeUntil = Time.time + 6f;
                Vector3 away = (transform.position - PlayerFeet).Flat().normalized;
                MoveTo(transform.position + away * 12f, true);
            }
            else base.OnHitByItem(item, speed);
        }

        // ------------------------------------------------------------------ trading (IItemReceiver)

        public Vector3 ReceivePoint => ChestPosition;
        public float ReceiveRadius => ReceiveRadiusMeters;

        public bool CanReceive(Item item)
        {
            if (trading || state == State.Fleeing || !isActiveAndEnabled) return false;
            return item != null && item.IsPackaged;
        }

        public void SetHover(Item item)
        {
            if (item == hoverItem) return;
            hoverItem = item;
            if (item == null || trading) return;
            Face(PlayerHead, 2f);
            Say(PreviewLine(item), 2f);
        }

        string PreviewLine(Item item)
        {
            var p = item.Product;
            if (!Profile.isContact) return "For me? ...A free sample?";
            var deal = Game.Deals.ActiveDealFor(Profile.id);
            if (deal != null)
            {
                if (p.Family != deal.family) return "That's not what I ordered.";
                if (ProductCatalog.QualityTier(p.quality) < deal.minTier) return "I asked for better than that.";
                return $"That's it! ${deal.unitPrice * p.units}, like we said.";
            }
            if (!Profile.IsCraving(Game.State.AbsoluteMinutes)) return "I'm good for now. Text me later.";
            if (ProductCatalog.QualityTier(p.quality) < Profile.standards) return $"{ProductCatalog.QualityName(p.quality)}? Nah.";
            int ask = ProductCatalog.AskingPrice(p);
            int max = Profile.MaxUnitPrice(p, transform.position);
            if (ask > max) return $"${ask * p.units}? Too rich. I'd do ${max * p.units}.";
            return $"${ask * p.units}? Deal.";
        }

        public bool TryReceive(Item item, PlayerHand hand)
        {
            if (!CanReceive(item)) return false;
            var p = item.Product;
            var now = Game.State.AbsoluteMinutes;

            if (!Profile.isContact) return TakeSample(item);

            var deal = Game.Deals.ActiveDealFor(Profile.id);
            if (deal != null)
            {
                if (p.Family != deal.family)
                {
                    Say("That's not what I ordered.");
                    return false;
                }
                if (ProductCatalog.QualityTier(p.quality) < deal.minTier)
                {
                    Say("I asked for better than that.");
                    return false;
                }
                int pay = deal.unitPrice * p.units;
                deal.unitsDelivered += p.units;
                Accept(item, pay, deal.minTier);
                if (deal.unitsDelivered >= deal.units)
                {
                    Game.Deals.Complete(deal);
                    Game.Deals.AddMessage(Profile.name, "pleasure doing business", deal.id);
                }
                else Say($"Need {deal.units - deal.unitsDelivered} more.");
                return true;
            }

            if (!Profile.IsCraving(now))
            {
                Say("I'm good for now. Text me later.");
                return false;
            }
            if (ProductCatalog.QualityTier(p.quality) < Profile.standards)
            {
                Say($"Ew, {ProductCatalog.QualityName(p.quality)}? No way.");
                Profile.AdjustRelationship(-0.02f);
                return false;
            }
            int maxUnits = 1 + Mathf.RoundToInt(Profile.wealth * 2f + Profile.addiction * 2f);
            if (p.units > maxUnits)
            {
                Say($"That's too much. Max {maxUnits} for me.");
                return false;
            }
            int ask = ProductCatalog.AskingPrice(p);
            int max = Profile.MaxUnitPrice(p, transform.position);
            if (ask > max)
            {
                Say($"${ask * p.units}?! I'd do ${max * p.units}, tops.");
                Profile.AdjustRelationship(-0.01f);
                return false;
            }
            Accept(item, ask * p.units, Profile.standards);
            return true;
        }

        bool TakeSample(Item item)
        {
            float now = Game.State.AbsoluteMinutes;
            if (now < Profile.sampleCooldownUntilAbs)
            {
                Say("You again? Give it a rest.");
                return false;
            }
            var p = item.Product;
            float score = p.quality + (p.Family == Profile.favoriteFamily ? 0.1f : -0.1f) + Random.Range(-0.12f, 0.12f);
            if (p.effects != null)
                foreach (var e in p.effects)
                    if (Profile.favoriteEffects.Contains(e)) score += 0.15f;
            float needed = 0.32f + 0.1f * Profile.standards;
            StartCoroutine(PocketItem(item));
            Face(PlayerHead, 3f);
            if (score >= needed)
            {
                Profile.isContact = true;
                Profile.relationship = Mathf.Max(Profile.relationship, 0.1f);
                Profile.addiction = Mathf.Min(1f, Profile.addiction + 0.1f);
                Profile.lastPurchaseAbs = now;
                Profile.nextDealCheckAbs = now + Random.Range(90f, 240f);
                Say("Oh, that's good. Here's my number.", 3f);
                Model.Wave();
                Game.Deals.AddMessage(Profile.name, "hit me up whenever. i'm usually around.", 0);
                Game.UI?.Notify("New customer!", $"{Profile.name} is now a contact.", Palette.UIAccent);
                Game.Progression?.AddXp(25);
                AudioManager.Play("success", transform.position, 0.5f);
                GameEvents.Raise(GameEventType.CustomerGained, Profile);
            }
            else
            {
                Profile.sampleCooldownUntilAbs = now + 1440f;
                Say("Hmm... nah, that's not it.", 3f);
            }
            NPCManager.ReportCrime(transform.position, 0.5f);
            return true;
        }

        void Accept(Item item, int pay, int expectedTier)
        {
            var p = item.Product;
            int tierDiff = ProductCatalog.QualityTier(p.quality) - expectedTier;
            float satisfaction = 0.04f + tierDiff * 0.03f;
            if (p.effects != null)
                foreach (var e in p.effects)
                    if (Profile.favoriteEffects.Contains(e)) satisfaction += 0.03f;
            Profile.AdjustRelationship(satisfaction);
            var strain = p.Strain;
            Profile.addiction = Mathf.Min(1f, Profile.addiction + (strain != null ? strain.Addictiveness : 0.2f) * 0.08f * p.units);
            Profile.lastPurchaseAbs = Game.State.AbsoluteMinutes;
            Profile.unitsBought += p.units;
            Game.State.totalUnitsSold += p.units;

            string line = tierDiff >= 2 ? "Whoa. This is the good stuff." : tierDiff >= 1 ? "Nice, thanks!" : tierDiff == 0 ? "Cool. Here." : "Guess this'll do...";
            Say(line, 2.5f);
            Face(PlayerHead, 3f);

            StartCoroutine(PocketItem(item));
            StartCoroutine(PayRoutine(pay));

            Game.Turf?.RecordSale(transform.position, pay);
            NPCManager.ReportCrime(transform.position, 0.75f);
            Game.Progression?.AddXp(Mathf.Max(3, pay / 3));
            GameEvents.Raise(GameEventType.ProductSold, pay);
        }

        IEnumerator PocketItem(Item item)
        {
            trading = true;
            if (item.Socket != null) item.Socket.Remove(item);
            if (item.Body != null) item.Body.isKinematic = true;
            foreach (var c in item.GetComponentsInChildren<Collider>()) c.enabled = false;
            item.allowGrab = false;
            var hand = Model.LeftHandPoint;
            item.transform.SetParent(hand, true);
            Vector3 from = item.transform.localPosition;
            float t = 0f;
            while (t < 1f && item != null)
            {
                t += Time.deltaTime / 0.35f;
                item.transform.localPosition = Vector3.Lerp(from, Vector3.zero, Util.SmoothStep01(t));
                yield return null;
            }
            yield return new WaitForSeconds(0.6f);
            t = 0f;
            while (t < 1f && item != null)
            {
                t += Time.deltaTime / 0.25f;
                item.transform.localScale = Vector3.one * (1f - t);
                yield return null;
            }
            if (item != null) Destroy(item.gameObject);
            trading = false;
        }

        IEnumerator PayRoutine(int amount)
        {
            yield return new WaitForSeconds(0.45f);
            if (offeredCash != null) CollectOfferedCash();
            Model.SetOffer(true);
            offeredCash = CashPickup.Spawn(amount, Model.RightHandPoint.position, Model.RightHandPoint.rotation, Model.RightHandPoint, false);
            offeredCash.transform.localPosition = new Vector3(0f, -0.01f, 0.03f);
            offeredCash.transform.localRotation = Quaternion.Euler(0f, 90f, 0f);
            cashOfferedAt = Time.time;
            AudioManager.Play("rustle", offeredCash.transform.position, 0.4f);
            while (offeredCash != null && !offeredCash.collected) yield return null;
            Model.SetOffer(false);
            offeredCash = null;
        }

        void CollectOfferedCash()
        {
            if (offeredCash == null) return;
            if (!offeredCash.collected) offeredCash.Collect();
            offeredCash = null;
            if (Model != null) Model.SetOffer(false);
        }
    }
}
