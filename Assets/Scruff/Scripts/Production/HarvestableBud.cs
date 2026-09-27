using UnityEngine;

namespace Scruff
{
    /// <summary>A bud growing on a plant. Once the plant is ready, grab it to pick it.</summary>
    public class HarvestableBud : Grabbable
    {
        PlantPot pot;
        bool ripe;
        float pulse;

        public static HarvestableBud Create(PlantPot pot, Transform parent, StrainDef strain)
        {
            var go = new GameObject("Bud");
            go.layer = Layers.Interactable;
            go.transform.SetParent(parent, false);
            go.transform.localRotation = Quaternion.Euler(0f, Random.Range(0f, 360f), 0f);
            MeshBuilder.AddRenderer(go, ModelFactory.Bud(strain != null ? strain.Color : Color.green));
            var col = go.AddComponent<SphereCollider>();
            col.radius = 0.035f;
            col.isTrigger = true; // query-only: must not change the pot's rigidbody mass/centre
            col.center = new Vector3(0f, 0.022f, 0f);
            var bud = go.AddComponent<HarvestableBud>();
            bud.pot = pot;
            bud.grabPriority = 1f;
            bud.followsHand = true;
            return bud;
        }

        public void SetRipe(bool value) => ripe = value;

        public override bool CanGrab(PlayerHand hand) => ripe && pot != null && pot.IsMature;

        public override Grabbable ResolveGrab(PlayerHand hand) => pot != null ? pot.Harvest(this, hand) : null;

        public override string GetLabel() => pot != null && pot.IsMature ? "Pick me" : null;

        void Update()
        {
            if (!ripe) return;
            // gentle "ready" bob so it's obvious you can pick it
            pulse += Time.deltaTime * 3f;
            transform.localRotation = Quaternion.Euler(Mathf.Sin(pulse) * 6f, transform.localEulerAngles.y, 0f);
        }
    }
}
