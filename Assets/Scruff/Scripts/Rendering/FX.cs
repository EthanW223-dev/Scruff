using UnityEngine;

namespace Scruff
{
    /// <summary>Tiny particle effects built in code (low-poly cube particles using the shared flat material).</summary>
    public static class FX
    {
        static ParticleSystem burst;

        static Mesh ParticleMesh => ModelFactory.Cached("particle_cube", b => b.AddBox(Vector3.zero, Vector3.one, Color.white));

        static ParticleSystem Create(string name, Transform parent)
        {
            var go = new GameObject(name);
            if (parent != null) go.transform.SetParent(parent, false);
            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            var r = go.GetComponent<ParticleSystemRenderer>();
            r.renderMode = ParticleSystemRenderMode.Mesh;
            r.mesh = ParticleMesh;
            r.sharedMaterial = ScruffMaterials.Flat;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            return ps;
        }

        /// <summary>A little puff of cubes (packaging, spawning, cash, harvest).</summary>
        public static void Burst(Vector3 position, Color color, int count = 8, float speed = 1f, float size = 0.012f)
        {
            if (burst == null)
            {
                burst = Create("FX Burst", null);
                Object.DontDestroyOnLoad(burst.gameObject);
                var main = burst.main;
                main.playOnAwake = false;
                main.simulationSpace = ParticleSystemSimulationSpace.World;
                main.maxParticles = 400;
                main.gravityModifier = 0.8f;
                main.startLifetime = 0.6f;
                var em = burst.emission;
                em.enabled = false;
                var shape = burst.shape;
                shape.enabled = false;
                var sol = burst.sizeOverLifetime;
                sol.enabled = true;
                sol.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 1f, 1f, 0f));
                var rot = burst.rotationOverLifetime;
                rot.enabled = true;
                rot.z = new ParticleSystem.MinMaxCurve(-4f, 4f);
                burst.Play();
            }
            var ep = new ParticleSystem.EmitParams { applyShapeToPosition = false };
            for (int i = 0; i < count; i++)
            {
                ep.position = position;
                ep.velocity = (Random.insideUnitSphere + Vector3.up * 0.8f) * speed;
                ep.startSize = size * Random.Range(0.7f, 1.3f);
                ep.startColor = Color.Lerp(color, Color.white, Random.Range(0f, 0.25f));
                ep.startLifetime = Random.Range(0.35f, 0.7f);
                ep.rotation3D = Random.insideUnitSphere * 180f;
                burst.Emit(ep, 1);
            }
        }

        /// <summary>A pour stream that emits downward from <paramref name="spout"/> while its emission is enabled.</summary>
        public static ParticleSystem CreateStream(Transform spout, Color color, float size)
        {
            var ps = Create("PourStream", spout);
            var main = ps.main;
            main.playOnAwake = false;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            main.startSpeed = 0.25f;
            main.startSize = new ParticleSystem.MinMaxCurve(size * 0.7f, size * 1.3f);
            main.startColor = new ParticleSystem.MinMaxGradient(color, Color.Lerp(color, Color.white, 0.2f));
            main.gravityModifier = 1f;
            main.startLifetime = 0.5f;
            main.maxParticles = 300;
            var em = ps.emission;
            em.enabled = false;
            em.rateOverTime = 80f;
            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = 0.008f;
            ps.Play();
            return ps;
        }

        /// <summary>A looping ambient emitter (bubbles on the chem station, sparkles in the mixer).</summary>
        public static ParticleSystem CreateAmbient(Transform parent, Color color, float rate, float size, float speed, float gravity)
        {
            var ps = Create("Ambient", parent);
            var main = ps.main;
            main.playOnAwake = false;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            main.startSpeed = speed;
            main.startSize = new ParticleSystem.MinMaxCurve(size * 0.6f, size * 1.4f);
            main.startColor = new ParticleSystem.MinMaxGradient(color, Color.Lerp(color, Color.white, 0.4f));
            main.gravityModifier = gravity;
            main.startLifetime = 0.8f;
            main.maxParticles = 150;
            var em = ps.emission;
            em.enabled = false;
            em.rateOverTime = rate;
            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Circle;
            shape.radius = 0.05f;
            shape.rotation = new Vector3(-90f, 0f, 0f);
            var sol = ps.sizeOverLifetime;
            sol.enabled = true;
            sol.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 1f, 1f, 0f));
            ps.Play();
            return ps;
        }

        public static void SetEmitting(ParticleSystem ps, bool on)
        {
            if (ps == null) return;
            var em = ps.emission;
            if (em.enabled != on) em.enabled = on;
        }
    }
}
