using UnityEngine;

namespace Scruff
{
    /// <summary>Glanceable watch on your wrist: time, cash, and a dot when there are new deal requests.</summary>
    public class WristWatch : MonoBehaviour
    {
        PlayerRig rig;
        TextBlock time;
        TextBlock money;
        TextBlock alert;
        Transform face;
        float refresh;

        public static WristWatch Create(PlayerRig rig)
        {
            var go = new GameObject("WristWatch");
            var w = go.AddComponent<WristWatch>();
            w.rig = rig;
            w.face = Util.CreateChild(go.transform, "Face");
            UIFactory.Panel(w.face, new Vector2(0.06f, 0.042f), new Color(0.06f, 0.07f, 0.08f), new Vector3(0f, 0f, 0.002f), 0.006f);
            w.time = UIFactory.Text(w.face, "", 0.012f, Palette.UIText, new Vector3(0f, 0.008f, 0f));
            w.money = UIFactory.Text(w.face, "", 0.0095f, Palette.Money, new Vector3(0f, -0.009f, 0f));
            w.alert = UIFactory.Text(w.face, "", 0.012f, Palette.UIAccent, new Vector3(0.036f, 0.018f, 0f));
            return w;
        }

        void LateUpdate()
        {
            bool show = Game.IsPlaying && !(Game.UI != null && Game.UI.Phone != null && Game.UI.Phone.IsOpen && GameSettings.PhoneOnLeftHand);
            if (face.gameObject.activeSelf != show) face.gameObject.SetActive(show);
            if (!show) return;

            var hand = rig.LeftHand.transform;
            // back of the wrist, nudged towards the viewer so the chunky mitt never hides it
            Vector3 pos = hand.TransformPoint(new Vector3(-0.02f, 0.03f, -0.095f));
            Vector3 head = rig.HeadPosition;
            pos += (head - pos).normalized * 0.03f;
            transform.position = pos;
            Vector3 look = pos - head;
            if (look.sqrMagnitude > 1e-4f) transform.rotation = Quaternion.LookRotation(look, Vector3.up);

            refresh -= Time.deltaTime;
            if (refresh > 0f) return;
            refresh = 0.5f;
            time.Text = Game.Clock != null ? GameClock.FormatTime(Game.Clock.MinuteOfDay) : "";
            money.Text = Util.Money(Game.Wallet != null ? Game.Wallet.Cash : 0);
            int offers = 0;
            if (Game.Deals != null)
                foreach (var d in Game.Deals.OpenDeals())
                    if (d.state == DealState.Offered) offers++;
            alert.Text = offers > 0 ? offers.ToString() : "";
        }
    }
}
