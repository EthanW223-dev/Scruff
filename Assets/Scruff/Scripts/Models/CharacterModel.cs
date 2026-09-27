using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Blocky low-poly person with procedural animation: walk/run cycle driven by speed, idle breathing,
    /// head tracking, talking mouth, offering arm, wave and flinch. No animation assets needed.
    /// </summary>
    public class CharacterModel : MonoBehaviour
    {
        public struct Appearance
        {
            public Color Skin, Shirt, Pants, Hair, Shoes, Accent;
            public int HairStyle;       // 0 bald, 1 short, 2 cap, 3 beanie, 4 afro, 5 long
            public bool Glasses;
            public bool Hoodie;
            public bool Police;
            public float Height;        // scale, ~0.86..0.96
            public float Bulk;          // width scale
        }

        public static Appearance RandomLook(System.Random rng)
        {
            var a = new Appearance
            {
                Skin = Palette.SkinTones[rng.Next(Palette.SkinTones.Length)],
                Shirt = Palette.ClothingColors[rng.Next(Palette.ClothingColors.Length)],
                Pants = Palette.PantsColors[rng.Next(Palette.PantsColors.Length)],
                Hair = Palette.HairColors[rng.Next(Palette.HairColors.Length)],
                Shoes = rng.NextDouble() < 0.5 ? new Color(0.15f, 0.15f, 0.16f) : new Color(0.9f, 0.9f, 0.88f),
                Accent = Palette.ClothingColors[rng.Next(Palette.ClothingColors.Length)],
                HairStyle = rng.Next(6),
                Glasses = rng.NextDouble() < 0.25,
                Hoodie = rng.NextDouble() < 0.35,
                Height = 0.86f + (float)rng.NextDouble() * 0.1f,
                Bulk = 0.9f + (float)rng.NextDouble() * 0.25f,
            };
            return a;
        }

        public static Appearance PoliceLook(System.Random rng)
        {
            var a = RandomLook(rng);
            a.Shirt = Palette.PoliceShirt;
            a.Pants = Palette.PoliceBlue;
            a.Shoes = new Color(0.1f, 0.1f, 0.11f);
            a.Accent = Palette.PoliceBlue;
            a.HairStyle = 2;
            a.Hoodie = false;
            a.Police = true;
            a.Height = 0.93f + (float)rng.NextDouble() * 0.05f;
            a.Bulk = 1.05f + (float)rng.NextDouble() * 0.15f;
            return a;
        }

        public Transform RightHandPoint { get; private set; }
        public Transform LeftHandPoint { get; private set; }
        public Transform HeadTransform => head;
        public float HeightMeters { get; private set; }

        Transform body;
        Transform torso;
        Transform head;
        Transform leftArm;
        Transform rightArm;
        Transform leftLeg;
        Transform rightLeg;
        Transform mouth;

        float phase;
        float speed;
        float talkTimer;
        float offer;
        float offerTarget;
        float waveTimer;
        float flinch;
        float headYaw;
        float headPitch;
        Vector3? lookPoint;
        float time;
        float idleSeed;

        public void Build(Appearance a)
        {
            idleSeed = Random.value * 10f;
            HeightMeters = 1.74f * a.Height;
            body = Util.CreateChild(transform, "Body");
            body.localScale = new Vector3(a.Bulk * a.Height, a.Height, a.Height);

            Color sleeve = a.Hoodie || a.Police ? a.Shirt : a.Skin;

            leftLeg = Part("LeftLeg", body, new Vector3(-0.09f, 0.82f, 0f), b => Leg(b, a));
            rightLeg = Part("RightLeg", body, new Vector3(0.09f, 0.82f, 0f), b => Leg(b, a));

            torso = Part("Torso", body, new Vector3(0f, 0.82f, 0f), b =>
            {
                b.AddBox(new Vector3(0f, 0.05f, 0f), new Vector3(0.32f, 0.14f, 0.19f), a.Pants);
                b.AddBox(new Vector3(0f, 0.35f, 0f), new Vector3(0.36f, 0.46f, 0.21f), Quaternion.identity, a.Shirt, Color.Lerp(a.Shirt, Color.white, 0.08f));
                if (a.Hoodie)
                {
                    b.AddBox(new Vector3(0f, 0.52f, -0.1f), new Vector3(0.28f, 0.14f, 0.08f), Color.Lerp(a.Shirt, Color.black, 0.15f));
                    b.AddBox(new Vector3(0f, 0.25f, 0.106f), new Vector3(0.2f, 0.1f, 0.01f), Color.Lerp(a.Shirt, Color.black, 0.12f));
                }
                if (a.Police)
                {
                    b.AddBox(new Vector3(-0.09f, 0.45f, 0.107f), new Vector3(0.05f, 0.06f, 0.01f), Palette.Badge);
                    b.AddBox(new Vector3(0f, 0.12f, 0f), new Vector3(0.37f, 0.05f, 0.22f), new Color(0.12f, 0.12f, 0.13f));
                }
            });

            head = Part("Head", torso, new Vector3(0f, 0.6f, 0f), b =>
            {
                b.AddBox(new Vector3(0f, 0.02f, 0f), new Vector3(0.1f, 0.06f, 0.1f), a.Skin);
                b.AddBox(new Vector3(0f, 0.18f, 0f), new Vector3(0.25f, 0.27f, 0.25f), a.Skin);
                b.AddBox(new Vector3(-0.055f, 0.2f, 0.126f), new Vector3(0.035f, 0.045f, 0.01f), new Color(0.08f, 0.08f, 0.1f));
                b.AddBox(new Vector3(0.055f, 0.2f, 0.126f), new Vector3(0.035f, 0.045f, 0.01f), new Color(0.08f, 0.08f, 0.1f));
                b.AddBox(new Vector3(-0.055f, 0.235f, 0.127f), new Vector3(0.045f, 0.01f, 0.01f), Color.Lerp(a.Hair, Color.black, 0.2f));
                b.AddBox(new Vector3(0.055f, 0.235f, 0.127f), new Vector3(0.045f, 0.01f, 0.01f), Color.Lerp(a.Hair, Color.black, 0.2f));
                b.AddBox(new Vector3(0f, 0.15f, 0.135f), new Vector3(0.03f, 0.05f, 0.03f), Color.Lerp(a.Skin, Color.black, 0.12f));
                if (a.Glasses)
                {
                    Color frame = new Color(0.1f, 0.1f, 0.12f);
                    b.AddBox(new Vector3(-0.055f, 0.2f, 0.133f), new Vector3(0.07f, 0.06f, 0.006f), frame);
                    b.AddBox(new Vector3(0.055f, 0.2f, 0.133f), new Vector3(0.07f, 0.06f, 0.006f), frame);
                }
                Hair(b, a);
            });

            mouth = Part("Mouth", head, new Vector3(0f, 0.095f, 0.127f), b =>
                b.AddBox(Vector3.zero, new Vector3(0.08f, 0.016f, 0.008f), new Color(0.45f, 0.18f, 0.18f)));

            leftArm = Part("LeftArm", torso, new Vector3(-0.235f, 0.54f, 0f), b => Arm(b, a, sleeve));
            rightArm = Part("RightArm", torso, new Vector3(0.235f, 0.54f, 0f), b => Arm(b, a, sleeve));
            RightHandPoint = Util.CreateChild(rightArm, "HandPoint", new Vector3(0f, -0.6f, 0.05f));
            LeftHandPoint = Util.CreateChild(leftArm, "HandPoint", new Vector3(0f, -0.6f, 0.05f));
        }

        static Transform Part(string name, Transform parent, Vector3 pos, System.Action<MeshBuilder> build)
        {
            var mb = new MeshBuilder();
            build(mb);
            var go = mb.ToGameObject(name, parent);
            go.transform.localPosition = pos;
            go.GetComponent<MeshRenderer>().shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            return go.transform;
        }

        static void Leg(MeshBuilder b, Appearance a)
        {
            b.AddBox(new Vector3(0f, -0.36f, 0f), new Vector3(0.13f, 0.72f, 0.15f), a.Pants);
            b.AddBox(new Vector3(0f, -0.77f, 0.035f), new Vector3(0.14f, 0.08f, 0.24f), Quaternion.identity, a.Shoes, Color.Lerp(a.Shoes, Color.white, 0.1f));
        }

        static void Arm(MeshBuilder b, Appearance a, Color forearm)
        {
            b.AddBox(new Vector3(0f, -0.14f, 0f), new Vector3(0.1f, 0.3f, 0.12f), a.Shirt);
            b.AddBox(new Vector3(0f, -0.41f, 0f), new Vector3(0.09f, 0.26f, 0.1f), forearm);
            b.AddBox(new Vector3(0f, -0.585f, 0.01f), new Vector3(0.09f, 0.09f, 0.1f), a.Skin);
        }

        static void Hair(MeshBuilder b, Appearance a)
        {
            switch (a.HairStyle)
            {
                case 1: // short
                    b.AddBox(new Vector3(0f, 0.325f, -0.005f), new Vector3(0.27f, 0.05f, 0.27f), a.Hair);
                    b.AddBox(new Vector3(0f, 0.23f, -0.12f), new Vector3(0.27f, 0.16f, 0.04f), a.Hair);
                    break;
                case 2: // cap
                    b.AddBox(new Vector3(0f, 0.335f, -0.005f), new Vector3(0.27f, 0.07f, 0.27f), a.Accent);
                    b.AddBox(new Vector3(0f, 0.31f, 0.17f), new Vector3(0.24f, 0.02f, 0.12f), Color.Lerp(a.Accent, Color.black, 0.2f));
                    if (a.Police) b.AddBox(new Vector3(0f, 0.34f, 0.137f), new Vector3(0.05f, 0.04f, 0.01f), Palette.Badge);
                    break;
                case 3: // beanie
                    b.AddFrustum(new Vector3(0f, 0.28f, 0f), 0.145f, 0.08f, 0.12f, 8, a.Accent);
                    break;
                case 4: // afro
                    b.AddSphere(new Vector3(0f, 0.3f, -0.02f), 0.18f, a.Hair, 8, 5);
                    break;
                case 5: // long
                    b.AddBox(new Vector3(0f, 0.325f, -0.005f), new Vector3(0.27f, 0.05f, 0.27f), a.Hair);
                    b.AddBox(new Vector3(0f, 0.16f, -0.12f), new Vector3(0.28f, 0.34f, 0.05f), a.Hair);
                    b.AddBox(new Vector3(-0.135f, 0.2f, -0.03f), new Vector3(0.03f, 0.22f, 0.18f), a.Hair);
                    b.AddBox(new Vector3(0.135f, 0.2f, -0.03f), new Vector3(0.03f, 0.22f, 0.18f), a.Hair);
                    break;
            }
        }

        // ------------------------------------------------------------------ animation API

        public void LookAt(Vector3? worldPoint) => lookPoint = worldPoint;

        public void Talk(float seconds) => talkTimer = Mathf.Max(talkTimer, seconds);

        public void SetOffer(bool on) => offerTarget = on ? 1f : 0f;

        public void Wave() => waveTimer = 1.4f;

        public void Flinch() => flinch = 1f;

        public void Animate(float moveSpeed, float dt)
        {
            time += dt;
            speed = Mathf.Lerp(speed, moveSpeed, Util.Damp(8f, dt));
            float walk = Mathf.Clamp01(speed / 1.2f);
            float run = Mathf.Clamp01((speed - 2f) / 2f);
            phase += speed / 1.15f * Mathf.PI * dt * (1f + run * 0.3f);

            float s = Mathf.Sin(phase);
            float legSwing = s * (28f + 14f * run) * walk;
            leftLeg.localRotation = Quaternion.Euler(legSwing, 0f, 0f);
            rightLeg.localRotation = Quaternion.Euler(-legSwing, 0f, 0f);

            float breath = Mathf.Sin(time * 2.1f + idleSeed) * (1f - walk);
            float armSwing = s * (22f + 28f * run) * walk;
            offer = Mathf.MoveTowards(offer, offerTarget, dt * 4f);

            float idleSway = Mathf.Sin(time * 1.3f + idleSeed) * 2f * (1f - walk);
            leftArm.localRotation = Quaternion.Euler(-armSwing + idleSway, 0f, -4f - breath);
            Quaternion rightWalk = Quaternion.Euler(armSwing - idleSway, 0f, 4f + breath);
            rightArm.localRotation = Quaternion.Slerp(rightWalk, Quaternion.Euler(-72f, -12f, 6f), Util.SmoothStep01(offer));

            if (waveTimer > 0f)
            {
                waveTimer -= dt;
                float w = Mathf.Clamp01(waveTimer * 3f) * Mathf.Clamp01((1.4f - waveTimer) * 5f);
                leftArm.localRotation = Quaternion.Slerp(leftArm.localRotation, Quaternion.Euler(0f, 0f, -150f + Mathf.Sin(time * 14f) * 18f), w);
            }

            flinch = Mathf.MoveTowards(flinch, 0f, dt * 3f);
            float bob = Mathf.Abs(s) * 0.035f * walk;
            torso.localPosition = new Vector3(0f, 0.82f + bob + breath * 0.004f, 0f);
            torso.localRotation = Quaternion.Euler(6f * run - flinch * 14f, 0f, s * 2f * walk);

            // head look
            float targetYaw = 0f, targetPitch = 0f;
            if (lookPoint.HasValue)
            {
                Vector3 local = torso.InverseTransformPoint(lookPoint.Value) - head.localPosition - Vector3.up * 0.2f;
                targetYaw = Mathf.Clamp(Mathf.Atan2(local.x, local.z) * Mathf.Rad2Deg, -70f, 70f);
                targetPitch = Mathf.Clamp(-Mathf.Atan2(local.y, new Vector2(local.x, local.z).magnitude) * Mathf.Rad2Deg, -30f, 35f);
            }
            else
            {
                targetYaw = Mathf.Sin(time * 0.4f + idleSeed) * 20f * (1f - walk);
            }
            headYaw = Mathf.Lerp(headYaw, targetYaw, Util.Damp(6f, dt));
            headPitch = Mathf.Lerp(headPitch, targetPitch, Util.Damp(6f, dt));
            head.localRotation = Quaternion.Euler(headPitch, headYaw, 0f);

            if (talkTimer > 0f)
            {
                talkTimer -= dt;
                mouth.localScale = new Vector3(1f, 1f + Mathf.Abs(Mathf.Sin(time * 17f)) * 1.8f, 1f);
            }
            else
            {
                mouth.localScale = Vector3.one;
            }
        }
    }
}
