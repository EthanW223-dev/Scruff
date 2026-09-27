using UnityEngine;

namespace Scruff
{
    public static class ItemFactory
    {
        /// <summary>Creates a physical item in the world. Position is the item's bottom centre.</summary>
        public static Item Spawn(string id, Vector3 position, Quaternion rotation, ProductData product = null)
        {
            var def = ItemDatabase.Get(id);
            if (def == null || !def.IsPhysical)
            {
                Debug.LogError($"[Scruff] Can't spawn unknown or non-physical item '{id}'.");
                return null;
            }

            var go = new GameObject(def.Name);
            go.transform.SetParent(Game.World != null ? Game.World.ItemsRoot : null, false);
            go.transform.SetPositionAndRotation(position, rotation);
            def.Build(go, product);
            Layers.SetLayerRecursively(go, Layers.Item);

            var rb = go.AddComponent<Rigidbody>();
            rb.mass = def.Mass;
            rb.SetDamping(0.05f, 0.3f);
            rb.interpolation = RigidbodyInterpolation.Interpolate;
            rb.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative;

            var item = go.AddComponent<Item>();
            item.Setup(def, product);
            def.Configure?.Invoke(item);
            item.RefreshComponents();
            return item;
        }

        public static Item SpawnProductUnit(ProductData product, Vector3 position, Quaternion rotation)
        {
            var strain = product?.Strain;
            if (strain == null) return null;
            var unit = product.Clone();
            unit.units = 1;
            return Spawn(strain.Family == ProductFamily.Crystal ? "crystal" : "bud", position, rotation, unit);
        }
    }
}
