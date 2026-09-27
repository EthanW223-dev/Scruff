using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    public class TurfZone
    {
        public string Id;
        public string Name;
        public Bounds Bounds;
    }

    /// <summary>
    /// Neighbourhood control. Selling in a zone builds your influence there; at 50% it's your turf and customers
    /// there pay a bit more. Influence slowly fades if you stop working the block.
    ///
    /// Multiplayer note: influence is stored per zone for the local player today. For turf wars, key it by player
    /// id (see <see cref="LocalPlayerId"/>) and sync it through your networking layer; the owner of a zone is whoever
    /// has the most influence above the threshold.
    /// </summary>
    public class TurfManager : MonoBehaviour
    {
        public const string LocalPlayerId = "local";
        public const float OwnershipThreshold = 0.5f;

        public readonly List<TurfZone> Zones = new List<TurfZone>();
        TurfZone playerZone;
        float checkTimer;

        void Awake()
        {
            Game.Turf = this;
        }

        void Start()
        {
            if (Game.Clock != null) Game.Clock.NewDay += OnNewDay;
        }

        void OnDestroy()
        {
            if (Game.Clock != null) Game.Clock.NewDay -= OnNewDay;
        }

        public TurfZone AddZone(string id, string name, Vector3 center, Vector3 size)
        {
            var z = new TurfZone { Id = id, Name = name, Bounds = new Bounds(center, size) };
            Zones.Add(z);
            return z;
        }

        public TurfZone ZoneAt(Vector3 p)
        {
            foreach (var z in Zones)
            {
                var b = z.Bounds;
                if (p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z) return z;
            }
            return null;
        }

        TurfSaveData Entry(string zoneId, bool create)
        {
            if (Game.State == null) return null;
            foreach (var t in Game.State.turf)
                if (t.zoneId == zoneId) return t;
            if (!create) return null;
            var e = new TurfSaveData { zoneId = zoneId, influence = 0f };
            Game.State.turf.Add(e);
            return e;
        }

        public float Influence(string zoneId) => Entry(zoneId, false)?.influence ?? 0f;

        public bool Owns(string zoneId) => Influence(zoneId) >= OwnershipThreshold;

        public float PriceMultiplierAt(Vector3 p)
        {
            var z = ZoneAt(p);
            return z != null && Owns(z.Id) ? 1.1f : 1f;
        }

        public void RecordSale(Vector3 position, int amount)
        {
            var z = ZoneAt(position);
            if (z == null) return;
            var e = Entry(z.Id, true);
            bool before = e.influence >= OwnershipThreshold;
            e.influence = Mathf.Clamp01(e.influence + 0.03f + amount / 1500f);
            if (!before && e.influence >= OwnershipThreshold)
            {
                Game.UI?.Notify("TURF TAKEN", $"{z.Name} is your turf now. Customers here pay +10%.", Palette.UIWarning, 5f);
                AudioManager.PlayUI("rankup", 0.6f);
            }
        }

        void OnNewDay(int day)
        {
            if (Game.State == null) return;
            foreach (var t in Game.State.turf) t.influence = Mathf.Max(0f, t.influence - 0.03f);
        }

        void Update()
        {
            if (!Game.IsPlaying || Game.Player == null) return;
            checkTimer -= Time.deltaTime;
            if (checkTimer > 0f) return;
            checkTimer = 1f;
            var z = ZoneAt(Game.Player.HeadPosition);
            if (z != playerZone)
            {
                playerZone = z;
                if (z != null)
                {
                    float inf = Influence(z.Id);
                    string owner = inf >= OwnershipThreshold ? "<#ffdd66>Your turf</>" : "Unclaimed";
                    Game.UI?.Notify(z.Name, $"{owner} - influence {Mathf.RoundToInt(inf * 100f)}%", Palette.UITextDim, 2.2f);
                }
            }
        }

        public TurfZone PlayerZone => playerZone;
    }
}
