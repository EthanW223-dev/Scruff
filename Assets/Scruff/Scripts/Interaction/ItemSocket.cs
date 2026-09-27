using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// A snap point: let go of an accepted object near it and it slides into place (station slots, holsters).
    /// Items snap with their pivot (bottom centre) on the socket.
    /// </summary>
    public class ItemSocket : MonoBehaviour
    {
        public static readonly List<ItemSocket> All = new List<ItemSocket>();

        public float radius = 0.12f;
        public Func<Grabbable, bool> Filter;
        [Tooltip("Stable id so saved items can be put back into this socket.")]
        public string saveKey;
        public Vector3 insertEuler;
        public bool keepRotation;

        public Grabbable Occupant { get; private set; }
        public bool IsOccupied => Occupant != null;

        public event Action<Grabbable> Inserted;
        public event Action<Grabbable> Removed;

        GameObject indicator;
        bool hadOccupant;

        void OnEnable() => All.Add(this);

        void OnDisable() => All.Remove(this);

        public bool Accepts(Grabbable g)
        {
            return isActiveAndEnabled && Occupant == null && g != null && g.followsHand && (Filter == null || Filter(g));
        }

        public static ItemSocket FindBestFor(Grabbable g)
        {
            if (g == null) return null;
            Vector3 p = g.transform.position;
            ItemSocket best = null;
            float bestDist = float.MaxValue;
            foreach (var s in All)
            {
                float d = Vector3.Distance(p, s.transform.position);
                if (d > s.radius || d >= bestDist || !s.Accepts(g)) continue;
                best = s;
                bestDist = d;
            }
            return best;
        }

        public void Insert(Grabbable g, bool instant = false)
        {
            if (g == null) return;
            if (g.Socket != null) g.Socket.Remove(g);
            Occupant = g;
            hadOccupant = true;
            g.Socket = this;
            if (g.Body != null)
            {
                g.Body.isKinematic = true;
                g.Body.interpolation = RigidbodyInterpolation.None;
            }
            g.transform.SetParent(transform, true);
            Quaternion targetRot = keepRotation ? g.transform.localRotation : Quaternion.Euler(insertEuler);
            if (instant || !isActiveAndEnabled)
            {
                g.transform.localPosition = Vector3.zero;
                g.transform.localRotation = targetRot;
            }
            else
            {
                StartCoroutine(SnapRoutine(g, targetRot));
                AudioManager.Play("snap", transform.position, 0.35f, UnityEngine.Random.Range(0.95f, 1.1f));
            }
            SetPreview(false);
            Inserted?.Invoke(g);
        }

        IEnumerator SnapRoutine(Grabbable g, Quaternion targetRot)
        {
            Vector3 fromPos = g.transform.localPosition;
            Quaternion fromRot = g.transform.localRotation;
            float t = 0f;
            while (t < 1f)
            {
                if (g == null || g.Socket != this) yield break;
                t += Time.deltaTime / 0.12f;
                float s = Util.SmoothStep01(t);
                g.transform.localPosition = Vector3.Lerp(fromPos, Vector3.zero, s);
                g.transform.localRotation = Quaternion.Slerp(fromRot, targetRot, s);
                yield return null;
            }
        }

        public void Remove(Grabbable g)
        {
            if (Occupant != g || g == null) return;
            Occupant = null;
            hadOccupant = false;
            g.Socket = null;
            g.transform.SetParent(Game.World != null ? Game.World.ItemsRoot : null, true);
            Removed?.Invoke(g);
        }

        /// <summary>Drops the reference to a destroyed occupant without touching its transform.</summary>
        internal void Forget(Grabbable g)
        {
            if (Occupant != g) return;
            Occupant = null;
            hadOccupant = false;
            Removed?.Invoke(null);
        }

        void Update()
        {
            if (hadOccupant && Occupant == null)
            {
                // occupant was destroyed while sitting here
                hadOccupant = false;
                Occupant = null;
                Removed?.Invoke(null);
            }
        }

        public void SetPreview(bool on)
        {
            if (on && indicator == null) indicator = BuildIndicator();
            if (indicator != null) indicator.SetActive(on);
        }

        GameObject BuildIndicator()
        {
            var mb = new MeshBuilder { RawAlpha = true };
            int seg = 16;
            float r0 = Mathf.Min(radius * 0.55f, 0.07f), r1 = r0 + 0.012f;
            var c = new Color(0.45f, 1f, 0.55f, 0.75f);
            for (int i = 0; i < seg; i++)
            {
                float a0 = i / (float)seg * Mathf.PI * 2f, a1 = (i + 1) / (float)seg * Mathf.PI * 2f;
                Vector3 d0 = new Vector3(Mathf.Cos(a0), 0f, Mathf.Sin(a0)), d1 = new Vector3(Mathf.Cos(a1), 0f, Mathf.Sin(a1));
                mb.AddQuad(d0 * r0, d1 * r0, d1 * r1, d0 * r1, c);
            }
            var go = mb.ToGameObject("SocketPreview", transform);
            go.transform.localPosition = Vector3.up * 0.003f;
            go.GetComponent<MeshRenderer>().sharedMaterial = ScruffMaterials.Transparent;
            return go;
        }
    }
}
