using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// The only component you need in a scene. It builds the whole game at runtime: systems, world, NavMesh,
    /// player rig, UI and NPCs. (Use the "Scruff > Create Game Scene" menu to make a scene with it.)
    /// </summary>
    [DefaultExecutionOrder(-1000)]
    public class GameBootstrap : MonoBehaviour
    {
        [Tooltip("Play with mouse & keyboard even if a headset is connected.")]
        public bool forceDesktopMode;
        [Tooltip("Skip the main menu: continue the save (or start a new game) immediately. Handy while developing.")]
        public bool skipMainMenu;
        [Tooltip("Real seconds per in-game minute. 1 = a day lasts 24 minutes.")]
        public float secondsPerGameMinute = 1f;

        WorldRefs world;
        bool started;

        void Awake()
        {
            if (Game.Manager != null)
            {
                Destroy(gameObject);
                return;
            }

            Layers.ConfigurePhysics();
            GameSettings.Load();
            ScruffMaterials.SetDefaultGlobals();
            SoundLibrary.Init();
            ItemDatabase.Init();

            var systems = new GameObject("Scruff Systems").transform;
            systems.SetParent(transform, false);
            systems.gameObject.AddComponent<AudioManager>();
            var clock = systems.gameObject.AddComponent<GameClock>();
            clock.realSecondsPerGameMinute = secondsPerGameMinute;
            var dayNight = systems.gameObject.AddComponent<DayNightCycle>();
            systems.gameObject.AddComponent<TurfManager>();
            systems.gameObject.AddComponent<DealSystem>();
            systems.gameObject.AddComponent<NPCManager>();
            systems.gameObject.AddComponent<TutorialSystem>();
            var manager = systems.gameObject.AddComponent<GameManager>();
            Game.Wallet = new Wallet();
            Game.Progression = new Progression();

            world = WorldBuilder.Build();
            Game.World = world;

            var rig = PlayerRig.Create(world.MenuSpawn, world.MenuYaw, forceDesktopMode);
            Game.Player = rig;
            dayNight.targetCamera = rig.Camera;
            UIManager.Create(rig);

            // Start the rest once the NavMesh is ready (NPCs need it).
            var bake = NavMeshBaker.BakeAsync(world.WorldBounds, world.NotWalkable);
            bake.completed += _ => Begin();
        }

        void Begin()
        {
            if (started || this == null) return;
            started = true;
            Game.Manager.Init(world, skipMainMenu);
        }
    }
}
