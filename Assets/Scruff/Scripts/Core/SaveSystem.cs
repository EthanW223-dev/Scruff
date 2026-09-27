using System;
using System.IO;
using UnityEngine;

namespace Scruff
{
    /// <summary>JSON save file in the persistent data path. Writes to a temp file first so a crash can't corrupt a save.</summary>
    public static class SaveSystem
    {
        const string FileName = "scruff_save.json";

        public static string SavePath => Path.Combine(Application.persistentDataPath, FileName);

        public static bool HasSave => File.Exists(SavePath);

        public static bool Save(GameState state)
        {
            try
            {
                string json = JsonUtility.ToJson(state);
                string temp = SavePath + ".tmp";
                File.WriteAllText(temp, json);
                if (File.Exists(SavePath)) File.Delete(SavePath);
                File.Move(temp, SavePath);
                return true;
            }
            catch (Exception e)
            {
                Debug.LogError($"[Scruff] Saving failed: {e}");
                return false;
            }
        }

        public static GameState Load()
        {
            try
            {
                if (!HasSave) return null;
                var state = JsonUtility.FromJson<GameState>(File.ReadAllText(SavePath));
                return state;
            }
            catch (Exception e)
            {
                Debug.LogError($"[Scruff] Loading failed: {e}");
                return null;
            }
        }

        public static void Delete()
        {
            try
            {
                if (HasSave) File.Delete(SavePath);
            }
            catch (Exception e)
            {
                Debug.LogError($"[Scruff] Deleting save failed: {e}");
            }
        }
    }
}
