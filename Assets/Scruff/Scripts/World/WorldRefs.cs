using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>Handles to the important places and objects in the generated world.</summary>
    public class WorldRefs
    {
        public Transform Root;
        public Transform ItemsRoot;

        public Vector3 MenuSpawn;
        public float MenuYaw;
        public float MenuKillY;

        public Vector3 HomeSpawn;
        public float HomeYaw;
        public Bounds SafeZone;
        public Bounds WorldBounds;
        public readonly List<Bounds> NotWalkable = new List<Bounds>();

        public Vector3 StarterPot;
        public Vector3 StarterSoil;
        public Vector3 StarterSeeds;
        public Vector3 StarterCan;
        public Vector3 HomeDelivery;

        public MixingStation Mixer;
        public ChemStation Chem;
        public PackingTable Packing;
        public MainMenu Menu;

        public bool IsInSafeZone(Vector3 p) => SafeZone.Contains(p);
    }
}
