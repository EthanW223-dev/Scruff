using UnityEngine;

namespace Scruff
{
    /// <summary>Drop anything in to get rid of it.</summary>
    public class TrashCan : MonoBehaviour, IItemReceiver
    {
        static readonly Collider[] overlap = new Collider[16];
        float scan;
        Transform mouth;

        public static TrashCan Create(Transform parent, Vector3 position)
        {
            var root = new GameObject("Trash Can");
            root.transform.SetParent(parent, false);
            root.transform.localPosition = position;
            var t = root.AddComponent<TrashCan>();
            Geo.Mesh("Body", root.transform, b =>
            {
                b.AddFrustum(Vector3.zero, 0.15f, 0.18f, 0.5f, 10, new Color(0.3f, 0.34f, 0.36f), capTop: false);
                b.Flip = true;
                b.AddFrustum(new Vector3(0f, 0.02f, 0f), 0.14f, 0.17f, 0.48f, 10, new Color(0.12f, 0.12f, 0.13f), capTop: false);
                b.Flip = false;
            });
            Geo.Solid(root.transform, new Vector3(0f, 0.25f, 0f), new Vector3(0.3f, 0.5f, 0.3f), SurfaceSound.Metal);
            t.mouth = Util.CreateChild(root.transform, "Mouth", new Vector3(0f, 0.5f, 0f));
            return t;
        }

        void OnEnable() => ItemReceivers.Register(this);

        void OnDisable() => ItemReceivers.Unregister(this);

        public Vector3 ReceivePoint => mouth.position + Vector3.up * 0.05f;
        public float ReceiveRadius => 0.2f;
        public bool CanReceive(Item item) => item != null;

        public bool TryReceive(Item item, PlayerHand hand)
        {
            Trash(item);
            return true;
        }

        public void SetHover(Item item) { }

        void Trash(Item item)
        {
            FX.Burst(mouth.position, new Color(0.5f, 0.5f, 0.5f), 6, 0.4f);
            AudioManager.Play("thud", mouth.position, 0.4f, 0.8f);
            Destroy(item.gameObject);
        }

        void FixedUpdate()
        {
            scan -= Time.fixedDeltaTime;
            if (scan > 0f) return;
            scan = 0.25f;
            int n = Physics.OverlapSphereNonAlloc(mouth.position + Vector3.down * 0.2f, 0.14f, overlap, Layers.ItemMask, QueryTriggerInteraction.Ignore);
            for (int i = 0; i < n; i++)
            {
                var item = overlap[i].GetComponentInParent<Item>();
                if (item != null && !item.IsHeld) Trash(item);
            }
        }
    }
}
