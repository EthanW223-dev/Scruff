using UnityEngine;

namespace Scruff
{
    /// <summary>The big board on the menu platform. Poke buttons to continue, start fresh, or change settings.</summary>
    public class MainMenu : MonoBehaviour
    {
        enum Page { Main, Settings, ConfirmNew }

        Transform ui;
        Transform content;
        Page page = Page.Main;
        bool dirty = true;

        public static MainMenu Create(Transform parent, Vector3 position, float yaw)
        {
            var go = new GameObject("MainMenu");
            go.transform.SetParent(parent, false);
            go.transform.SetPositionAndRotation(position, Quaternion.Euler(0f, yaw, 0f));
            var m = go.AddComponent<MainMenu>();
            m.Build();
            return m;
        }

        void Build()
        {
            Geo.Mesh("Board", transform, b =>
            {
                b.AddBox(new Vector3(0f, 1.15f, -0.06f), new Vector3(1.75f, 1.25f, 0.08f), Palette.WoodDark);
                b.AddBox(new Vector3(-0.75f, 0.3f, -0.06f), new Vector3(0.1f, 0.6f, 0.1f), Palette.WoodDark);
                b.AddBox(new Vector3(0.75f, 0.3f, -0.06f), new Vector3(0.1f, 0.6f, 0.1f), Palette.WoodDark);
            });
            Geo.Solid(transform, new Vector3(0f, 0.9f, -0.06f), new Vector3(1.75f, 1.8f, 0.1f), SurfaceSound.Wood);
            ui = Geo.UIRoot(transform, new Vector3(0f, 1.15f, -0.015f));
            UIFactory.Panel(ui, new Vector2(1.62f, 1.12f), Palette.UIBackground, new Vector3(0f, 0f, 0.002f));
            UIFactory.Text(ui, "SCRUFF", 0.16f, Palette.UIAccent, new Vector3(0f, 0.43f, 0f));
            UIFactory.Text(ui, "broke, hungry, and very good at climbing", 0.03f, Palette.UITextDim, new Vector3(0f, 0.32f, 0f));
            content = Util.CreateChild(ui, "Content");
        }

        public void Show()
        {
            page = Page.Main;
            dirty = true;
        }

        void Update()
        {
            if (!dirty) return;
            dirty = false;
            Rebuild();
        }

        void Rebuild()
        {
            for (int i = content.childCount - 1; i >= 0; i--) Destroy(content.GetChild(i).gameObject);
            Vector2 big = new Vector2(0.5f, 0.1f);
            switch (page)
            {
                case Page.Main:
                {
                    bool hasSave = SaveSystem.HasSave;
                    float y = 0.17f;
                    var cont = UIFactory.Button(content, "CONTINUE", big, Palette.UIButtonActive, new Vector3(0f, y, -0.005f), () => Game.Manager.ContinueGame(), 0.045f);
                    cont.SetInteractable(hasSave);
                    y -= 0.13f;
                    UIFactory.Button(content, "NEW GAME", big, hasSave ? Palette.UIButton : Palette.UIButtonActive, new Vector3(0f, y, -0.005f), () =>
                    {
                        if (SaveSystem.HasSave) SetPage(Page.ConfirmNew);
                        else Game.Manager.NewGame();
                    }, 0.045f);
                    y -= 0.13f;
                    UIFactory.Button(content, "SETTINGS", big, Palette.UIButton, new Vector3(0f, y, -0.005f), () => SetPage(Page.Settings), 0.045f);
                    y -= 0.13f;
                    UIFactory.Button(content, "QUIT", new Vector2(0.3f, 0.08f), Palette.UIButtonDanger, new Vector3(0f, y, -0.005f), Quit, 0.035f);
                    UIFactory.Text(content, hasSave ? "Save found." : "No save yet.", 0.025f, Palette.UITextDim, new Vector3(0f, -0.49f, 0f));
                    break;
                }
                case Page.ConfirmNew:
                {
                    UIFactory.Text(content, "Start over? Your current save will be erased.", 0.04f, Palette.UIWarning, new Vector3(0f, 0.15f, 0f), TextBlock.HAlign.Center, TextBlock.VAlign.Middle, 1.4f);
                    UIFactory.Button(content, "YES, NEW GAME", big, Palette.UIButtonDanger, new Vector3(-0.3f, -0.05f, -0.005f), () => Game.Manager.NewGame(), 0.038f);
                    UIFactory.Button(content, "BACK", big, Palette.UIButton, new Vector3(0.3f, -0.05f, -0.005f), () => SetPage(Page.Main), 0.04f);
                    break;
                }
                case Page.Settings:
                {
                    float y = 0.19f;
                    Row("Turning", y);
                    string turn = GameSettings.TurnMode == TurnMode.Snap ? "SNAP" : GameSettings.TurnMode == TurnMode.Smooth ? "SMOOTH" : "OFF";
                    UIFactory.Button(content, turn, new Vector2(0.28f, 0.08f), Palette.UIButton, new Vector3(0.12f, y, -0.005f), () => { GameSettings.CycleTurnMode(); dirty = true; }, 0.035f);
                    UIFactory.Button(content, $"{GameSettings.SnapAngle:0} DEG", new Vector2(0.2f, 0.08f), Palette.UIButton, new Vector3(0.39f, y, -0.005f), () => { GameSettings.CycleSnapAngle(); dirty = true; }, 0.032f);
                    y -= 0.12f;
                    Row("Volume", y);
                    UIFactory.Button(content, "-", new Vector2(0.09f, 0.08f), Palette.UIButton, new Vector3(0.05f, y, -0.005f), () => { GameSettings.AdjustVolume(-0.1f); dirty = true; }, 0.05f);
                    UIFactory.Text(content, $"{Mathf.RoundToInt(GameSettings.MasterVolume * 100f)}%", 0.04f, Palette.UIText, new Vector3(0.2f, y, 0f));
                    UIFactory.Button(content, "+", new Vector2(0.09f, 0.08f), Palette.UIButton, new Vector3(0.35f, y, -0.005f), () => { GameSettings.AdjustVolume(0.1f); dirty = true; }, 0.05f);
                    y -= 0.12f;
                    Row("Monke colour", y);
                    for (int i = 0; i < GameSettings.PlayerColors.Length; i++)
                    {
                        int idx = i;
                        UIFactory.Button(content, i == GameSettings.ColorIndex ? "*" : "", new Vector2(0.07f, 0.07f), GameSettings.PlayerColors[i],
                            new Vector3(-0.02f + i * 0.085f, y, -0.005f), () => { GameSettings.SetColor(idx); dirty = true; }, 0.05f);
                    }
                    y -= 0.12f;
                    Row("Phone hand", y);
                    UIFactory.Button(content, GameSettings.PhoneOnLeftHand ? "LEFT" : "RIGHT", new Vector2(0.28f, 0.08f), Palette.UIButton, new Vector3(0.12f, y, -0.005f), () =>
                    {
                        GameSettings.PhoneOnLeftHand = !GameSettings.PhoneOnLeftHand;
                        GameSettings.Save();
                        dirty = true;
                    }, 0.035f);
                    y -= 0.14f;
                    UIFactory.Button(content, "BACK", new Vector2(0.3f, 0.08f), Palette.UIButtonActive, new Vector3(0f, y, -0.005f), () => SetPage(Page.Main), 0.04f);
                    break;
                }
            }
        }

        void Row(string label, float y)
        {
            UIFactory.Text(content, label, 0.035f, Palette.UITextDim, new Vector3(-0.72f, y, 0f), TextBlock.HAlign.Left);
        }

        void SetPage(Page p)
        {
            page = p;
            dirty = true;
        }

        static void Quit()
        {
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit();
#endif
        }
    }
}
