using System.Collections.Generic;
using UnityEngine;
using UnityEngine.AI;

namespace Scruff
{
    /// <summary>
    /// Shared NPC body: NavMesh movement with smooth turning, procedural animation, speech, looking at the player,
    /// and reacting to being hit by thrown stuff. Customer and police brains derive from this.
    /// </summary>
    public abstract class NPCAgent : MonoBehaviour
    {
        public static readonly List<NPCAgent> All = new List<NPCAgent>();

        public NavMeshAgent Agent { get; private set; }
        public CharacterModel Model { get; private set; }
        public SpeechBubble Speech { get; private set; }
        public string DisplayName { get; protected set; }
        public float voicePitch = 1f;
        public float walkSpeed = 1.25f;
        public float runSpeed = 3.8f;

        protected float thinkInterval = 0.25f;
        float thinkTimer;
        Vector3? facePoint;
        float faceUntil;
        float lastHitTime = -10f;
        protected int recentHits;

        protected Vector3 PlayerHead => Game.Player != null ? Game.Player.HeadPosition : Vector3.one * 9999f;
        protected Vector3 PlayerFeet => Game.Player != null ? Game.Player.FeetPosition : Vector3.one * 9999f;

        public float DistanceToPlayer
        {
            get
            {
                if (Game.Player == null) return 9999f;
                Vector3 d = Game.Player.HeadPosition - transform.position;
                d.y = 0f;
                return d.magnitude;
            }
        }

        public Vector3 ChestPosition => transform.position + Vector3.up * (Model != null ? Model.HeightMeters * 0.62f : 1f) + transform.forward * 0.22f;

        /// <summary>Must be called with the object already standing on the NavMesh.</summary>
        protected void InitAgent(string displayName, CharacterModel.Appearance look, float pitch)
        {
            DisplayName = displayName;
            voicePitch = pitch;
            gameObject.layer = Layers.NPC;

            var rb = gameObject.AddComponent<Rigidbody>();
            rb.isKinematic = true;
            rb.interpolation = RigidbodyInterpolation.None;
            var col = gameObject.AddComponent<CapsuleCollider>();
            col.radius = 0.26f;
            col.height = 1.6f;
            col.center = new Vector3(0f, 0.8f, 0f);

            Agent = gameObject.AddComponent<NavMeshAgent>();
            Agent.radius = 0.28f;
            Agent.height = 1.6f;
            Agent.speed = walkSpeed;
            Agent.acceleration = 10f;
            Agent.angularSpeed = 540f;
            Agent.stoppingDistance = 0.3f;
            Agent.autoBraking = true;
            Agent.updateRotation = false;
            Agent.obstacleAvoidanceType = ObstacleAvoidanceType.LowQualityObstacleAvoidance;
            Agent.avoidancePriority = Random.Range(30, 70);

            var modelGo = new GameObject("Model");
            modelGo.transform.SetParent(transform, false);
            Model = modelGo.AddComponent<CharacterModel>();
            Model.Build(look);
            Layers.SetLayerRecursively(modelGo, Layers.NPC);

            Speech = SpeechBubble.Create(transform, Model.HeightMeters + 0.28f);
            thinkTimer = Random.value * thinkInterval;
        }

        protected virtual void OnEnable() => All.Add(this);

        protected virtual void OnDisable() => All.Remove(this);

        protected virtual void Update()
        {
            if (Agent == null) return;
            float dt = Time.deltaTime;

            thinkTimer -= dt;
            if (thinkTimer <= 0f)
            {
                thinkTimer = thinkInterval * Random.Range(0.8f, 1.2f);
                Think();
            }

            Vector3 v = Agent.velocity;
            v.y = 0f;
            float speed = v.magnitude;

            Vector3? dir = null;
            if (facePoint.HasValue && Time.time < faceUntil) dir = facePoint.Value - transform.position;
            else if (speed > 0.15f) dir = v;
            if (dir.HasValue)
            {
                Vector3 d = dir.Value;
                d.y = 0f;
                if (d.sqrMagnitude > 1e-4f)
                    transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(d), Util.Damp(speed > 2f ? 10f : 7f, dt));
            }

            Model.Animate(speed, dt);
        }

        protected abstract void Think();

        public bool MoveTo(Vector3 target, bool run = false)
        {
            if (Agent == null || !Agent.isOnNavMesh) return false;
            Agent.speed = run ? runSpeed : walkSpeed;
            Agent.isStopped = false;
            if (NavMesh.SamplePosition(target, out var hit, 3f, NavMesh.AllAreas))
                return Agent.SetDestination(hit.position);
            return false;
        }

        public void Stop()
        {
            if (Agent != null && Agent.isOnNavMesh)
            {
                Agent.isStopped = true;
                Agent.ResetPath();
            }
        }

        public bool HasArrived => Agent != null && Agent.isOnNavMesh && !Agent.pathPending &&
                                  (!Agent.hasPath || Agent.remainingDistance <= Agent.stoppingDistance + 0.2f);

        public void Face(Vector3 point, float seconds = 1.5f)
        {
            facePoint = point;
            faceUntil = Time.time + seconds;
        }

        public void Say(string line, float duration = 2.5f)
        {
            if (Speech == null) return;
            Speech.Show(line, duration, voicePitch);
            Model.Talk(Mathf.Min(duration, 0.4f + line.Length / 38f));
        }

        public bool Warp(Vector3 position)
        {
            if (!NavMesh.SamplePosition(position, out var hit, 4f, NavMesh.AllAreas)) return false;
            transform.position = hit.position;
            return Agent == null || Agent.Warp(hit.position);
        }

        protected bool PlayerIsLookingAtMe(float maxAngle = 30f)
        {
            if (Game.Player == null) return false;
            var head = Game.Player.Head;
            Vector3 to = (transform.position + Vector3.up * 1.2f) - head.position;
            return Vector3.Angle(head.forward, to) < maxAngle;
        }

        void OnCollisionEnter(Collision c)
        {
            var item = c.rigidbody != null ? c.rigidbody.GetComponent<Item>() : null;
            float speed = c.relativeVelocity.magnitude;
            if (item == null || speed < 2.5f || Time.time - lastHitTime < 0.5f) return;
            recentHits = Time.time - lastHitTime < 8f ? recentHits + 1 : 1;
            lastHitTime = Time.time;
            Model.Flinch();
            AudioManager.Play("thud", c.contactCount > 0 ? c.GetContact(0).point : transform.position, 0.6f, 0.8f);
            OnHitByItem(item, speed);
        }

        protected virtual void OnHitByItem(Item item, float speed)
        {
            Say(recentHits > 1 ? "Knock it off!" : "Ow!", 1.5f);
            Face(PlayerHead, 2f);
        }
    }
}
