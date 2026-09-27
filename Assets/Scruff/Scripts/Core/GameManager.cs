using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    public enum GameMode { Menu, Playing, Transition }

    /// <summary>
    /// Top-level flow: main menu -> new game / continue -> playing -> save / sleep / busted / quit to menu.
    /// Also handles weekly rent, passing out at 4 AM, and station unlocks.
    /// </summary>
    public class GameManager : MonoBehaviour
    {
        public const int StartingCash = 80;
        public const int WeeklyRent = 150;

        public GameMode Mode { get; private set; } = GameMode.Transition;
        public int RentAmount => WeeklyRent;

        public bool InputLocked => Mode == GameMode.Transition || (Game.UI != null && Game.UI.Fader != null && Game.UI.Fader.IsBusy);

        public bool CanSleep
        {
            get
            {
                if (Mode != GameMode.Playing || Game.Clock == null) return false;
                float m = Game.Clock.MinuteOfDay;
                return m >= 18f * 60f || m < 5f * 60f;
            }
        }

        WorldRefs world;
        float safetyTimer;

        void Awake()
        {
            Game.Manager = this;
        }

        public void Init(WorldRefs worldRefs, bool skipMenu)
        {
            world = worldRefs;
            Mode = GameMode.Menu;
            Game.Clock.HourTick += OnHour;
            Game.Clock.NewDay += OnNewDay;
            if (skipMenu)
            {
                if (SaveSystem.HasSave) ContinueGame();
                else NewGame();
            }
            else
            {
                EnterMenu();
            }
        }

        void OnDestroy()
        {
            if (Game.Clock != null)
            {
                Game.Clock.HourTick -= OnHour;
                Game.Clock.NewDay -= OnNewDay;
            }
        }

        // ------------------------------------------------------------------ flow

        void EnterMenu()
        {
            Mode = GameMode.Menu;
            Game.Clock.Running = false;
            Game.NPCs.DespawnAll();
            ClearWorldItems();
            Game.State = null;
            Game.Deals.OnGameLoaded(); // clears deal beacons
            Game.Player.Teleport(world.MenuSpawn, world.MenuYaw);
            world.Menu.Show();
        }

        public void NewGame()
        {
            if (world == null || Mode != GameMode.Menu) return;
            StartCoroutine(Transition(() =>
            {
                SaveSystem.Delete();
                ClearWorldItems();
                var state = new GameState
                {
                    seed = Random.Range(1, int.MaxValue),
                    cash = StartingCash,
                    day = 1,
                    minuteOfDay = 8f * 60f,
                    nextRentDay = 7,
                    baggieStock = 5,
                };
                state.SetMarkup(ProductFamily.Green, 1f);
                state.SetMarkup(ProductFamily.Crystal, 1f);
                Game.State = state;
                NPCManager.GenerateProfiles(state, 12);
                SpawnStarterKit();
                StartPlaying();

                Game.Deals.AddMessage("Uncle Ray", "heard u got kicked out lol. got u this dump of an apartment.", 0);
                Game.Deals.AddMessage("Uncle Ray", "left u a pot, soil and some seeds. grow it, bag it, sell it. rent's $150, due sunday.", 0);
                Game.Deals.AddMessage("Uncle Ray", "two of my guys already know ur selling. check ur CREW app.", 0);
                Game.UI.Notify("Welcome to Scruff", "You've got $80 and a pot. Check your phone with Y.", Palette.UIAccent, 5f);
                Game.Tutorial.ShowCurrent();
                SaveGame();
            }, "Day 1"));
        }

        public void ContinueGame()
        {
            if (world == null || Mode != GameMode.Menu) return;
            var loaded = SaveSystem.Load();
            if (loaded == null)
            {
                NewGame();
                return;
            }
            StartCoroutine(Transition(() =>
            {
                ClearWorldItems();
                Game.State = loaded;
                ApplyUnlocks(); // before restoring, so items go back into station slots
                foreach (var d in loaded.items) Item.Restore(d);
                StartPlaying();
                Game.UI.Notify($"Day {loaded.day}", $"{GameClock.FormatTime(loaded.minuteOfDay)} - {Util.Money(loaded.cash)}", Palette.UIAccent, 3f);
                Game.Tutorial.ShowCurrent();
            }, "Welcome back"));
        }

        void StartPlaying()
        {
            ApplyUnlocks();
            Game.NPCs.SpawnAll();
            Game.Deals.OnGameLoaded();
            Game.Player.Teleport(world.HomeSpawn, world.HomeYaw);
            Mode = GameMode.Playing;
            Game.Clock.Running = true;
            Game.UI.Phone.MarkDirty();
        }

        public void QuitToMenu()
        {
            if (Mode != GameMode.Playing) return;
            SaveGame();
            StartCoroutine(Transition(EnterMenu, "Saved"));
        }

        IEnumerator Transition(System.Action action, string caption)
        {
            var previous = Mode;
            Mode = GameMode.Transition;
            Game.Clock.Running = false;
            while (Game.UI.Fader.IsBusy) yield return null;
            bool done = false;
            Game.UI.Fader.FadeOutIn(() =>
            {
                action();
                done = true;
            }, caption, 0.6f);
            while (!done) yield return null;
            if (Mode == GameMode.Transition) Mode = previous == GameMode.Transition ? GameMode.Menu : previous;
        }

        // ------------------------------------------------------------------ saving

        public bool SaveGame()
        {
            var s = Game.State;
            if (s == null) return false;
            // Cash left lying around gets banked; items get captured.
            foreach (var cash in new List<CashPickup>(CashPickup.All))
                if (cash != null && !cash.collected) cash.Collect();
            s.items.Clear();
            foreach (var item in Item.All)
            {
                if (item == null || item.Def == null || !item.Def.Persistent || !item.allowGrab) continue;
                if (item.GetComponentInParent<NPCAgent>() != null) continue;
                s.items.Add(item.Capture());
            }
            bool ok = SaveSystem.Save(s);
            if (!ok) Game.UI?.Notify("Save failed", "Check the log for details.", Palette.UIDanger);
            return ok;
        }

        void ClearWorldItems()
        {
            if (Game.Player != null)
            {
                Game.Player.LeftHand.Drop(false);
                Game.Player.RightHand.Drop(false);
            }
            var items = new List<Item>(Item.All);
            foreach (var item in items)
                if (item != null) Destroy(item.gameObject);
            foreach (var cash in new List<CashPickup>(CashPickup.All))
                if (cash != null) Destroy(cash.gameObject);
        }

        void SpawnStarterKit()
        {
            ItemFactory.Spawn("pot", world.StarterPot, Quaternion.identity);
            ItemFactory.Spawn("soil_bag", world.StarterSoil, Quaternion.Euler(0f, 200f, 0f));
            ItemFactory.Spawn("seeds_backyard", world.StarterSeeds, Quaternion.Euler(0f, 160f, 0f));
            ItemFactory.Spawn("watering_can", world.StarterCan, Quaternion.Euler(0f, 120f, 0f));
        }

        // ------------------------------------------------------------------ stations

        public void UnlockStation(string id)
        {
            if (Game.State == null) return;
            Game.State.Unlock(id);
            ApplyUnlocks();
            string name = id == "mixer" ? "Mixing Station" : id == "chem" ? "Chem Station" : id;
            Game.UI.Notify("Unlocked: " + name, "It's set up in your apartment.", Palette.UIWarning, 4f);
            AudioManager.PlayUI("rankup", 0.6f);
            GameEvents.Raise(GameEventType.StationUnlocked, id);
        }

        void ApplyUnlocks()
        {
            var s = Game.State;
            world.Mixer.SetUnlocked(s != null && s.HasUnlock("mixer"));
            world.Chem.SetUnlocked(s != null && s.HasUnlock("chem"));
        }

        // ------------------------------------------------------------------ time events

        public void Sleep()
        {
            if (!CanSleep) return;
            StartCoroutine(Transition(() =>
            {
                Game.Clock.SkipTo(7f * 60f);
                Game.NPCs.ResetPolice();
                SaveGame();
                GameEvents.Raise(GameEventType.Slept);
                Game.UI.Notify($"Day {Game.State.day} - {GameClock.DayName(Game.State.day)}", "Rise and grind. Game saved.", Palette.UIAccent, 3.5f);
            }, "Zzz..."));
        }

        void OnHour(int hour)
        {
            if (Mode != GameMode.Playing) return;
            if (hour == 4)
            {
                StartCoroutine(Transition(() =>
                {
                    int lost = Game.Wallet.Take(Mathf.RoundToInt(Game.Wallet.Cash * 0.1f));
                    Game.Player.Teleport(world.HomeSpawn, world.HomeYaw);
                    Game.Clock.SkipTo(7f * 60f);
                    Game.NPCs.ResetPolice();
                    SaveGame();
                    Game.UI.Notify("You passed out", lost > 0 ? $"Woke up at home. ${lost} is missing from your pocket..." : "Woke up at home. Get some sleep next time.", Palette.UIWarning, 5f);
                }, "You passed out..."));
            }
            else if (hour == 20 && Game.State.day + 1 >= Game.State.nextRentDay && Game.State.rentDebt == 0)
            {
                Game.UI.Notify("Rent due tomorrow", $"${WeeklyRent} comes out in the morning. You have {Util.Money(Game.Wallet.Cash)}.", Palette.UIWarning, 4f);
            }
        }

        void OnNewDay(int day)
        {
            var s = Game.State;
            if (s == null) return;
            if (s.rentDebt > 0 && Game.Wallet.TrySpend(s.rentDebt))
            {
                Game.UI.Notify("Debt paid", $"Paid off ${s.rentDebt} you owed. Landlord's off your back.", Palette.UIAccent);
                s.rentDebt = 0;
            }
            if (day >= s.nextRentDay)
            {
                s.nextRentDay += 7;
                if (Game.Wallet.TrySpend(WeeklyRent))
                {
                    Game.UI.Notify("Rent paid", $"-${WeeklyRent}. Next due {GameClock.DayName(s.nextRentDay)}.", Palette.UIText);
                }
                else
                {
                    s.rentDebt += WeeklyRent;
                    Game.Deals.AddMessage("Landlord", $"rent's late. you owe ${s.rentDebt}. pay up or you're out.", 0);
                    Game.UI.Notify("Rent missed!", $"You owe ${s.rentDebt}. It'll be taken as soon as you have it.", Palette.UIDanger, 5f);
                }
            }
        }

        // ------------------------------------------------------------------ getting caught

        public void Bust(PoliceNPC cop)
        {
            if (Mode != GameMode.Playing) return;
            StartCoroutine(Transition(() =>
            {
                int confiscated = 0;
                foreach (var item in new List<Item>(Game.Player.CarriedItems()))
                {
                    if (!item.ContainsProduct) continue;
                    confiscated += item.Product.units;
                    if (item.HeldBy != null) item.HeldBy.Drop(false);
                    if (item.Socket != null) item.Socket.Remove(item);
                    Destroy(item.gameObject);
                }
                int fine = Game.Wallet.Take(Mathf.Max(20, Mathf.RoundToInt(Game.Wallet.Cash * 0.25f)));
                Game.Player.Teleport(world.HomeSpawn, world.HomeYaw);
                Game.Clock.Advance(120f);
                Game.NPCs.ResetPolice();
                GameEvents.Raise(GameEventType.Busted, fine);
                string lostText = confiscated > 0 ? $"They took {confiscated} units of product" : "They didn't find anything";
                Game.UI.Notify("BUSTED", $"{lostText} and fined you ${fine}. Released 2 hours later.", Palette.UIDanger, 6f);
                SaveGame();
            }, "BUSTED"));
        }

        // ------------------------------------------------------------------ safety nets

        void Update()
        {
            safetyTimer -= Time.deltaTime;
            if (safetyTimer > 0f || Game.Player == null || world == null) return;
            safetyTimer = 1f;

            // player fell off the world / menu platform
            float y = Game.Player.HeadPosition.y;
            if (Mode == GameMode.Menu && y < world.MenuKillY) Game.Player.Teleport(world.MenuSpawn, world.MenuYaw);
            else if (Mode == GameMode.Playing && y < -15f) Game.Player.Teleport(world.HomeSpawn, world.HomeYaw);

            // items that fell through the floor come back to the delivery mat
            foreach (var item in Item.All)
            {
                if (item == null || item.IsHeld || item.transform.position.y > -10f) continue;
                item.transform.position = world.HomeDelivery + Vector3.up * 0.3f;
                if (item.Body != null && !item.Body.isKinematic) item.Body.SetVelocity(Vector3.zero);
            }
        }
    }
}
