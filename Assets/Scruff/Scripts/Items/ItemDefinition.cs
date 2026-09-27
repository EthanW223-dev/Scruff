using System;
using UnityEngine;

namespace Scruff
{
    public enum ItemCategory { Tool, SeedPacket, Seed, Soil, Container, ProductUnit, Additive, Ingredient, Unlock, Supply, Misc }

    public enum ShopCatalog { None, Supplies, CornerStore }

    /// <summary>Static data for one kind of item. Registered in <see cref="ItemDatabase"/>.</summary>
    public class ItemDefinition
    {
        public string Id;
        public string Name;
        public string Description = "";
        public ItemCategory Category;

        // Shop
        public ShopCatalog Catalog;
        public int Price;
        public int UnlockRank;
        public string ShopName;                       // optional different name in the shop ("Baggies x10")

        // Physical
        public float Mass = 0.3f;
        public int StartUses;
        public float StartCharge;
        public bool Persistent = true;

        // Links
        public string StrainId;                       // seeds / product units
        public string EffectId;                       // additives

        /// <summary>Adds meshes + colliders to the item's root object. Product may be null.</summary>
        public Action<GameObject, ProductData> Build;
        /// <summary>Adds behaviour components after the Item exists.</summary>
        public Action<Item> Configure;

        /// <summary>For shop entries that aren't physical (unlocks, restocks).</summary>
        public Action OnPurchase;
        public Func<bool> CanPurchase;

        public bool IsPhysical => Build != null;
        public string DisplayShopName => string.IsNullOrEmpty(ShopName) ? Name : ShopName;
    }

    /// <summary>Components that add to an item's floating label implement this.</summary>
    public interface ILabelProvider
    {
        string GetLabel();
    }

    /// <summary>Components with extra state to persist implement this (plant pots, etc.).</summary>
    public interface IItemState
    {
        string CaptureState();
        void RestoreState(string json);
    }
}
