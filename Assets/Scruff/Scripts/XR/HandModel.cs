using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Chunky mitt hand (Gorilla Tag style) with animated fingers: grip curls the fingers, trigger curls the index,
    /// an extended index is what pokes buttons. Built procedurally, tinted with the player's colour.
    /// </summary>
    public class HandModel : MonoBehaviour
    {
        public Transform PokePoint { get; private set; }
        public Transform GripPoint { get; private set; }

        bool left;
        Transform modelRoot;
        Transform visual;
        Transform palm;
        Transform fingers;
        Transform index;
        Transform thumb;
        float curl;
        float indexCurl;
        float targetCurl;
        float targetIndexCurl;
        float squash;

        static readonly Color Skin = new Color(0.30f, 0.24f, 0.22f);

        public void Build(bool isLeft, Color fur)
        {
            left = isLeft;
            float s = left ? -1f : 1f;

            // modelRoot turns the mitt so the palm faces inwards (OpenXR grip pose); visual gets squashed on taps.
            modelRoot = Util.CreateChild(transform, "Model", Vector3.zero, Quaternion.Euler(0f, 0f, left ? 90f : -90f));
            visual = Util.CreateChild(modelRoot, "Visual");
            palm = Util.CreateChild(visual, "Palm");
            fingers = Util.CreateChild(visual, "Fingers", new Vector3(0f, 0f, 0.045f));
            index = Util.CreateChild(visual, "Index", new Vector3(-s * 0.03f, 0.004f, 0.045f));
            thumb = Util.CreateChild(visual, "Thumb", new Vector3(-s * 0.045f, -0.006f, 0.002f), Quaternion.Euler(0f, -s * 35f, 0f));

            PokePoint = Util.CreateChild(index, "PokePoint", new Vector3(0f, 0f, 0.066f));
            GripPoint = Util.CreateChild(modelRoot, "GripPoint", new Vector3(0f, -0.04f, 0.025f));

            foreach (var t in new[] { palm, fingers, index, thumb })
            {
                t.gameObject.AddComponent<MeshFilter>();
                var r = t.gameObject.AddComponent<MeshRenderer>();
                r.sharedMaterial = ScruffMaterials.Flat;
                r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            }
            SetColor(fur);
        }

        public void SetColor(Color fur)
        {
            ModelFactory.HandParts(left, fur, Skin, out var palmMesh, out var fingerMesh, out var indexMesh, out var thumbMesh);
            palm.GetComponent<MeshFilter>().sharedMesh = palmMesh;
            fingers.GetComponent<MeshFilter>().sharedMesh = fingerMesh;
            index.GetComponent<MeshFilter>().sharedMesh = indexMesh;
            thumb.GetComponent<MeshFilter>().sharedMesh = thumbMesh;
        }

        /// <summary>Sets the target pose; the model eases towards it.</summary>
        public void SetPose(float grip, float trigger, bool holding)
        {
            targetCurl = holding ? Mathf.Max(0.55f, grip) : grip;
            targetIndexCurl = holding ? Mathf.Max(0.5f, Mathf.Max(grip * 0.8f, trigger)) : trigger;
        }

        /// <summary>A quick squash when the hand slaps a surface - makes taps feel punchy.</summary>
        public void Squash(float amount) => squash = Mathf.Max(squash, Mathf.Clamp01(amount));

        void Update()
        {
            float k = Util.Damp(22f, Time.deltaTime);
            curl = Mathf.Lerp(curl, targetCurl, k);
            indexCurl = Mathf.Lerp(indexCurl, targetIndexCurl, k);
            float s = left ? -1f : 1f;
            fingers.localRotation = Quaternion.Euler(curl * 95f, 0f, 0f);
            index.localRotation = Quaternion.Euler(indexCurl * 90f, 0f, 0f);
            thumb.localRotation = Quaternion.Euler(curl * 30f, -s * (35f - curl * 30f), -s * curl * 25f);

            squash = Mathf.MoveTowards(squash, 0f, Time.deltaTime * 6f);
            float sq = squash * 0.18f;
            visual.localScale = new Vector3(1f + sq, 1f - sq, 1f + sq * 0.5f);
        }
    }
}
