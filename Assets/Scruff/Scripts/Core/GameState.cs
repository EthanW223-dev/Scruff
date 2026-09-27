using System;
using System.Collections.Generic;
using UnityEngine;

namespace Scruff
{
    /// <summary>
    /// Everything that gets written to the save file. Plain serializable data only (JsonUtility-friendly:
    /// no dictionaries, no properties).
    /// </summary>
    [Serializable]
    public class GameState
    {
        public int version = 1;
        public int seed;

        // Time
        public int day = 1;
        public float minuteOfDay = 8 * 60;

        // Money & progress
        public int cash;
        public int xp;
        public int totalEarned;
        public int totalUnitsSold;
        public int rentDebt;
        public int nextRentDay = 7;
        public List<string> unlocks = new List<string>();

        // Packaging table stock (bought as packs, pulled out one at a time)
        public int baggieStock;
        public int jarStock;

        // Economy
        public List<PriceSetting> prices = new List<PriceSetting>();

        // People
        public List<CustomerProfile> customers = new List<CustomerProfile>();
        public List<Deal> deals = new List<Deal>();
        public List<PhoneMessage> messages = new List<PhoneMessage>();
        public int nextDealId = 1;

        // World
        public List<ItemSaveData> items = new List<ItemSaveData>();
        public List<TurfSaveData> turf = new List<TurfSaveData>();

        // Tutorial
        public int tutorialStep;

        public float AbsoluteMinutes => (day - 1) * 1440f + minuteOfDay;

        public bool HasUnlock(string id) => unlocks.Contains(id);

        public void Unlock(string id)
        {
            if (!unlocks.Contains(id)) unlocks.Add(id);
        }

        public float GetMarkup(ProductFamily family)
        {
            foreach (var p in prices)
                if (p.family == family) return p.markup;
            return 1f;
        }

        public void SetMarkup(ProductFamily family, float markup)
        {
            foreach (var p in prices)
            {
                if (p.family == family)
                {
                    p.markup = markup;
                    return;
                }
            }
            prices.Add(new PriceSetting { family = family, markup = markup });
        }
    }

    [Serializable]
    public class PriceSetting
    {
        public ProductFamily family;
        public float markup = 1f;
    }

    [Serializable]
    public class ItemSaveData
    {
        public string id;
        public Vector3 position;
        public Quaternion rotation = Quaternion.identity;
        public bool hasProduct;
        public ProductData product;
        public int uses;
        public float charge;
        public string socketKey;
        public string extra;
    }

    [Serializable]
    public class TurfSaveData
    {
        public string zoneId;
        public float influence;
    }

    [Serializable]
    public class PhoneMessage
    {
        public string from;
        public string text;
        public int day;
        public float minute;
        public int dealId;
    }
}
