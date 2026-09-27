using System;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// The grow loop: pour soil in -> drop a seed in -> keep it watered -> it grows (visibly, continuously) ->
    /// pick the buds off. Quality comes from how consistently it was watered, plus fertilizer.
    /// </summary>
    public class PlantPot : MonoBehaviour, IPourReceiver, ILabelProvider, IItemState
    {
        [Serializable]
        class State
        {
            public float soil;
            public float water;
            public float fertilizer;
            public string strain;
            public float growth;
            public float careMinutes;
            public float totalMinutes;
            public float fertilizerMinutes;
            public int yield;
            public int harvested;
            public int variant;
            public float qualityRoll;
        }

        const float SoilLow = 0.03f;
        const float SoilHigh = 0.185f;
        const float PotInnerRadius = 0.125f;

        State s = new State();
        Item item;
        Transform soilDisk;
        MeshRenderer soilRenderer;
        Transform plant;
        MeshFilter plantFilter;
        int builtStep = -1;
        string builtStrain;
        readonly List<HarvestableBud> buds = new List<HarvestableBud>();
        readonly List<Vector3> budPositions = new List<Vector3>();
        float scanTimer;
        bool subscribed;
        bool wasWateredEnough;
        static readonly Collider[] overlap = new Collider[16];

        public bool HasSoil => s.soil >= 0.999f;
        public bool HasPlant => !string.IsNullOrEmpty(s.strain);
        public bool IsMature => HasPlant && s.growth >= 1f;
        public float Growth => s.growth;
        public float Water => s.water;
        public StrainDef Strain => ProductCatalog.Strain(s.strain);

        public float Quality
        {
            get
            {
                float care = s.totalMinutes > 0f ? s.careMinutes / s.totalMinutes : 0.5f;
                float fert = s.totalMinutes > 0f ? s.fertilizerMinutes / s.totalMinutes : 0f;
                return Mathf.Clamp01(0.28f + 0.42f * care + 0.28f * fert + s.qualityRoll);
            }
        }

        Vector3 SoilSurfaceLocal => new Vector3(0f, Mathf.Lerp(SoilLow, SoilHigh, s.soil), 0f);

        void Awake()
        {
            item = GetComponent<Item>();
            s.variant = UnityEngine.Random.Range(0, 1000);
            s.qualityRoll = UnityEngine.Random.Range(-0.04f, 0.04f);

            soilDisk = Util.CreateChild(transform, "Soil");
            soilRenderer = MeshBuilder.AddRenderer(soilDisk.gameObject, ModelFactory.SoilDisk());
            plant = Util.CreateChild(transform, "Plant");
            plantFilter = plant.gameObject.AddComponent<MeshFilter>();
            var pr = plant.gameObject.AddComponent<MeshRenderer>();
            pr.sharedMaterial = ScruffMaterials.Flat;
            pr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        }

        void Start()
        {
            Subscribe();
            RefreshVisuals(true);
        }

        void Subscribe()
        {
            if (subscribed || Game.Clock == null) return;
            Game.Clock.Advanced += OnAdvanced;
            subscribed = true;
        }

        void OnDestroy()
        {
            if (subscribed && Game.Clock != null) Game.Clock.Advanced -= OnAdvanced;
        }

        // ------------------------------------------------------------------ pouring

        public float ReceivePour(PourType type, float amount, Item source)
        {
            switch (type)
            {
                case PourType.Soil:
                {
                    if (HasPlant || HasSoil) return 0f;
                    float used = Mathf.Min(amount, 1f - s.soil);
                    s.soil += used;
                    if (s.soil >= 0.999f)
                    {
                        s.soil = 1f;
                        AudioManager.Play("pop", transform.position, 0.4f, 0.8f);
                        FX.Burst(transform.TransformPoint(SoilSurfaceLocal), ModelFactory.SoilDry, 6, 0.5f);
                        GameEvents.Raise(GameEventType.PotFilledWithSoil, this);
                    }
                    RefreshVisuals(false);
                    return used;
                }
                case PourType.Water:
                {
                    if (!HasSoil && !HasPlant) return amount; // just splashes through
                    s.water = Mathf.Min(1f, s.water + amount * 2.5f);
                    bool enough = s.water > 0.5f;
                    if (enough && !wasWateredEnough && HasPlant) GameEvents.Raise(GameEventType.PlantWatered, this);
                    wasWateredEnough = enough;
                    UpdateSoilTint();
                    return amount;
                }
                case PourType.Fertilizer:
                {
                    if (!HasSoil) return amount;
                    s.fertilizer = Mathf.Min(1f, s.fertilizer + amount * 4f);
                    return amount;
                }
            }
            return 0f;
        }

        // ------------------------------------------------------------------ seeds

        void Update()
        {
            if (!subscribed) Subscribe();
            if (!HasSoil || HasPlant) return;
            scanTimer -= Time.deltaTime;
            if (scanTimer > 0f) return;
            scanTimer = 0.15f;
            Vector3 center = transform.TransformPoint(SoilSurfaceLocal);
            int n = Physics.OverlapSphereNonAlloc(center, PotInnerRadius, overlap, Layers.ItemMask, QueryTriggerInteraction.Ignore);
            for (int i = 0; i < n; i++)
            {
                var seed = overlap[i].GetComponentInParent<Item>();
                if (seed == null || seed.IsHeld || seed.Def == null || seed.Def.Category != ItemCategory.Seed) continue;
                // must actually be inside the pot, not resting on the rim outside
                Vector3 local = transform.InverseTransformPoint(seed.transform.position);
                if (new Vector2(local.x, local.z).magnitude > PotInnerRadius || local.y < SoilLow - 0.02f) continue;
                Plant(seed.Def.StrainId);
                Destroy(seed.gameObject);
                break;
            }
        }

        public void Plant(string strainId)
        {
            if (ProductCatalog.Strain(strainId) == null) return;
            s.strain = strainId;
            s.growth = 0f;
            s.careMinutes = 0f;
            s.totalMinutes = 0f;
            s.fertilizerMinutes = 0f;
            s.harvested = 0;
            s.yield = 0;
            s.qualityRoll = UnityEngine.Random.Range(-0.04f, 0.04f);
            wasWateredEnough = false; // the next pour counts as "watered it"
            AudioManager.Play("pop", transform.position, 0.45f, 1.3f);
            FX.Burst(transform.TransformPoint(SoilSurfaceLocal), new Color(0.4f, 0.7f, 0.3f), 6, 0.5f);
            Game.Progression?.AddXp(2);
            GameEvents.Raise(GameEventType.SeedPlanted, this);
            RefreshVisuals(true);
        }

        // ------------------------------------------------------------------ growth

        void OnAdvanced(float minutes)
        {
            if (!HasPlant)
            {
                s.water = Mathf.Max(0f, s.water - minutes / 900f);
                UpdateSoilTint();
                return;
            }

            var strain = Strain;
            if (!IsMature && strain != null)
            {
                float watered = s.water > 0.05f ? 1f : 0.15f;
                s.growth = Mathf.Min(1f, s.growth + minutes / strain.GrowMinutes * watered * (1f + 0.2f * s.fertilizer));
                float care = s.water >= 0.25f ? 1f : s.water > 0.05f ? 0.5f : 0f;
                s.careMinutes += care * minutes;
                s.totalMinutes += minutes;
                s.fertilizerMinutes += Mathf.Clamp01(s.fertilizer * 2f) * minutes;
                s.fertilizer = Mathf.Max(0f, s.fertilizer - minutes / 720f);
                if (s.growth >= 1f && s.yield == 0) Mature();
            }
            s.water = Mathf.Max(0f, s.water - minutes / (IsMature ? 960f : 480f));
            if (s.water < 0.5f) wasWateredEnough = false;
            UpdateSoilTint();
            RefreshVisuals(false);
        }

        void Mature()
        {
            var strain = Strain;
            s.yield = UnityEngine.Random.Range(strain.MinYield, strain.MaxYield + 1) + (Quality > 0.7f ? 1 : 0);
            AudioManager.Play("success", transform.position, 0.35f);
            RefreshVisuals(true);
        }

        /// <summary>Called by a bud when grabbed: turns it into a loose product unit in your hand.</summary>
        public Grabbable Harvest(HarvestableBud bud, PlayerHand hand)
        {
            if (!IsMature || !buds.Contains(bud)) return null;
            var product = new ProductData { strain = s.strain, quality = Quality, units = 1 };
            var unit = ItemFactory.Spawn("bud", bud.transform.position - Vector3.up * 0.02f, bud.transform.rotation, product);
            buds.Remove(bud);
            Destroy(bud.gameObject);
            s.harvested++;
            AudioManager.Play("snap", transform.position, 0.5f, UnityEngine.Random.Range(0.9f, 1.1f));
            FX.Burst(bud.transform.position, Strain != null ? Strain.Color : Color.green, 5, 0.4f);
            Game.Progression?.AddXp(2);
            GameEvents.Raise(GameEventType.BudHarvested, unit);

            if (s.harvested >= s.yield)
            {
                // Plant is spent: clear it, soil is used up.
                s.strain = null;
                s.growth = 0f;
                s.soil = 0f;
                s.yield = 0;
                s.harvested = 0;
                RefreshVisuals(true);
            }
            return unit;
        }

        // ------------------------------------------------------------------ visuals

        void UpdateSoilTint()
        {
            if (soilRenderer == null) return;
            UIFactory.Tint(soilRenderer, Color.Lerp(ModelFactory.SoilDry, ModelFactory.SoilWet, Mathf.Clamp01(s.water * 1.4f)));
        }

        void RefreshVisuals(bool force)
        {
            soilDisk.gameObject.SetActive(s.soil > 0.01f || HasPlant);
            soilDisk.localPosition = SoilSurfaceLocal;
            UpdateSoilTint();

            plant.gameObject.SetActive(HasPlant);
            if (!HasPlant)
            {
                ClearBuds();
                builtStep = -1;
                return;
            }

            plant.localPosition = SoilSurfaceLocal;
            int step = PlantVisual.Step(s.growth);
            if (force || step != builtStep || builtStrain != s.strain)
            {
                builtStep = step;
                builtStrain = s.strain;
                plantFilter.sharedMesh = PlantVisual.Get(Strain, s.growth, s.variant);
                UpdateBuds();
            }
        }

        void UpdateBuds()
        {
            int count = s.yield > 0 ? s.yield - s.harvested : (Strain != null ? Strain.MinYield : 4);
            bool show = s.growth >= 0.7f && count > 0;
            if (!show)
            {
                ClearBuds();
                return;
            }
            PlantVisual.BudPositions(s.growth, s.variant, s.yield > 0 ? s.yield : count, budPositions);
            // positions are stable per index, so harvested buds leave gaps rather than reshuffling
            int start = s.yield > 0 ? s.harvested : 0;
            while (buds.Count < count) buds.Add(HarvestableBud.Create(this, plant, Strain));
            while (buds.Count > count)
            {
                var last = buds[buds.Count - 1];
                buds.RemoveAt(buds.Count - 1);
                if (last != null) Destroy(last.gameObject);
            }
            float scale = Mathf.Lerp(0.35f, 1f, Mathf.InverseLerp(0.7f, 1f, s.growth));
            for (int i = 0; i < buds.Count; i++)
            {
                int posIndex = Mathf.Clamp(start + i, 0, budPositions.Count - 1);
                buds[i].transform.localPosition = budPositions[posIndex];
                buds[i].transform.localScale = Vector3.one * scale;
                buds[i].SetRipe(IsMature);
            }
        }

        void ClearBuds()
        {
            foreach (var b in buds)
                if (b != null) Destroy(b.gameObject);
            buds.Clear();
        }

        // ------------------------------------------------------------------ label & save

        public string GetLabel()
        {
            if (!HasPlant)
            {
                if (s.soil < 0.01f) return "Plant Pot\n<#aaaaaa>Pour soil in</>";
                if (!HasSoil) return $"Plant Pot\n<#aaaaaa>Soil {Mathf.RoundToInt(s.soil * 100f)}%</>";
                return "Plant Pot\n<#aaaaaa>Drop a seed in</>";
            }
            var strain = Strain;
            string waterColor = s.water > 0.25f ? "77bbff" : s.water > 0.05f ? "ffcc55" : "ff6655";
            string water = $"<#{waterColor}>Water {Mathf.RoundToInt(s.water * 100f)}%</>";
            if (IsMature) return $"{strain?.Name} - <#77ee77>Ready!</>\n{ProductCatalog.QualityTag(Quality)} - {s.yield - s.harvested} buds";
            float remaining = strain != null ? (1f - s.growth) * strain.GrowMinutes / (s.water > 0.05f ? 1f : 0.15f) : 0f;
            string eta = s.water > 0.05f ? GameClock.FormatDuration(remaining) : "<#ff6655>needs water</>";
            return $"{strain?.Name} {Mathf.RoundToInt(s.growth * 100f)}%\n{water} - {eta}";
        }

        public string CaptureState() => JsonUtility.ToJson(s);

        public void RestoreState(string json)
        {
            try
            {
                var loaded = JsonUtility.FromJson<State>(json);
                if (loaded != null) s = loaded;
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Scruff] Bad pot state: {e.Message}");
            }
            wasWateredEnough = s.water > 0.5f;
            if (soilDisk != null) RefreshVisuals(true);
        }
    }
}
