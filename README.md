# Scruff

A VR hustle game in the style of *Schedule One* meets *Rust*, played with **Gorilla Tag locomotion**.
You start broke in a crummy apartment with a pot, some soil and three seeds. Grow product, package it,
mix it, cook it, and sell it to the neighbourhood, while dodging the cops and making rent. Later, other
players join and fight over turf.

This repo is the **foundation**: every core system is in and working together in a small test
neighbourhood. It is not the final map.

| System | What's in |
|---|---|
| Locomotion | Gorilla Tag arm locomotion (port of Another Axiom's open-source `Player.cs`), snap/smooth turn, hand tap sounds + haptics |
| Hands | Grab anything with grip, throw with real hand velocity, hand-to-hand passing, poke buttons with your finger, belt holsters |
| Growing | Pour soil into a pot, tip a seed packet, water it, watch it grow continuously, pick the buds |
| Packaging | Grab a baggie (1 unit) or jar (5 units) from the packing table, drop product in |
| Mixing | Mixing station: product + additive = new effects, new name, higher value (hidden transformation rules) |
| Cooking | Chem station: two ingredients + a heat-control mini-game on a twistable knob |
| Selling | Customers text deal requests; meet them and hand over the bag. Walk-up sales, free samples to win new customers, price haggling, referrals |
| Economy | Cash, per-product-family markup, quality tiers, effects, weekly rent, XP and street ranks, shop unlocks |
| AI | Customers with schedules, homes, preferences, addiction and relationships; police who patrol, get suspicious, chase and bust you |
| UI | Phone (home, messages/deals, crew, prices, settings), wrist watch, toasts, floating "+$" text, item labels, deal beacons |
| Menu | Main-menu platform with continue / new game / settings, and a "how to play" board |
| World | Apartment, corner store, police station, houses, park, alley, day/night cycle, turf zones |
| Save | JSON save of money, time, customers, deals and every item in the world (including what's inside station slots and holsters) |

Everything (models, sounds, UI, the world) is **generated in code**, so there are no art or audio assets to import.
Swap in real assets whenever you're ready.

### Browser preview

`web/` is a small browser version of the same game (Three.js, no build step) so you can try the loop without Unity or a
headset: grow, bag, sell, mix, cook, police, phone, rent and saves. It plays with mouse and keyboard or touch, and it's a
preview only; the VR game is the Unity project. Serve the folder with any static server (for example
`python3 -m http.server` inside `web/`) and open `index.html`.

---

## Getting it running

1. Install **Unity 2022.3 LTS** (the project was written against 2022.3; Unity Hub will offer to use whichever 2022.3 you have).
2. Open this folder with Unity Hub (**Add > Add project from disk**).
3. Unity may ask to **enable the new Input System backends**. Either answer works; the code supports both.
4. On first import the editor script creates `Assets/Scruff/Scenes/Scruff.unity` and adds it to Build Settings.
   If it didn't open automatically, use **Scruff > Open Game Scene**.
5. Press **Play**. With no headset you get **desktop test mode** (below). With a headset and XR enabled you get VR.

### VR (Quest via Link / Air Link, or standalone)

VR is set up automatically. The first time the project opens, `ScruffVRSetup` turns on OpenXR for PC with the
Oculus Touch, Valve Index and HTC Vive controller profiles (single-pass instanced). Once **Android Build Support** is
installed it does the same for standalone Quest, adding **Meta Quest Support** (Quest 2, 3, 3S and Pro).
**Scruff > VR > Set Up VR Again** re-applies all of it if you change something by accident.

**On PC through Quest Link / Air Link (Windows):**

1. Install the **Meta Quest Link** app. In **Settings > General > OpenXR Runtime**, set Meta Quest Link as active.
2. Connect the headset (USB-C cable or Air Link) and start Link inside the headset.
3. Press **Play** in Unity. If the Console says "Still no headset", step 1 or 2 isn't done yet.

SteamVR headsets work the same way with SteamVR set as the OpenXR runtime.

**On the Quest itself (no PC needed while playing):**

1. In Unity Hub add **Android Build Support** (with OpenJDK and Android SDK & NDK Tools) to your 2022.3 install.
2. Turn on **Developer Mode** for the headset in the Meta Horizon phone app.
3. Plug the Quest in, accept **Allow USB debugging** in the headset, then **Scruff > VR > Build And Install On Quest**.
   It applies the Quest settings (Android, IL2CPP, ARM64, Linear colour, landscape), builds `Builds/Scruff.apk` and
   starts it on the headset. Afterwards it's in the Quest library under **Unknown Sources**.

The game uses Unity's XR `InputDevices` API directly (like the original Gorilla Locomotion), so it doesn't need the
XR Interaction Toolkit.

### Handy options

Select **Scruff Game** in the scene to find the `GameBootstrap` component:

- **Force Desktop Mode**: play with mouse and keyboard even if a headset is connected.
- **Skip Main Menu**: jump straight into your save (or a new game). Great while iterating.
- **Seconds Per Game Minute**: 1 = a 24-minute day. Lower it to speed-test growing.

Menu **Scruff > Delete Save File** wipes your save.

---

## Controls

### VR

| Action | Input |
|---|---|
| Move | Swing your arms and push off the world, exactly like Gorilla Tag |
| Grab / hold | Grip. Let go to drop; swing and let go to throw |
| Use buttons & screens | Poke them with your index finger |
| Phone | **Y** (or the menu button) on the phone hand (left by default) |
| Turn | Right stick (snap / smooth / off in settings) |
| Pour (soil, water, seeds) | Tilt the item over the target |
| Stash | Let go of a small item by your hip (belt holsters) |
| Twist dials | Grab the knob and turn your wrist |

### Desktop test mode

| Action | Input |
|---|---|
| Look / move / run / jump | Mouse / WASD / Shift / Space (click to capture the mouse, Esc to release) |
| Grab, hold, press buttons | Left mouse (hold to keep holding; scroll wheel changes hold distance) |
| Throw | F while holding |
| Tilt (pour) | R |
| Twist (dials) | Q / E while holding |
| Trigger / use | Right mouse |
| Phone | Tab |

---

## The loop

1. **Grow.** Tip the soil bag over an empty pot, tip the seed packet so a seed drops in, water it with the can
   (refill at the sink). It grows continuously; hover it to see water, growth and time left. Quality depends on how
   consistently it stayed watered (fertilizer helps more). When it's ready, grab the buds to pick them.
2. **Package.** Grab a baggie (or a jar) from the packing table and drop buds into it. Customers only buy packaged product.
3. **Sell.** Customers text you (**Messages** app). Accept, go to the meeting spot (a beacon marks it) and hand them the bag.
   You can also walk up to a customer who "wants some". Hold the bag near them first and they'll tell you if the price is right.
   Strangers get a **free sample**: if they like it, they become a customer.
4. **Price.** In the **Prices** app set a markup per product family. Push it too far and people walk.
   What someone will pay depends on quality, effects they like, how rich they are, how much they like you, how hooked
   they are, and whether it's your turf.
5. **Level up.** Sales, harvests, cooking and mixing give XP. Ranks unlock better seeds, fertilizer, jars, the
   **Mixing Station** (rank 1) and the **Chem Station** (rank 2) in the shop on your apartment computer. Mixers
   (energy drinks, candy, glitter...) are sold at the **Corner Mart**.
6. **Don't get caught.** Police notice product *in your hands* (holstered stuff is hidden) and deals they can see.
   If they chase you, break line of sight, climb out of reach, or get home. Getting busted costs you the product you're
   carrying and a fine.
7. **Pay rent.** $150 every 7 days. Sleep after 6 PM to skip the night (this also saves). Stay up past 4 AM and you pass out.

---

## Project layout

```
Assets/Scruff/
  Resources/Scruff/      Shaders (flat vertex-colour lit, text, transparent). In Resources so builds include them.
  Editor/ScruffSetup.cs  Creates the scene, adds it to Build Settings, names layers, Quest setup helper.
  Scripts/
    Core/        GameBootstrap (entry point), GameManager (flow, rent, busts), GameClock, GameState/SaveSystem,
                 GameSettings, TutorialSystem, Layers, GameEvents
    XR/          XRInput, GorillaLocomotion, PlayerRig, HandModel, PokeTip, DesktopRigController, DesktopInput
    Interaction/ Grabbable, PlayerHand, ItemSocket, ItemReceivers, PokeButton, HingeGrabbable, ItemDispenser, CashPickup
    Items/       ItemDefinition, ItemDatabase (every item), ItemFactory, Item, ProductCatalog (strains, effects,
                 mixing rules, value math), ProductContainer, Pourable
    Production/  PlantPot, PlantVisual, HarvestableBud, PackingTable, MixingStation, ChemStation, Sink, TrashCan
    Economy/     Wallet, Progression, ShopTerminal, TurfManager
    NPC/         NPCAgent (movement, animation, speech), CustomerNPC, PoliceNPC, CustomerProfile, DealSystem,
                 NPCManager, PointOfInterest, SpeechBubble, NameGenerator
    UI/          TextBlock (mesh text from the built-in font), UIFactory, PhoneUI, WristWatch, Notifications,
                 FloatingText, Beacon, ScreenFader, HandLabel, MainMenu, UIManager
    World/       WorldBuilder (the test neighbourhood), DayNightCycle, NavMeshBaker (runtime NavMesh), Bed, Geo
    Models/      MeshBuilder (flat-shaded low-poly mesh maker), ModelFactory (all item meshes), CharacterModel
    Audio/       SoundLibrary (every sound is synthesised), AudioManager
    Rendering/   ScruffMaterials, Palette, FX (particles)
```

The scene contains a single object with `GameBootstrap`. It builds the systems, the world, bakes the NavMesh at
runtime, spawns the player rig and UI, then hands control to `GameManager`. `Game` is a small static locator for the
running systems (`Game.Wallet`, `Game.Player`, `Game.Deals`...).

### Physics layers

| # | Name | Used for |
|---|---|---|
| 0 | Default | Solid world. The only layer gorilla locomotion pushes off. |
| 8 | PlayerBody | Player head/body colliders |
| 9 | PlayerHand | Reserved |
| 10 | Item | Physical items |
| 11 | NPC | NPC bodies |
| 12 | Interactable | Query-only colliders: buttons, dispensers, knobs, handles |

Collisions between these are configured in code (`Layers.ConfigurePhysics`), so you don't need to touch the
physics matrix.

---

## Extending it

- **New item:** add a `Register(new ItemDefinition { ... })` in `ItemDatabase.Init`. Give it a `Build` (mesh + colliders,
  usually from `ModelFactory`), a shop catalog, price and unlock rank. Add behaviour with `Configure`
  (e.g. `Pourable`, `ProductContainer`, or your own component).
- **New strain / product line:** add a `StrainDef` in `ProductCatalog.Init`. Seed packets for plant strains are generated
  automatically.
- **New mixing effect or rule:** `AddEffect` / `AddRule` in `ProductCatalog.Init`, then an additive item with `AddAdditive`.
- **Balance:** base values, grow times and yields are in `ProductCatalog`; rent, start cash in `GameManager`; rank XP in
  `Progression`; customer willingness in `CustomerProfile.MaxUnitPrice`.
- **Locomotion feel:** `GorillaLocomotion` fields (jump multiplier, max jump speed, velocity limit...) and `PlayerRig`
  (`standHeight` = how tall you stand, `handCollisionOffset`).
- **Hand model orientation:** `HandModel.Build` rotates the mitt for the OpenXR grip pose. If you use the Oculus
  XR plugin instead and the hands look rotated, adjust that rotation.
- **Real level art:** the gameplay only needs colliders on the Default layer, `PointOfInterest`s (homes, hangouts,
  meeting spots, patrol points) and the stations. Replace `WorldBuilder` piece by piece.

See [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) for the design notes and the multiplayer / turf wars plan.

## Credits

Gorilla locomotion is ported from [Another Axiom's GorillaLocomotion](https://github.com/Another-Axiom/GorillaLocomotion)
(MIT). See [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md).
