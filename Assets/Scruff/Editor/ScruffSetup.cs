using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Scruff.EditorTools
{
    /// <summary>
    /// Editor helpers. On first import this creates Assets/Scruff/Scenes/Scruff.unity (an empty scene containing
    /// just the GameBootstrap) and adds it to Build Settings, so you can open the project and press Play.
    /// </summary>
    [InitializeOnLoad]
    public static class ScruffSetup
    {
        const string SceneFolder = "Assets/Scruff/Scenes";
        internal const string ScenePath = SceneFolder + "/Scruff.unity";

        static readonly (int index, string name)[] RequiredLayers =
        {
            (8, "PlayerBody"),
            (9, "PlayerHand"),
            (10, "Item"),
            (11, "NPC"),
            (12, "Interactable"),
        };

        static ScruffSetup()
        {
            EditorApplication.delayCall += FirstRunCheck;
        }

        static void FirstRunCheck()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            EnsureLayers();
            if (File.Exists(ScenePath) || SessionState.GetBool("Scruff.SceneChecked", false)) return;
            SessionState.SetBool("Scruff.SceneChecked", true);

            var active = SceneManager.GetActiveScene();
            bool openIt = string.IsNullOrEmpty(active.path) && !active.isDirty;
            CreateScene(openIt, false);
            Debug.Log($"[Scruff] Created {ScenePath}. Open it and press Play (no headset = desktop test mode).");
        }

        [MenuItem("Scruff/Create Game Scene", priority = 0)]
        static void CreateSceneMenu() => CreateScene(true, true);

        [MenuItem("Scruff/Open Game Scene", priority = 1)]
        static void OpenScene()
        {
            if (!File.Exists(ScenePath))
            {
                CreateScene(true, true);
                return;
            }
            if (EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())
                EditorSceneManager.OpenScene(ScenePath);
        }

        [MenuItem("Scruff/Delete Save File", priority = 20)]
        static void DeleteSave()
        {
            SaveSystem.Delete();
            Debug.Log("[Scruff] Save deleted: " + SaveSystem.SavePath);
        }

        [MenuItem("Scruff/Show Save Folder", priority = 21)]
        static void ShowSaveFolder()
        {
            EditorUtility.RevealInFinder(Application.persistentDataPath);
        }

        static void CreateScene(bool open, bool askToSave)
        {
            if (askToSave && !EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;

            Directory.CreateDirectory(SceneFolder);
            var previous = SceneManager.GetActiveScene().path;
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var go = new GameObject("Scruff Game");
            go.AddComponent<GameBootstrap>();
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.Refresh();
            AddToBuildSettings();

            if (!open && !string.IsNullOrEmpty(previous) && File.Exists(previous))
                EditorSceneManager.OpenScene(previous);
        }

        internal static void AddToBuildSettings()
        {
            var scenes = EditorBuildSettings.scenes;
            foreach (var s in scenes)
                if (s.path == ScenePath) return;
            var list = new System.Collections.Generic.List<EditorBuildSettingsScene> { new EditorBuildSettingsScene(ScenePath, true) };
            list.AddRange(scenes);
            EditorBuildSettings.scenes = list.ToArray();
        }

        /// <summary>Names the physics layers Scruff uses (the code works off the indices either way).</summary>
        static void EnsureLayers()
        {
            var assets = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset");
            if (assets == null || assets.Length == 0) return;
            var tagManager = new SerializedObject(assets[0]);
            var layers = tagManager.FindProperty("layers");
            if (layers == null || !layers.isArray) return;
            bool changed = false;
            foreach (var (index, name) in RequiredLayers)
            {
                if (index >= layers.arraySize) continue;
                var prop = layers.GetArrayElementAtIndex(index);
                if (string.IsNullOrEmpty(prop.stringValue))
                {
                    prop.stringValue = name;
                    changed = true;
                }
                else if (prop.stringValue != name)
                {
                    Debug.LogWarning($"[Scruff] Layer {index} is named '{prop.stringValue}' but Scruff uses it as '{name}'.");
                }
            }
            if (changed) tagManager.ApplyModifiedProperties();
        }
    }
}
