using UnityEngine;

namespace Scruff
{
    public enum PourType { Soil, Water, Fertilizer, Seeds }

    /// <summary>Things that can be poured into (plant pots).</summary>
    public interface IPourReceiver
    {
        /// <summary>Returns how much of <paramref name="amount"/> was actually used.</summary>
        float ReceivePour(PourType type, float amount, Item source);
    }

    /// <summary>
    /// Tip it over to pour: soil bags, watering cans, fertilizer, seed packets (which drop individual seeds).
    /// Uses the owning Item's Charge (or Uses for seeds) as the amount left.
    /// </summary>
    public class Pourable : MonoBehaviour
    {
        public PourType type;
        public Transform spout;
        [Tooltip("Degrees the item must be tilted from upright before it pours.")]
        public float pourAngle = 70f;
        [Tooltip("Charge per second at full tilt.")]
        public float flowRate = 0.5f;
        public string seedItemId;
        public Color streamColor = Color.white;

        Item item;
        ParticleSystem particles;
        AudioSource loop;
        float seedTimer;
        bool pouring;
        static readonly RaycastHit[] hits = new RaycastHit[8];

        void Awake()
        {
            item = GetComponent<Item>();
        }

        void Start()
        {
            if (type != PourType.Seeds)
            {
                particles = FX.CreateStream(spout, streamColor, type == PourType.Water || type == PourType.Fertilizer ? 0.012f : 0.016f);
                loop = AudioManager.CreateLoop(spout, type == PourType.Soil ? "pour_soil" : "pour_water", 8f);
            }
        }

        public bool HasContent => type == PourType.Seeds ? item.Uses > 0 : item.Charge > 0.0001f;

        void Update()
        {
            float tilt = Vector3.Angle(transform.up, Vector3.up);
            bool tilted = tilt > pourAngle;
            bool active = HasContent && tilted && (item.IsHeld || item.Socket == null);

            if (type == PourType.Seeds)
            {
                UpdateSeeds(active);
                return;
            }

            float strength = active ? Mathf.Clamp01(Mathf.InverseLerp(pourAngle, pourAngle + 35f, tilt) * 0.7f + 0.3f) : 0f;
            if (active)
            {
                float amount = Mathf.Min(item.Charge, flowRate * strength * Time.deltaTime);
                float fall = 1.2f;
                var receiver = FindReceiver(out fall);
                if (receiver != null)
                {
                    float used = receiver.ReceivePour(type, amount, item);
                    // Soil only leaves the bag if it went somewhere useful; water spills regardless.
                    item.Charge -= type == PourType.Soil ? used : amount;
                }
                else if (type != PourType.Soil)
                {
                    item.Charge -= amount;
                }
                if (item.Charge < 0f) item.Charge = 0f;
                if (particles != null)
                {
                    var main = particles.main;
                    main.startLifetime = Mathf.Clamp(Mathf.Sqrt(2f * fall / 9.81f), 0.08f, 0.7f);
                }
                if (item.HeldBy != null) item.HeldBy.Haptic(0.05f + strength * 0.08f, Time.deltaTime * 1.5f);
            }

            if (active != pouring)
            {
                pouring = active;
                if (particles != null)
                {
                    var em = particles.emission;
                    em.enabled = active;
                }
            }
            if (particles != null)
            {
                var em = particles.emission;
                em.rateOverTime = 90f * strength;
            }
            if (loop != null) loop.volume = Mathf.MoveTowards(loop.volume, active ? 0.35f + strength * 0.3f : 0f, Time.deltaTime * 4f);
        }

        void UpdateSeeds(bool active)
        {
            seedTimer -= Time.deltaTime;
            if (!active || seedTimer > 0f) return;
            seedTimer = 0.55f;
            item.Uses--;
            var seed = ItemFactory.Spawn(seedItemId, spout.position, Random.rotation);
            if (seed != null && seed.Body != null)
            {
                seed.Body.SetVelocity(Vector3.down * 0.5f + Random.insideUnitSphere * 0.1f);
            }
            AudioManager.Play("rustle", spout.position, 0.3f, 1.5f);
            if (item.HeldBy != null) item.HeldBy.Haptic(0.2f, 0.03f);
        }

        IPourReceiver FindReceiver(out float fallDistance)
        {
            fallDistance = 1.2f;
            int n = Physics.SphereCastNonAlloc(spout.position, 0.035f, Vector3.down, hits, 1.5f, Layers.EnvironmentMask | Layers.ItemMask, QueryTriggerInteraction.Ignore);
            float best = float.MaxValue;
            IPourReceiver receiver = null;
            for (int i = 0; i < n; i++)
            {
                var h = hits[i];
                if (h.collider.transform.IsChildOf(transform)) continue;
                if (h.distance >= best) continue;
                best = h.distance;
                receiver = h.collider.GetComponentInParent<IPourReceiver>();
            }
            if (best < float.MaxValue) fallDistance = best;
            return receiver;
        }
    }
}
