using System;
using UnityEngine;

namespace Scruff
{
    /// <summary>Your cash. Lives in <see cref="GameState.cash"/>; this adds events, feedback and safety.</summary>
    public class Wallet
    {
        /// <summary>(new balance, change)</summary>
        public event Action<int, int> Changed;

        public int Cash => Game.State != null ? Game.State.cash : 0;

        public bool CanAfford(int amount) => Cash >= amount;

        public void Add(int amount, Vector3? worldPosition = null, bool countAsEarnings = true)
        {
            if (Game.State == null || amount == 0) return;
            Game.State.cash += amount;
            if (amount > 0 && countAsEarnings) Game.State.totalEarned += amount;
            Changed?.Invoke(Game.State.cash, amount);
            if (amount > 0)
            {
                if (worldPosition.HasValue)
                {
                    AudioManager.Play("cash", worldPosition.Value, 0.6f);
                    FloatingText.Spawn(worldPosition.Value + Vector3.up * 0.08f, $"+${amount}", Palette.Money);
                    FX.Burst(worldPosition.Value, Palette.Money, 8, 0.7f, 0.01f);
                }
                else
                {
                    AudioManager.PlayUI("cash", 0.5f);
                }
            }
        }

        public bool TrySpend(int amount)
        {
            if (Game.State == null || amount < 0 || Game.State.cash < amount) return false;
            Game.State.cash -= amount;
            Changed?.Invoke(Game.State.cash, -amount);
            return true;
        }

        /// <summary>Takes up to <paramref name="amount"/> (never below zero). Returns what was actually taken.</summary>
        public int Take(int amount)
        {
            if (Game.State == null) return 0;
            int taken = Mathf.Clamp(amount, 0, Game.State.cash);
            Game.State.cash -= taken;
            if (taken > 0) Changed?.Invoke(Game.State.cash, -taken);
            return taken;
        }
    }
}
