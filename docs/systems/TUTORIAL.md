# Tutorial

The tutorial is the player's first 30–40 minutes with Ledgway. It opens
the new-game wizard alongside a floating helper orb, walks the player
through the interface, coaches them through a few cargo loops, gives
them a taste of the stock exchange, and then steps aside. It also
hijacks the first combat encounter to explain the dice-roll panel
before the player has to read it cold.

The orb is a small 3D character that follows the cursor, occasionally
glances at whatever you're being told to click, and wanders when you
tab away. It's not just a tooltip with a face — its motion is part of
the affordance: where it's pointing tells you where the next action
lives.

> **Status:** implementation reference. Source of truth lives in:
> - `src/sim/tutorial.ts` — phase data, hint resolution, flavor text
> - `src/sim/types.ts` (`TutorialState`, `TutorialActionKind`)
> - `src/ui/components/TutorialController.tsx` — orchestrator
> - `src/ui/components/TutorialHelper.tsx` / `.css` — orb + bubble
> - `src/ui/components/TutorialOverlay.tsx` / `.css` — spotlight + dim
> - `src/ui/store.ts` — phase-transition actions

## Design principles

1. **Coach with engine, not script.** Every "do X next" instruction
   resolves through the same `getGuidedHint()` / `getStockExchangeHint()`
   the in-game suggestion system already uses. The tutorial doesn't
   know what to recommend on a station; it asks the engine and points
   at the result. New goods, new contract types, and new station kinds
   show up in the tutorial automatically.
2. **Don't auto-navigate.** When the player is on the wrong tab, the
   tutorial spotlights the tab button itself (every tab already wears a
   `.has-suggestion` pip) instead of switching for them. Clicking the
   tab is part of the lesson, not a sleight of hand. The interface tour
   is the one exception — it's explanatory rather than guided-by-action,
   so it pre-navigates between tabs to set the scene.
3. **Imperatives, not explanations.** Each step's body is a short
   instruction ("buy 8 grain"), not a paragraph about commodity
   markets. The flavor variants exist to keep the tone fresh across
   loops, not to teach.
4. **Always have a fallback orb.** If the engine returns `wait`, the
   player is at a shipyard, or the spotlight selector resolves to a
   missing element, the orb stays visible with a generic "catch your
   breath" message. Disappearing tutorial reads as broken tutorial.
5. **Single render path.** The controller resolves the current step
   into one config object and renders one `<TutorialHelper>` and one
   `<TutorialOverlay>` instance for the whole run. Without that, the
   model-viewer reinitialises on every step swap and the orb visibly
   "flips" between targets.

## Phase state machine

`TutorialState.phase` is the discriminator. Transitions are mostly
one-way; the only loops are within `cargo` (multiple buy/sell rounds)
and `exchange` (multiple trades).

```
                    new player
                        │
                        ▼
                    ┌────────┐
                    │ setup  │  pre-game wizard companion
                    └────┬───┘
                         │ confirmNewGame ⇒ pendingNewGame = null
                         ▼
                    ┌────────┐
                    │ tour   │  13 stops in INTERFACE_TOUR
                    └────┬───┘
                         │ last stop "Next" / Skip tour
                         ▼
                    ┌────────┐
                    │ cargo  │  N loops, hint-driven coaching
                    └────┬───┘
                         │ end-of-loop fork prompt
            ┌────────────┼────────────┐
            ▼            ▼            ▼
       continue       exchange     skip tutorial
       (loopGoal+1)      │             │
                         ▼             ▼
                    ┌────────┐     ┌─────────┐
                    │exchange│     │ skipped │
                    └────┬───┘     └─────────┘
                         │ TUTORIAL_EXCHANGE_TRADES reached
                         ▼
                    ┌────────────┐
                    │ farewell   │
                    └────┬───────┘
                         │ "Off I go"
                         ▼
                    ┌────────┐
                    │  done  │
                    └────────┘
```

There's also a **combat sub-tutorial** that runs orthogonally: any time
`world.pendingEncounter` fires while `tutorial.combatSeen === false`,
the controller takes over the helper to explain the encounter modal.
It auto-retires after one encounter regardless of whether the player
dismissed the rest of the tutorial.

## Setup phase — pre-game wizard

While `pendingNewGame` is non-null, the orb sits in the bottom-right
corner of the viewport (`fallbackPlacement: "bottom-right"`) and
swaps body text based on `pendingNewGame.phase`:

- `intro` — "Welcome aboard. Skim the cards and hit Continue."
- `pilot` — "Roll a name, pick traits, click reroll for a portrait."
- `syndicate` — "Each syndicate sets your colors and your starting
  station."

There's no spotlight overlay during setup — the new-game modal owns
its own dim backdrop, and stacking ours on top would obscure the
wizard. The helper's only escape hatch in setup is "Skip tutorial",
which flips straight to `skipped`.

When the wizard commits (`confirmNewGame` fires) and `pendingNewGame`
goes null, an effect in the controller calls `advanceTutorialSetup()`
to flip the phase to `tour`. The first interface-tour stop loads on
the next render with the freshly-built world behind it.

## Tour phase — interface walkthrough

`INTERFACE_TOUR` (`src/sim/tutorial.ts`) is a 13-stop array. Each stop
has:

- `selector` — CSS selector for the spotlit element, or `null` for
  full-dim "monologue" stops with no target
- `fullDim` — true when the whole screen should dim with no cutout
  (intro, transition stops)
- `title` / `body` — orb copy
- `focus` — optional info-panel keyword. `resolveTourFocus()` maps it
  to a `TutorialFocus` object that the controller pushes into the
  store, which pins the relevant card open in the side panel
- `switchTab` — optional main-tab id. The controller pre-navigates to
  this tab before the stop renders (the only place the tutorial
  auto-switches tabs)

The structure of the tour is roughly: full-dim intro → 5 UI callouts
(ship card / tabs / controls / settings / info area) → full-dim
transition → cargo flow preview. The full-dim stops use centered
helper placement; the spotlight stops use the spotlit element as the
anchor and let the helper drift to a side that fits.

The helper exposes three buttons during the tour:
- **Next** (green / advance) — bumps `tourStop`
- **Skip tour** (yellow) — `phase = "cargo"`, `tourStop = 0`
- **Skip tutorial** (red) — `phase = "skipped"`

## Cargo phase — engine-driven coaching

The cargo phase is the bulk of the tutorial. It runs `loopGoal`
buy/sell loops (default 3) before offering the end-of-loop fork.

Each render, the controller calls `resolveCargoHint(world, ship)`. The
result is a `ResolvedCargoHint`:

```ts
{
  hint: GuidedHint,        // raw engine output
  selector: string,        // CSS selector for the action target
  requiredTab: Tab,        // main tab the action lives on
  requiredFleetTab: FleetTab | null,   // fleet sub-tab if applicable
  title: string,           // localized step title
  body: string,            // imperative instruction
  focus: TutorialFocus | null,
}
```

The controller walks a series of gates before reaching the action
spotlight:

1. **Quick Travel callout** — if the ship is in transit and pilot is
   manual, spotlight the Quick Travel button with a snarky reminder.
2. **End-of-loop fork** — if `tutorialLoopsCompleted(world) >= goal`,
   show the fork prompt (continue / move to exchange / skip).
3. **Wrong main tab** — if `selectedTab !== "player"`, spotlight the
   Cargo tab.
4. **Shipyard fallback** — if the ship is idle at a shipyard
   (which sells blueprints, not goods), spotlight the travel panel.
   The engine doesn't know shipyards have no cargo to recommend.
5. **No engine recommendation** — if `cargoHint` is null (engine
   returned `wait` or empty), spotlight the travel panel with a
   "catch your breath" line.
6. **Wrong fleet sub-tab** — if `requiredFleetTab` is set and
   `fleetTab` doesn't match, spotlight the sub-tab button.
7. **The action itself** — finally, spotlight whatever element the
   selector resolves to (a buy row, a contract row, the refuel button,
   etc.).

### Buy-before-contract reorder

`route_plan` hints emit accept-contract, buy, and travel as a unit.
The default sort puts contracts first, but if a contract's good is
also in the planned buy list there's no point pinning the contract for
cargo the player doesn't have yet — `resolveHintTarget()` walks the
substeps in this order: accept (only for goods not in buy list) →
buy → accept (deferred ones now eligible) → travel. The same reorder
is mirrored in the engine itself (`src/sim/suggestions.ts`) so the
player's normal in-UI hints match.

### Manual ship contract auto-complete is off

For ships with `pilot === "manual"`, cargo-haul contracts no longer
auto-credit on full delivery. The player has to click **Collect**
explicitly. The tutorial covers this with a dedicated step
(`collectResolution()`), and `creditJobOnDelivery()` checks
`ship.pilot !== "manual"` before crediting. Auto-piloted fleet ships
behave as before.

### Manual `Skip section` and `Skip tutorial`

Every non-fork cargo stop carries `Skip section` (yellow → flip to
exchange) and `Skip tutorial` (red → `skipped`). The fork's
`Skip tutorial` re-uses the same red dismiss path.

## Exchange phase — stock coaching

`resolveStockHint(world, shipId)` wraps the stock suggestion engine
with a few filters:

- `watch` hints are filtered out (the player can't actually "watch"
  anything; the verb confuses).
- The hint's "primary action" maps to one of `buy` / `short` / `sell` /
  `cover` for the action spotlight.

Gate order in the controller:

1. Wrong main tab → spotlight Exchange tab.
2. No hint → spotlight the equities list with "watch the tape".
3. Equity hidden by kind filter → spotlight the matching kind tab
   (each kind tab already wears the existing `.has-suggestion` pip).
4. Row not selected → spotlight the equity row in the list.
5. Row selected → spotlight the actual trade button (buy/sell/etc.)
   with `data-tutorial-trade-action="..."`.

`guidedTradeEnabled` in the store also flips true while
`tutorial.phase === "exchange"`, which bypasses the navigator-50-action
gate and auto-fills the qty/price inputs from the engine's
recommendation. Brand-new players get full guided behaviour during
the tutorial regardless of the milestone unlock.

`TUTORIAL_EXCHANGE_TRADES` (= 3) trades complete the phase. When
`shouldExitExchangePhase(world)` returns true, the controller fires
`finishTutorial()` which moves to `farewell`.

## Combat sub-tutorial

The first encounter is a special case because:
- The encounter modal is its own UI with its own animations.
- The dice roll only takes ~1.2s — too fast to spotlight anything
  useful during the roll.
- Players genuinely want to read the resolution panel without the orb
  in the way.

The sub-tutorial runs whenever `world.pendingEncounter` is non-null
and `tutorial.combatSeen === false`, regardless of the main phase:

- **Stop 0**: full bubble, no spotlight. Intro monologue ("we got into
  a scuffle, want some tips?"). Two buttons: "Tips, please" and
  "I've got this" (skips combat tutorial).
- **Past intro**: switches on `encounterPhase` (a store-mirror of the
  modal's local state):
  - `choosing` → spotlight the recommended action card
    (`data-tutorial-encounter-recommended="true"`).
  - `rolling` → no spotlight, just an easter-egg line ("Don't blink.
    The dice gods are voting.").
  - `revealed` → spotlight the Continue button, body explains where
    to read the gain/loss summary.

When the encounter clears (`world.pendingEncounter` flips null while
the previous render had one), `finishCombatTutorial()` fires and
flips `combatSeen = true`. This branch is permanently retired after
that.

## Farewell + done

After exchange, the helper sits in centered placement, full-dim
overlay, with one body line and an "Off I go" button. Clicking it
calls `bidFarewell()` which sets `phase = "done"`. From then on the
controller renders nothing.

The Settings dropdown has a "Replay tutorial" entry that calls
`replayTutorial()` → `resetTutorial(world)` → `phase = "tour"`,
`tourStop = 0`. Replay starts at `tour`, not `setup`, since the
new-game wizard has already run.

## The orb

The orb is the visible part of the helper. It's 240×240px, contains a
`<model-viewer>` rendering `public/art/3d/robot4_tiny.glb`, and lives
above the spotlight overlay (z-index 1100 vs the overlay's 1000).

### Positioning

Two placement modes:

1. **Spotlit** — `lookAtSelector` resolves to an element. The helper
   measures the target rect (`useLayoutEffect` + `MutationObserver` +
   resize + 250ms poll) and picks a side: right preferred → left → fall
   back to the side with more room. The orb sits adjacent to the
   target on the chosen side; the bubble drops above or below the orb
   depending on which has more vertical room. The bubble overlaps the
   orb by `BUBBLE_GAP` (currently `-70px`) so the dialog's top edge
   sits right under the model's thrusters.
2. **Unspotlit** — no `lookAtSelector`. Two sub-modes:
   - `fallbackPlacement: "center"` (default) — orb + bubble centred
     on the viewport. Used by intro / transition / farewell stops.
   - `fallbackPlacement: "bottom-right"` — orb pinned to bottom-right
     corner with the bubble extending up-left. Used by the setup
     phase so the orb doesn't fight the centred new-game modal.

Position changes between targets animate with a 720ms
`cubic-bezier(0.65, 0, 0.35, 1)` easing — slow-in / slow-out, almost
sinusoidal. The bubble's transition is delayed 90ms so the orb leads
the bubble like a trailing companion. This is the "float between
targets" feel.

### Look-at behaviour

The model rotates by writing its `cameraOrbit` property
(`theta phi radius`). We don't write the model's `orientation`
because `model-viewer` 4.x's `ARRenderer.onUpdateScene` runs on every
orientation change and tries to add a menu panel to a null
`presentedScene` outside an active AR session. `cameraOrbit` skips
that path entirely.

`BASE_THETA = 90°` because the GLB's forward axis points along its
`+X` instead of the conventional `+Z`. `BASE_PHI = 86°` puts the
camera near eye-level with the model.

A `requestAnimationFrame` loop, mounted once on the helper, drives
target selection:

1. **Cursor tracking (default)** — `atan2(dx, FOCAL_DIST)` maps the
   cursor's screen position to a yaw/pitch offset around the base
   orbit, clamped to `±60° / ±35°`. `FOCAL_DIST = 350px` gives him
   meaningful turn even when the cursor is close to the orb.
2. **Intro gaze (on step swap)** — `introGazeAtRef` is bumped each
   time `title` or `lookAtSelector` changes. The loop holds the gaze
   on the spotlit element with a 280ms ease-in, 2000ms hold, 650ms
   ease-out before returning to cursor tracking.
3. **Distraction (every 25–35s)** — when a distraction fires, it
   randomly picks one of two goals: glance at the spotlit element, or
   "idle" (face forward, no offset from base orbit). Eases out (380ms)
   → holds (1500ms) → eases back (420ms). Distractions are gated to
   not fire during the intro window so they don't fight.
4. **Bored loop (page inactive, or no spotlight)** — when
   `document.hidden || !document.hasFocus()` or `lookAtSelector` is
   null, cursor tracking is short-circuited. Instead, a slow random
   wander picks a fresh target every 2.4–5.2s within `±30° / ±12°`
   and drifts toward it at half the active easing. Without this the
   orb would lock on whatever screen edge the cursor was parked at
   when the user tabbed away.

All transitions through these modes use a single 0.09 lerp so the
camera feel stays consistent regardless of which goal is currently in
charge.

## The spotlight overlay

`<TutorialOverlay>` is the dim layer. It renders one fixed-position
fullscreen div with:

- A radial gradient as `background`, centred on the cutout, that goes:
  - transparent at the cutout itself (radius = max(width, height) / 2 + padding)
  - `rgba(0,0,0,0.18)` 140px past the cutout — light "lit area" halo
  - `rgba(0,0,0,0.55)` at 55% of the viewport
  - `rgba(0,0,0,0.95)` at the corners
- A child `<div>` with `position: absolute` and a 1px accent ring +
  16px bloom shadow as the cutout's visible outline. A 2.8s pulse
  keyframe breathes the bloom intensity.

The cutout's CSS variables (`--tutorial-cutout-x`, `-y`, `-r`) come
from JS once the target's rect is measured. The dim is a property of
the overlay's background, not an inset shadow on the cutout — the
older shadow-based approach gave a uniform dim with no light gradient
near the target.

`fullDim` mode (no cutout, just a flat dim) is used for tour intro /
transition / farewell stops. It overrides the gradient with a flat
`rgba(0,0,0,0.42)` and a 240ms fade-in keyframe.

`interactive` toggles `pointer-events: auto` on the overlay so clicks
on the dim land on the helper instead of leaking through to the UI.
The cutout itself always passes clicks (`pointer-events: none`) so the
spotlit element stays clickable.

## Data attribute scheme

The tutorial reaches DOM elements via `data-tutorial-*` attributes.
Anything the tutorial spotlights or measures wears one. Conventions:

| attribute                              | example                                  | purpose                                      |
| --                                     | --                                       | --                                           |
| `data-tutorial="<key>"`                | `data-tutorial="cargo-list"`             | named region (cargo bay, info panel, etc.)   |
| `data-tutorial-buy-good="<goodId>"`    | `data-tutorial-buy-good="grain"`         | a specific market row                        |
| `data-tutorial-sell-good="<goodId>"`   | `data-tutorial-sell-good="grain"`        | a specific cargo row                         |
| `data-tutorial-travel-to="<locId>"`    | `data-tutorial-travel-to="kepler-3"`     | a travel-panel destination                   |
| `data-tutorial-accept-job="<jobId>"`   |                                          | a contract accept row                        |
| `data-tutorial-collect-job="<jobId>"`  |                                          | a contract collect button                    |
| `data-tutorial-equity="<equityId>"`    |                                          | an equity list row                           |
| `data-tutorial-stock-kind="<kind>"`    |                                          | a kind-filter tab                            |
| `data-tutorial-trade-action="<action>"`| `data-tutorial-trade-action="buy"`       | the inline order panel's buy/sell buttons    |
| `data-tutorial-fleet-tab="<tab>"`      | `data-tutorial-fleet-tab="contracts"`    | a fleet sub-tab button                       |
| `data-tutorial-encounter-action`       |                                          | encounter modal action card                  |
| `data-tutorial-encounter-recommended`  |                                          | encounter modal recommended card             |

The selectors used in `tutorial.ts` resolution functions are full CSS
selectors built from these attributes (e.g.,
`` `[data-tutorial-buy-good="${good}"]` ``).

## Persistence

`TutorialState` lives on `world.player.tutorial` and is saved with
the rest of the world. Every store action that mutates phase (advance,
skip, dismiss, replay, etc.) calls `persistCurrentGame()` so the
player can close the tab mid-tour and resume. Reads are guarded with
`!tutorial?` checks because the field is optional on `Player`
(legacy saves without it just render nothing — they're past the
tutorial by definition).

## Why a single render path

The controller resolves the current step into one `RenderConfig`
object and renders one `<TutorialHelper>` and one `<TutorialOverlay>`
for the whole run. This wasn't the original structure — initially
every conditional branch returned its own JSX with fresh component
instances. The orb visibly "flipped" between stops because:

1. `<model-viewer>` re-initialised the GLB on every mount, briefly
   showing its loading state.
2. The bubble's `tutorial-helper-bubble-in` fade-in animation replayed.
3. The orb's drift state (current orientation, distraction timer,
   intro-gaze timestamp) reset to defaults.

Hoisting to a single render path lets React reconcile in place — only
props change, the underlying instances stay mounted, and the orb's
internal animation state carries across phase transitions.

## Tunables

Most numbers live as constants near the top of their owning file. The
ones most often touched:

| const                    | file                            | value     | what it controls                          |
| --                       | --                              | --        | --                                        |
| `TUTORIAL_DEFAULT_LOOPS` | `src/sim/tutorial.ts`           | 3         | cargo-loop count before fork              |
| `TUTORIAL_EXCHANGE_TRADES` | `src/sim/tutorial.ts`         | 3         | exchange-phase trade count to finish      |
| `BUBBLE_GAP`             | `src/ui/components/TutorialHelper.tsx` | -70 | overlap of bubble onto orb (negative)     |
| `ORB_GAP`                | `src/ui/components/TutorialHelper.tsx` | 23  | distance from target edge to orb edge     |
| `ORB_Y_OFFSET`           | `src/ui/components/TutorialHelper.tsx` | -20 | extra vertical nudge for the model        |
| `EASING`                 | inside the rAF loop             | 0.09      | head-turn lerp factor                     |
| transition duration      | `TutorialHelper.css`            | 720ms     | orb/bubble drift between targets          |
| distraction interval     | inside the rAF loop             | 25–35s    | how often a glance/idle pose fires        |
