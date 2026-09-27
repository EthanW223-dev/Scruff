using System;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// In-game time. By default one real second is one in-game minute (a day lasts 24 real minutes).
    /// Systems that simulate over time (plants, cooking) listen to <see cref="Advanced"/>, which also fires
    /// with a big delta when the player sleeps, so everything catches up correctly.
    /// </summary>
    public class GameClock : MonoBehaviour
    {
        public float realSecondsPerGameMinute = 1f;
        public bool Running;

        /// <summary>Fired every frame the clock moves (and once with a large value when time is skipped).</summary>
        public event Action<float> Advanced;
        /// <summary>Fired once per whole in-game minute passed.</summary>
        public event Action MinuteTick;
        /// <summary>Fired when the hour changes, with the new hour (0-23).</summary>
        public event Action<int> HourTick;
        /// <summary>Fired when a new day starts, with the new day number.</summary>
        public event Action<int> NewDay;

        public int Day => Game.State != null ? Game.State.day : 1;
        public float MinuteOfDay => Game.State != null ? Game.State.minuteOfDay : 8 * 60;
        public float AbsoluteMinutes => Game.State != null ? Game.State.AbsoluteMinutes : 0f;
        public int Hour => Mathf.FloorToInt(MinuteOfDay / 60f) % 24;
        public bool IsNight => MinuteOfDay >= 21 * 60 || MinuteOfDay < 6 * 60;
        public bool IsCurfew => MinuteOfDay >= 23 * 60 || MinuteOfDay < 5 * 60;

        void Awake()
        {
            Game.Clock = this;
        }

        void Update()
        {
            if (!Running || Game.State == null) return;
            Advance(Time.deltaTime / Mathf.Max(0.01f, realSecondsPerGameMinute));
        }

        /// <summary>Moves time forward by the given number of in-game minutes, firing all tick events on the way.</summary>
        public void Advance(float minutes)
        {
            var s = Game.State;
            if (s == null || minutes <= 0f) return;

            float remaining = minutes;
            while (remaining > 0f)
            {
                float toNextMinute = Mathf.Floor(s.minuteOfDay + 1f) - s.minuteOfDay;
                if (toNextMinute <= 0f) toNextMinute = 1f;
                float step = Mathf.Min(remaining, toNextMinute);
                int prevWhole = Mathf.FloorToInt(s.minuteOfDay);
                s.minuteOfDay += step;
                remaining -= step;

                if (Mathf.FloorToInt(s.minuteOfDay) != prevWhole)
                {
                    if (s.minuteOfDay >= 1440f)
                    {
                        s.minuteOfDay -= 1440f;
                        s.day++;
                        NewDay?.Invoke(s.day);
                    }
                    MinuteTick?.Invoke();
                    int whole = Mathf.FloorToInt(s.minuteOfDay);
                    if (whole % 60 == 0) HourTick?.Invoke(whole / 60);
                }
            }

            Advanced?.Invoke(minutes);
        }

        /// <summary>Skips forward to the next occurrence of the given time of day.</summary>
        public float SkipTo(float targetMinuteOfDay)
        {
            float delta = targetMinuteOfDay - MinuteOfDay;
            if (delta <= 0f) delta += 1440f;
            Advance(delta);
            return delta;
        }

        public static string FormatTime(float minuteOfDay)
        {
            int total = Mathf.FloorToInt(minuteOfDay) % 1440;
            int h = total / 60;
            int m = total % 60;
            string ampm = h < 12 ? "AM" : "PM";
            int h12 = h % 12;
            if (h12 == 0) h12 = 12;
            return $"{h12}:{m:00} {ampm}";
        }

        public static string FormatDuration(float minutes)
        {
            int total = Mathf.Max(0, Mathf.CeilToInt(minutes));
            int h = total / 60;
            int m = total % 60;
            return h > 0 ? $"{h}h {m:00}m" : $"{m}m";
        }

        public static string DayName(int day)
        {
            string[] names = { "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun" };
            return names[(Mathf.Max(1, day) - 1) % 7];
        }
    }
}
