using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Cook Blue Crystal: slot in Blue Syrup + Fizz Salt, press START, then babysit the heat dial.
    /// Keeping the needle in the green band gives quality; too cold cooks slowly; too hot burns it.
    /// </summary>
    public class ChemStation : MonoBehaviour
    {
        const float CookMinutes = 50f;
        const float BandMin = 0.55f;
        const float BandMax = 0.78f;
        const float BurnAbove = 0.92f;

        ItemSocket syrupSlot;
        ItemSocket saltSlot;
        HingeGrabbable dial;
        PokeButton startButton;
        TextBlock status;
        Transform progressFill;
        Transform needle;
        Transform output;
        ParticleSystem bubbles;
        AudioSource bubbleLoop;
        GameObject lockedCover;
        MeshRenderer burnerRenderer;

        bool cooking;
        float progress;
        float heat;             // smoothed temperature 0..1 that chases the dial
        float bandMinutes;
        float cookedMinutes;
        float burnMinutes;
        float refreshTimer;
        bool subscribed;

        public bool Unlocked { get; private set; }

        public static ChemStation Create(Transform parent, Vector3 position, float yaw)
        {
            var root = new GameObject("Chem Station");
            root.transform.SetParent(parent, false);
            root.transform.localPosition = position;
            root.transform.localRotation = Quaternion.Euler(0f, yaw, 0f);
            var station = root.AddComponent<ChemStation>();
            station.Build();
            return station;
        }

        void Build()
        {
            const float h = 0.62f;
            Geo.Mesh("Body", transform, b =>
            {
                Geo.Table(b, transform, Vector3.zero, new Vector2(0.95f, 0.55f), h, Palette.Metal, Palette.MetalDark, SurfaceSound.Metal);
                // stove
                b.AddBox(new Vector3(-0.05f, h + 0.06f, -0.08f), new Vector3(0.42f, 0.12f, 0.34f), Quaternion.identity, new Color(0.9f, 0.9f, 0.88f), new Color(0.2f, 0.2f, 0.22f));
                // cook pot
                b.AddFrustum(new Vector3(-0.05f, h + 0.125f, -0.1f), 0.1f, 0.11f, 0.13f, 10, Palette.Metal, capTop: false);
                b.AddBox(new Vector3(-0.19f, h + 0.23f, -0.1f), new Vector3(0.08f, 0.015f, 0.02f), Palette.MetalDark);
                // ingredient pads
                b.AddBox(new Vector3(-0.38f, h + 0.005f, 0.14f), new Vector3(0.12f, 0.01f, 0.12f), Quaternion.identity, Palette.MetalDark, new Color(0.3f, 0.45f, 0.8f));
                b.AddBox(new Vector3(-0.38f, h + 0.005f, -0.08f), new Vector3(0.12f, 0.01f, 0.12f), Quaternion.identity, Palette.MetalDark, new Color(0.95f, 0.6f, 0.3f));
                // output tray
                b.AddBox(new Vector3(0.3f, h + 0.01f, 0.13f), new Vector3(0.22f, 0.02f, 0.16f), Quaternion.identity, Palette.MetalDark, Palette.Metal);
                // console
                b.AddBox(new Vector3(0.3f, h + 0.17f, -0.17f), new Vector3(0.3f, 0.34f, 0.06f), Quaternion.Euler(-12f, 0f, 0f), Palette.MetalDark, Palette.MetalDark);
            });
            Geo.Solid(transform, new Vector3(-0.05f, h + 0.06f, -0.08f), new Vector3(0.42f, 0.12f, 0.34f), SurfaceSound.Metal);

            burnerRenderer = Geo.Mesh("Burner", transform, b =>
            {
                b.Emission = 1f;
                b.AddCylinder(Vector3.zero, 0.085f, 0.004f, 10, Color.white);
            }, new Vector3(-0.05f, h + 0.121f, -0.1f)).GetComponent<MeshRenderer>();

            syrupSlot = MakeSlot("SyrupSlot", new Vector3(-0.38f, h + 0.01f, 0.14f), "chem_syrup", "blue_syrup");
            saltSlot = MakeSlot("SaltSlot", new Vector3(-0.38f, h + 0.01f, -0.08f), "chem_salt", "fizz_salt");

            // Heat dial on the front of the stove: twist it like a real knob.
            var dialPivot = Util.CreateChild(transform, "HeatDial", new Vector3(-0.05f, h + 0.06f, 0.095f));
            Geo.Mesh("Knob", dialPivot, b =>
            {
                b.AddCylinder(Vector3.zero, 0.032f, 0.025f, 10, new Color(0.15f, 0.15f, 0.17f), Quaternion.Euler(90f, 0f, 0f));
                b.AddBox(new Vector3(0f, 0.018f, 0.024f), new Vector3(0.01f, 0.03f, 0.012f), new Color(0.95f, 0.4f, 0.25f));
            });
            var dialCol = dialPivot.gameObject.AddComponent<SphereCollider>();
            dialCol.radius = 0.045f;
            dialCol.center = new Vector3(0f, 0f, 0.015f);
            dialPivot.gameObject.layer = Layers.Interactable;
            dial = dialPivot.gameObject.AddComponent<HingeGrabbable>();
            dial.Configure(dialPivot, Vector3.forward, -135f, 135f, HingeGrabbable.Mode.Twist);
            dial.clickEvery = 15f;
            dial.grabPriority = 2f;
            dial.SetAngle(-135f, false);

            output = Util.CreateChild(transform, "Output", new Vector3(0.3f, h + 0.03f, 0.13f));

            // Console UI
            var ui = Geo.UIRoot(transform, new Vector3(0.3f, h + 0.17f, -0.135f), 12f);
            UIFactory.Panel(ui, new Vector2(0.28f, 0.32f), Palette.UIBackground, new Vector3(0f, 0f, 0.002f));
            UIFactory.Text(ui, "CHEM STATION", 0.017f, new Color(0.55f, 0.8f, 1f), new Vector3(0f, 0.135f, 0f));
            UIFactory.Text(ui, "HEAT", 0.011f, Palette.UITextDim, new Vector3(-0.115f, 0.095f, 0f), TextBlock.HAlign.Left);
            // heat gauge with green band
            UIFactory.Panel(ui, new Vector2(0.24f, 0.022f), new Color(0.2f, 0.2f, 0.24f), new Vector3(0f, 0.072f, 0.001f), 0.002f);
            UIFactory.Panel(ui, new Vector2(0.24f * (BandMax - BandMin), 0.022f), new Color(0.25f, 0.6f, 0.3f), new Vector3(-0.12f + 0.24f * (BandMin + BandMax) * 0.5f, 0.072f, 0f), 0.002f);
            UIFactory.Panel(ui, new Vector2(0.24f * (1f - BurnAbove), 0.022f), new Color(0.7f, 0.25f, 0.2f), new Vector3(-0.12f + 0.24f * (1f + BurnAbove) * 0.5f, 0.072f, 0f), 0.002f);
            needle = Util.CreateChild(ui, "Needle", new Vector3(-0.12f, 0.072f, -0.002f));
            UIFactory.Panel(needle, new Vector2(0.006f, 0.034f), Color.white, Vector3.zero, 0.002f);
            UIFactory.Text(ui, "PROGRESS", 0.011f, Palette.UITextDim, new Vector3(-0.115f, 0.04f, 0f), TextBlock.HAlign.Left);
            progressFill = UIFactory.Bar(ui, new Vector2(0.24f, 0.016f), new Color(0.2f, 0.2f, 0.24f), new Color(0.45f, 0.75f, 0.95f), new Vector3(0f, 0.02f, 0f), 0f);
            status = UIFactory.Text(ui, "", 0.012f, Palette.UIText, new Vector3(0f, -0.005f, 0f), TextBlock.HAlign.Center, TextBlock.VAlign.Top, 0.25f);
            startButton = UIFactory.Button(ui, "START", new Vector2(0.14f, 0.045f), Palette.UIButtonActive, new Vector3(0f, -0.125f, -0.004f), OnStart, 0.02f);

            var pot = Util.CreateChild(transform, "PotTop", new Vector3(-0.05f, h + 0.25f, -0.1f));
            bubbles = FX.CreateAmbient(pot, new Color(0.6f, 0.85f, 1f), 25f, 0.012f, 0.25f, -0.05f);
            bubbleLoop = AudioManager.CreateLoop(pot, "bubble", 6f);

            lockedCover = MixingStation.BuildLockedCover(transform, "Chem Station", "Buy on the laptop (Rank 2)", h);
            SetUnlocked(false);
        }

        ItemSocket MakeSlot(string name, Vector3 pos, string key, string itemId)
        {
            var slot = Util.CreateChild(transform, name, pos).gameObject.AddComponent<ItemSocket>();
            slot.radius = 0.12f;
            slot.saveKey = key;
            slot.Filter = g => g is Item it && it.Def != null && it.Def.Id == itemId;
            return slot;
        }

        public void SetUnlocked(bool value)
        {
            Unlocked = value;
            lockedCover.SetActive(!value);
            syrupSlot.enabled = value;
            saltSlot.enabled = value;
            dial.enabled = value;
            startButton.gameObject.SetActive(value);
        }

        void Start()
        {
            if (Game.Clock != null)
            {
                Game.Clock.Advanced += OnAdvanced;
                subscribed = true;
            }
        }

        void OnDestroy()
        {
            if (subscribed && Game.Clock != null) Game.Clock.Advanced -= OnAdvanced;
        }

        void Update()
        {
            // The flame wanders while cooking, so you have to keep nudging the knob.
            float drift = cooking ? (Mathf.PerlinNoise(Time.time * 0.12f, 3.7f) - 0.5f) * 0.35f : 0f;
            float target = Mathf.Clamp01(dial.Normalized + drift);
            heat = Mathf.MoveTowards(heat, target, Time.deltaTime * 0.22f);
            needle.localPosition = new Vector3(-0.12f + 0.24f * heat, needle.localPosition.y, needle.localPosition.z);
            if (burnerRenderer != null) UIFactory.Tint(burnerRenderer, Color.Lerp(new Color(0.15f, 0.15f, 0.2f), new Color(1f, 0.45f, 0.15f), cooking ? heat : 0f));
            FX.SetEmitting(bubbles, cooking && heat > 0.3f);
            bubbleLoop.volume = Mathf.MoveTowards(bubbleLoop.volume, cooking ? 0.2f + heat * 0.4f : 0f, Time.deltaTime);

            refreshTimer -= Time.deltaTime;
            if (refreshTimer <= 0f)
            {
                refreshTimer = 0.2f;
                RefreshUI();
            }
        }

        void OnAdvanced(float minutes)
        {
            if (!cooking) return;
            // Temperature controls speed: cold is slow, hot is fast.
            float rate = Mathf.Lerp(0.25f, 1.35f, heat);
            float step = minutes * rate / CookMinutes;
            progress += step;
            cookedMinutes += minutes;
            if (heat >= BandMin && heat <= BandMax) bandMinutes += minutes;
            if (heat > BurnAbove) burnMinutes += minutes;
            if (progress >= 1f) Finish();
        }

        void RefreshUI()
        {
            if (!Unlocked) return;
            UIFactory.SetBar(progressFill, 0.24f, progress);
            if (cooking)
            {
                string zone = heat > BurnAbove ? "<#ff6655>TOO HOT - burning!</>" : heat >= BandMin && heat <= BandMax ? "<#77ee77>Perfect heat</>" : heat > BandMax ? "<#ffcc55>A bit hot</>" : "<#88bbff>Too cold - slow</>";
                float bandPct = cookedMinutes > 0f ? bandMinutes / cookedMinutes : 0f;
                status.Text = $"{zone}\nIn the zone: {Mathf.RoundToInt(bandPct * 100f)}%\n<#aaaaaa>Twist the knob to adjust</>";
                startButton.SetInteractable(false);
                return;
            }
            bool hasSyrup = syrupSlot.Occupant != null, hasSalt = saltSlot.Occupant != null;
            if (!hasSyrup || !hasSalt)
            {
                status.Text = $"{(hasSyrup ? "<#77ee77>Blue Syrup</>" : "<#ff6655>Blue Syrup</>")} + {(hasSalt ? "<#77ee77>Fizz Salt</>" : "<#ff6655>Fizz Salt</>")}\n<#aaaaaa>Place both on the pads</>";
                startButton.SetInteractable(false);
            }
            else
            {
                status.Text = "Ready to cook.\n<#aaaaaa>Keep the needle in the green.</>";
                startButton.SetInteractable(true);
            }
        }

        void OnStart()
        {
            if (cooking || syrupSlot.Occupant == null || saltSlot.Occupant == null) return;
            var syrup = syrupSlot.Occupant;
            var salt = saltSlot.Occupant;
            syrupSlot.Remove(syrup);
            saltSlot.Remove(salt);
            FX.Burst(syrup.transform.position, new Color(0.3f, 0.5f, 0.95f), 8, 0.6f);
            FX.Burst(salt.transform.position, Color.white, 8, 0.6f);
            Destroy(syrup.gameObject);
            Destroy(salt.gameObject);
            cooking = true;
            progress = 0f;
            bandMinutes = 0f;
            cookedMinutes = 0f;
            burnMinutes = 0f;
            AudioManager.Play("pop", transform.position, 0.5f, 0.7f);
        }

        void Finish()
        {
            cooking = false;
            progress = 0f;
            var strain = ProductCatalog.Strain("blue_crystal");
            float band = cookedMinutes > 0f ? bandMinutes / cookedMinutes : 0f;
            float burnt = cookedMinutes > 0f ? burnMinutes / cookedMinutes : 0f;
            float quality = Mathf.Clamp01(0.2f + 0.72f * band - 0.6f * burnt + Random.Range(-0.04f, 0.04f));
            int units = Mathf.Max(1, strain.MaxYield - Mathf.RoundToInt(burnt * 3f));
            for (int i = 0; i < units; i++)
            {
                var pos = output.position + new Vector3((i % 3 - 1) * 0.06f, 0.02f + (i / 3) * 0.05f, (i / 3 - 0.5f) * 0.05f);
                ItemFactory.Spawn("crystal", pos, Quaternion.Euler(0f, Random.Range(0f, 360f), 0f), new ProductData { strain = strain.Id, quality = quality, units = 1 });
            }
            FX.Burst(output.position, strain.Color, 14, 0.8f);
            AudioManager.Play("success", transform.position, 0.6f);
            Game.Progression?.AddXp(15);
            GameEvents.Raise(GameEventType.CrystalCooked, quality);
            Game.UI?.Notify("Cook finished", $"{units}x {strain.Name} ({ProductCatalog.QualityName(quality)})", strain.Color);
        }
    }
}
