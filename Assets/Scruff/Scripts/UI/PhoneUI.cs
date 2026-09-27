using System;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Your phone. Press Y (or the menu button) to pull it out in your off hand; poke it with your other hand.
    /// Apps: Home (stats/goal), Messages (deal requests: accept/decline), Crew (customers), Prices (markup), Menu (settings/save).
    /// </summary>
    public class PhoneUI : MonoBehaviour
    {
        enum App { Home, Messages, Crew, Prices, Menu }

        const float SW = 0.185f;
        const float SH = 0.28f;
        const float ContentTop = 0.093f;
        const float ContentBottom = -0.1f;
        const float TextW = 0.172f;

        public bool IsOpen { get; private set; }

        PlayerRig rig;
        Transform device;
        Transform content;
        TextBlock clock;
        TextBlock cash;
        TextBlock appTitle;
        readonly List<PokeButton> nav = new List<PokeButton>();
        App app = App.Home;
        int page;
        bool dirty = true;
        float rebuildCooldown;
        float periodic;
        float statusTimer;
        float open;
        bool confirmQuit;
        bool placed;
        bool subscribed;

        PlayerHand PhoneHand => GameSettings.PhoneOnLeftHand ? rig.LeftHand : rig.RightHand;

        public static PhoneUI Create(PlayerRig rig)
        {
            var go = new GameObject("Phone");
            var p = go.AddComponent<PhoneUI>();
            p.rig = rig;
            p.Build();
            return p;
        }

        void Build()
        {
            device = Util.CreateChild(transform, "Device");
            UIFactory.Panel(device, new Vector2(0.2f, 0.3f), new Color(0.1f, 0.1f, 0.12f), new Vector3(0f, 0f, 0.003f), 0.012f, "Body");
            UIFactory.Panel(device, new Vector2(SW, SH), Palette.UIBackground, new Vector3(0f, 0f, 0.001f), 0.002f, "Screen");
            clock = UIFactory.Text(device, "", 0.0105f, Palette.UIText, new Vector3(-SW * 0.46f, 0.128f, 0f), TextBlock.HAlign.Left);
            cash = UIFactory.Text(device, "", 0.0105f, Palette.Money, new Vector3(SW * 0.46f, 0.128f, 0f), TextBlock.HAlign.Right);
            appTitle = UIFactory.Text(device, "", 0.015f, Palette.UIAccent, new Vector3(0f, 0.107f, 0f));
            UIFactory.Panel(device, new Vector2(SW * 0.94f, 0.0015f), Palette.UIPanelLight, new Vector3(0f, 0.097f, 0f), 0.001f, "Divider");
            content = Util.CreateChild(device, "Content");

            string[] labels = { "HOME", "MSGS", "CREW", "PRICE", "MENU" };
            for (int i = 0; i < labels.Length; i++)
            {
                int idx = i;
                var b = UIFactory.Button(device, labels[i], new Vector2(0.034f, 0.03f), Palette.UIButton, new Vector3(-0.0724f + i * 0.0362f, -0.122f, -0.004f), () => SwitchApp((App)idx), 0.0078f);
                nav.Add(b);
            }
            device.localScale = Vector3.zero;
            device.gameObject.SetActive(false);
        }

        void Subscribe()
        {
            if (subscribed) return;
            if (Game.Deals == null || Game.Wallet == null || Game.Progression == null) return;
            Game.Deals.Changed += MarkDirty;
            Game.Wallet.Changed += OnCashChanged;
            Game.Progression.XpChanged += MarkDirty;
            GameSettings.Changed += MarkDirty;
            subscribed = true;
        }

        void OnDestroy()
        {
            if (!subscribed) return;
            if (Game.Deals != null) Game.Deals.Changed -= MarkDirty;
            if (Game.Wallet != null) Game.Wallet.Changed -= OnCashChanged;
            if (Game.Progression != null) Game.Progression.XpChanged -= MarkDirty;
            GameSettings.Changed -= MarkDirty;
        }

        void OnCashChanged(int balance, int delta) => MarkDirty();

        public void MarkDirty() => dirty = true;

        public void Toggle()
        {
            if (IsOpen) Close();
            else Open();
        }

        public void Open(bool toMessages = false)
        {
            if (!Game.IsPlaying) return;
            IsOpen = true;
            confirmQuit = false;
            if (toMessages) app = App.Messages;
            dirty = true;
            device.gameObject.SetActive(true);
            PhoneHand.Drop();
            AudioManager.PlayUI("pop", 0.4f, 1.2f);
            PhoneHand.Haptic(0.2f, 0.04f);
        }

        public void Close()
        {
            if (!IsOpen) return;
            IsOpen = false;
            AudioManager.PlayUI("drop", 0.3f, 1.3f);
        }

        void SwitchApp(App a)
        {
            if (app != a) page = 0;
            app = a;
            confirmQuit = false;
            dirty = true;
        }

        void Update()
        {
            Subscribe();
            if (Game.IsPlaying)
            {
                bool left = GameSettings.PhoneOnLeftHand;
                if (XRInput.Pressed(left, XRButton.Secondary) || (left && XRInput.Pressed(true, XRButton.Menu))) Toggle();
            }
            else if (IsOpen)
            {
                IsOpen = false;
            }

            rig.LeftHand.GrabBlocked = IsOpen && GameSettings.PhoneOnLeftHand;
            rig.RightHand.GrabBlocked = IsOpen && !GameSettings.PhoneOnLeftHand;

            open = Mathf.MoveTowards(open, IsOpen ? 1f : 0f, Time.deltaTime * 7f);
            if (open <= 0f && !IsOpen)
            {
                if (device.gameObject.activeSelf) device.gameObject.SetActive(false);
                placed = false;
                return;
            }
            device.localScale = Vector3.one * Util.SmoothStep01(open);

            statusTimer -= Time.deltaTime;
            if (statusTimer <= 0f)
            {
                statusTimer = 0.5f;
                clock.Text = Game.Clock != null ? GameClock.FormatTime(Game.Clock.MinuteOfDay) : "";
                cash.Text = Util.Money(Game.Wallet != null ? Game.Wallet.Cash : 0);
            }

            periodic -= Time.deltaTime;
            if (periodic <= 0f)
            {
                periodic = 3f;
                dirty = true;
            }
            rebuildCooldown -= Time.deltaTime;
            if (dirty && rebuildCooldown <= 0f && IsOpen)
            {
                dirty = false;
                rebuildCooldown = 0.25f;
                Rebuild();
            }
        }

        void LateUpdate()
        {
            if (!device.gameObject.activeSelf) return;
            var hand = PhoneHand;
            Vector3 head = rig.HeadPosition;
            Vector3 anchor = hand.GripPosition + Vector3.up * 0.12f;
            anchor += (head - anchor).normalized * 0.04f;
            Quaternion rot = Quaternion.LookRotation(anchor - head, Vector3.up) * Quaternion.Euler(8f, 0f, 0f);
            if (!placed)
            {
                transform.SetPositionAndRotation(anchor, rot);
                placed = true;
            }
            else
            {
                transform.position = Vector3.Lerp(transform.position, anchor, Util.Damp(30f, Time.deltaTime));
                transform.rotation = Quaternion.Slerp(transform.rotation, rot, Util.Damp(14f, Time.deltaTime));
            }
        }

        // ------------------------------------------------------------------ building

        void Clear()
        {
            for (int i = content.childCount - 1; i >= 0; i--) Destroy(content.GetChild(i).gameObject);
        }

        TextBlock T(string text, float x, float y, float size, Color color, TextBlock.HAlign h = TextBlock.HAlign.Left, float width = TextW)
        {
            return UIFactory.Text(content, text, size, color, new Vector3(x, y, 0f), h, TextBlock.VAlign.Top, width);
        }

        PokeButton B(string label, float x, float y, float w, float h, Color c, Action a, float textSize = 0.0085f)
        {
            return UIFactory.Button(content, label, new Vector2(w, h), c, new Vector3(x, y, -0.004f), a, textSize);
        }

        void Card(float y, float height, Color? color = null)
        {
            UIFactory.Panel(content, new Vector2(SW * 0.95f, height), color ?? Palette.UIPanel, new Vector3(0f, y - height * 0.5f, 0.0005f), 0.001f, "Card");
        }

        void Rebuild()
        {
            Clear();
            for (int i = 0; i < nav.Count; i++) nav[i].SetTint(i == (int)app ? Palette.UIButtonActive : Palette.UIButton);
            if (Game.State == null) return;
            switch (app)
            {
                case App.Home: BuildHome(); break;
                case App.Messages: BuildMessages(); break;
                case App.Crew: BuildCrew(); break;
                case App.Prices: BuildPrices(); break;
                case App.Menu: BuildMenu(); break;
            }
        }

        void BuildHome()
        {
            appTitle.Text = "HOME";
            var s = Game.State;
            float x = -SW * 0.46f;
            float y = ContentTop;
            T($"Day {s.day} ({GameClock.DayName(s.day)})  {GameClock.FormatTime(s.minuteOfDay)}", x, y, 0.0095f, Palette.UITextDim);
            y -= 0.017f;
            T(Util.Money(s.cash), x, y, 0.026f, Palette.Money);
            y -= 0.034f;

            var prog = Game.Progression;
            T($"{prog.RankName}", x, y, 0.012f, Palette.UIWarning);
            T($"{s.xp} XP", -x, y, 0.009f, Palette.UITextDim, TextBlock.HAlign.Right);
            y -= 0.017f;
            UIFactory.Bar(content, new Vector2(SW * 0.92f, 0.007f), Palette.UIPanelLight, Palette.Xp, new Vector3(0f, y, 0f), prog.RankProgress);
            y -= 0.008f;
            if (prog.XpToNext > 0) T($"{prog.XpToNext} XP to {Progression.RankNames[Mathf.Min(prog.Rank + 1, Progression.RankNames.Length - 1)]}", x, y, 0.008f, Palette.UITextDim);
            y -= 0.017f;

            string rent = s.rentDebt > 0
                ? $"<#ff6655>Owe ${s.rentDebt} rent!</>"
                : $"Rent ${Game.Manager.RentAmount} due {GameClock.DayName(s.nextRentDay)} (day {s.nextRentDay})";
            T(rent, x, y, 0.0095f, Palette.UIText);
            y -= 0.016f;

            var open = Game.Deals.OpenDeals();
            int offers = 0, accepted = 0;
            foreach (var d in open)
            {
                if (d.state == DealState.Offered) offers++;
                else accepted++;
            }
            T($"Deals: {offers} new, {accepted} active", x, y, 0.0095f, offers > 0 ? Palette.UIAccent : Palette.UIText);
            y -= 0.016f;

            var zone = Game.Turf != null ? Game.Turf.PlayerZone : null;
            if (zone != null)
            {
                float inf = Game.Turf.Influence(zone.Id);
                T($"{zone.Name}: {Mathf.RoundToInt(inf * 100f)}% {(inf >= TurfManager.OwnershipThreshold ? "<#ffdd66>(yours)</>" : "")}", x, y, 0.0095f, Palette.UIText);
                y -= 0.016f;
            }

            string goal = Game.Tutorial != null ? Game.Tutorial.CurrentObjective : null;
            if (!string.IsNullOrEmpty(goal))
            {
                Card(y + 0.004f, 0.05f, new Color(0.2f, 0.18f, 0.1f));
                T("GOAL", x + 0.003f, y, 0.0085f, Palette.UIWarning);
                T(goal, x + 0.003f, y - 0.011f, 0.0088f, Palette.UIText, TextBlock.HAlign.Left, TextW - 0.006f);
            }
        }

        void BuildMessages()
        {
            appTitle.Text = "MESSAGES";
            float x = -SW * 0.46f;
            float y = ContentTop;
            var deals = Game.Deals.OpenDeals();
            deals.Sort((a, b) => a.state.CompareTo(b.state));
            float now = Game.State.AbsoluteMinutes;

            foreach (var d in deals)
            {
                var c = Game.NPCs.Profile(d.customerId);
                var spot = DealSystem.MeetSpot(d.meetSpot);
                string fam = d.family == ProductFamily.Green ? "Green" : "Crystal";
                string tier = d.minTier >= 2 ? $" {ProductCatalog.TierNames[d.minTier]}+" : "";
                const float h = 0.058f;
                Card(y, h, d.state == DealState.Offered ? new Color(0.14f, 0.2f, 0.16f) : new Color(0.2f, 0.18f, 0.12f));
                T(c != null ? c.name : "???", x + 0.003f, y - 0.004f, 0.011f, Palette.UIText);
                T($"<#77ee77>${d.Total}</>", x + 0.1f, y - 0.004f, 0.011f, Palette.UIText);
                T($"{d.units}x {fam}{tier}", x + 0.003f, y - 0.019f, 0.009f, Palette.UIText);
                T($"@ {spot?.displayName}", x + 0.003f, y - 0.031f, 0.0085f, Palette.UITextDim);
                if (d.state == DealState.Offered)
                {
                    T($"Reply within {GameClock.FormatDuration(d.respondByAbs - now)}", x + 0.003f, y - 0.043f, 0.008f, Palette.UIWarning);
                    int id = d.id;
                    B("OK", SW * 0.37f, y - 0.016f, 0.036f, 0.022f, Palette.UIButtonActive, () => Game.Deals.Accept(id), 0.0085f);
                    B("NO", SW * 0.37f, y - 0.042f, 0.036f, 0.018f, Palette.UIButtonDanger, () => Game.Deals.Decline(id), 0.0075f);
                }
                else
                {
                    string left = d.unitsDelivered > 0 ? $" ({d.unitsDelivered}/{d.units})" : "";
                    T($"Meet by {GameClock.FormatTime(d.meetEndAbs % 1440f)} ({GameClock.FormatDuration(d.meetEndAbs - now)}){left}", x + 0.003f, y - 0.043f, 0.008f, Palette.UIWarning, TextBlock.HAlign.Left);
                }
                y -= h + 0.005f;
            }

            if (deals.Count == 0)
            {
                T("No deal requests right now.\nKeep your customers happy and they'll text.", x, y, 0.0088f, Palette.UITextDim);
                y -= 0.03f;
            }

            y -= 0.004f;
            T("RECENT", x, y, 0.0085f, Palette.UITextDim);
            y -= 0.012f;
            var msgs = Game.State.messages;
            for (int i = msgs.Count - 1; i >= 0 && y > ContentBottom + 0.012f; i--)
            {
                var m = msgs[i];
                var tb = T($"<#{(m.from == "You" ? "88bbff" : "ffdd88")}>{m.from}:</> {m.text}", x, y, 0.0082f, Palette.UIText);
                tb.Rebuild();
                y -= tb.Bounds.y + 0.004f;
                if (y < ContentBottom) Destroy(tb.gameObject);
            }
        }

        void BuildCrew()
        {
            appTitle.Text = "CREW";
            var known = new List<CustomerProfile>();
            foreach (var c in Game.State.customers)
                if (c.isContact) known.Add(c);
            known.Sort((a, b) => b.relationship.CompareTo(a.relationship));

            float x = -SW * 0.46f;
            float y = ContentTop;
            if (known.Count == 0)
            {
                T("No customers yet.\nHand a stranger a packaged sample to win them over.", x, y, 0.009f, Palette.UITextDim);
                return;
            }
            const int perPage = 4;
            int pages = Mathf.Max(1, Mathf.CeilToInt(known.Count / (float)perPage));
            page = Mathf.Clamp(page, 0, pages - 1);
            float now = Game.State.AbsoluteMinutes;
            for (int i = page * perPage; i < Mathf.Min(known.Count, (page + 1) * perPage); i++)
            {
                var c = known[i];
                const float h = 0.038f;
                Card(y, h);
                string craving = c.IsCraving(now) ? " <#77ee77>wants some</>" : "";
                T($"{c.name}{craving}", x + 0.003f, y - 0.004f, 0.0105f, Palette.UIText);
                T($"<#ff8899>{Util.Stars(c.Relationship01)}</>", -x - 0.003f, y - 0.004f, 0.009f, Palette.UIText, TextBlock.HAlign.Right);
                var likes = new List<string> { c.favoriteFamily == ProductFamily.Green ? "Green" : "Crystal" };
                foreach (var e in c.favoriteEffects)
                {
                    var def = ProductCatalog.Effect(e);
                    if (def != null) likes.Add($"<#{ColorUtility.ToHtmlStringRGB(def.Color)}>{def.Name}</>");
                }
                T($"Likes {string.Join(", ", likes)}", x + 0.003f, y - 0.017f, 0.0078f, Palette.UITextDim);
                T($"{ProductCatalog.TierNames[Mathf.Clamp(c.standards, 0, 4)]}+ only, hooked {Mathf.RoundToInt(c.addiction * 100f)}%, {Game.NPCs.LocationOf(c.id)}", x + 0.003f, y - 0.027f, 0.0078f, Palette.UITextDim);
                y -= h + 0.003f;
            }
            if (pages > 1)
            {
                B("<", -0.06f, ContentBottom + 0.008f, 0.03f, 0.02f, Palette.UIButton, () => { page = (page - 1 + pages) % pages; dirty = true; });
                T($"{page + 1}/{pages}", 0f, ContentBottom + 0.013f, 0.009f, Palette.UITextDim, TextBlock.HAlign.Center, 0.05f);
                B(">", 0.06f, ContentBottom + 0.008f, 0.03f, 0.02f, Palette.UIButton, () => { page = (page + 1) % pages; dirty = true; });
            }
        }

        void BuildPrices()
        {
            appTitle.Text = "PRICES";
            float x = -SW * 0.46f;
            float y = ContentTop;
            T("Your asking price = street value x markup. Too high and people walk.", x, y, 0.0082f, Palette.UITextDim);
            y -= 0.026f;
            foreach (ProductFamily fam in Enum.GetValues(typeof(ProductFamily)))
            {
                if (fam == ProductFamily.Crystal && !Game.State.HasUnlock("chem")) continue;
                var f = fam;
                float markup = Game.State.GetMarkup(fam);
                var strain = DealSystem.CheapestStrain(fam);
                var sample = new ProductData { strain = strain.Id, quality = 0.5f };
                const float h = 0.06f;
                Card(y, h);
                T(fam == ProductFamily.Green ? "GREEN" : "CRYSTAL", x + 0.003f, y - 0.004f, 0.011f, Palette.UIAccent);
                T($"{Mathf.RoundToInt(markup * 100f)}%", -x - 0.003f, y - 0.003f, 0.014f, markup > 1.3f ? Palette.UIWarning : Palette.UIText, TextBlock.HAlign.Right);
                T($"{strain.Name} (Standard): <#77ee77>${ProductCatalog.AskingPrice(sample)}</>/unit", x + 0.003f, y - 0.021f, 0.0085f, Palette.UIText);
                B("-10%", -0.04f, y - 0.045f, 0.05f, 0.02f, Palette.UIButton, () => SetMarkup(f, -0.1f));
                B("+10%", 0.04f, y - 0.045f, 0.05f, 0.02f, Palette.UIButton, () => SetMarkup(f, 0.1f));
                y -= h + 0.006f;
            }
            T("Limits depend on quality, effects they like, their wallet, how much they like you and how hooked they are.", x, y, 0.0078f, Palette.UITextDim);
        }

        void SetMarkup(ProductFamily family, float delta)
        {
            float m = Mathf.Clamp(Mathf.Round((Game.State.GetMarkup(family) + delta) * 10f) / 10f, 0.5f, 2.5f);
            Game.State.SetMarkup(family, m);
            dirty = true;
        }

        void BuildMenu()
        {
            appTitle.Text = "MENU";
            const float row = 0.028f;
            float y = ContentTop - 0.012f;
            float x = -SW * 0.46f;
            B("SAVE GAME", 0f, y, 0.15f, 0.024f, Palette.UIButtonActive, () =>
            {
                if (Game.Manager.SaveGame()) Game.UI.Notify("Saved", $"Day {Game.State.day}, {GameClock.FormatTime(Game.State.minuteOfDay)}", Palette.UIAccent, 2f);
            }, 0.01f);
            y -= 0.032f;

            T("Turning", x, y + 0.006f, 0.009f, Palette.UITextDim);
            string turn = GameSettings.TurnMode == TurnMode.Snap ? $"SNAP {GameSettings.SnapAngle:0}" : GameSettings.TurnMode == TurnMode.Smooth ? "SMOOTH" : "OFF";
            B(turn, 0.01f, y, 0.06f, 0.022f, Palette.UIButton, GameSettings.CycleTurnMode);
            B("ANGLE", 0.062f, y, 0.036f, 0.022f, Palette.UIButton, GameSettings.CycleSnapAngle, 0.0075f);
            y -= row;

            T("Volume", x, y + 0.006f, 0.009f, Palette.UITextDim);
            B("-", -0.01f, y, 0.026f, 0.022f, Palette.UIButton, () => GameSettings.AdjustVolume(-0.1f), 0.012f);
            T($"{Mathf.RoundToInt(GameSettings.MasterVolume * 100f)}%", 0.027f, y + 0.006f, 0.0095f, Palette.UIText, TextBlock.HAlign.Center, 0.04f);
            B("+", 0.064f, y, 0.026f, 0.022f, Palette.UIButton, () => GameSettings.AdjustVolume(0.1f), 0.012f);
            y -= row;

            T("Phone hand", x, y + 0.006f, 0.009f, Palette.UITextDim);
            B(GameSettings.PhoneOnLeftHand ? "LEFT" : "RIGHT", 0.035f, y, 0.06f, 0.022f, Palette.UIButton, () =>
            {
                GameSettings.PhoneOnLeftHand = !GameSettings.PhoneOnLeftHand;
                GameSettings.Save();
            });
            y -= row;

            T("Colour", x, y + 0.006f, 0.009f, Palette.UITextDim);
            for (int i = 0; i < GameSettings.PlayerColors.Length; i++)
            {
                int idx = i;
                B(i == GameSettings.ColorIndex ? "*" : "", -0.03f + (i % 4) * 0.028f, y - (i / 4) * 0.025f, 0.022f, 0.021f, GameSettings.PlayerColors[i], () => GameSettings.SetColor(idx), 0.012f);
            }
            y -= 0.054f;

            B(confirmQuit ? "SURE? (SAVES)" : "QUIT TO TITLE", 0f, y, 0.15f, 0.024f, Palette.UIButtonDanger, () =>
            {
                if (!confirmQuit)
                {
                    confirmQuit = true;
                    dirty = true;
                    return;
                }
                Close();
                Game.Manager.QuitToMenu();
            }, 0.0095f);
        }
    }
}
