// Compile-time-only stubs of the UnityEngine API the bridge uses. This assembly is named
// UnityEngine.CoreModule exactly like BepInEx 6's generated interop assembly, so at runtime
// every reference unifies with the interop assembly BepInEx already loaded: the stub DLL is
// never deployed. Member signatures must match Unity's real API.
using System;
using System.Collections;
using System.Reflection;
using Il2CppInterop.Runtime.InteropTypes;


namespace UnityEngine
{
    public enum HideFlags
    {
        None = 0,
        HideInHierarchy = 1,
        HideInInspector = 2,
        DontSaveInEditor = 4,
        NotEditable = 8,
        DontSaveInBuild = 16,
        DontUnloadUnusedAsset = 32,
        HideAndDontSave = 61,
    }

    public class Object : Il2CppObjectBase
    {
        public Object(IntPtr ptr) : base(ptr) { }
        public string name { get; set; }
        public HideFlags hideFlags { get; set; }
        public int GetInstanceID() { return 0; }
        public static Object[] FindObjectsOfType(Type type) { return new Object[0]; }
        public static void Destroy(Object obj) { }
        public static void DontDestroyOnLoad(Object target) { }
        public static Object Instantiate(Object original, Vector3 position, Quaternion rotation) { return null; }
    }

    public class GameObject : Object
    {
        public GameObject(IntPtr ptr) : base(ptr) { }
        public GameObject(string name) : base(IntPtr.Zero) { }
        public bool activeSelf { get { return false; } }
        public bool activeInHierarchy { get { return false; } }
        public SceneManagement.Scene scene { get { return default(SceneManagement.Scene); } }
        public string tag { get; set; }
        public int layer { get; set; }
        public Transform transform { get { return null; } }
        public void SetActive(bool value) { }
        public Component GetComponent(Type type) { return null; }
        public T GetComponent<T>() { return default(T); }
        public T[] GetComponents<T>() { return new T[0]; }
        public Component[] GetComponents(Type type) { return new Component[0]; }
        public T[] GetComponentsInChildren<T>(bool includeInactive) { return new T[0]; }
        public T GetComponentInChildren<T>(bool includeInactive) { return default(T); }
        public Component AddComponent(Type componentType) { return null; }
        public T AddComponent<T>() where T : Component { return null; }
    }

    public class Component : Object
    {
        public Component(IntPtr ptr) : base(ptr) { }
        public GameObject gameObject { get { return null; } }
        public Transform transform { get { return null; } }
        public Component GetComponent(Type type) { return null; }
        public T GetComponent<T>() { return default(T); }
        public T[] GetComponents<T>() { return new T[0]; }
        public T[] GetComponentsInChildren<T>(bool includeInactive) { return new T[0]; }
        public T GetComponentInChildren<T>(bool includeInactive) { return default(T); }
    }

    public class Behaviour : Component
    {
        public Behaviour(IntPtr ptr) : base(ptr) { }
        public bool enabled { get; set; }
    }

    public class MonoBehaviour : Behaviour
    {
        public MonoBehaviour(IntPtr ptr) : base(ptr) { }
        public Coroutine StartCoroutine(IEnumerator routine) { return null; }
    }

    public class Coroutine : Object
    {
        public Coroutine(IntPtr ptr) : base(ptr) { }
    }

    public class Transform : Component
    {
        public Transform(IntPtr ptr) : base(ptr) { }
        public Vector3 position { get; set; }
        public Vector3 localPosition { get; set; }
        public Vector3 eulerAngles { get; set; }
        public Vector3 localEulerAngles { get; set; }
        public Vector3 localScale { get; set; }
        public Quaternion rotation { get; set; }
        public Transform parent { get { return null; } }
        public int childCount { get { return 0; } }
        public Transform GetChild(int index) { return null; }
        public void SetParent(Transform parent, bool worldPositionStays) { }
    }

    public struct Vector2
    {
        public float x;
        public float y;
        public Vector2(float x, float y) { this.x = x; this.y = y; }
    }

    public struct Vector3
    {
        public float x;
        public float y;
        public float z;
        public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }
        public static Vector3 right { get { return new Vector3(1f, 0f, 0f); } }
        public static Vector3 operator +(Vector3 a, Vector3 b) { return new Vector3(a.x + b.x, a.y + b.y, a.z + b.z); }
        public static Vector3 operator *(Vector3 a, float d) { return new Vector3(a.x * d, a.y * d, a.z * d); }
        public static Vector3 Scale(Vector3 a, Vector3 b) { return new Vector3(a.x * b.x, a.y * b.y, a.z * b.z); }
    }

    public struct Quaternion
    {
        public float x;
        public float y;
        public float z;
        public float w;
    }

    public struct Color
    {
        public float r;
        public float g;
        public float b;
        public float a;
        public Color(float r, float g, float b, float a) { this.r = r; this.g = g; this.b = b; this.a = a; }
    }

    public static class Mathf
    {
        public static float Max(float a, float b) { return a > b ? a : b; }
    }

    public static class Application
    {
        public static string productName { get { return ""; } }
        public static string unityVersion { get { return ""; } }
        public static bool runInBackground { get { return false; } set { } }
    }

    public static class Time
    {
        public static float timeScale { get { return 1f; } set { } }
    }

    public static class Resources
    {
        public static Object[] FindObjectsOfTypeAll(Type type) { return new Object[0]; }
    }

    public struct LayerMask
    {
        public static string LayerToName(int layer) { return ""; }
    }

    public class Renderer : Component
    {
        public Renderer(IntPtr ptr) : base(ptr) { }
        public Material[] materials { get { return new Material[0]; } }
        public Material[] sharedMaterials { get { return new Material[0]; } set { } }
    }

    public class Material : Object
    {
        public Material(IntPtr ptr) : base(ptr) { }
        public bool HasProperty(string name) { return false; }
        public void SetColor(string name, Color value) { }
    }

    public class Mesh : Object
    {
        public Mesh(IntPtr ptr) : base(ptr) { }
    }

    public class MeshFilter : Component
    {
        public MeshFilter(IntPtr ptr) : base(ptr) { }
        public Mesh sharedMesh { get; set; }
    }

    public class MeshRenderer : Renderer
    {
        public MeshRenderer(IntPtr ptr) : base(ptr) { }
    }

    public class SkinnedMeshRenderer : Renderer
    {
        public SkinnedMeshRenderer(IntPtr ptr) : base(ptr) { }
        public Mesh sharedMesh { get; set; }
    }

    public class Sprite : Object
    {
        public Sprite(IntPtr ptr) : base(ptr) { }
    }

    public class SpriteRenderer : Renderer
    {
        public SpriteRenderer(IntPtr ptr) : base(ptr) { }
        public Sprite sprite { get; set; }
        public Color color { get; set; }
    }

    public class Light : Behaviour
    {
        public Light(IntPtr ptr) : base(ptr) { }
        public Color color { get; set; }
    }
}

namespace UnityEngine.SceneManagement
{
    public enum LoadSceneMode
    {
        Single = 0,
        Additive = 1,
    }

    public struct Scene
    {
        public string name { get { return ""; } }
        public int buildIndex { get { return 0; } }
        public int rootCount { get { return 0; } }
        public bool IsValid() { return false; }
    }

    public static class SceneManager
    {
        public static event UnityEngine.Events.UnityAction<Scene, LoadSceneMode> sceneLoaded;
        public static void LoadScene(string sceneName) { }
        public static void LoadScene(int sceneBuildIndex) { }
        public static int sceneCount { get { return 0; } }
        public static Scene GetSceneAt(int index) { return default(Scene); }
        public static int sceneCountInBuildSettings { get { return 0; } }
    }

    public static class SceneUtility
    {
        public static string GetScenePathByBuildIndex(int buildIndex) { return ""; }
    }
}

namespace UnityEngine.Events
{
    public delegate void UnityAction<T0, T1>(T0 arg0, T1 arg1);
}
