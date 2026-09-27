using UnityEngine;

namespace Scruff
{
    /// <summary>Physical cash. Grab it and it goes straight into your wallet with a ka-ching.</summary>
    public class CashPickup : Grabbable
    {
        public static readonly System.Collections.Generic.List<CashPickup> All = new System.Collections.Generic.List<CashPickup>();

        public int amount;
        public bool collected;

        void OnEnable() => All.Add(this);

        void OnDisable() => All.Remove(this);

        public static CashPickup Spawn(int amount, Vector3 position, Quaternion rotation, Transform parent = null, bool physics = true)
        {
            int stacks = amount >= 200 ? 3 : amount >= 60 ? 2 : 1;
            var go = new GameObject($"Cash ${amount}");
            go.layer = Layers.Item;
            go.transform.SetParent(parent != null ? parent : (Game.World != null ? Game.World.ItemsRoot : null), false);
            go.transform.SetPositionAndRotation(position, rotation);
            MeshBuilder.AddRenderer(go, ModelFactory.Cash(stacks));
            var col = ModelFactory.Box(go, new Vector3(0f, 0.006f * stacks + 0.002f, 0f), new Vector3(0.08f, 0.0125f * stacks + 0.002f, 0.04f));
            col.isTrigger = !physics; // held out in an NPC's hand: grabbable, but not part of their body
            if (physics)
            {
                var rb = go.AddComponent<Rigidbody>();
                rb.mass = 0.05f;
                rb.interpolation = RigidbodyInterpolation.Interpolate;
                rb.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative;
            }
            var cash = go.AddComponent<CashPickup>();
            cash.amount = amount;
            cash.grabPriority = 2f;
            return cash;
        }

        public override Grabbable ResolveGrab(PlayerHand hand)
        {
            Collect();
            hand.Haptic(0.5f, 0.08f);
            return null;
        }

        public void Collect()
        {
            if (collected) return;
            collected = true;
            Game.Wallet?.Add(amount, transform.position);
            Destroy(gameObject);
        }

        public override string GetLabel() => $"<#77ee77>${amount}</>";
    }
}
