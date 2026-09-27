using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.XR.Management;
using UnityEditor.XR.OpenXR.Features;
using UnityEngine;
using UnityEngine.XR.Management;
using UnityEngine.XR.OpenXR;
using UnityEngine.XR.OpenXR.Features;
using UnityEngine.XR.OpenXR.Features.Interactions;
using UnityEngine.XR.OpenXR.Features.MetaQuestSupport;

namespace Scruff.EditorTools
{
    /// <summary>
    /// Sets the project up for VR so nobody has to click through XR Plug-in Management by hand.
    ///
    /// The first time the project opens it turns on OpenXR for PC (Quest Link, Air Link, SteamVR) with the
    /// Oculus Touch, Valve Index and HTC Vive controller profiles. As soon as Android Build Support is installed
    /// it does the same for standalone Quest (Oculus Touch + Meta Quest Support). Each platform is only set up
    /// once (remembered in ProjectSettings/ScruffVRSetup.txt), so later changes you make by hand are kept;
    /// <c>Scruff > VR > Set Up VR Again</c> re-applies everything.
    /// </summary>
    [InitializeOnLoad]
    public static class ScruffVRSetup
    {
        const string MarkerPath = "ProjectSettings/ScruffVRSetup.txt";
        const string ApkPath = "Builds/Scruff.apk";

        static ScruffVRSetup()
        {
            EditorApplication.delayCall += AutoSetup;
        }

        static bool AndroidInstalled => BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.Android, BuildTarget.Android);

        static void AutoSetup()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            {
                EditorApplication.delayCall += AutoSetup;
                return;
            }

            var done = ReadMarker();
            bool changed = false;
            if (!done.Contains(BuildTargetGroup.Standalone) && Configure(BuildTargetGroup.Standalone))
            {
                done.Add(BuildTargetGroup.Standalone);
                changed = true;
                Debug.Log("[Scruff] VR is set up for PC: OpenXR is on with Oculus Touch, Index and Vive controllers. " +
                          "Start Quest Link (or Air Link / SteamVR), put the headset on and press Play.");
            }
            if (!done.Contains(BuildTargetGroup.Android) && AndroidInstalled && Configure(BuildTargetGroup.Android))
            {
                done.Add(BuildTargetGroup.Android);
                changed = true;
                Debug.Log("[Scruff] VR is set up for standalone Quest (OpenXR + Meta Quest Support). " +
                          "Use Scruff > VR > Build And Install On Quest with the headset plugged in.");
            }
            if (changed) WriteMarker(done);
        }

        [MenuItem("Scruff/VR/Set Up VR Again", priority = 30)]
        static void SetUpAgain()
        {
            var done = new HashSet<BuildTargetGroup>();
            if (Configure(BuildTargetGroup.Standalone)) done.Add(BuildTargetGroup.Standalone);
            if (AndroidInstalled && Configure(BuildTargetGroup.Android)) done.Add(BuildTargetGroup.Android);
            WriteMarker(done);
            Debug.Log("[Scruff] VR settings re-applied for: " + string.Join(", ", done) +
                      (AndroidInstalled ? "" : ". (Standalone Quest skipped: install Android Build Support in Unity Hub first.)"));
        }

        [MenuItem("Scruff/VR/Setup Project For Quest", priority = 40)]
        public static void SetupForQuest()
        {
            if (!AndroidInstalled)
            {
                ShowAndroidMissing();
                return;
            }

            PlayerSettings.companyName = "Scruff";
            PlayerSettings.productName = "Scruff";
            PlayerSettings.SetApplicationIdentifier(BuildTargetGroup.Android, "com.scruff.game");
            PlayerSettings.SetScriptingBackend(BuildTargetGroup.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel29;
            // Quest only runs landscape-left, and OpenXR on Android refuses to build in Gamma space with OpenGL ES.
            // Scruff converts its vertex colours for Linear space (Util.ToVertexColor), so it looks the same.
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.LandscapeLeft;
            PlayerSettings.colorSpace = ColorSpace.Linear;
            EditorUserBuildSettings.androidBuildSubtarget = MobileTextureSubtarget.ASTC;
            ScruffSetup.AddToBuildSettings();

            bool ok = Configure(BuildTargetGroup.Android);
            if (ok)
            {
                var done = ReadMarker();
                done.Add(BuildTargetGroup.Android);
                WriteMarker(done);
            }

            if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.Android)
                EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android);

            Debug.Log(ok
                ? "[Scruff] Quest setup done (Android, IL2CPP, ARM64, OpenXR + Meta Quest Support). Plug the headset in and use Scruff > VR > Build And Install On Quest."
                : "[Scruff] Quest player settings applied, but OpenXR couldn't be turned on for Android. See the errors above.");
        }

        [MenuItem("Scruff/VR/Build And Install On Quest", priority = 41)]
        static void BuildAndInstallOnQuest()
        {
            if (!AndroidInstalled)
            {
                ShowAndroidMissing();
                return;
            }
            if (!EditorUtility.DisplayDialog("Build for Quest",
                    "Plug your Quest into this PC with a USB cable, put it on and accept \"Allow USB debugging\" " +
                    "(Developer Mode must be on).\n\nThe first build takes a while (5-15 minutes). The game then starts on the headset " +
                    "and stays in your library under Unknown Sources.", "Build", "Cancel"))
                return;

            SetupForQuest();
            Directory.CreateDirectory(Path.GetDirectoryName(ApkPath));
            var options = new BuildPlayerOptions
            {
                scenes = new[] { ScruffSetup.ScenePath },
                locationPathName = ApkPath,
                target = BuildTarget.Android,
                targetGroup = BuildTargetGroup.Android,
                options = BuildOptions.AutoRunPlayer,
            };
            var report = BuildPipeline.BuildPlayer(options);
            var summary = report.summary;
            if (summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded)
                Debug.Log($"[Scruff] Built {ApkPath} ({summary.totalSize / (1024 * 1024)} MB) and sent it to the headset.");
            else
                Debug.LogError($"[Scruff] Quest build {summary.result} with {summary.totalErrors} error(s). The first red error above says why. " +
                               "No headset found? Check the cable, Developer Mode and the \"Allow USB debugging\" prompt inside the headset.");
        }

        static void ShowAndroidMissing()
        {
            EditorUtility.DisplayDialog("Android Build Support needed",
                "To put Scruff on the Quest itself, add the Android module to this Unity version:\n\n" +
                "Unity Hub > Installs > the gear next to your 2022.3 version > Add modules > tick Android Build Support " +
                "(with OpenJDK and Android SDK & NDK Tools) > Install. Then reopen the project.\n\n" +
                "Playing on PC through Quest Link doesn't need this: just start Link and press Play.", "OK");
        }

        /// <summary>Turns on OpenXR for one platform and enables the controller profiles and features Scruff needs.</summary>
        static bool Configure(BuildTargetGroup group)
        {
            try
            {
                var perTarget = GetOrCreatePerTargetSettings();
                if (!perTarget.HasManagerSettingsForBuildTarget(group))
                    perTarget.CreateDefaultManagerSettingsForBuildTarget(group);
                var general = perTarget.SettingsForBuildTarget(group);
                general.InitManagerOnStart = true;
                EditorUtility.SetDirty(general);

                var manager = general.Manager;
                if (!manager.activeLoaders.Any(l => l is OpenXRLoader))
                {
                    if (!manager.TryAddLoader(GetOrCreateLoader()))
                    {
                        Debug.LogError($"[Scruff] Couldn't add the OpenXR loader for {group}.");
                        return false;
                    }
                    EditorUtility.SetDirty(manager);
                }

                // Creates the OpenXR settings for this platform (and every feature asset) if they don't exist yet.
                FeatureHelpers.RefreshFeatures(group);
                var openxr = OpenXRSettings.GetSettingsForBuildTargetGroup(group);
                if (openxr == null)
                {
                    Debug.LogError($"[Scruff] OpenXR settings for {group} aren't available (is that platform's module installed?).");
                    return false;
                }
                // Scruff's shaders support single-pass instanced stereo, the fastest mode.
                openxr.renderMode = OpenXRSettings.RenderMode.SinglePassInstanced;

                Enable<OculusTouchControllerProfile>(openxr);
                if (group == BuildTargetGroup.Standalone)
                {
                    Enable<ValveIndexControllerProfile>(openxr);
                    Enable<HTCViveControllerProfile>(openxr);
                }
                if (group == BuildTargetGroup.Android)
                    Enable<MetaQuestFeature>(openxr);

                EditorUtility.SetDirty(openxr);
                AssetDatabase.SaveAssets();
                return true;
            }
            catch (System.Exception e)
            {
                Debug.LogError($"[Scruff] VR setup for {group} failed: {e}");
                return false;
            }
        }

        static void Enable<T>(OpenXRSettings settings) where T : OpenXRFeature
        {
            var feature = settings.GetFeature<T>();
            if (feature == null)
            {
                Debug.LogWarning($"[Scruff] OpenXR feature {typeof(T).Name} wasn't found.");
                return;
            }
            feature.enabled = true;
            EditorUtility.SetDirty(feature);
        }

        static XRGeneralSettingsPerBuildTarget GetOrCreatePerTargetSettings()
        {
            EditorBuildSettings.TryGetConfigObject(XRGeneralSettings.k_SettingsKey, out XRGeneralSettingsPerBuildTarget settings);
            if (settings == null)
            {
                var guids = AssetDatabase.FindAssets("t:XRGeneralSettingsPerBuildTarget");
                if (guids.Length > 0)
                    settings = AssetDatabase.LoadAssetAtPath<XRGeneralSettingsPerBuildTarget>(AssetDatabase.GUIDToAssetPath(guids[0]));
            }
            if (settings == null)
            {
                Directory.CreateDirectory("Assets/XR");
                settings = ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();
                AssetDatabase.CreateAsset(settings, "Assets/XR/XRGeneralSettingsPerBuildTarget.asset");
                AssetDatabase.SaveAssets();
            }
            EditorBuildSettings.AddConfigObject(XRGeneralSettings.k_SettingsKey, settings, true);
            return settings;
        }

        static OpenXRLoader GetOrCreateLoader()
        {
            foreach (var guid in AssetDatabase.FindAssets("t:OpenXRLoader"))
            {
                var existing = AssetDatabase.LoadAssetAtPath<OpenXRLoader>(AssetDatabase.GUIDToAssetPath(guid));
                if (existing != null && existing.GetType() == typeof(OpenXRLoader)) return existing;
            }
            Directory.CreateDirectory("Assets/XR/Loaders");
            var loader = ScriptableObject.CreateInstance<OpenXRLoader>();
            AssetDatabase.CreateAsset(loader, "Assets/XR/Loaders/OpenXRLoader.asset");
            AssetDatabase.SaveAssets();
            return loader;
        }

        static HashSet<BuildTargetGroup> ReadMarker()
        {
            var set = new HashSet<BuildTargetGroup>();
            if (!File.Exists(MarkerPath)) return set;
            foreach (var line in File.ReadAllLines(MarkerPath))
                if (System.Enum.TryParse(line.Trim(), out BuildTargetGroup g))
                    set.Add(g);
            return set;
        }

        static void WriteMarker(HashSet<BuildTargetGroup> done)
        {
            File.WriteAllLines(MarkerPath, done.Select(g => g.ToString()));
        }
    }
}
