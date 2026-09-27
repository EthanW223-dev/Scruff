using System;
using UnityEngine;

namespace Scruff
{
    /// <summary>Reach into it and grab: puts a fresh item in your hand (baggie box, jar crate...).</summary>
    public class ItemDispenser : Grabbable
    {
        public string itemId;
        public Func<bool> CanDispense;
        public Action Dispensed;
        public Func<string> Label;

        protected override void Awake()
        {
            base.Awake();
            grabPriority = -1f;
        }

        public override Grabbable ResolveGrab(PlayerHand hand)
        {
            if (CanDispense != null && !CanDispense())
            {
                AudioManager.Play("error", transform.position, 0.4f);
                return null;
            }
            var item = ItemFactory.Spawn(itemId, hand.GripPosition, hand.GripPoint.rotation);
            if (item == null) return null;
            Dispensed?.Invoke();
            AudioManager.Play("rustle", transform.position, 0.4f);
            return item;
        }

        public override string GetLabel() => Label != null ? Label() : null;
    }
}
