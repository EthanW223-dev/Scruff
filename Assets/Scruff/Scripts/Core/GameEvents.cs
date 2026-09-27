using System;

namespace Scruff
{
    public enum GameEventType
    {
        PotFilledWithSoil,
        SeedPlanted,
        PlantWatered,
        BudHarvested,
        ProductPackaged,
        ProductMixed,
        CrystalCooked,
        ProductSold,
        DealAccepted,
        DealCompleted,
        DealFailed,
        CustomerGained,
        ItemPurchased,
        StationUnlocked,
        RankUp,
        Busted,
        Slept,
    }

    /// <summary>Tiny global event hub, used mostly by the tutorial and UI to react to gameplay.</summary>
    public static class GameEvents
    {
        public static event Action<GameEventType, object> OnEvent;

        public static void Raise(GameEventType type, object data = null) => OnEvent?.Invoke(type, data);

        public static void Clear() => OnEvent = null;
    }
}
