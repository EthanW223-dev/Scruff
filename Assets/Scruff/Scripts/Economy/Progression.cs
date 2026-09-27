using System;
using UnityEngine;

namespace Scruff
{
    /// <summary>XP and street rank. Ranks unlock better seeds, stations and ingredients in the shop.</summary>
    public class Progression
    {
        public static readonly string[] RankNames = { "Street Rat", "Corner Kid", "Hustler", "Dealer", "Supplier", "Plug", "Kingpin" };
        public static readonly int[] RankXp = { 0, 120, 400, 900, 1800, 3200, 5500 };

        /// <summary>(new rank)</summary>
        public event Action<int> RankUp;
        public event Action XpChanged;

        public int Xp => Game.State != null ? Game.State.xp : 0;

        public int Rank => RankFor(Xp);

        public string RankName => RankNames[Rank];

        public static int RankFor(int xp)
        {
            int r = 0;
            for (int i = 0; i < RankXp.Length; i++)
                if (xp >= RankXp[i]) r = i;
            return r;
        }

        /// <summary>0..1 progress towards the next rank.</summary>
        public float RankProgress
        {
            get
            {
                int r = Rank;
                if (r >= RankXp.Length - 1) return 1f;
                return Mathf.InverseLerp(RankXp[r], RankXp[r + 1], Xp);
            }
        }

        public int XpToNext
        {
            get
            {
                int r = Rank;
                return r >= RankXp.Length - 1 ? 0 : RankXp[r + 1] - Xp;
            }
        }

        public void AddXp(int amount)
        {
            if (Game.State == null || amount <= 0) return;
            int before = Rank;
            Game.State.xp += amount;
            XpChanged?.Invoke();
            int after = Rank;
            if (after > before)
            {
                AudioManager.PlayUI("rankup", 0.8f);
                Game.UI?.Notify("RANK UP!", $"You're now a {RankNames[after]}. New stuff in the shop.", Palette.UIWarning, 5f);
                RankUp?.Invoke(after);
                GameEvents.Raise(GameEventType.RankUp, after);
            }
        }
    }
}
