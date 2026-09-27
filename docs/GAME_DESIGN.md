# Scruff - design notes

*Schedule One's production/dealing loop + Rust's "other players are the threat", played as a Gorilla Tag monke.*

## Pillars

1. **Everything is physical.** No inventory screens. You carry things in your hands (and two belt holsters),
   pour soil by tipping the bag, pick buds off the plant, hand the bag to the customer, grab the cash out of their hand.
2. **Movement is the skill.** Gorilla locomotion means escaping cops, reaching meeting spots and (later) raiding rival
   stashes are about how well you move. Buildings, dumpsters, fences and the jungle gym are all climbable on purpose.
3. **Start with nothing.** $80, one pot, three seeds, rent due Sunday.
4. **People, not vending machines.** Customers have homes, schedules, tastes, standards, budgets, addiction and a
   relationship with you. They talk, react and remember.

## Core loop (what's built)

```
 buy seeds/soil ─► grow (soil → seed → water → wait → pick)
        ▲                          │
        │                          ▼
   shop / unlocks           package (baggie / jar) ──► mix (optional, +effects/+value)
        ▲                          │                         cook crystal (rank 2)
        │                          ▼
     cash + XP  ◄──── sell (deal requests, walk-ups, samples)  ◄── set markup
                                   │
                         police heat / turf influence
```

### Growing (`PlantPot`)
- Soil fills the pot (a bag holds 3 pots). A seed that lands on full soil is planted.
- Growth is continuous and visible (24 mesh steps, buds swell from 70% growth).
- Growth needs water (> 5%), otherwise it crawls at 15% speed. Water drains over ~8 in-game hours.
- **Quality** = 0.28 + 0.42 × (time well watered) + 0.28 × (time fertilized) ± a little luck.
- Yield: strain min..max buds, +1 if quality > 0.7. Picking the last bud clears the pot (soil used up).

| Strain | Base $/unit | Grow time | Yield | Seeds | Rank |
|---|---|---|---|---|---|
| Backyard Green | 18 | 5 h | 4-6 | $15 | 0 |
| Alley Purple | 28 | 7 h | 4-7 | $30 | 1 |
| Midnight Gold | 42 | 9 h | 5-8 | $55 | 3 |
| Blue Crystal (cooked) | 55 | 50 min cook | 5 | $65 in ingredients | 2 |

### Quality tiers
Trash < 0.2 ≤ Poor < 0.4 ≤ Standard < 0.6 ≤ Premium < 0.8 ≤ Heavenly. Value multiplier = 0.6 + 0.8 × quality.

### Mixing (`MixingStation`, `ProductCatalog`)
Each additive adds its effect (max 4). Some existing effects transform when a certain additive is added
(e.g. Chill + Energizing → Paranoid, Giggly + Chill → Smooth, Energizing + Giggly → Euphoric). Effects add a %
to value; the top effect names the product ("Zippy Backyard Green"). The station screen previews the result and
the price change before you commit.

### Cooking (`ChemStation`)
Blue Syrup + Fizz Salt → press START → keep the heat needle in the green band with the knob. The flame drifts, so
you have to keep adjusting. Cold = slow, too hot = burnt (lower quality and yield).

### Selling (`CustomerNPC`, `DealSystem`)
- **Deal requests**: contacts text you (daytime, when craving). Accept within 90 min, then meet within 3 h at the named
  spot. Missing a deal hurts the relationship.
- **Walk-ups**: hand packaged product to a contact who's craving. Holding it near them previews their reaction.
- **Samples**: strangers take a free bag. Score = quality ± family match + liked effects + luck vs their standards.
  Pass → new contact. Fail → they won't try again for a day.
- **Willingness**: `max $/unit = value × wealth × (1 + 0.3 × relationship) × (1 + 0.35 × addiction) × 1.12 per liked effect
  × 0.85 if not their favourite family × 1.1 on your turf`.
- **Referrals**: a happy customer may introduce a friend after a completed deal.
- Every sale builds addiction (crystal much faster), relationship (by quality vs expectations) and turf influence.

### Police (`PoliceNPC`)
Patrol → Suspicious ("?") → Chase ("!") → Search → back to patrol.
- Suspicion builds while they can see product in your hands (faster up close and at night) and when they witness a deal.
- Chasing cops call nearby officers. They catch you within ~1.3 m unless you're more than 1.4 m above them.
- Home is a safe zone. Busted = lose carried product (hands and holsters), 25% cash fine (min $20), lose 2 hours.

### Money & progression
- Weekly rent $150 (missed rent becomes debt, taken automatically as soon as you have it).
- Ranks: Street Rat → Corner Kid (120 XP) → Hustler (400) → Dealer (900) → Supplier (1800) → Plug (3200) → Kingpin (5500).
- XP: sale ≈ price/3, deal completed +10, new customer +25, cook +15, mix +3/unit, plant/harvest +2, package +1.

### Time
1 real second = 1 game minute by default. Sleep from 6 PM (skips to 7 AM, saves). Awake at 4 AM → pass out, wake at
home missing 10% of your cash.

## Multiplayer & turf wars (next)

The code is single-player today but is laid out for it:

- **Networking**: Gorilla Tag and most fan games use **Photon** (PUN 2 or Fusion). Recommended: Photon Fusion (shared mode)
  for low-latency hands/heads, or PUN 2 for simplicity.
- **Players**: sync head + both hand followers (the resolved `GorillaLocomotion` hand positions) plus a body model.
  Locomotion stays fully local (like GT).
- **Items**: add a network id to `Item`; grabbing requests ownership (`Grabbable.BeginGrab` is the hook), the owner
  simulates it. Items in apartments belong to their owner.
- **NPCs**: simulate on the master client, sync position/state. Deals stay per-player (they're text messages to *your* phone).
- **Turf** (`TurfManager`): influence is already stored per zone; key it by player/crew id and sync it. Zone owner = highest
  influence above 50%. Ideas for the "war" part:
  - Selling in someone else's turf steals influence; their customers there pay you less.
  - **Crews**: players join a crew and share turf, stash and income split.
  - **Raids** (the Rust part): break into rival stashes/grow rooms; home safe-zones only protect you from NPC police.
  - Spray tags / flags to contest zones; contested zones get more police heat.
- **Apartments**: each joining player gets their own unit (the apartment builder is already self-contained; stamp one per
  player) or starts homeless and has to buy/rent one.

## Also next

- Real art pass (the procedural models are placeholders designed to be replaced one prefab at a time).
- More production: drying rack, grow lights/tents with bonuses, automation (hire a botanist/cook like Schedule One).
- Money laundering / property upgrades (move from the apartment to a house, then a warehouse).
- Rival NPC dealers competing for customers and turf.
- Bigger map with districts that have different wealth, police presence and tastes.
