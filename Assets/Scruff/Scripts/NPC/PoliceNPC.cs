using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Patrols between points. Gets suspicious when it sees you holding product or dealing, then chases.
    /// If it catches you (and you're not up on a roof out of reach), you're busted.
    /// Break line of sight or get home to lose them. Gorilla movement is your escape plan.
    /// </summary>
    public class PoliceNPC : NPCAgent
    {
        enum State { Patrol, Pause, Suspicious, Chase, Search }

        public float sightRange = 16f;
        public float fov = 140f;
        public float catchDistance = 1.3f;

        public float Suspicion { get; private set; }
        public bool IsChasing => state == State.Chase;

        State state = State.Patrol;
        int patrolIndex;
        float stateTimer;
        Vector3 lastKnownPlayer;
        float lastSeenTime = -100f;
        bool canSeePlayer;
        float shoutCooldown;
        float whistleCooldown;

        public static PoliceNPC Spawn(int seed, Vector3 position, Transform parent, int startPatrol)
        {
            var go = new GameObject("Police Officer");
            go.transform.SetParent(parent, false);
            go.transform.position = position;
            var cop = go.AddComponent<PoliceNPC>();
            var rng = new System.Random(seed);
            cop.InitAgent("Officer " + NameGenerator.Make(rng), CharacterModel.PoliceLook(rng), 0.75f + (float)rng.NextDouble() * 0.2f);
            cop.walkSpeed = 1.2f;
            cop.runSpeed = 4.3f;
            cop.patrolIndex = startPatrol;
            cop.thinkInterval = 0.2f;
            return cop;
        }

        protected override void Update()
        {
            base.Update();
            shoutCooldown -= Time.deltaTime;
            whistleCooldown -= Time.deltaTime;
            UpdatePerception(Time.deltaTime);
            Model.LookAt(canSeePlayer && DistanceToPlayer < 12f ? PlayerHead : (Vector3?)null);

            if (Suspicion > 0.99f || state == State.Chase) Speech.SetIcon("!", Palette.UIDanger);
            else if (Suspicion > 0.15f) Speech.SetIcon("?", Color.Lerp(Palette.UIWarning, Palette.UIDanger, Suspicion));
            else Speech.SetIcon("", Color.white);
        }

        bool PlayerIsSafe => Game.Player == null || Game.World == null || Game.World.IsInSafeZone(Game.Player.HeadPosition) || !Game.IsPlaying;

        void UpdatePerception(float dt)
        {
            canSeePlayer = false;
            if (PlayerIsSafe)
            {
                Suspicion = Mathf.MoveTowards(Suspicion, 0f, dt * 0.3f);
                return;
            }
            Vector3 eye = transform.position + Vector3.up * (Model.HeightMeters - 0.1f);
            Vector3 toPlayer = PlayerHead - eye;
            float dist = toPlayer.magnitude;
            if (dist < sightRange)
            {
                float angle = Vector3.Angle(transform.forward, toPlayer.Flat());
                bool inView = angle < fov * 0.5f || dist < 3f;
                if (inView && !Physics.Linecast(eye, PlayerHead, Layers.SightBlockMask, QueryTriggerInteraction.Ignore))
                    canSeePlayer = true;
            }

            if (canSeePlayer)
            {
                lastKnownPlayer = PlayerFeet;
                lastSeenTime = Time.time;
                if (Game.Player.IsHoldingProduct())
                {
                    float closeness = 1f - Mathf.Clamp01(dist / sightRange) * 0.7f;
                    float night = Game.Clock != null && Game.Clock.IsNight ? 1.3f : 1f;
                    AddSuspicion(0.55f * closeness * night * dt);
                }
                else if (Game.Clock != null && Game.Clock.IsCurfew && dist < 8f)
                {
                    AddSuspicion(0.08f * dt);
                }
            }
            if (state != State.Chase) Suspicion = Mathf.MoveTowards(Suspicion, 0f, dt * (canSeePlayer ? 0.02f : 0.08f));
        }

        public void AddSuspicion(float amount)
        {
            if (PlayerIsSafe) return;
            Suspicion = Mathf.Clamp01(Suspicion + amount);
        }

        /// <summary>Someone reported a crime nearby (a deal happening in view).</summary>
        public void Witness(Vector3 position, float severity)
        {
            Vector3 eye = transform.position + Vector3.up * (Model.HeightMeters - 0.1f);
            float dist = Vector3.Distance(eye, position);
            if (dist > sightRange) return;
            if (Physics.Linecast(eye, position + Vector3.up * 1.2f, Layers.SightBlockMask, QueryTriggerInteraction.Ignore)) return;
            float angle = Vector3.Angle(transform.forward, (position - eye).Flat());
            if (angle > fov * 0.5f && dist > 4f) return;
            AddSuspicion(severity * (1f - dist / sightRange * 0.5f));
            lastKnownPlayer = PlayerFeet;
            if (state == State.Patrol || state == State.Pause) Say("Hey! What's going on there?", 2f);
        }

        protected override void Think()
        {
            if (!Game.IsPlaying)
            {
                if (state == State.Chase) EndChase();
                return;
            }

            if (state != State.Chase && Suspicion >= 1f && !PlayerIsSafe)
            {
                StartChase();
                return;
            }

            switch (state)
            {
                case State.Patrol:
                    if (Suspicion > 0.35f && canSeePlayer)
                    {
                        state = State.Suspicious;
                        stateTimer = 4f;
                        if (shoutCooldown <= 0f)
                        {
                            Say(Game.Player.IsHoldingProduct() ? "Hey you. What's that in your hand?" : "Hold on a sec...", 2.5f);
                            shoutCooldown = 8f;
                        }
                        break;
                    }
                    if (HasArrived)
                    {
                        state = State.Pause;
                        stateTimer = Random.Range(2f, 5f);
                    }
                    break;

                case State.Pause:
                    stateTimer -= thinkInterval;
                    if (stateTimer <= 0f) NextPatrolPoint();
                    break;

                case State.Suspicious:
                    stateTimer -= thinkInterval;
                    Face(lastKnownPlayer, 1f);
                    if (canSeePlayer && DistanceToPlayer > 3f) MoveTo(lastKnownPlayer);
                    else Stop();
                    if (Suspicion < 0.2f || stateTimer <= 0f && Suspicion < 0.5f)
                    {
                        if (shoutCooldown <= 0f) Say("...Carry on.", 1.5f);
                        NextPatrolPoint();
                    }
                    break;

                case State.Chase:
                    UpdateChase();
                    break;

                case State.Search:
                    stateTimer -= thinkInterval;
                    if (canSeePlayer && Suspicion > 0.6f)
                    {
                        StartChase();
                        break;
                    }
                    if (HasArrived) MoveTo(lastKnownPlayer + Random.insideUnitSphere.Flat() * 4f);
                    if (stateTimer <= 0f)
                    {
                        Say("Lost 'em.", 1.5f);
                        Suspicion = 0.3f;
                        NextPatrolPoint();
                    }
                    break;
            }
        }

        void StartChase()
        {
            state = State.Chase;
            Suspicion = 1f;
            Say("STOP RIGHT THERE!", 2f);
            if (whistleCooldown <= 0f)
            {
                AudioManager.Play("whistle", transform.position, 0.9f);
                whistleCooldown = 6f;
            }
            Game.UI?.Notify("COPS!", "You've been spotted. Lose them or get home!", Palette.UIDanger, 3f);
            NPCManager.AlertNearbyPolice(transform.position, this);
        }

        public void JoinChase(Vector3 lastKnown)
        {
            if (state == State.Chase) return;
            lastKnownPlayer = lastKnown;
            Suspicion = 1f;
            state = State.Chase;
            Say("On my way!", 1.5f);
        }

        void UpdateChase()
        {
            if (PlayerIsSafe)
            {
                Say("Where'd they go?!", 2f);
                EndChase();
                return;
            }
            if (canSeePlayer)
            {
                MoveTo(PlayerFeet, true);
                float flat = DistanceToPlayer;
                float heightDiff = Game.Player.FeetPosition.y - transform.position.y;
                if (flat < catchDistance && heightDiff < 1.4f)
                {
                    Stop();
                    Game.Manager?.Bust(this);
                    EndChase();
                    return;
                }
                if (flat < 3f && heightDiff >= 1.4f && shoutCooldown <= 0f)
                {
                    Say("Get down from there!", 2f);
                    shoutCooldown = 5f;
                }
            }
            else
            {
                MoveTo(lastKnownPlayer, true);
                if (Time.time - lastSeenTime > 6f)
                {
                    state = State.Search;
                    stateTimer = 8f;
                    Say("Where'd they go...", 2f);
                }
            }
        }

        void EndChase()
        {
            Suspicion = 0f;
            NextPatrolPoint();
        }

        void NextPatrolPoint()
        {
            var points = PointOfInterest.OfType(PoiType.Patrol);
            state = State.Patrol;
            if (points.Count == 0) return;
            patrolIndex = (patrolIndex + 1) % points.Count;
            MoveTo(points[patrolIndex].RandomPointNear());
        }

        public void ResetToPatrol()
        {
            Suspicion = 0f;
            NextPatrolPoint();
        }

        protected override void OnHitByItem(Item item, float speed)
        {
            base.OnHitByItem(item, speed);
            AddSuspicion(0.5f);
            if (item.ContainsProduct) AddSuspicion(1f);
        }
    }
}
