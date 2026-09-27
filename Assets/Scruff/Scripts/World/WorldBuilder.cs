using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Generates the playable sandbox in code: your apartment (with every station), a street block with a corner
    /// store, police station, houses, a park, an alley, plus the floating main-menu platform.
    /// It's a test neighbourhood for the core loop, not the final map - swap in real level art any time; the
    /// gameplay only needs the POIs, stations and colliders this creates.
    /// </summary>
    public class WorldBuilder
    {
        readonly WorldRefs refs = new WorldRefs();
        Transform root;
        Transform colliders;
        Transform meshes;
        Transform pois;
        MeshBuilder mb = new MeshBuilder();
        int meshPart;
        System.Random rng = new System.Random(1234);

        public static WorldRefs Build()
        {
            var b = new WorldBuilder();
            return b.BuildAll();
        }

        WorldRefs BuildAll()
        {
            root = new GameObject("World").transform;
            refs.Root = root;
            refs.ItemsRoot = Util.CreateChild(root, "Items");
            meshes = Util.CreateChild(root, "StaticMeshes");
            colliders = Util.CreateChild(root, "Colliders");
            pois = Util.CreateChild(root, "POIs");

            Ground();
            Roads();
            Apartment();
            CornerStore();
            PoliceStation();
            Houses();
            Park();
            Alley();
            StreetProps();
            Boundary();
            Flush();

            MenuStage();
            Flush();

            refs.WorldBounds = new Bounds(new Vector3(5f, 5f, 15f), new Vector3(136f, 14f, 96f));
            DayNightCycle.SetIndoorBoxes(
                new Bounds(new Vector3(0f, 1.45f, 12f), new Vector3(9.8f, 3.1f, 7.8f)),
                new Bounds(new Vector3(16f, 1.45f, 13.5f), new Vector3(7.8f, 3.1f, 6.8f)));

            if (Game.Turf != null)
            {
                Game.Turf.AddZone("maple", "Maple Street", new Vector3(-20f, 0f, 15f), new Vector3(84f, 50f, 96f));
                Game.Turf.AddZone("oakpark", "Oak Park", new Vector3(47f, 0f, -3f), new Vector3(50f, 50f, 56f));
                Game.Turf.AddZone("northside", "Northside", new Vector3(47f, 0f, 43f), new Vector3(50f, 50f, 40f));
            }
            return refs;
        }

        // ------------------------------------------------------------------ primitives

        void Flush()
        {
            if (mb.IsEmpty) return;
            var go = mb.ToGameObject("Static " + meshPart++, meshes);
            go.isStatic = true;
            mb = new MeshBuilder();
        }

        void Check()
        {
            if (mb.VertexCount > 50000) Flush();
        }

        void Solid(Vector3 min, Vector3 max, SurfaceSound sound = SurfaceSound.Default)
        {
            var go = new GameObject("C");
            go.layer = Layers.Default;
            go.isStatic = true;
            go.transform.SetParent(colliders, false);
            go.transform.position = (min + max) * 0.5f;
            var c = go.AddComponent<BoxCollider>();
            c.size = max - min;
            if (sound != SurfaceSound.Default) go.AddComponent<GorillaSurface>().sound = sound;
        }

        void Box(Vector3 min, Vector3 max, Color side, Color top, bool solid = true, SurfaceSound sound = SurfaceSound.Default)
        {
            Check();
            mb.AddBoxMinMax(min, max, side, top);
            if (solid) Solid(min, max, sound);
        }

        void Box(Vector3 min, Vector3 max, Color color, bool solid = true, SurfaceSound sound = SurfaceSound.Default) => Box(min, max, color, color, solid, sound);

        /// <summary>Box given by centre + size.</summary>
        void BoxC(Vector3 center, Vector3 size, Color color, bool solid = true, SurfaceSound sound = SurfaceSound.Default)
        {
            Box(center - size * 0.5f, center + size * 0.5f, color, color, solid, sound);
        }

        void Window(Vector3 center, Vector3 size)
        {
            Check();
            mb.NightEmission = 0.9f;
            mb.AddBox(center, size, Color.Lerp(Palette.WindowDay, Palette.WindowNight, 0.45f));
            mb.NightEmission = 0f;
            mb.AddBox(center + Vector3.up * (size.y * 0.5f + 0.03f), new Vector3(size.x + 0.12f, 0.06f, size.z + 0.04f), Palette.Plaster);
        }

        PointOfInterest Poi(PoiType type, string name, Vector3 pos, float yaw = 0f, float radius = 1.5f)
        {
            var p = PointOfInterest.Create(pois, type, name, pos, yaw);
            p.radius = radius;
            return p;
        }

        TextBlock Sign(Vector3 position, float yaw, string text, float size, Color color, Color? backing = null, Vector2? backingSize = null)
        {
            var t = Util.CreateChild(root, "Sign " + text, position, Quaternion.Euler(0f, yaw, 0f));
            if (backing.HasValue)
                UIFactory.Panel(t, backingSize ?? new Vector2(text.Length * size * 0.7f + size, size * 1.6f), backing.Value, new Vector3(0f, 0f, 0.01f), 0.03f);
            return UIFactory.Text(t, text, size, color, Vector3.zero);
        }

        // ------------------------------------------------------------------ ground & roads

        void Ground()
        {
            Box(new Vector3(-62f, -0.5f, -32f), new Vector3(72f, 0f, 62f), Palette.GrassDark, Palette.Grass, true, SurfaceSound.Grass);
        }

        void Roads()
        {
            // Main Street (east-west) and Oak Ave (north-south)
            Box(new Vector3(-62f, 0f, 22f), new Vector3(72f, 0.02f, 29f), Palette.Asphalt, false);
            Box(new Vector3(24f, 0f, -32f), new Vector3(31f, 0.021f, 62f), Palette.Asphalt, false);

            // dashed centre lines
            for (float x = -60f; x < 70f; x += 4f)
                if (x < 22f || x > 33f) Box(new Vector3(x, 0.02f, 25.4f), new Vector3(x + 2f, 0.025f, 25.6f), Palette.RoadLine, false);
            for (float z = -30f; z < 60f; z += 4f)
                if (z < 20f || z > 31f) Box(new Vector3(27.4f, 0.021f, z), new Vector3(27.6f, 0.026f, z + 2f), Palette.RoadLine, false);
            // crosswalks
            for (int i = 0; i < 6; i++)
            {
                float x = 24.4f + i * 1.1f;
                Box(new Vector3(x, 0.02f, 19.2f), new Vector3(x + 0.6f, 0.026f, 21.9f), Color.white, false);
                Box(new Vector3(x, 0.02f, 29.1f), new Vector3(x + 0.6f, 0.026f, 31.8f), Color.white, false);
            }

            // Sidewalks (raised 12cm, curbs are a real step)
            float h = 0.12f;
            Box(new Vector3(-62f, 0f, 19f), new Vector3(24f, h, 22f), Palette.Curb, Palette.Sidewalk, true);
            Box(new Vector3(31f, 0f, 19f), new Vector3(72f, h, 22f), Palette.Curb, Palette.Sidewalk, true);
            Box(new Vector3(-62f, 0f, 29f), new Vector3(24f, h, 32f), Palette.Curb, Palette.Sidewalk, true);
            Box(new Vector3(31f, 0f, 29f), new Vector3(72f, h, 32f), Palette.Curb, Palette.Sidewalk, true);
            Box(new Vector3(21f, 0f, -32f), new Vector3(24f, h, 19f), Palette.Curb, Palette.Sidewalk, true);
            Box(new Vector3(21f, 0f, 32f), new Vector3(24f, h, 62f), Palette.Curb, Palette.Sidewalk, true);
            Box(new Vector3(31f, 0f, -32f), new Vector3(34f, h, 19f), Palette.Curb, Palette.Sidewalk, true);
            Box(new Vector3(31f, 0f, 32f), new Vector3(34f, h, 62f), Palette.Curb, Palette.Sidewalk, true);
        }

        // ------------------------------------------------------------------ the apartment

        void Apartment()
        {
            const float x0 = -5f, x1 = 5f, z0 = 8f, z1 = 16f, wallH = 2.8f, t = 0.2f;
            Color brick = Palette.Brick;
            Color inner = Palette.Wall;

            // floor + rug
            Box(new Vector3(x0 + t, 0f, z0 + t), new Vector3(x1 - t, 0.05f, z1 - t), Palette.WoodDark, Palette.Floor, true, SurfaceSound.Wood);
            Box(new Vector3(-2.2f, 0.05f, 11.2f), new Vector3(1.2f, 0.06f, 14.2f), new Color(0.5f, 0.28f, 0.25f), new Color(0.55f, 0.3f, 0.26f), false);
            // grow corner mat
            Box(new Vector3(1.7f, 0.05f, 8.25f), new Vector3(4.75f, 0.058f, 11.2f), new Color(0.85f, 0.85f, 0.85f), new Color(0.9f, 0.9f, 0.92f), false);

            // walls (brick outside) with a doorway in the north wall
            Box(new Vector3(x0, 0f, z0), new Vector3(x1, wallH, z0 + t), brick);
            Box(new Vector3(x0, 0f, z0 + t), new Vector3(x0 + t, wallH, z1 - t), brick);
            Box(new Vector3(x1 - t, 0f, z0 + t), new Vector3(x1, wallH, z1 - t), brick);
            Box(new Vector3(x0, 0f, z1 - t), new Vector3(-0.65f, wallH, z1), brick);
            Box(new Vector3(0.65f, 0f, z1 - t), new Vector3(x1, wallH, z1), brick);
            Box(new Vector3(-0.65f, 2.25f, z1 - t), new Vector3(0.65f, wallH, z1), brick);

            // interior wallpaper (visual only)
            const float p = 0.012f;
            Box(new Vector3(x0 + t, 0.05f, z0 + t), new Vector3(x1 - t, wallH, z0 + t + p), inner, false);
            Box(new Vector3(x0 + t, 0.05f, z0 + t), new Vector3(x0 + t + p, wallH, z1 - t), inner, false);
            Box(new Vector3(x1 - t - p, 0.05f, z0 + t), new Vector3(x1 - t, wallH, z1 - t), inner, false);
            Box(new Vector3(x0 + t, 0.05f, z1 - t - p), new Vector3(-0.65f, wallH, z1 - t), inner, false);
            Box(new Vector3(0.65f, 0.05f, z1 - t - p), new Vector3(x1 - t, wallH, z1 - t), inner, false);
            // skirting
            Box(new Vector3(x0 + t, 0.05f, z0 + t), new Vector3(x1 - t, 0.14f, z0 + t + p + 0.01f), Palette.WoodDark, false);

            // windows (both faces of the north wall)
            Window(new Vector3(-3f, 1.45f, z1 + 0.01f), new Vector3(1.1f, 0.85f, 0.05f));
            Window(new Vector3(3f, 1.45f, z1 + 0.01f), new Vector3(1.1f, 0.85f, 0.05f));
            Window(new Vector3(-3f, 1.45f, z1 - t - 0.02f), new Vector3(1.1f, 0.85f, 0.03f));
            Window(new Vector3(3f, 1.45f, z1 - t - 0.02f), new Vector3(1.1f, 0.85f, 0.03f));

            // ceiling + light panel
            Box(new Vector3(x0, wallH, z0), new Vector3(x1, wallH + 0.2f, z1), Palette.Plaster);
            Check();
            mb.Emission = 1f;
            mb.AddBox(new Vector3(0f, wallH - 0.02f, 12f), new Vector3(1.2f, 0.04f, 0.6f), new Color(1f, 0.95f, 0.85f));
            // grow lamp (purple glow)
            mb.AddBox(new Vector3(3.2f, 2.1f, 9.7f), new Vector3(1.4f, 0.06f, 0.8f), new Color(0.85f, 0.55f, 1f));
            mb.Emission = 0f;
            mb.AddBox(new Vector3(3.2f, 2.16f, 9.7f), new Vector3(1.5f, 0.08f, 0.9f), Palette.MetalDark);
            mb.AddBox(new Vector3(2.6f, 2.5f, 9.7f), new Vector3(0.02f, 0.6f, 0.02f), Palette.MetalDark);
            mb.AddBox(new Vector3(3.8f, 2.5f, 9.7f), new Vector3(0.02f, 0.6f, 0.02f), Palette.MetalDark);

            // upper floors (the rest of the building) + roof
            Box(new Vector3(x0, wallH + 0.2f, z0), new Vector3(x1, 6.4f, z1), brick);
            Box(new Vector3(x0 - 0.1f, 6.4f, z0 - 0.1f), new Vector3(x1 + 0.1f, 6.55f, z1 + 0.1f), Palette.ConcreteDark, Palette.Roof);
            Box(new Vector3(x0 - 0.1f, 6.55f, z0 - 0.1f), new Vector3(x1 + 0.1f, 6.9f, z0 + 0.1f), Palette.ConcreteDark);
            Box(new Vector3(x0 - 0.1f, 6.55f, z1 - 0.1f), new Vector3(x1 + 0.1f, 6.9f, z1 + 0.1f), Palette.ConcreteDark);
            for (int i = 0; i < 4; i++)
            {
                float wx = -3.6f + i * 2.4f;
                Window(new Vector3(wx, 4.6f, z1 + 0.01f), new Vector3(1f, 1.1f, 0.05f));
                Window(new Vector3(wx, 4.6f, z0 - 0.01f), new Vector3(1f, 1.1f, 0.05f));
            }
            // fire escape ladder on the side - climb to the roof, gorilla style
            for (int i = 0; i < 12; i++)
                Box(new Vector3(x1 + 0.05f, 0.4f + i * 0.5f, 10.4f), new Vector3(x1 + 0.12f, 0.45f + i * 0.5f, 11.2f), Palette.MetalDark, true, SurfaceSound.Metal);
            Box(new Vector3(x1 + 0.05f, 0f, 10.35f), new Vector3(x1 + 0.12f, 6.4f, 10.42f), Palette.MetalDark, true, SurfaceSound.Metal);
            Box(new Vector3(x1 + 0.05f, 0f, 11.18f), new Vector3(x1 + 0.12f, 6.4f, 11.25f), Palette.MetalDark, true, SurfaceSound.Metal);

            // front step, path, and sign
            Box(new Vector3(-1.2f, 0f, z1), new Vector3(1.2f, 0.1f, 19f), Palette.Curb, Palette.Concrete);
            Sign(new Vector3(0f, 2.55f, z1 + 0.03f), 180f, "APT 1", 0.18f, Palette.UIText, new Color(0.15f, 0.15f, 0.17f), new Vector2(0.8f, 0.3f));

            refs.SafeZone = new Bounds(new Vector3(0f, 1.5f, 12f), new Vector3(9.6f, 3.2f, 7.6f));
            refs.NotWalkable.Add(new Bounds(new Vector3(0f, 1f, 12f), new Vector3(9.8f, 4f, 7.8f)));
            refs.HomeSpawn = new Vector3(0f, 0.05f, 12.4f);
            refs.HomeYaw = 180f;

            // Door (grab the handle and swing it)
            BuildDoor(new Vector3(-0.6f, 0.05f, z1 - t * 0.5f));

            // Furniture & stations
            Flush();
            var home = Util.CreateChild(root, "Apartment");
            Bed.Create(home, new Vector3(-3.95f, 0.05f, 9.45f), 0f);
            Sink.Create(home, new Vector3(0f, 0.05f, 8.47f), 0f);
            refs.Packing = PackingTable.Create(home, new Vector3(-4.48f, 0.05f, 12.4f), 90f);
            TrashCan.Create(home, new Vector3(-4.45f, 0.05f, 14.3f));
            refs.Mixer = MixingStation.Create(home, new Vector3(4.5f, 0.05f, 12.2f), -90f);
            refs.Chem = ChemStation.Create(home, new Vector3(4.5f, 0.05f, 14.5f), -90f);

            refs.HomeDelivery = new Vector3(-1.7f, 0.1f, 15.1f);
            Box(new Vector3(-2.3f, 0.05f, 14.6f), new Vector3(-1.1f, 0.07f, 15.6f), new Color(0.3f, 0.5f, 0.35f), new Color(0.35f, 0.6f, 0.4f), false);
            Sign(new Vector3(-1.7f, 0.08f, 14.6f), 0f, "DELIVERIES", 0.06f, Palette.UIText).transform.parent.localRotation = Quaternion.Euler(90f, 180f, 0f);
            var delivery = Util.CreateChild(home, "Delivery", refs.HomeDelivery);
            ShopTerminal.Create(home, new Vector3(-3.3f, 0.05f, 15.5f), 180f, ShopCatalog.Supplies, "SUPPLIES", delivery, false);

            refs.StarterPot = new Vector3(2.7f, 0.06f, 9.3f);
            refs.StarterSoil = new Vector3(1.9f, 0.06f, 11.0f);
            refs.StarterSeeds = new Vector3(2.4f, 0.06f, 11.4f);
            refs.StarterCan = new Vector3(1.2f, 0.06f, 9.0f);

            // a couple of spare pot spots marked on the mat
            Check();
            for (int i = 0; i < 4; i++)
            {
                float px = 2.7f + (i % 2) * 1.1f, pz = 9.3f + (i / 2) * 1.0f;
                mb.AddCylinder(new Vector3(px, 0.058f, pz), 0.16f, 0.004f, 12, new Color(0.75f, 0.75f, 0.78f));
            }
        }

        void BuildDoor(Vector3 hinge)
        {
            var pivot = Util.CreateChild(root, "Door", hinge);
            Geo.Mesh("Panel", pivot, b =>
            {
                b.AddBox(new Vector3(0.6f, 1.08f, 0f), new Vector3(1.18f, 2.16f, 0.05f), Palette.Door);
                b.AddBox(new Vector3(0.6f, 1.5f, 0f), new Vector3(0.8f, 0.6f, 0.06f), Color.Lerp(Palette.Door, Color.black, 0.15f));
                b.AddBox(new Vector3(0.6f, 0.55f, 0f), new Vector3(0.8f, 0.6f, 0.06f), Color.Lerp(Palette.Door, Color.black, 0.15f));
                b.AddBox(new Vector3(1.05f, 0.95f, 0.06f), new Vector3(0.12f, 0.035f, 0.035f), Palette.Badge);
                b.AddBox(new Vector3(1.05f, 0.95f, -0.06f), new Vector3(0.12f, 0.035f, 0.035f), Palette.Badge);
            });
            Geo.Solid(pivot, new Vector3(0.6f, 1.08f, 0f), new Vector3(1.18f, 2.16f, 0.05f), SurfaceSound.Wood);
            Geo.Touch(pivot, new Vector3(1.05f, 0.95f, 0f), new Vector3(0.2f, 0.16f, 0.2f));
            var door = pivot.gameObject.AddComponent<HingeGrabbable>();
            door.Configure(pivot, Vector3.up, 0f, 100f, HingeGrabbable.Mode.Drag);
            door.grabPriority = 1f;
            door.SetAngle(95f, false);
            float lastCreak = -1f;
            door.AngleChanged += a =>
            {
                if (Time.time - lastCreak < 0.8f) return;
                lastCreak = Time.time;
                AudioManager.Play("door", pivot.position + Vector3.up, 0.35f, Random.Range(0.9f, 1.1f));
            };
        }

        // ------------------------------------------------------------------ other buildings

        void CornerStore()
        {
            const float x0 = 12f, x1 = 20f, z0 = 10f, z1 = 17f, h = 3f, t = 0.2f;
            Color wall = Palette.SidingYellow;
            Box(new Vector3(x0 + t, 0f, z0 + t), new Vector3(x1 - t, 0.05f, z1 - t), Palette.ConcreteDark, new Color(0.75f, 0.75f, 0.72f));
            Box(new Vector3(x0, 0f, z0), new Vector3(x1, h, z0 + t), wall);
            Box(new Vector3(x0, 0f, z0 + t), new Vector3(x0 + t, h, z1 - t), wall);
            Box(new Vector3(x1 - t, 0f, z0 + t), new Vector3(x1, h, z1 - t), wall);
            Box(new Vector3(x0, 0f, z1 - t), new Vector3(15f, h, z1), wall);
            Box(new Vector3(17f, 0f, z1 - t), new Vector3(x1, h, z1), wall);
            Box(new Vector3(15f, 2.3f, z1 - t), new Vector3(17f, h, z1), wall);
            Box(new Vector3(x0 - 0.2f, h, z0 - 0.2f), new Vector3(x1 + 0.2f, h + 0.25f, z1 + 0.2f), Palette.ConcreteDark, Palette.Roof);
            // awning + big windows
            Box(new Vector3(x0, 2.4f, z1), new Vector3(x1, 2.5f, z1 + 1.2f), new Color(0.8f, 0.25f, 0.2f), new Color(0.9f, 0.3f, 0.25f), true);
            Window(new Vector3(13.5f, 1.3f, z1 + 0.01f), new Vector3(2.2f, 1.4f, 0.05f));
            Window(new Vector3(18.5f, 1.3f, z1 + 0.01f), new Vector3(2.2f, 1.4f, 0.05f));
            Sign(new Vector3(16f, 2.75f, z1 + 1.25f), 180f, "CORNER MART", 0.28f, new Color(1f, 0.95f, 0.8f), new Color(0.75f, 0.2f, 0.18f), new Vector2(3.2f, 0.45f));

            // shelves inside
            for (int i = 0; i < 2; i++)
            {
                float sx = 13f + i * 2.6f;
                Box(new Vector3(sx, 0.05f, 11f), new Vector3(sx + 1.8f, 1.3f, 11.5f), Palette.MetalDark, Palette.Metal, true, SurfaceSound.Metal);
                Check();
                for (int k = 0; k < 10; k++)
                {
                    var c = Palette.ClothingColors[rng.Next(Palette.ClothingColors.Length)];
                    mb.AddBox(new Vector3(sx + 0.15f + k * 0.16f, 1.38f, 11.25f), new Vector3(0.12f, 0.16f, 0.12f), c);
                    mb.AddBox(new Vector3(sx + 0.15f + k * 0.16f, 0.72f, 11.25f), new Vector3(0.12f, 0.14f, 0.12f), Palette.ClothingColors[(k * 3) % Palette.ClothingColors.Length]);
                }
            }
            // counter
            Box(new Vector3(12.3f, 0.05f, 13.8f), new Vector3(14.2f, 0.95f, 14.5f), Palette.WoodDark, Palette.Wood, true, SurfaceSound.Wood);

            Flush();
            var store = Util.CreateChild(root, "CornerStore");
            var delivery = Util.CreateChild(store, "Delivery", new Vector3(17.9f, 0.12f, 13.6f));
            ShopTerminal.Create(store, new Vector3(19.3f, 0.05f, 13.6f), -90f, ShopCatalog.CornerStore, "CORNER MART - MIXERS", delivery, true);

            Poi(PoiType.Hangout, "Corner Mart", new Vector3(16f, 0.12f, 18.4f), 0f, 1.5f);
            Poi(PoiType.MeetSpot, "Corner Mart", new Vector3(18.5f, 0.12f, 18.6f), 0f, 1f);
            Poi(PoiType.Hangout, "Mart Aisle", new Vector3(16f, 0.05f, 12.4f), 0f, 1f);
        }

        void PoliceStation()
        {
            const float x0 = -27f, x1 = -14f, z0 = 5f, z1 = 17f;
            Box(new Vector3(x0, 0f, z0), new Vector3(x1, 4.2f, z1), new Color(0.72f, 0.74f, 0.78f), Palette.Roof);
            Box(new Vector3(x0 - 0.05f, 3.3f, z0 - 0.05f), new Vector3(x1 + 0.05f, 3.7f, z1 + 0.05f), Palette.PoliceBlue, false);
            Box(new Vector3(-21.4f, 0f, z1), new Vector3(-19.6f, 2.3f, z1 + 0.05f), new Color(0.2f, 0.25f, 0.35f), false);
            for (int i = 0; i < 4; i++)
                Window(new Vector3(-25.5f + i * 3.6f + (i >= 2 ? 1.2f : 0f), 1.6f, z1 + 0.01f), new Vector3(1.4f, 1f, 0.05f));
            Sign(new Vector3(-20.5f, 3.5f, z1 + 0.1f), 180f, "POLICE", 0.4f, Color.white);
            Box(new Vector3(-22f, 0f, z1), new Vector3(-19f, 0.1f, 19f), Palette.Curb, Palette.Concrete);
            // cruiser out front
            Car(new Vector3(-24.5f, 0f, 20.8f), 0f, new Color(0.95f, 0.95f, 0.95f), true);

            Poi(PoiType.PoliceStation, "Police Station", new Vector3(-20.5f, 0.12f, 18.6f), 0f, 1.2f);
        }

        void Houses()
        {
            float[] xs = { -52f, -38f, -24f, -10f, 6f, 42f, 56f };
            Color[] sidings = { Palette.Siding, Palette.SidingYellow, Palette.SidingGreen, Palette.Plaster, new Color(0.75f, 0.55f, 0.5f), Palette.Siding, Palette.SidingGreen };
            for (int i = 0; i < xs.Length; i++)
            {
                float cx = xs[i];
                float w = 8f, d = 7f, z0 = 36f;
                Color wall = sidings[i % sidings.Length];
                Box(new Vector3(cx - w / 2, 0f, z0), new Vector3(cx + w / 2, 3.2f, z0 + d), wall, Palette.Roof);
                // gabled roof
                Check();
                Color roof = Color.Lerp(Palette.Roof, new Color(0.45f, 0.2f, 0.15f), (i % 3) * 0.35f);
                Vector3 a = new Vector3(cx - w / 2 - 0.3f, 3.2f, z0 - 0.3f), bb = new Vector3(cx + w / 2 + 0.3f, 3.2f, z0 - 0.3f);
                Vector3 c = new Vector3(cx + w / 2 + 0.3f, 3.2f, z0 + d + 0.3f), dd = new Vector3(cx - w / 2 - 0.3f, 3.2f, z0 + d + 0.3f);
                Vector3 r0 = new Vector3(cx - w / 2 - 0.3f, 5.2f, z0 + d / 2), r1 = new Vector3(cx + w / 2 + 0.3f, 5.2f, z0 + d / 2);
                mb.AddQuad(a, r0, r1, bb, roof);
                mb.AddQuad(c, r1, r0, dd, roof);
                mb.AddTriangle(dd, r0, a, wall);
                mb.AddTriangle(bb, r1, c, wall);
                // roof colliders (two slabs so you can climb up there)
                AddSlopeCollider(a, bb, r0, r1);
                AddSlopeCollider(dd, c, r0, r1);
                // door + windows + porch
                Box(new Vector3(cx - 0.55f, 0f, z0 - 0.04f), new Vector3(cx + 0.55f, 2.1f, z0), Palette.Door, false);
                Window(new Vector3(cx - 2.5f, 1.6f, z0 - 0.02f), new Vector3(1.2f, 1f, 0.05f));
                Window(new Vector3(cx + 2.5f, 1.6f, z0 - 0.02f), new Vector3(1.2f, 1f, 0.05f));
                Box(new Vector3(cx - 1.2f, 0f, z0 - 1.2f), new Vector3(cx + 1.2f, 0.15f, z0), Palette.WoodDark, Palette.Wood, true, SurfaceSound.Wood);
                Box(new Vector3(cx - 0.6f, 0f, 32f), new Vector3(cx + 0.6f, 0.13f, z0 - 1.2f), Palette.Curb, Palette.Concrete);
                // picket fence bits
                for (float fx = cx - w / 2; fx < cx - 1f; fx += 0.4f) Box(new Vector3(fx, 0f, 33f), new Vector3(fx + 0.08f, 0.8f, 33.08f), Color.white, false);
                for (float fx = cx + 1f; fx < cx + w / 2; fx += 0.4f) Box(new Vector3(fx, 0f, 33f), new Vector3(fx + 0.08f, 0.8f, 33.08f), Color.white, false);
                Box(new Vector3(cx - w / 2, 0.55f, 32.98f), new Vector3(cx - 1f, 0.65f, 33.1f), Color.white, true);
                Box(new Vector3(cx + 1f, 0.55f, 32.98f), new Vector3(cx + w / 2, 0.65f, 33.1f), Color.white, true);

                Poi(PoiType.Home, $"House {i + 1}", new Vector3(cx, 0.1f, z0 - 1.8f), 180f, 0.3f);
                if (i % 2 == 0) Poi(PoiType.Hangout, $"Yard {i + 1}", new Vector3(cx + 2.5f, 0f, 34.5f), 0f, 1.2f);
                Tree(new Vector3(cx + 3.2f, 0f, 44.5f), 1.1f);
            }
        }

        void AddSlopeCollider(Vector3 eaveA, Vector3 eaveB, Vector3 ridgeA, Vector3 ridgeB)
        {
            Vector3 eaveMid = (eaveA + eaveB) * 0.5f, ridgeMid = (ridgeA + ridgeB) * 0.5f;
            Vector3 up = ridgeMid - eaveMid;
            var go = new GameObject("RoofSlope");
            go.layer = Layers.Default;
            go.isStatic = true;
            go.transform.SetParent(colliders, false);
            Vector3 along = (eaveB - eaveA).normalized;
            Vector3 normal = Vector3.Cross(up.normalized, along);
            if (normal.y < 0f) normal = -normal;
            go.transform.position = (eaveMid + ridgeMid) * 0.5f - normal * 0.1f;
            go.transform.rotation = Quaternion.LookRotation(up.normalized, normal);
            var c = go.AddComponent<BoxCollider>();
            c.size = new Vector3((eaveB - eaveA).magnitude, 0.2f, up.magnitude);
        }

        void Park()
        {
            Box(new Vector3(35f, 0f, -20f), new Vector3(62f, 0.012f, 21f), Palette.Grass, Palette.GrassDark * 0.2f + Palette.Grass * 0.8f, false);
            // paths
            Box(new Vector3(34f, 0f, 9f), new Vector3(62f, 0.03f, 11f), Palette.Curb, new Color(0.75f, 0.7f, 0.6f), false);
            Box(new Vector3(46f, 0f, -20f), new Vector3(48f, 0.031f, 21f), Palette.Curb, new Color(0.75f, 0.7f, 0.6f), false);

            // fountain
            Vector3 f = new Vector3(47f, 0f, 10f);
            Check();
            mb.AddCylinder(f, 2.2f, 0.55f, 16, Palette.Concrete, null, Palette.ConcreteDark);
            mb.Emission = 0.25f;
            mb.AddCylinder(f + Vector3.up * 0.4f, 1.95f, 0.16f, 16, new Color(0.35f, 0.6f, 0.85f));
            mb.Emission = 0f;
            mb.AddCylinder(f, 0.3f, 1.6f, 8, Palette.Concrete);
            mb.AddCylinder(f + Vector3.up * 1.6f, 0.8f, 0.15f, 10, Palette.Concrete);
            Solid(f + new Vector3(-2f, 0f, -2f), f + new Vector3(2f, 0.55f, 2f));
            Solid(f + new Vector3(-0.3f, 0f, -0.3f), f + new Vector3(0.3f, 1.75f, 0.3f));
            Poi(PoiType.MeetSpot, "Fountain", f + new Vector3(0f, 0f, -3f), 0f, 1f);
            Poi(PoiType.Hangout, "Fountain", f + new Vector3(3f, 0f, 0f), 0f, 1.5f);

            // benches
            Bench(new Vector3(40f, 0f, 8.3f), 0f);
            Bench(new Vector3(54f, 0f, 8.3f), 0f);
            Bench(new Vector3(44.5f, 0f, 16f), 90f);
            Bench(new Vector3(49.5f, 0f, 4f), -90f);
            Poi(PoiType.MeetSpot, "Park Bench", new Vector3(40f, 0f, 7.2f), 0f, 0.8f);
            Poi(PoiType.Hangout, "Park Bench", new Vector3(54f, 0f, 7.2f), 0f, 1f);
            Poi(PoiType.Hangout, "Park Lawn", new Vector3(55f, 0f, 16f), 0f, 3f);

            // basketball court
            Box(new Vector3(37f, 0f, -12f), new Vector3(45f, 0.04f, -2f), new Color(0.25f, 0.3f, 0.35f), new Color(0.3f, 0.45f, 0.55f), false);
            Box(new Vector3(40.9f, 0.04f, -12f), new Vector3(41.1f, 0.045f, -2f), Color.white, false);
            Hoop(new Vector3(41f, 0f, -11.6f), 0f);
            Hoop(new Vector3(41f, 0f, -2.4f), 180f);
            Poi(PoiType.MeetSpot, "Basketball Court", new Vector3(44f, 0f, -1f), 0f, 1f);
            Poi(PoiType.Hangout, "Basketball Court", new Vector3(41f, 0f, -7f), 0f, 2.5f);

            // jungle gym - pure gorilla playground
            Vector3 g = new Vector3(55f, 0f, -8f);
            Color bar = new Color(0.9f, 0.45f, 0.2f);
            for (int ix = 0; ix < 4; ix++)
            for (int iz = 0; iz < 3; iz++)
                Box(g + new Vector3(ix * 1.2f, 0f, iz * 1.2f), g + new Vector3(ix * 1.2f + 0.08f, 2.2f, iz * 1.2f + 0.08f), bar, true, SurfaceSound.Metal);
            for (int iz = 0; iz < 3; iz++)
                Box(g + new Vector3(0f, 2.2f, iz * 1.2f), g + new Vector3(3.68f, 2.28f, iz * 1.2f + 0.08f), bar, true, SurfaceSound.Metal);
            for (int ix = 0; ix < 4; ix++)
                Box(g + new Vector3(ix * 1.2f, 2.2f, 0f), g + new Vector3(ix * 1.2f + 0.08f, 2.28f, 2.48f), bar, true, SurfaceSound.Metal);
            Box(g + new Vector3(0f, 1.1f, 0f), g + new Vector3(3.68f, 1.16f, 2.48f), new Color(0.3f, 0.6f, 0.85f), true, SurfaceSound.Wood);

            // trees
            for (int i = 0; i < 26; i++)
            {
                var p = new Vector3(36f + (float)rng.NextDouble() * 25f, 0f, -19f + (float)rng.NextDouble() * 39f);
                if (Mathf.Abs(p.z - 10f) < 2.5f || Mathf.Abs(p.x - 47f) < 2.5f) continue;
                if ((p - f).magnitude < 4f) continue;
                if (p.x < 46f && p.z < -1f && p.z > -13f) continue;
                if (p.x > 53f && p.x < 60f && p.z > -10f && p.z < -4f) continue;
                Tree(p, 0.8f + (float)rng.NextDouble() * 0.6f);
            }
        }

        void Alley()
        {
            // back fence and alley clutter behind the apartment
            for (float x = -12f; x < 11f; x += 2f)
            {
                Box(new Vector3(x, 0f, 0f), new Vector3(x + 0.1f, 2f, 0.1f), Palette.WoodDark, true, SurfaceSound.Wood);
                Box(new Vector3(x, 0.2f, 0.02f), new Vector3(x + 2f, 1.9f, 0.08f), Palette.Wood, true, SurfaceSound.Wood);
            }
            Dumpster(new Vector3(-3.5f, 0f, 4.5f), 0f);
            Dumpster(new Vector3(7.5f, 0f, 3.8f), 20f);
            for (int i = 0; i < 5; i++)
            {
                var p = new Vector3(-9f + (i % 3) * 0.95f, (i / 3) * 0.9f, 2.2f);
                Box(p, p + new Vector3(0.9f, 0.9f, 0.9f), Palette.Wood, Palette.WoodLight, true, SurfaceSound.Wood);
            }
            Poi(PoiType.MeetSpot, "Back Alley", new Vector3(2f, 0f, 4f), 0f, 0.8f);
            Poi(PoiType.Hangout, "Back Alley", new Vector3(-6f, 0f, 5.5f), 0f, 1.5f);
        }

        void StreetProps()
        {
            for (float x = -56f; x < 70f; x += 16f)
            {
                if (x > 20f && x < 34f) continue;
                StreetLamp(new Vector3(x, 0.12f, 21.5f), 0f);
                StreetLamp(new Vector3(x + 8f, 0.12f, 29.5f), 180f);
            }
            for (float z = -26f; z < 60f; z += 16f)
            {
                if (z > 17f && z < 33f) continue;
                StreetLamp(new Vector3(22.5f, 0.12f, z), 90f);
                StreetLamp(new Vector3(32.5f, 0.12f, z + 8f), -90f);
            }

            Car(new Vector3(-36f, 0f, 22.9f), 90f, new Color(0.7f, 0.2f, 0.2f), false);
            Car(new Vector3(-8f, 0f, 22.9f), 90f, new Color(0.25f, 0.4f, 0.7f), false);
            Car(new Vector3(40f, 0f, 22.9f), 90f, new Color(0.9f, 0.8f, 0.4f), false);
            Car(new Vector3(-44f, 0f, 28.1f), -90f, new Color(0.3f, 0.6f, 0.4f), false);
            Car(new Vector3(12f, 0f, 28.1f), -90f, new Color(0.85f, 0.85f, 0.85f), false);
            Car(new Vector3(29.8f, 0f, 4f), 0f, new Color(0.45f, 0.3f, 0.6f), false);

            // bus stop
            Vector3 bs = new Vector3(-10f, 0.12f, 31.2f);
            Box(bs + new Vector3(-1.5f, 0f, 0.35f), bs + new Vector3(1.5f, 2.3f, 0.45f), new Color(0.3f, 0.45f, 0.6f), true, SurfaceSound.Metal);
            Box(bs + new Vector3(-1.6f, 2.3f, -0.4f), bs + new Vector3(1.6f, 2.4f, 0.5f), new Color(0.25f, 0.35f, 0.45f), true, SurfaceSound.Metal);
            Box(bs + new Vector3(-1.2f, 0.4f, 0f), bs + new Vector3(1.2f, 0.47f, 0.35f), Palette.Wood, true, SurfaceSound.Wood);
            Poi(PoiType.MeetSpot, "Bus Stop", bs + new Vector3(0f, 0f, -0.8f), 0f, 0.8f);
            Poi(PoiType.Hangout, "Bus Stop", bs + new Vector3(0.5f, 0f, -0.6f), 0f, 1f);

            // other hangouts along the street
            Poi(PoiType.Hangout, "Main St West", new Vector3(-40f, 0.12f, 20.5f), 0f, 2f);
            Poi(PoiType.Hangout, "Main St", new Vector3(-2f, 0.12f, 20.5f), 0f, 2f);
            Poi(PoiType.Hangout, "Northside Walk", new Vector3(50f, 0.12f, 30.5f), 0f, 2f);
            Poi(PoiType.Hangout, "Oak Ave", new Vector3(32.5f, 0.12f, 0f), 0f, 1.5f);

            // police patrol loop
            Vector3[] patrol =
            {
                new Vector3(-40f, 0.12f, 20.5f), new Vector3(-12f, 0.12f, 20.5f), new Vector3(8f, 0.12f, 20.5f), new Vector3(22.5f, 0.12f, 12f),
                new Vector3(40f, 0f, 10f), new Vector3(55f, 0.12f, 20.5f), new Vector3(45f, 0.12f, 30.5f), new Vector3(22.5f, 0.12f, 38f),
                new Vector3(0f, 0.12f, 30.5f), new Vector3(-30f, 0.12f, 30.5f),
            };
            for (int i = 0; i < patrol.Length; i++) Poi(PoiType.Patrol, "Patrol " + i, patrol[i], 0f, 1.5f);
        }

        void Boundary()
        {
            Color fence = new Color(0.5f, 0.52f, 0.55f);
            Box(new Vector3(-62f, 0f, -32f), new Vector3(-61.8f, 3f, 62f), fence, true, SurfaceSound.Metal);
            Box(new Vector3(71.8f, 0f, -32f), new Vector3(72f, 3f, 62f), fence, true, SurfaceSound.Metal);
            Box(new Vector3(-62f, 0f, -32f), new Vector3(72f, 3f, -31.8f), fence, true, SurfaceSound.Metal);
            Box(new Vector3(-62f, 0f, 61.8f), new Vector3(72f, 3f, 62f), fence, true, SurfaceSound.Metal);
            // invisible walls above the fence so nobody flings out of the map
            Solid(new Vector3(-63f, 3f, -33f), new Vector3(-61.8f, 60f, 63f));
            Solid(new Vector3(71.8f, 3f, -33f), new Vector3(73f, 60f, 63f));
            Solid(new Vector3(-63f, 3f, -33f), new Vector3(73f, 60f, -31.8f));
            Solid(new Vector3(-63f, 3f, 61.8f), new Vector3(73f, 60f, 63f));
        }

        // ------------------------------------------------------------------ props

        void Tree(Vector3 p, float s)
        {
            Check();
            mb.AddFrustum(p, 0.2f * s, 0.14f * s, 2.2f * s, 6, Palette.TreeTrunk);
            mb.AddSphere(p + Vector3.up * 2.9f * s, 1.3f * s, Palette.Leaves, 7, 4);
            mb.AddSphere(p + new Vector3(0.6f, 2.4f, 0.3f) * s, 0.9f * s, Palette.LeavesLight, 6, 4);
            mb.AddSphere(p + new Vector3(-0.5f, 2.5f, -0.4f) * s, 0.85f * s, Palette.Leaves, 6, 4);
            Solid(p + new Vector3(-0.18f * s, 0f, -0.18f * s), p + new Vector3(0.18f * s, 2.2f * s, 0.18f * s), SurfaceSound.Wood);
            Solid(p + new Vector3(-1.1f, 2f, -1.1f) * s, p + new Vector3(1.1f, 3.8f, 1.1f) * s, SurfaceSound.Grass);
        }

        void Bench(Vector3 p, float yaw)
        {
            var q = Quaternion.Euler(0f, yaw, 0f);
            Check();
            mb.PushTRS(p, q);
            mb.AddBox(new Vector3(0f, 0.45f, 0f), new Vector3(1.6f, 0.06f, 0.45f), Palette.Wood);
            mb.AddBox(new Vector3(0f, 0.75f, -0.2f), new Vector3(1.6f, 0.35f, 0.05f), Palette.Wood);
            mb.AddBox(new Vector3(-0.7f, 0.22f, 0f), new Vector3(0.06f, 0.45f, 0.4f), Palette.MetalDark);
            mb.AddBox(new Vector3(0.7f, 0.22f, 0f), new Vector3(0.06f, 0.45f, 0.4f), Palette.MetalDark);
            mb.PopMatrix();
            var go = new GameObject("Bench");
            go.transform.SetParent(colliders, false);
            go.transform.SetPositionAndRotation(p, q);
            Geo.Solid(go.transform, new Vector3(0f, 0.24f, 0f), new Vector3(1.6f, 0.48f, 0.45f), SurfaceSound.Wood);
            Geo.Solid(go.transform, new Vector3(0f, 0.75f, -0.2f), new Vector3(1.6f, 0.35f, 0.05f), SurfaceSound.Wood);
        }

        void Hoop(Vector3 p, float yaw)
        {
            var q = Quaternion.Euler(0f, yaw, 0f);
            Check();
            mb.PushTRS(p, q);
            mb.AddBox(new Vector3(0f, 1.5f, 0f), new Vector3(0.12f, 3f, 0.12f), Palette.MetalDark);
            mb.AddBox(new Vector3(0f, 3.2f, 0.25f), new Vector3(1.2f, 0.8f, 0.05f), Color.white);
            mb.AddFrustum(new Vector3(0f, 2.95f, 0.5f), 0.24f, 0.24f, 0.03f, 10, new Color(0.9f, 0.4f, 0.2f), null, false, false);
            mb.PopMatrix();
            var go = new GameObject("Hoop");
            go.transform.SetParent(colliders, false);
            go.transform.SetPositionAndRotation(p, q);
            Geo.Solid(go.transform, new Vector3(0f, 1.5f, 0f), new Vector3(0.12f, 3f, 0.12f), SurfaceSound.Metal);
            Geo.Solid(go.transform, new Vector3(0f, 3.2f, 0.25f), new Vector3(1.2f, 0.8f, 0.05f), SurfaceSound.Wood);
        }

        void Dumpster(Vector3 p, float yaw)
        {
            var q = Quaternion.Euler(0f, yaw, 0f);
            Check();
            mb.PushTRS(p, q);
            mb.AddBox(new Vector3(0f, 0.65f, 0f), new Vector3(1.9f, 1.2f, 1.1f), Palette.Dumpster);
            mb.AddBox(new Vector3(0f, 1.3f, -0.05f), new Vector3(1.95f, 0.08f, 1.2f), Quaternion.Euler(-6f, 0f, 0f), Palette.MetalDark);
            mb.AddBox(new Vector3(-0.8f, 0.05f, 0f), new Vector3(0.12f, 0.1f, 0.12f), Palette.MetalDark);
            mb.AddBox(new Vector3(0.8f, 0.05f, 0f), new Vector3(0.12f, 0.1f, 0.12f), Palette.MetalDark);
            mb.PopMatrix();
            var go = new GameObject("Dumpster");
            go.transform.SetParent(colliders, false);
            go.transform.SetPositionAndRotation(p, q);
            Geo.Solid(go.transform, new Vector3(0f, 0.68f, 0f), new Vector3(1.9f, 1.36f, 1.1f), SurfaceSound.Metal);
        }

        void StreetLamp(Vector3 p, float yaw)
        {
            var q = Quaternion.Euler(0f, yaw, 0f);
            Check();
            mb.PushTRS(p, q);
            mb.AddCylinder(Vector3.zero, 0.08f, 4.2f, 6, Palette.MetalDark);
            mb.AddBox(new Vector3(0f, 4.15f, 0.45f), new Vector3(0.1f, 0.08f, 0.9f), Palette.MetalDark);
            mb.AddBox(new Vector3(0f, 4.05f, 0.85f), new Vector3(0.35f, 0.12f, 0.3f), Palette.MetalDark);
            mb.NightEmission = 1f;
            mb.AddBox(new Vector3(0f, 3.98f, 0.85f), new Vector3(0.3f, 0.03f, 0.25f), Palette.LampGlow);
            mb.NightEmission = 0f;
            mb.PopMatrix();
            Solid(p + new Vector3(-0.08f, 0f, -0.08f), p + new Vector3(0.08f, 4.2f, 0.08f), SurfaceSound.Metal);
        }

        void Car(Vector3 p, float yaw, Color color, bool police)
        {
            var q = Quaternion.Euler(0f, yaw, 0f);
            Check();
            mb.PushTRS(p, q);
            Color dark = Color.Lerp(color, Color.black, 0.3f);
            mb.AddBox(new Vector3(0f, 0.55f, 0f), new Vector3(1.8f, 0.6f, 4.2f), Quaternion.identity, color, color);
            mb.AddBox(new Vector3(0f, 1.1f, -0.2f), new Vector3(1.6f, 0.55f, 2.2f), Quaternion.identity, color, dark);
            mb.NightEmission = 0.4f;
            mb.AddBox(new Vector3(0f, 1.1f, -0.2f), new Vector3(1.62f, 0.4f, 2.0f), new Color(0.35f, 0.45f, 0.55f));
            mb.NightEmission = 0f;
            if (police)
            {
                mb.AddBox(new Vector3(0f, 0.55f, 0f), new Vector3(1.82f, 0.25f, 2.4f), Palette.PoliceBlue);
                mb.Emission = 1f;
                mb.AddBox(new Vector3(-0.3f, 1.42f, -0.2f), new Vector3(0.45f, 0.1f, 0.2f), new Color(1f, 0.2f, 0.2f));
                mb.AddBox(new Vector3(0.3f, 1.42f, -0.2f), new Vector3(0.45f, 0.1f, 0.2f), new Color(0.2f, 0.4f, 1f));
                mb.Emission = 0f;
            }
            for (int i = 0; i < 4; i++)
            {
                float wx = i % 2 == 0 ? -0.92f : 0.92f, wz = i < 2 ? -1.3f : 1.3f;
                mb.AddCylinder(new Vector3(wx - 0.1f, 0.33f, wz), 0.33f, 0.2f, 8, new Color(0.1f, 0.1f, 0.1f), Quaternion.Euler(0f, 0f, -90f));
            }
            mb.Emission = 0.9f;
            mb.AddBox(new Vector3(-0.6f, 0.65f, 2.11f), new Vector3(0.3f, 0.15f, 0.02f), new Color(1f, 0.95f, 0.8f));
            mb.AddBox(new Vector3(0.6f, 0.65f, 2.11f), new Vector3(0.3f, 0.15f, 0.02f), new Color(1f, 0.95f, 0.8f));
            mb.AddBox(new Vector3(-0.6f, 0.65f, -2.11f), new Vector3(0.3f, 0.12f, 0.02f), new Color(0.9f, 0.15f, 0.1f));
            mb.AddBox(new Vector3(0.6f, 0.65f, -2.11f), new Vector3(0.3f, 0.12f, 0.02f), new Color(0.9f, 0.15f, 0.1f));
            mb.Emission = 0f;
            mb.PopMatrix();
            var go = new GameObject("Car");
            go.transform.SetParent(colliders, false);
            go.transform.SetPositionAndRotation(p, q);
            Geo.Solid(go.transform, new Vector3(0f, 0.55f, 0f), new Vector3(1.8f, 0.9f, 4.2f), SurfaceSound.Metal);
            Geo.Solid(go.transform, new Vector3(0f, 1.1f, -0.2f), new Vector3(1.6f, 0.55f, 2.2f), SurfaceSound.Metal);
        }

        // ------------------------------------------------------------------ main menu platform

        void MenuStage()
        {
            Vector3 c = new Vector3(0f, 40f, -140f);
            Box(c + new Vector3(-8f, -0.6f, -8f), c + new Vector3(8f, 0f, 8f), Palette.WoodDark, Palette.Wood, true, SurfaceSound.Wood);
            // edge rails
            Box(c + new Vector3(-8f, 0f, -8f), c + new Vector3(8f, 0.6f, -7.8f), Palette.WoodDark, true, SurfaceSound.Wood);
            Box(c + new Vector3(-8f, 0f, 7.8f), c + new Vector3(8f, 0.6f, 8f), Palette.WoodDark, true, SurfaceSound.Wood);
            Box(c + new Vector3(-8f, 0f, -8f), c + new Vector3(-7.8f, 0.6f, 8f), Palette.WoodDark, true, SurfaceSound.Wood);
            Box(c + new Vector3(7.8f, 0f, -8f), c + new Vector3(8f, 0.6f, 8f), Palette.WoodDark, true, SurfaceSound.Wood);
            // practice blocks to climb
            Box(c + new Vector3(-6.5f, 0f, -2f), c + new Vector3(-4.5f, 1f, 0f), Palette.Brick, Palette.BrickDark, true);
            Box(c + new Vector3(-6.5f, 0f, 0f), c + new Vector3(-4.5f, 2f, 2f), Palette.Brick, Palette.BrickDark, true);
            Box(c + new Vector3(-6.5f, 0f, 2f), c + new Vector3(-4.5f, 3f, 4f), Palette.Brick, Palette.BrickDark, true);
            Box(c + new Vector3(4.5f, 0f, -3f), c + new Vector3(6.5f, 1.4f, -1f), Palette.Dumpster, true, SurfaceSound.Metal);
            Tree(c + new Vector3(5.5f, 0f, 4.5f), 1f);

            refs.MenuSpawn = c + new Vector3(0f, 0f, -3f);
            refs.MenuYaw = 0f;
            refs.MenuKillY = 25f;

            Flush();
            refs.Menu = MainMenu.Create(root, c + new Vector3(0f, 0f, 2.2f), 180f);
            HowToBoard(c + new Vector3(-3.2f, 0f, 1.4f), 150f);
        }

        void HowToBoard(Vector3 pos, float yaw)
        {
            var t = Util.CreateChild(root, "HowTo", pos, Quaternion.Euler(0f, yaw, 0f));
            Geo.Mesh("Board", t, b =>
            {
                b.AddBox(new Vector3(0f, 1.05f, -0.05f), new Vector3(1.3f, 1.1f, 0.06f), Palette.WoodDark);
                b.AddBox(new Vector3(-0.55f, 0.25f, -0.05f), new Vector3(0.08f, 0.5f, 0.08f), Palette.WoodDark);
                b.AddBox(new Vector3(0.55f, 0.25f, -0.05f), new Vector3(0.08f, 0.5f, 0.08f), Palette.WoodDark);
            });
            var ui = Geo.UIRoot(t, new Vector3(0f, 1.05f, -0.015f));
            UIFactory.Panel(ui, new Vector2(1.2f, 1.0f), Palette.UIBackground, new Vector3(0f, 0f, 0.002f));
            UIFactory.Text(ui, "HOW TO PLAY", 0.05f, Palette.UIAccent, new Vector3(0f, 0.43f, 0f));
            UIFactory.Text(ui,
                "MOVE: swing your arms and push off the ground, like Gorilla Tag.\n" +
                "GRAB: grip button. Let go to drop, swing and let go to throw.\n" +
                "USE: poke screens and buttons with your finger.\n" +
                "PHONE: Y button (left hand). Deals, customers, prices, settings.\n" +
                "TURN: right stick.\n\n" +
                "GROW: pour soil in a pot, drop a seed in, water it, pick the buds.\n" +
                "PACK: grab a baggie at the packing table, drop buds in.\n" +
                "SELL: hand bags to customers. Strangers get free samples.\n" +
                "COPS: don't let them see product in your hand. Run, climb, or get home.\n\n" +
                "Rent is due every week. Don't get evicted.",
                0.028f, Palette.UIText, new Vector3(-0.56f, 0.37f, 0f), TextBlock.HAlign.Left, TextBlock.VAlign.Top, 1.12f);
        }
    }
}
