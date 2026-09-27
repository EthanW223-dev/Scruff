using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Walks a new player through the core loop one goal at a time (shown on the phone's Home app and as toasts).
    /// Progress is saved in <see cref="GameState.tutorialStep"/>.
    /// </summary>
    public class TutorialSystem : MonoBehaviour
    {
        struct Step
        {
            public string Objective;
            public GameEventType CompletesOn;
        }

        static readonly Step[] Steps =
        {
            new Step { Objective = "Grab the soil bag in the grow corner and tip it over the empty pot.", CompletesOn = GameEventType.PotFilledWithSoil },
            new Step { Objective = "Tip the seed packet over the pot so a seed drops in.", CompletesOn = GameEventType.SeedPlanted },
            new Step { Objective = "Water it: tilt the watering can over the pot. (Refill at the sink.)", CompletesOn = GameEventType.PlantWatered },
            new Step { Objective = "Let it grow - keep it watered. Sleep after 6 PM to skip time. Pick the buds when it's ready.", CompletesOn = GameEventType.BudHarvested },
            new Step { Objective = "Grab a baggie from the packing table and drop a bud into it.", CompletesOn = GameEventType.ProductPackaged },
            new Step { Objective = "Sell it: accept a deal on your phone (Y) and hand the bag to the customer. Or find someone who wants some.", CompletesOn = GameEventType.ProductSold },
        };

        public string CurrentObjective
        {
            get
            {
                if (Game.State == null) return null;
                int i = Game.State.tutorialStep;
                return i >= 0 && i < Steps.Length ? Steps[i].Objective : null;
            }
        }

        void Awake()
        {
            Game.Tutorial = this;
            GameEvents.OnEvent += OnGameEvent;
        }

        void OnDestroy()
        {
            GameEvents.OnEvent -= OnGameEvent;
        }

        void OnGameEvent(GameEventType type, object data)
        {
            if (Game.State == null) return;
            int i = Game.State.tutorialStep;
            if (i < 0 || i >= Steps.Length || Steps[i].CompletesOn != type) return;

            Game.State.tutorialStep++;
            AudioManager.PlayUI("success", 0.5f);
            if (Game.State.tutorialStep < Steps.Length)
            {
                Game.UI?.Notify("Goal complete", "Next: " + Steps[Game.State.tutorialStep].Objective, Palette.UIWarning, 6f);
            }
            else
            {
                Game.UI?.Notify("You're in business", "Buy more seeds and pots on the computer, set prices on your phone, and keep away from the cops.", Palette.UIWarning, 7f);
                Game.Deals?.AddMessage("Uncle Ray", "look at u go. rent's still due sunday tho", 0);
            }
            Game.UI?.Phone?.MarkDirty();
        }

        public void ShowCurrent()
        {
            var o = CurrentObjective;
            if (!string.IsNullOrEmpty(o)) Game.UI?.Notify("Goal", o, Palette.UIWarning, 6f);
        }
    }
}
