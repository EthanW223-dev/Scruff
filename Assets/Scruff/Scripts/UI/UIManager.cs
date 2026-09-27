using UnityEngine;

namespace Scruff
{
    /// <summary>Owns the player-attached UI: phone, wrist watch, toasts and the screen fader.</summary>
    public class UIManager : MonoBehaviour
    {
        public PhoneUI Phone { get; private set; }
        public WristWatch Watch { get; private set; }
        public Notifications Toasts { get; private set; }
        public ScreenFader Fader { get; private set; }

        public static UIManager Create(PlayerRig rig)
        {
            var go = new GameObject("UI");
            var ui = go.AddComponent<UIManager>();
            Game.UI = ui;
            ui.Phone = PhoneUI.Create(rig);
            ui.Phone.transform.SetParent(go.transform, true);
            ui.Watch = WristWatch.Create(rig);
            ui.Watch.transform.SetParent(go.transform, true);
            ui.Toasts = Notifications.Create();
            ui.Toasts.transform.SetParent(go.transform, true);
            ui.Fader = ScreenFader.Create(rig.Camera);
            return ui;
        }

        public void Notify(string title, string body, Color color, float seconds = 3.5f)
        {
            if (Toasts != null) Toasts.Show(title, body, color, seconds);
        }
    }
}
