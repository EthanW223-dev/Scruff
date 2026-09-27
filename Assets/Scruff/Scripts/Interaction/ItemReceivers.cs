using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Something you can hand an item to by letting go of it nearby: an NPC's hands, a baggie's opening,
    /// the trash can.
    /// </summary>
    public interface IItemReceiver
    {
        Vector3 ReceivePoint { get; }
        float ReceiveRadius { get; }
        bool CanReceive(Item item);
        /// <summary>Take the item. Return false to refuse (the item then drops normally).</summary>
        bool TryReceive(Item item, PlayerHand hand);
        /// <summary>Called when a held item hovers over / leaves this receiver (null = left). Good for previews.</summary>
        void SetHover(Item item);
    }

    public static class ItemReceivers
    {
        static readonly List<IItemReceiver> all = new List<IItemReceiver>();

        public static void Register(IItemReceiver r)
        {
            if (!all.Contains(r)) all.Add(r);
        }

        public static void Unregister(IItemReceiver r) => all.Remove(r);

        public static bool FindBest(Item item, out IItemReceiver best)
        {
            best = null;
            if (item == null) return false;
            Vector3 p = item.VisualBounds().center;
            float bestDist = float.MaxValue;
            for (int i = 0; i < all.Count; i++)
            {
                var r = all[i];
                if (r == null || ReferenceEquals(r, item.Container)) continue;
                float d = Vector3.Distance(p, r.ReceivePoint);
                if (d > r.ReceiveRadius || d >= bestDist || !r.CanReceive(item)) continue;
                best = r;
                bestDist = d;
            }
            return best != null;
        }
    }
}
