using System.Collections.Generic;
using UnityEngine;
using UnityEngine.AI;

namespace Scruff
{
    /// <summary>
    /// Bakes the NavMesh at runtime from the world's colliders (the world is generated in code, so there's
    /// nothing to bake in the editor). Uses only core Unity APIs - no AI Navigation package required.
    /// </summary>
    public static class NavMeshBaker
    {
        static NavMeshDataInstance instance;

        public static AsyncOperation BakeAsync(Bounds bounds, List<Bounds> notWalkable)
        {
            if (instance.valid) NavMesh.RemoveNavMeshData(instance);

            var sources = new List<NavMeshBuildSource>();
            NavMeshBuilder.CollectSources(bounds, Layers.EnvironmentMask, NavMeshCollectGeometry.PhysicsColliders, 0, new List<NavMeshBuildMarkup>(), sources);
            // Drop trigger-ish/query colliders that live on the Default layer by accident: nothing to do, they're filtered by layer.
            if (notWalkable != null)
            {
                foreach (var b in notWalkable)
                {
                    sources.Add(new NavMeshBuildSource
                    {
                        shape = NavMeshBuildSourceShape.ModifierBox,
                        transform = Matrix4x4.TRS(b.center, Quaternion.identity, Vector3.one),
                        size = b.size,
                        area = 1, // built-in "Not Walkable"
                    });
                }
            }

            var settings = NavMesh.GetSettingsByID(0);
            settings.agentRadius = 0.3f;
            settings.agentHeight = 1.7f;
            settings.agentClimb = 0.4f;
            settings.agentSlope = 40f;
            settings.overrideVoxelSize = true;
            settings.voxelSize = 0.1f;
            settings.overrideTileSize = true;
            settings.tileSize = 128;

            var data = new NavMeshData(settings.agentTypeID) { name = "Scruff Runtime NavMesh" };
            instance = NavMesh.AddNavMeshData(data);
            return NavMeshBuilder.UpdateNavMeshDataAsync(data, settings, sources, bounds);
        }
    }
}
