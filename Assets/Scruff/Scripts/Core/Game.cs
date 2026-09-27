using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Central access point for the running game's systems. Everything is created at runtime by
    /// <see cref="GameBootstrap"/>, which fills these in.
    /// </summary>
    public static class Game
    {
        public static GameManager Manager;
        public static GameClock Clock;
        public static Wallet Wallet;
        public static Progression Progression;
        public static PlayerRig Player;
        public static DealSystem Deals;
        public static NPCManager NPCs;
        public static TurfManager Turf;
        public static UIManager UI;
        public static WorldRefs World;
        public static TutorialSystem Tutorial;

        /// <summary>The live, saveable state of the current run. Null while in the main menu before a game starts.</summary>
        public static GameState State;

        public static bool IsPlaying => Manager != null && Manager.Mode == GameMode.Playing;

        /// <summary>True while the app / play mode is shutting down (don't spawn things then).</summary>
        public static bool IsQuitting;

        /// <summary>Resets statics so "Enter Play Mode without domain reload" doesn't keep stale references.</summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            Manager = null;
            Clock = null;
            Wallet = null;
            Progression = null;
            Player = null;
            Deals = null;
            NPCs = null;
            Turf = null;
            UI = null;
            World = null;
            Tutorial = null;
            State = null;
            IsQuitting = false;
            GameEvents.Clear();
            Application.quitting -= OnQuitting;
            Application.quitting += OnQuitting;
        }

        static void OnQuitting()
        {
            IsQuitting = true;
        }
    }
}
