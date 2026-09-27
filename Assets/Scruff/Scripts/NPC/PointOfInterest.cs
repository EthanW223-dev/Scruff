using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    public enum PoiType { Home, Hangout, MeetSpot, Patrol, PoliceStation }

    /// <summary>A named spot NPCs use: homes, hangouts, deal meeting spots, police patrol points.</summary>
    public class PointOfInterest : MonoBehaviour
    {
        public static readonly List<PointOfInterest> All = new List<PointOfInterest>();
        static readonly Dictionary<PoiType, List<PointOfInterest>> byType = new Dictionary<PoiType, List<PointOfInterest>>();
        static bool cacheDirty = true;

        public PoiType type;
        public string displayName;
        public float radius = 1.5f;

        void OnEnable()
        {
            All.Add(this);
            cacheDirty = true;
        }

        void OnDisable()
        {
            All.Remove(this);
            cacheDirty = true;
        }

        public static PointOfInterest Create(Transform parent, PoiType type, string name, Vector3 position, float yaw = 0f)
        {
            var go = new GameObject($"POI {type} {name}");
            go.transform.SetParent(parent, false);
            go.transform.position = position;
            go.transform.rotation = Quaternion.Euler(0f, yaw, 0f);
            var poi = go.AddComponent<PointOfInterest>();
            poi.type = type;
            poi.displayName = name;
            return poi;
        }

        /// <summary>All points of a type, in a stable order. The returned list is shared: don't modify it.</summary>
        public static List<PointOfInterest> OfType(PoiType type)
        {
            if (cacheDirty)
            {
                byType.Clear();
                foreach (var p in All)
                {
                    if (!byType.TryGetValue(p.type, out var l)) byType[p.type] = l = new List<PointOfInterest>();
                    l.Add(p);
                }
                cacheDirty = false;
            }
            if (!byType.TryGetValue(type, out var list)) byType[type] = list = new List<PointOfInterest>();
            return list;
        }

        public Vector3 RandomPointNear()
        {
            var r = Random.insideUnitCircle * radius;
            return transform.position + new Vector3(r.x, 0f, r.y);
        }
    }
}
