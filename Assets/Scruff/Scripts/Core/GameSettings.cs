using System;
using UnityEngine;

namespace Scruff
{
    public enum TurnMode { Snap, Smooth, Off }

    /// <summary>Per-device player preferences, persisted with PlayerPrefs (not part of the save game).</summary>
    public static class GameSettings
    {
        public static TurnMode TurnMode = TurnMode.Snap;
        public static float SnapAngle = 45f;
        public static float SmoothTurnSpeed = 120f;
        public static float MasterVolume = 0.8f;
        public static int ColorIndex = 0;
        public static bool PhoneOnLeftHand = true;

        public static event Action Changed;

        public static readonly Color[] PlayerColors =
        {
            new Color(0.55f, 0.36f, 0.24f), // monke brown
            new Color(0.30f, 0.30f, 0.33f), // concrete grey
            new Color(0.85f, 0.35f, 0.25f), // brick red
            new Color(0.25f, 0.55f, 0.35f), // money green
            new Color(0.25f, 0.45f, 0.80f), // blue
            new Color(0.62f, 0.38f, 0.75f), // purple
            new Color(0.90f, 0.72f, 0.25f), // gold
            new Color(0.92f, 0.92f, 0.90f), // white
        };

        public static Color PlayerColor => PlayerColors[Mathf.Clamp(ColorIndex, 0, PlayerColors.Length - 1)];

        public static void Load()
        {
            TurnMode = (TurnMode)PlayerPrefs.GetInt("scruff.turnMode", (int)TurnMode.Snap);
            SnapAngle = PlayerPrefs.GetFloat("scruff.snapAngle", 45f);
            SmoothTurnSpeed = PlayerPrefs.GetFloat("scruff.smoothTurnSpeed", 120f);
            MasterVolume = PlayerPrefs.GetFloat("scruff.volume", 0.8f);
            ColorIndex = PlayerPrefs.GetInt("scruff.color", 0);
            PhoneOnLeftHand = PlayerPrefs.GetInt("scruff.phoneLeft", 1) == 1;
            Apply();
        }

        public static void Save()
        {
            PlayerPrefs.SetInt("scruff.turnMode", (int)TurnMode);
            PlayerPrefs.SetFloat("scruff.snapAngle", SnapAngle);
            PlayerPrefs.SetFloat("scruff.smoothTurnSpeed", SmoothTurnSpeed);
            PlayerPrefs.SetFloat("scruff.volume", MasterVolume);
            PlayerPrefs.SetInt("scruff.color", ColorIndex);
            PlayerPrefs.SetInt("scruff.phoneLeft", PhoneOnLeftHand ? 1 : 0);
            PlayerPrefs.Save();
            Apply();
        }

        static void Apply()
        {
            AudioListener.volume = Mathf.Clamp01(MasterVolume);
            Changed?.Invoke();
        }

        public static void CycleTurnMode()
        {
            TurnMode = (TurnMode)(((int)TurnMode + 1) % 3);
            Save();
        }

        public static void CycleSnapAngle()
        {
            SnapAngle = SnapAngle >= 60f ? 30f : SnapAngle + 15f;
            Save();
        }

        public static void AdjustVolume(float delta)
        {
            MasterVolume = Mathf.Clamp01(Mathf.Round((MasterVolume + delta) * 10f) / 10f);
            Save();
        }

        public static void SetColor(int index)
        {
            ColorIndex = Mathf.Clamp(index, 0, PlayerColors.Length - 1);
            Save();
        }
    }
}
