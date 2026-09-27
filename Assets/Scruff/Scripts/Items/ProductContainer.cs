using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Baggies and jars. Drop loose buds/crystals into the opening (or let go of them right above it) to package them.
    /// Customers only buy packaged product. Contents are stored in the owning Item's Product field.
    /// </summary>
    public class ProductContainer : MonoBehaviour, IItemReceiver
    {
        public int capacity = 1;
        public Transform opening;
        public float openingRadius = 0.05f;
        public Transform fill;
        public float fillMaxHeight = 0.06f;

        Item item;
        MeshRenderer fillRenderer;
        bool hovered;
        static readonly Collider[] overlap = new Collider[16];

        public int Units => item != null && item.Product != null ? item.Product.units : 0;
        public bool IsFull => Units >= capacity;

        void Awake()
        {
            item = GetComponent<Item>();
        }

        void OnEnable() => ItemReceivers.Register(this);

        void OnDisable() => ItemReceivers.Unregister(this);

        void Start() => UpdateVisual();

        public bool CanAccept(Item unit)
        {
            if (unit == null || unit == item || !unit.IsProductUnit || unit.Product == null || IsFull) return false;
            return Units == 0 || item.Product.SameProductAs(unit.Product);
        }

        public void AddUnit(Item unit)
        {
            var p = unit.Product;
            if (Units == 0)
            {
                item.Product = p.Clone();
                item.Product.units = 1;
            }
            else
            {
                var c = item.Product;
                c.quality = (c.quality * c.units + p.quality) / (c.units + 1);
                c.units++;
            }
            if (unit.HeldBy != null) unit.HeldBy.Drop(false);
            Destroy(unit.gameObject);
            UpdateVisual();

            AudioManager.Play("rustle", opening.position, 0.55f, Random.Range(0.95f, 1.15f));
            FX.Burst(opening.position, p.Strain != null ? p.Strain.Color : Color.green, 5, 0.6f);
            if (item.HeldBy != null) item.HeldBy.Haptic(0.3f, 0.05f);
            Game.Progression?.AddXp(1);
            GameEvents.Raise(GameEventType.ProductPackaged, item);
        }

        void FixedUpdate()
        {
            if (IsFull || opening == null) return;
            int n = Physics.OverlapSphereNonAlloc(opening.position, openingRadius, overlap, Layers.ItemMask, QueryTriggerInteraction.Ignore);
            for (int i = 0; i < n; i++)
            {
                var unit = overlap[i].GetComponentInParent<Item>();
                if (unit == null || unit.IsHeld || !CanAccept(unit)) continue;
                AddUnit(unit);
                if (IsFull) break;
            }
        }

        public void UpdateVisual()
        {
            if (fill == null) return;
            int units = Units;
            fill.gameObject.SetActive(units > 0);
            if (units <= 0) return;
            var ls = fill.localScale;
            fill.localScale = new Vector3(ls.x, fillMaxHeight * Mathf.Clamp01(units / (float)capacity), ls.z);
            var strain = item.Product.Strain;
            if (fillRenderer == null) fillRenderer = fill.GetComponentInChildren<MeshRenderer>();
            if (fillRenderer != null && strain != null)
            {
                var c = strain.Color;
                var eff = item.Product.effects;
                if (eff != null && eff.Count > 0)
                {
                    var e = ProductCatalog.Effect(eff[eff.Count - 1]);
                    if (e != null) c = Color.Lerp(c, e.Color, 0.35f);
                }
                UIFactory.Tint(fillRenderer, c);
            }
        }

        // ---- IItemReceiver: let go of a bud right above the bag
        public Vector3 ReceivePoint => opening != null ? opening.position : transform.position;
        public float ReceiveRadius => openingRadius + 0.05f;
        public bool CanReceive(Item unit) => CanAccept(unit);

        public bool TryReceive(Item unit, PlayerHand hand)
        {
            if (!CanAccept(unit)) return false;
            AddUnit(unit);
            return true;
        }

        public void SetHover(Item held)
        {
            bool on = held != null;
            if (on == hovered) return;
            hovered = on;
            item.SetHighlight(on);
        }
    }
}
