using System.Collections.Generic;
using UnityEngine;
using UnityEngine.AI;

namespace Scruff
{
    /// <summary>Spawns customers (one per saved profile) and police, sends people home at night and back out in the morning.</summary>
    public class NPCManager : MonoBehaviour
    {
        public int policeCount = 3;

        readonly List<CustomerNPC> customers = new List<CustomerNPC>();
        readonly List<PoliceNPC> police = new List<PoliceNPC>();
        Transform root;
        float scheduleTimer;
        bool spawned;

        public IReadOnlyList<CustomerNPC> Customers => customers;
        public IReadOnlyList<PoliceNPC> Police => police;

        void Awake()
        {
            Game.NPCs = this;
            root = new GameObject("NPCs").transform;
        }

        public CustomerProfile Profile(string id)
        {
            if (Game.State == null) return null;
            foreach (var c in Game.State.customers)
                if (c.id == id) return c;
            return null;
        }

        /// <summary>Generates the neighbourhood's customers for a new game.</summary>
        public static void GenerateProfiles(GameState state, int count)
        {
            var rng = new System.Random(state.seed);
            var names = new HashSet<string>();
            int homes = Mathf.Max(1, PointOfInterest.OfType(PoiType.Home).Count);
            for (int i = 0; i < count; i++)
            {
                string name = NameGenerator.Make(rng, names);
                names.Add(name);
                var p = CustomerProfile.Generate(rng, name, i % homes);
                if (i < 2)
                {
                    // Two people already know you're selling.
                    p.isContact = true;
                    p.relationship = 0.15f;
                    p.addiction = 0.25f;
                    p.favoriteFamily = ProductFamily.Green;
                    p.standards = 0;
                    p.lastPurchaseAbs = -99999f;
                    // first texts arrive around when the first plant is ready
                    p.nextDealCheckAbs = state.AbsoluteMinutes + 300f + rng.Next(0, 120);
                }
                state.customers.Add(p);
            }
        }

        public void SpawnAll()
        {
            DespawnAll();
            if (Game.State == null) return;
            var homes = PointOfInterest.OfType(PoiType.Home);
            var hangouts = PointOfInterest.OfType(PoiType.Hangout);
            foreach (var profile in Game.State.customers)
            {
                Vector3 pos;
                if (hangouts.Count > 0) pos = hangouts[Random.Range(0, hangouts.Count)].RandomPointNear();
                else if (homes.Count > 0) pos = homes[profile.homeIndex % homes.Count].transform.position;
                else pos = Vector3.zero;
                if (!NavMesh.SamplePosition(pos, out var hit, 6f, NavMesh.AllAreas)) continue;
                var npc = CustomerNPC.Spawn(profile, hit.position, root);
                customers.Add(npc);
            }

            var stations = PointOfInterest.OfType(PoiType.PoliceStation);
            var patrols = PointOfInterest.OfType(PoiType.Patrol);
            for (int i = 0; i < policeCount; i++)
            {
                Vector3 pos = stations.Count > 0 ? stations[0].RandomPointNear() : (patrols.Count > 0 ? patrols[0].transform.position : Vector3.zero);
                if (!NavMesh.SamplePosition(pos, out var hit, 6f, NavMesh.AllAreas)) continue;
                var cop = PoliceNPC.Spawn(Game.State.seed + 1000 + i, hit.position, root, i * Mathf.Max(1, patrols.Count / Mathf.Max(1, policeCount)));
                cop.ResetToPatrol();
                police.Add(cop);
            }
            spawned = true;
            UpdateSchedules(true);
        }

        public void DespawnAll()
        {
            foreach (var c in customers)
                if (c != null) Destroy(c.gameObject);
            foreach (var p in police)
                if (p != null) Destroy(p.gameObject);
            customers.Clear();
            police.Clear();
            spawned = false;
        }

        public CustomerNPC FindCustomer(string profileId)
        {
            foreach (var c in customers)
                if (c != null && c.Profile != null && c.Profile.id == profileId) return c;
            return null;
        }

        /// <summary>Human-readable "where are they" for the phone.</summary>
        public string LocationOf(string profileId)
        {
            var npc = FindCustomer(profileId);
            if (npc == null || !npc.gameObject.activeInHierarchy) return "at home";
            PointOfInterest best = null;
            float bestDist = float.MaxValue;
            foreach (var poi in PointOfInterest.All)
            {
                if (poi.type == PoiType.Patrol || poi.type == PoiType.PoliceStation) continue;
                float d = (poi.transform.position - npc.transform.position).sqrMagnitude;
                if (d < bestDist)
                {
                    bestDist = d;
                    best = poi;
                }
            }
            return best != null ? "near " + best.displayName : "out and about";
        }

        public void SendHome(CustomerNPC npc)
        {
            npc.gameObject.SetActive(false);
        }

        void Update()
        {
            if (!spawned) return;
            scheduleTimer -= Time.deltaTime;
            if (scheduleTimer > 0f) return;
            scheduleTimer = 2f;
            UpdateSchedules(false);
        }

        void UpdateSchedules(bool instant)
        {
            var homes = PointOfInterest.OfType(PoiType.Home);
            foreach (var npc in customers)
            {
                if (npc == null) continue;
                bool shouldBeHome = npc.ShouldBeHome;
                if (npc.gameObject.activeSelf)
                {
                    if (shouldBeHome && instant) npc.gameObject.SetActive(false);
                }
                else if (!shouldBeHome && homes.Count > 0)
                {
                    // Come back out of the front door in the morning (or for a late deal).
                    var home = homes[npc.Profile.homeIndex % homes.Count];
                    npc.gameObject.SetActive(true);
                    if (npc.Warp(home.transform.position)) npc.WakeUp();
                    else npc.gameObject.SetActive(false);
                }
            }
            policeCountActive = Game.Clock != null && Game.Clock.IsNight ? police.Count : Mathf.Max(1, police.Count - 1);
            for (int i = 0; i < police.Count; i++)
            {
                if (police[i] == null) continue;
                bool active = i < policeCountActive || police[i].IsChasing;
                if (police[i].gameObject.activeSelf != active)
                {
                    police[i].gameObject.SetActive(active);
                    if (active) police[i].ResetToPatrol();
                }
            }
        }

        int policeCountActive;

        public static void ReportCrime(Vector3 position, float severity)
        {
            if (Game.NPCs == null) return;
            foreach (var cop in Game.NPCs.police)
                if (cop != null && cop.isActiveAndEnabled) cop.Witness(position, severity);
        }

        public static void AlertNearbyPolice(Vector3 position, PoliceNPC caller)
        {
            if (Game.NPCs == null) return;
            foreach (var cop in Game.NPCs.police)
            {
                if (cop == null || cop == caller || !cop.isActiveAndEnabled) continue;
                if (Vector3.Distance(cop.transform.position, position) < 30f) cop.JoinChase(Game.Player != null ? Game.Player.FeetPosition : position);
            }
        }

        public void ResetPolice()
        {
            foreach (var cop in police)
                if (cop != null) cop.ResetToPatrol();
        }

        public bool AnyChasing
        {
            get
            {
                foreach (var cop in police)
                    if (cop != null && cop.isActiveAndEnabled && cop.IsChasing) return true;
                return false;
            }
        }
    }
}
