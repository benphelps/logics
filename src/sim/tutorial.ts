// Onboarding tutorial state machine. The helper-orb UI reads from here to
// know what to surface; the spotlight reads `selector` to find the DOM
// target; incrementManualActions writes back into world.player.tutorial
// so phase-exit predicates can fire.
//
// The tutorial has three live phases after the interface tour:
//   - cargo:    hint-driven coaching over getGuidedHint(). Whatever the
//               engine recommends right now is what the orb says +
//               which UI element gets the spotlight.
//   - exchange: same idea but reads the stock suggestion engine so the
//               player learns the equity tab.
//   - done:     orb is gone.
// The cargo→exchange transition fires once the player has done a buy +
// sell (the trade loop). exchange→done fires after the first stock
// trade. Both phases are skippable.
//
// We deliberately don't gate the stock engine on having a navigator —
// the navigator unlocks "guidance hints in the UI" at 50 actions, but
// the suggestion *engine itself* is always available, and the tutorial
// uses it directly so a brand-new player still gets coached on stocks.

import type { GoodId, LocationId, Trader, World } from "./types";
import { getGuidedHint, hintTarget, type GuidedHint } from "./suggestions";
import { findRoutePath } from "./geometry";
import { listLocalJobs } from "./jobs";
import { getStockExchangeHint, type StockExchangeHint } from "./stock/suggestions";

export type { TutorialActionKind } from "./types";

// What the orb wants the info panel to display for the current step.
// Lifted to a store slice so DockedView can override its local pinned-
// focus stack — pinning a good when a buy is suggested teaches the
// player to read the "route profit" panel; pinning the current station
// during a sell teaches them to read the local-best-price panel.
export type TutorialFocus =
  | { kind: "good"; good: GoodId; source: "market" | "cargo" }
  | { kind: "station"; loc: LocationId; source: "station" | "travel" }
  | null;

export interface InterfaceTourStop {
  id: string;
  // Raw CSS selector for the element to spotlight, or null for stops
  // that just dim the screen and let the orb monologue.
  selector: string | null;
  title: string;
  // Body text shown in the helper bubble. Supports a tiny markdown
  // subset rendered by formatTutorialBody — **bold**, *italic*,
  // paragraph breaks (blank line), and `- ` bullet lists.
  body: string;
  // Spoken-aloud version with v3 audio tags ([amused], [curious], etc.),
  // ALL CAPS for emphasis, ellipses/em-dashes for pacing. Numbers are
  // spelled out so ElevenLabs Flash/Multilingual variants don't mangle
  // them. Generation script reads this; UI never displays it.
  tts: string;
  // When true, render a flat full-screen dim with no cutout. Used by
  // intro / transition stops that have no specific spotlight target.
  fullDim?: boolean;
  // Optional pre-tour side effects: switch tabs / sub-tabs so the spotlit
  // element is actually mounted. Keep these limited to UI navigation —
  // never mutate world state from the tour.
  switchTab?: "player" | "stocks" | "markets" | "locations" | "charters";
  // Optional info-panel focus to pin while this tour stop is active.
  // Used for stops that point inside the info panel — those sections
  // only render when the panel is showing the matching entity type
  // (a good or a station). The controller resolves the focus at render
  // time using the current ship/location so the targets always exist.
  focus?: "currentStation" | "anyCargoGood" | "anyMarketGood";
}

// Selectors are raw CSS now — TutorialOverlay passes them straight to
// document.querySelector. Tour stops use the static [data-tutorial="..."]
// markers; action phases compose attribute queries from suggestion-engine
// output (e.g. [data-tutorial-buy-good="parts"]).
const TUT = (name: string) => `[data-tutorial="${name}"]`;

// Tour structure:
//   1) intro             — full dim, the orb introduces itself
//   2) ship-selector     — top-bar fleet picker
//   3) main tabs         — view switcher
//   4) tick + speed      — the universe heartbeat + speed presets
//   5) music + settings  — saves, music, replay tutorial
//   6) main game area    — the active view container
//   7) transition        — full dim, fourth-wall jab and segue
//   8) cargo panel       — "the goods bay"
//   9) markets panel     — buy/upgrade/hire/contracts pickup
//  10) info panel intro  — overview of the right-column reader
//  11) station sell row  — Market pressure section, station-focused
//  12) product sell row  — Market signals section, good-focused
//  13) travel panel      — fly-to neighbours
// After that the action coaching takes over (3 buy/sell loops).
// First-time-mechanic intros: longer, voiced explanations that fire the
// FIRST time the engine surfaces a given action (e.g., the player's
// first contract, first refuel, first stock trade). After the player
// completes the action once, perTypeCount flips and we revert to the
// snappy one-line flavor copy in `currentFlavor()`. Each intro has a
// stable id used both to key `seenIntros` and to look up the matching
// audio clip under public/audio/tutorial/<id>.ogg.
export interface TutorialIntro {
  id: string;
  title: string;
  // Markdown body, same subset as InterfaceTourStop.body.
  body: string;
  // Voiced version with v3 audio tags. Numbers spelled out.
  tts: string;
}

export const TUTORIAL_INTROS: Readonly<Record<string, TutorialIntro>> = {
  nextBuy: {
    id: "intro-next-buy",
    title: "Next: buying",
    body:
      "Next we'll learn about **buying**. Click the highlighted tab to open the cargo panel.",
    tts:
      "[amused] Next we'll learn about buying. Click the highlighted tab to open the cargo panel.",
  },
  nextSell: {
    id: "intro-next-sell",
    title: "Next: selling",
    body:
      "Next we'll learn about **selling**. Click the highlighted tab to open the cargo panel.",
    tts:
      "[amused] Next we'll learn about selling. Click the highlighted tab to open the cargo panel.",
  },
  buy: {
    id: "intro-buy",
    title: "Your first buy",
    body:
      "This is where the cargo loop starts.\n\n" +
      "Every station **produces** some goods cheap and **consumes** others at a premium. The spotlit row is the cheapest thing the engine thinks you can flip for a profit somewhere nearby.\n\n" +
      "Each purchase becomes a **lot** — quantity, price, station of origin, the tick you bought it. Lots never merge, so your cost basis stays honest across mixed buys. Credits come straight out of the ship's wallet; you can't buy what you can't afford.\n\n" +
      "Click the highlighted buy button to load up.",
    tts:
      "[amused] This is where the cargo loop starts. [curious] Every station produces some goods cheap and consumes others at a premium. The spotlit row is the cheapest thing the engine thinks you can flip for a profit somewhere nearby… Each purchase becomes a lot — quantity, price, station of origin, the tick you bought it. Lots never merge, so your cost basis stays honest. [mischievously] Click the highlighted buy button to load up.",
  },
  sell: {
    id: "intro-sell",
    title: "Your first sale",
    body:
      "Time to cash out.\n\n" +
      "When you sell, the oldest **lot** leaves first and the proceeds settle straight into the ship's wallet. The price depends on how badly this station wants the good — empty warehouse means premium prices, full warehouse means a discount.\n\n" +
      "Glance at the **Market pressure** row in the right panel before clicking. If the good in your hold is listed as *begging to import*, you're golden. If not, the price will sting.\n\n" +
      "Click the highlighted row to sell.",
    tts:
      "[amused] Time to cash out. [curious] When you sell, the oldest lot leaves first and the proceeds settle straight into the ship's wallet. The price depends on how badly this station wants the good — empty warehouse means premium prices, full warehouse means a discount. [mischievously] Glance at the market pressure row before clicking. If the good in your hold is listed as begging to import, you're golden. If not, the price will sting. [amused] Click the highlighted row to sell.",
  },
  refuel: {
    id: "intro-refuel",
    title: "First refuel",
    body:
      "Time to top up the tank.\n\n" +
      "Fuel burns all at once on **departure**, based on trip distance and your engine's efficiency. The travel panel won't let you launch if the tank can't cover the next hop — so you'll never strand mid-route, but you can absolutely get stuck dockside if you ignore the gauge.\n\n" +
      "A couple of details:\n" +
      "- Ships have a **fuel preference list** and pick the cheapest compatible type they can buy locally. You don't normally have to think about which fuel — just *that* you need some.\n" +
      "- Switching fuel types **dumps** any incompatible residual. Don't swap mid-tank if you're trying to save credits.\n" +
      "- Refuels come straight out of the ship's wallet, like everything else.\n\n" +
      "Click the highlighted refuel button to fill up.",
    tts:
      "[amused] Time to top up the tank. [curious] Fuel burns all at once on departure, based on trip distance and your engine's efficiency. The travel panel won't let you launch if the tank can't cover the next hop — so you'll never strand mid-route, but you can absolutely get stuck dockside if you ignore the gauge. [mischievously] Refuels come straight out of the ship's wallet, like everything else. [amused] Click the highlighted refuel button to fill up.",
  },
  combatIntro: {
    id: "combat-intro",
    title: "First contact",
    body:
      "Looks like we ran into someone.\n\n" +
      "The encounter modal **pauses the universe** while you decide. You'll see who flagged you down, what they want, and three options: **Fight**, **Flee**, **Negotiate**. Each shows your odds and the concrete cost if it flops.\n\n" +
      "The engine highlights its pick — usually flee, since it's the cheapest \"lose\" outcome. But the call's yours. Want a walkthrough of the three choices?",
    tts:
      "[amused] Looks like we ran into someone. [curious] The encounter modal pauses the universe while you decide. You'll see who flagged you down, what they want, and three options — Fight, Flee, Negotiate. Each shows your odds and the concrete cost if it flops. [mischievously] The engine highlights its pick — usually flee, since it's the cheapest \"lose\" outcome. But the call's yours. Want a walkthrough of the three choices?",
  },
  combatChoosing: {
    id: "combat-choosing",
    title: "Pick your move",
    body:
      "Three choices, each with **fuzzy odds** — very likely, likely, even, risky, longshot — and a concrete cost line if it goes wrong.\n\n" +
      "- **Fight** — best with a *mercenary* aboard or a beefy hull. Win: drive them off clean. Lose: hull damage and cargo gone (lightest items first).\n" +
      "- **Flee** — best with a fast, lightly-loaded ship. Win: outrun them untouched. Lose: a few hull scratches on the way out.\n" +
      "- **Negotiate** — bribe your way out with credits or partial cargo. Best with decent reputation. Cleanest exit if it works; collapses to the worst case if it doesn't.\n\n" +
      "The highlighted card is the engine's pick. Trust it or don't — but pick something.",
    tts:
      "[curious] Three choices, each with fuzzy odds and a concrete cost line if it goes wrong. [mischievously] The highlighted card is the engine's pick. Trust it or don't — but pick something.",
  },
  combatRevealed: {
    id: "combat-revealed",
    title: "Read the damage",
    body:
      "The panel above tells you what just happened — your choice, the roll, the outcome.\n\n" +
      "Read the **gains** (cargo recovered, credits earned), the **losses** (cargo gone, credits paid), and any **hull damage**. Hull repairs cost credits at any docked station; until you pay, the bar in your ship card stays dim. Cargo loss goes lightest-first, so a hold full of fuel cells suffers less than one full of bullion.\n\n" +
      "Hit **Continue** to resume the trip.",
    tts:
      "[curious] The panel above tells you what just happened — your choice, the roll, the outcome. Read the gains, the losses, and any hull damage. Hull repairs cost credits at any docked station; until you pay, the bar in your ship card stays dim. [amused] Cargo loss goes lightest-first — so a hold full of fuel cells suffers less than one full of bullion. [mischievously] Hit Continue to resume the trip.",
  },
  nextContract: {
    id: "intro-next-contract",
    title: "Next: contracts",
    body:
      "Next we'll learn about **contracts**. Click the highlighted tab to open the contracts panel.",
    tts:
      "[amused] Next we'll learn about contracts. Click the highlighted tab to open the contracts panel.",
  },
  nextCollect: {
    id: "intro-next-collect",
    title: "Next: collect",
    body:
      "Time to **collect your payout**. Click the highlighted tab to open the contracts panel.",
    tts:
      "[amused] Time to collect your payout. Click the highlighted tab to open the contracts panel.",
  },
  contract: {
    id: "intro-contract",
    title: "Your first contract",
    body:
      "A **contract** is a named, deadlined job posted by a station or a stranded captain. *\"Haul forty grain to Haven by tick six thousand, payout twelve hundred credits.\"* Stuff like that. Take it, do the run, and you'll earn more than you would on the open market — plus a little reputation with the destination's syndicate while you're at it.\n\n" +
      "A few flavours:\n" +
      "- **Shortage hauls** — bring goods to a station that's running low.\n" +
      "- **Rescues** — deliver fuel to a captain who's stuck out somewhere.\n" +
      "- **Trade settlements** — when you close a stock position, the cheque shows up here as a *\"go pick up your money\"* job.\n\n" +
      "The big idea: contracts pay you a **bonus** on top of a trade you'd already be doing. The one I've spotlighted lines up with our current move. Taking it costs nothing and pays extra. Click the highlighted row to accept.",
    tts:
      "[amused] A contract is a named, deadlined job posted by a station or a stranded captain. [curious] Take it, do the run, and you'll earn more than you would on the open market — plus a little reputation with the destination's syndicate while you're at it. [mischievously] The big idea: contracts pay you a BONUS on top of a trade you'd already be doing. The one I've spotlighted lines up with our current move. [amused] Click the highlighted row to accept.",
  },
} as const;

// Audio-only cues: short voiced one-liners played over the engine's
// own body copy. Unlike TUTORIAL_INTROS, cues don't override the bubble
// title/body — the bubble keeps the engine's snappy, dynamic copy
// (e.g., "Buy 12 grain"), and the cue rides on top as a personality
// nudge. Fires once per condition (gating lives in the controller).
export interface TutorialCue {
  id: string;
  tts: string;
}

export const TUTORIAL_CUES: Readonly<Record<string, TutorialCue>> = {
  buyFill: {
    id: "cue-buy-fill",
    tts: "[amused] Go ahead and buy the remaining suggested goods. Always a full cargo bay!",
  },
  departure: {
    id: "cue-departure",
    tts: "[amused] Hold's loaded — time to head out! Click the highlighted destination to launch.",
  },
  quickTravel: {
    id: "cue-quick-travel",
    tts: "[mischievously] Don't feel like watching the timer tick down? Hit quick-travel to skip straight to arrival.",
  },
} as const;

// Title strings produced by the action-specific resolutions below.
// Re-exported as constants so the controller can match on them without
// stringly-typed comparisons sprinkled through render code.
export const TUTORIAL_HINT_TITLE_BUY = "Buy low";
export const TUTORIAL_HINT_TITLE_SELL = "Sell high";
export const TUTORIAL_HINT_TITLE_TRAVEL = "Fly";
export const TUTORIAL_HINT_TITLE_REFUEL = "Refuel";
export const TUTORIAL_HINT_TITLE_ACCEPT = "Take a contract";
export const TUTORIAL_HINT_TITLE_COLLECT = "Collect";

export const INTERFACE_TOUR: readonly InterfaceTourStop[] = [
  {
    id: "intro",
    selector: null,
    fullDim: true,
    title: "Welcome aboard",
    body:
      "Hey. I'm your friendly orb-shaped tour guide.\n\n" +
      "Here's the deal: Ledgway is a logistics game. You buy cargo cheap at one station, fly it somewhere it's worth more, and pocket the difference. The whole universe runs on a heartbeat called a **tick** — every station produces, consumes, and reprices once per tick, every NPC takes their turn, every event you'll see ripples out from there.\n\n" +
      "I'll walk you through the interface first — every panel, every button. Then I'll spotlight a few cargo runs so you can feel the loop. Bail any time with **Skip tutorial**. I won't take it personally. Much.",
    tts:
      "[amused] Hey. I'm your friendly orb-shaped tour guide… Here's the deal: Ledgway is a logistics game. You buy cargo cheap at one station, fly it somewhere it's worth more, and pocket the difference. The whole universe runs on a heartbeat called a tick. [curious] I'll walk you through the interface first. Then I'll spotlight a few cargo runs so you can feel the loop. [mischievously] Bail any time. I won't take it personally. Much.",
    switchTab: "player",
  },
  {
    id: "ui-ship",
    selector: TUT("ship-selector"),
    title: "Ship selector",
    body:
      "Your active ship lives here.\n\n" +
      "Right now you've got one — a starter hauler with a small hold, a modest tank, and a wallet of its own. Ships in Ledgway are *financially independent*: each hull has its own cargo, its own funds, its own crew. When you eventually buy a second one, this selector is how you swap which captain you're micromanaging.\n\n" +
      "The little stat row underneath is hull, cargo capacity, and fuel — your three \"am I about to do something stupid?\" gauges.",
    tts:
      "Your active ship lives here. [curious] Ships in Ledgway are financially independent: each hull has its own cargo, its own funds, its own crew. When you eventually buy a second one, this selector is how you swap which captain you're micromanaging. [amused] The stat row is hull, cargo capacity, and fuel — your three \"am I about to do something stupid\" gauges.",
    switchTab: "player",
  },
  {
    id: "ui-tabs",
    selector: TUT("view-tabs"),
    title: "Main tabs",
    body:
      "The five top-level views.\n\n" +
      "- **Cargo** — your ship, your hold, the local market, and where to fly. You'll spend most of your life here.\n" +
      "- **Exchange** — the stock market layered on top of the world. Stations, syndicates, commodities, futures. The long game.\n" +
      "- **Markets** — every station's prices in one giant cross-reference. Read it like a map, find the gaps, exploit them.\n" +
      "- **Atlas** — the sector map. Who controls what, where the lanes run, who's mad at whom.\n" +
      "- **Ledger** — your captain's diary. Every buy, sell, fight, and faction shift. Search it later when you can't remember why you went broke.",
    tts:
      "The five top-level views. [curious] Cargo — your ship, your hold, the local market, and where to fly. Exchange — the stock market layered on top of the world. The long game. Markets — every station's prices in one giant cross-reference. Find the gaps, exploit them. Atlas — the sector map. Who controls what, who's mad at whom. [amused] Ledger — your captain's diary. Search it later when you can't remember why you went broke.",
    switchTab: "player",
  },
  {
    id: "ui-controls",
    selector: TUT("game-controls"),
    title: "Tick & game controls",
    body:
      "The universe runs on **ticks** — single moments of game-time where everything happens at once, in a fixed order.\n\n" +
      "The number on the left is the heartbeat. Right of it: **pause**, **step one tick**, **real-time**, and a few fast-forward presets. Same starting world plus same actions always lands you in the same place — which is what makes saves trustworthy, and why the game is perfectly happy if you walk away mid-flight and come back tomorrow.\n\n" +
      "Pro tip: when something interesting is happening, slow it down. When you're refuelling for the third time at a backwater outpost… crank it up.",
    tts:
      "The universe runs on ticks… The number on the left is the heartbeat. Right of it: pause, step one tick, real-time, and fast-forward presets. [curious] Same starting world plus same actions always lands you in the same place — which is what makes saves trustworthy. [mischievously] Pro tip: when something interesting is happening, slow it down. When you're refuelling for the third time at a backwater outpost… crank it up.",
    switchTab: "player",
  },
  {
    id: "ui-settings",
    selector: TUT("settings-buttons"),
    title: "Music & settings",
    body:
      "Two utility buttons.\n\n" +
      "The notes button hides a **tracker** — proper retro chiptune, fully shippable in a logistics game about hauling crates through space. Don't @ me.\n\n" +
      "The menu button is your save slots, new game, options, and yes — a **Replay tutorial** option for when nostalgia hits. Auto-save runs every tick, so a refresh never costs more than a moment of progress.",
    tts:
      "Two utility buttons… The notes button hides a tracker — proper retro chiptune. [sarcastic] Don't at me… The menu button is your save slots, new game, options, and yes — a \"Replay tutorial\" option for when nostalgia hits. [amused] Auto-save runs every tick, so a refresh never costs more than a moment.",
    switchTab: "player",
  },
  {
    id: "ui-game-area",
    selector: TUT("game-area"),
    title: "Main game area",
    body:
      "Everything the active tab shows lives in this rectangle.\n\n" +
      "Switch tabs and the whole view swaps in. Most of what we'll cover next happens here — the cargo bay, the markets, the info panel, the travel options. Keep an eye on it.",
    tts:
      "Everything the active tab shows lives in this rectangle… Switch tabs and the whole view swaps in. Most of what we'll cover next happens here. [amused] Keep an eye on it.",
    switchTab: "player",
  },
  {
    id: "transition",
    selector: null,
    fullDim: true,
    title: "Enough chrome",
    body:
      "Ohh, I love shiny chrome. But we don't *haul* shiny chrome — we haul actual cargo.\n\n" +
      "Now let's get on to some space truckin'. Next up: the four panels you'll be living inside.",
    tts:
      "[amused] Ohh, I love shiny chrome. But we don't haul shiny chrome — we haul actual cargo. [mischievously] Now let's get on to some space truckin'.",
    switchTab: "player",
  },
  {
    id: "cargo",
    selector: TUT("cargo-panel"),
    title: "Cargo bay",
    body:
      "Your hold.\n\n" +
      "Every purchase is remembered as a **lot** — quantity, price, station of origin, the tick you bought it. Lots never merge, so the cost basis of every good is honest. The card shows a weighted average, but the truth underneath is \"I bought twelve grain at fourteen and eight more at eighteen — selling above sixteen still profits.\"\n\n" +
      "When you sell, the oldest lot leaves first. This panel's also where you fire crew, second-guess your upgrade choices, and stare wistfully at goods you haven't unloaded yet.",
    tts:
      "Your hold. [curious] Every purchase is remembered as a lot — quantity, price, station of origin, the tick you bought it. Lots never merge, so the cost basis of every good is honest… When you sell, the oldest lot leaves first. [amused] This panel's also where you fire crew, second-guess your upgrade choices, and stare wistfully at goods you haven't unloaded yet.",
    switchTab: "player",
  },
  {
    id: "markets",
    selector: TUT("markets-panel"),
    title: "Markets",
    body:
      "The station's wares — what they make, what they need, the price they're asking right now.\n\n" +
      "Stations *produce* some goods locally and *consume* others. **Producers** are cheap — they've got stockpiles. **Consumers** are expensive — they're hungry. The whole game is: find a place that makes X cheap, find another place that needs X badly, fly between them.\n\n" +
      "Prices ease toward their target instead of snapping, so a single trade won't whiplash the market. But they *will* drift if you keep hammering the same route.\n\n" +
      "Buy low. Sell high. The whole game in three syllables.",
    tts:
      "The station's wares — what they make, what they need, the price they're asking right now. [curious] Producers are cheap — they've got stockpiles. Consumers are expensive — they're hungry. The whole game is: find a place that makes X cheap, find another place that needs X badly, fly between them. [amused] Buy low. Sell high. The whole game in three syllables.",
    switchTab: "player",
  },
  {
    id: "info-panel",
    selector: TUT("info-panel"),
    title: "Info panel",
    body:
      "The right column reads your mind.\n\n" +
      "Hover any good, ship, station, or contract — the panel below fills in. Stats, recent trades, profit estimates, and (once you've hired a Navigator) one-line action cues like *\"Buy twelve grain → fly to Ironhold → sell. Net three thousand two hundred credits.\"*\n\n" +
      "Without a Navigator the panel still works as a reference — you just won't get the **verb**. Hire one as soon as you can afford it. It's the single biggest \"aha\" moment in the game.",
    tts:
      "The right column reads your mind. Hover any good, ship, station, or contract — the panel below fills in. Stats, recent trades, profit estimates, and once you've hired a navigator, one-line action cues. [curious] Without a navigator, the panel still works as a reference — you just won't get the verb. [mischievously] Hire one as soon as you can afford it. It's the single biggest \"aha\" moment in the game.",
    switchTab: "player",
  },
  {
    id: "info-station-sell",
    selector: TUT("info-station-pressure"),
    title: "What sells here",
    body:
      "The **Market pressure** row tells you which goods this station is *desperate* for and which ones they're drowning in.\n\n" +
      "Stations love surplus — when their warehouse is empty, prices spike and they'll pay above market. They hate excess — when it's overflowing, prices crater. This row sorts the local goods into \"begging to import\" and \"please, take it off our hands.\"\n\n" +
      "Glance here before every sell. If the thing in your hold isn't on the *want* list, you'll get bottom-of-band prices.",
    tts:
      "The market pressure row tells you which goods this station is desperate for and which ones they're drowning in. [curious] Stations love surplus — when their warehouse is empty, prices spike and they'll pay above market. They hate excess — when it's overflowing, prices crater. [amused] Glance here before every sell. If the thing in your hold isn't on the WANT list, you'll get bottom-of-band prices.",
    switchTab: "player",
    focus: "currentStation",
  },
  {
    id: "info-product-sell",
    selector: TUT("info-product-signals"),
    title: "Where to sell it",
    body:
      "Pin a good and the **Market signals** section shows the answer to \"where do I take this for the best price?\"\n\n" +
      "Best nearby buyer, the route **P&L** (price difference minus fuel and docking), and a one-click **fly there** if you've got the tank for it.\n\n" +
      "Math is hard. Let the panel do it.",
    tts:
      "Pin a good and the market signals section shows the answer to \"where do I take this for the best price?\" [curious] Best nearby buyer, the route P-and-L, and a one-click \"fly there\" if you've got the tank for it. [amused] Math is hard. Let the panel do it.",
    switchTab: "player",
    focus: "anyCargoGood",
  },
  {
    id: "travel",
    selector: TUT("travel-panel"),
    title: "Travel panel",
    body:
      "Where you actually *go* somewhere.\n\n" +
      "The list shows **neighbours** — stations you can reach in one trip. For anywhere further, you hop: pick a neighbour, fly there, pick the next. Hire a Navigator and you can plan multi-hop routes in one go (still burns the full fuel up front — no refuelling at intermediate stops).\n\n" +
      "Fuel burns all at once on departure, based on trip distance and engine efficiency. If the tank can't cover the trip, the panel won't let you launch — no surprises, no being stranded mid-route.\n\n" +
      "Easiest panel in the game. Probably.",
    tts:
      "Where you actually go somewhere… The list shows neighbours — stations you can reach in one trip. For anywhere further, you hop: pick a neighbour, fly there, pick the next. [curious] Hire a navigator and you can plan multi-hop routes in one go… Fuel burns all at once on departure. [amused] If the tank can't cover the trip, the panel won't let you launch. [mischievously] Easiest panel in the game. Probably.",
    switchTab: "player",
  },
] as const;

// --- cargo phase ----------------------------------------------------------
//
// The cargo phase NEVER leaves the Cargo (player) tab. Everything the
// engine can recommend — buy, sell, travel, refuel, accept/collect
// contracts — is reachable from the player view (markets pane, cargo
// pane, travel-options panel on the right column, contracts subtab).
// Sending the player to the Atlas tab strands them at a screen with
// the wrong controls; we stay put and spotlight the row in the panel
// they need to click.
//
// Selectors are computed from hintTarget() — the same engine output the
// in-game guidance hints use to highlight the suggested good/destination/
// contract. Each row in the matching UI table has a data-tutorial-* attr
// keyed by the engine's id (good name, location id, job id), so the
// spotlight aligns with what the engine is recommending right now.

type Tab = "player" | "stocks" | "markets" | "locations" | "charters";
type FleetTab = "cargo" | "upgrades" | "crew" | "contracts";

// Resolve a destination to the row that's actually visible in the
// Cargo tab's travel panel. The panel only lists immediate neighbors
// (one-hop reachable). For multi-hop destinations the player would
// ordinarily detour through Atlas; we instead shortcut by spotlighting
// the next-hop neighbor on the shortest path. Departing toward that
// neighbor still routes to the final destination — `travel()` does the
// multi-hop pathfinding under the hood — so following the spotlight
// produces the same trip the engine recommended.
function travelSelectorFor(world: World, ship: Trader, dst: LocationId): string | null {
  if (!world.locations[dst]) return null;
  const path = findRoutePath(world, ship.location, dst);
  // path is [from, ...intermediates, dst]. The neighbor row in the
  // panel is path[1]. Fall back to the literal destination if the path
  // is degenerate (single-element or unrooted graph).
  const nextHop = path && path.length > 1 ? path[1] : dst;
  return `[data-tutorial-travel-to="${nextHop}"]`;
}

// Resolution result. Pairs the spotlight selector with the sub-tab the
// target lives under, the orb's terse copy, and the info-panel focus
// the step wants pinned (so the player learns to read the relevant
// panel as part of doing the action).
//
// title + body are sub-step-aware: a route_plan hint pointing at a
// buy row says "Buy", pointing at the eventual travel row says "Travel".
// Without this, the orb's title would lock to the engine's high-level
// kind and tell the player "Plan a route" while the spotlight is on a
// single buy row — confusing.
//
// body is intentionally terse — an imperative, not an explanation.
// "Buy 60 Machine Parts", not "Let's run a trade. Buy 60 Machine Parts
// here → travel..." The info focus does the teaching.
interface HintResolution {
  selector: string;
  fleetTab: FleetTab | null;
  // Optional override for the "switch panel" spotlight when the player
  // isn't on `fleetTab` yet. Two card-strips share the FleetTab state
  // (ship card on the left, markets/exchange card on the right), and
  // for a few actions — most notably "accept a contract" — the
  // actionable button lives on the markets-card side, not the ship
  // card. Without this override, the spotlight defaults to the
  // ship-card's tab button, which has the right name but the wrong
  // contents (player's active contracts vs station's available ones).
  subTabSelector?: string;
  title: string;
  body: string;
  focus: TutorialFocus;
}

// Pick the acceptJobId that matches the visual top-of-table for the
// player's local-jobs panel. The engine returns acceptJobIds in plan
// order; the existing UI sorts the table by tier (high → low) then
// expiresAt. Mirroring that sort here keeps the orb's spotlight on the
// same row a player would scan to first when both are highlighted.
const TIER_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
function pickPrimaryJobId(ids: readonly string[] | undefined, world: World): string | undefined {
  if (!ids || ids.length === 0) return undefined;
  if (ids.length === 1) return ids[0];
  return [...ids].sort((aId, bId) => {
    const a = world.jobs[aId];
    const b = world.jobs[bId];
    if (!a || !b) return 0;
    const tierDelta = (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99);
    return tierDelta !== 0 ? tierDelta : a.expiresAt - b.expiresAt;
  })[0];
}

function goodName(world: World, gid: string): string {
  return world.goods[gid]?.name ?? gid;
}

function locName(world: World, id: string): string {
  return world.locations[id]?.name ?? id;
}

// Flavor variants — four sets of action copy in the same dry, slightly
// snarky voice. The orb cycles through them by loop index so each of
// the first ~3-4 loops gets its own line; once the player goes past
// the last variant, we cycle modulo length so every loop still has a
// fresh-feeling line without repeating the very same one back-to-back.
//
// Each variant function returns just the body text. Title is fixed
// per substep (above) — only the body has to keep up with the joke.
interface FlavorVariant {
  buy: (good: GoodId, qty: number | undefined, world: World) => string;
  sell: (good: GoodId, qty: number | undefined, world: World) => string;
  travel: (dst: LocationId, world: World) => string;
  accept: () => string;
  deliver: (good: GoodId, world: World) => string;
  refuel: () => string;
  collect: () => string;
  quickTravel: (ticks: number) => string;
}

const qtyPrefix = (qty: number | undefined): string =>
  qty != null && qty > 0 ? `${Math.round(qty)} ` : "";

const FLAVOR: readonly FlavorVariant[] = [
  // 1 — onboarding
  {
    buy: (good, qty, world) =>
      `Buy ${qtyPrefix(qty)}${goodName(world, good)}. The info panel's already done the math; trust it.`,
    sell: (good, qty, world) =>
      `Sell ${qtyPrefix(qty)}${goodName(world, good)}. The station's info panel has the rate if you doubt my numbers.`,
    travel: (dst, world) =>
      `Travel to ${locName(world, dst)}. Bring snacks — we don't do warp.`,
    accept: () => "Free credits for cargo you were hauling anyway. Don't think too hard.",
    deliver: (good, world) =>
      `Sell ${goodName(world, good)} here. The contract closes itself. Mediocrity rewarded.`,
    refuel: () => "Top up. Coasting on fumes is a poor business model.",
    collect: () => "Collect. Credits aren't going to wire themselves.",
    quickTravel: (ticks) =>
      `Well — maybe YOU do, but for us it's still ${ticks} ticks. Click to skip the wait.`,
  },
  // 2 — the player's getting it
  {
    buy: (good, qty, world) =>
      `Buy ${qtyPrefix(qty)}${goodName(world, good)}. Cheap here, expensive elsewhere — that's the whole game.`,
    sell: (good, qty, world) =>
      `Sell ${qtyPrefix(qty)}${goodName(world, good)}. They want it. You have it. Capitalism.`,
    travel: (dst, world) =>
      `Travel to ${locName(world, dst)}. Try not to crash into anything important.`,
    accept: () => "Take the contract. Bonus credits for doing what you'd already do.",
    deliver: (good, world) =>
      `Sell ${goodName(world, good)}. Contract closes; you'll get a notification you'll ignore.`,
    refuel: () => "Top off. Drifting builds character but burns clock.",
    collect: () => "Collect the settlement. Yes, even the small ones add up.",
    quickTravel: (ticks) =>
      `${ticks} ticks left. You can twiddle thumbs or skip to the good part.`,
  },
  // 3 — getting cocky
  {
    buy: (good, qty, world) =>
      `Buy ${qtyPrefix(qty)}${goodName(world, good)}. Routes don't run themselves.`,
    sell: (good, qty, world) =>
      `Sell ${qtyPrefix(qty)}${goodName(world, good)}. Cash beats inventory every quarter.`,
    travel: (dst, world) =>
      `Travel to ${locName(world, dst)}. Highway to the dock zone.`,
    accept: () => "Take the contract. The penalty for skipping is regret.",
    deliver: (good, world) =>
      `Sell ${goodName(world, good)}. Contract resolves itself — you're welcome.`,
    refuel: () => "Refuel. Nothing more embarrassing than running dry on the way home.",
    collect: () => "Collect. Don't be the trader who forgot their settlements.",
    quickTravel: (ticks) =>
      `Still ${ticks} ticks. Universe's slowest treadmill. Skip if you must.`,
  },
  // 4 — graduation lap
  {
    buy: (good, qty, world) =>
      `Buy ${qtyPrefix(qty)}${goodName(world, good)}. By now this should feel automatic.`,
    sell: (good, qty, world) =>
      `Sell ${qtyPrefix(qty)}${goodName(world, good)}. You know the drill.`,
    travel: (dst, world) =>
      `Travel to ${locName(world, dst)}. Last call before we let you off the leash.`,
    accept: () => "Take the contract. Free money is on theme.",
    deliver: (good, world) =>
      `Sell ${goodName(world, good)}. Lock in the bonus, log off, mission accomplished.`,
    refuel: () => "Refuel. We've been over this.",
    collect: () => "Collect. Sweet, sweet endorphin hit.",
    quickTravel: (ticks) =>
      `${ticks} ticks. You know what to do.`,
  },
] as const;

// Choose which flavor variant to use for the current loop. Loops 0-3
// use sets 0-3 in order; loops 4+ cycle modulo length. Deterministic
// per-loop (so the body doesn't flicker mid-loop on re-renders).
export function flavorVariantForLoop(loopIndex: number): FlavorVariant {
  if (loopIndex < 0) return FLAVOR[0];
  return FLAVOR[loopIndex % FLAVOR.length];
}

function currentFlavor(world: World): FlavorVariant {
  return flavorVariantForLoop(tutorialLoopsCompleted(world));
}

function buyResolution(world: World, good: GoodId, qty: number | undefined): HintResolution {
  return {
    selector: `[data-tutorial-buy-good="${good}"]`,
    fleetTab: "cargo",
    title: TUTORIAL_HINT_TITLE_BUY,
    body: currentFlavor(world).buy(good, qty, world),
    // Pin the good so the right-column info panel shows route profit
    // for this specific commodity — the player learns where to read
    // that information by following the spotlight.
    focus: { kind: "good", good, source: "market" },
  };
}

function sellResolution(world: World, ship: Trader, good: GoodId, qty: number | undefined): HintResolution {
  return {
    selector: `[data-tutorial-sell-good="${good}"]`,
    fleetTab: "cargo",
    title: TUTORIAL_HINT_TITLE_SELL,
    body: currentFlavor(world).sell(good, qty, world),
    // Pin the current station — its info panel surfaces the local
    // best-sell-price context the player should learn to scan.
    focus: { kind: "station", loc: ship.location, source: "station" },
  };
}

function travelResolution(world: World, ship: Trader, dst: LocationId): HintResolution | null {
  const sel = travelSelectorFor(world, ship, dst);
  if (!sel) return null;
  return {
    selector: sel,
    fleetTab: null,
    title: TUTORIAL_HINT_TITLE_TRAVEL,
    body: currentFlavor(world).travel(dst, world),
    // Open the destination's info panel so the player sees what's
    // there before flying.
    focus: { kind: "station", loc: dst, source: "travel" },
  };
}

function acceptResolution(world: World, jobId: string): HintResolution {
  return {
    selector: `[data-tutorial-accept-job="${jobId}"]`,
    fleetTab: "contracts",
    // The Take button lives on the markets-card's "Contracts" tab
    // (station's available board). The ship-card's "Contracts" tab
    // shows the player's active jobs and would lead them to the wrong
    // panel. Spotlight the markets-side tab specifically.
    subTabSelector: `[data-tutorial-contracts-board-tab="true"]`,
    title: TUTORIAL_HINT_TITLE_ACCEPT,
    body: currentFlavor(world).accept(),
    focus: null,
  };
}

function deliverResolution(world: World, good: GoodId): HintResolution {
  return {
    selector: `[data-tutorial-sell-good="${good}"]`,
    fleetTab: "cargo",
    title: "Deliver",
    body: currentFlavor(world).deliver(good, world),
    focus: { kind: "good", good, source: "cargo" },
  };
}

function refuelResolution(world: World): HintResolution {
  return {
    selector: `[data-tutorial="refuel-button"]`,
    fleetTab: null,
    title: TUTORIAL_HINT_TITLE_REFUEL,
    body: currentFlavor(world).refuel(),
    focus: null,
  };
}

function collectResolution(world: World, jobId: string): HintResolution {
  return {
    selector: `[data-tutorial-collect-job="${jobId}"]`,
    fleetTab: "contracts",
    title: TUTORIAL_HINT_TITLE_COLLECT,
    body: currentFlavor(world).collect(),
    focus: null,
  };
}

// Quick Travel callout body — used by the controller during transit to
// follow up the "we don't do warp" line on the previous travel orb.
export function quickTravelBody(world: World, ticks: number): string {
  return currentFlavor(world).quickTravel(ticks);
}

function resolveHintTarget(hint: GuidedHint, world: World, ship: Trader): HintResolution | null {
  const t = hintTarget(hint);
  switch (hint.kind) {
    case "buy_for_route":
      return t.buyGood ? buyResolution(world, t.buyGood, t.buyQty) : null;
    case "route_plan": {
      // route_plan covers three sub-actions: accept-contract, buy,
      // travel. We walk them in that order *except* when a contract's
      // good is also in the planned buy list — there's no point
      // pinning a contract for cargo the player doesn't have yet, so
      // those accepts get deferred until after the buy. Engine
      // re-emits the contract on the next tick once cargo's loaded.
      const buyGoodSet = new Set(Object.keys(t.buyGoods ?? {}));
      const eligibleAccepts = (t.acceptJobIds ?? []).filter(id => {
        const job = world.jobs[id];
        // Non-cargo contracts (rescue / settlement) can't be deferred
        // by buy-good overlap; keep them eligible.
        if (!job?.good) return true;
        return !buyGoodSet.has(job.good);
      });
      const acceptId = pickPrimaryJobId(eligibleAccepts, world);
      if (acceptId) return acceptResolution(world, acceptId);
      const buyEntry = Object.entries(t.buyGoods ?? {})[0];
      if (buyEntry) {
        const [good, qty] = buyEntry;
        return buyResolution(world, good, qty);
      }
      // After the buy, the deferral condition no longer applies — the
      // goods are loaded — so any accept we previously skipped is now
      // fair game.
      const fallbackAcceptId = pickPrimaryJobId(t.acceptJobIds, world);
      if (fallbackAcceptId) return acceptResolution(world, fallbackAcceptId);
      if (t.travelTo) return travelResolution(world, ship, t.travelTo);
      return null;
    }
    case "sell_here":
      return t.sellGood ? sellResolution(world, ship, t.sellGood, undefined) : null;
    case "travel_to_sell":
      return t.travelTo ? travelResolution(world, ship, t.travelTo) : null;
    case "travel_to_collect_trade_job":
      return t.travelTo ? travelResolution(world, ship, t.travelTo) : null;
    case "speculate":
      return t.travelTo ? travelResolution(world, ship, t.travelTo) : null;
    case "refuel":
      return refuelResolution(world);
    case "accept_job": {
      const id = t.acceptJobId ?? pickPrimaryJobId(t.acceptJobIds, world);
      return id ? acceptResolution(world, id) : null;
    }
    case "job_plan": {
      const id = pickPrimaryJobId(t.acceptJobIds, world);
      if (id) return acceptResolution(world, id);
      const sellGood = t.sellGoods?.[0];
      if (sellGood) return deliverResolution(world, sellGood);
      return null;
    }
    case "collect_trade_job":
      return t.collectJobId ? collectResolution(world, t.collectJobId) : null;
    case "wait":
      return null;
  }
}

export interface ResolvedCargoHint {
  hint: GuidedHint;
  selector: string;
  // Required main + sub tab for the spotlight target to be mounted.
  // The controller compares against the player's current selection;
  // mismatches turn the resolution into a "click this tab" prompt
  // (we don't auto-switch — the click is part of the guide).
  requiredTab: Tab;
  requiredFleetTab: FleetTab | null;
  // Optional spotlight override for the "switch panel" step (see
  // HintResolution.subTabSelector). null/undefined means use the
  // default `[data-tutorial-fleet-tab="${requiredFleetTab}"]`.
  subTabSelector?: string;
  title: string;
  body: string;
  focus: TutorialFocus;
}

// True when the engine's resolved target is already a contract row.
// Used to decide whether the tutorial-mandatory contract override needs
// to fire — if the engine itself is pointing the player at a contract,
// stay out of its way. We deliberately match the engine's exact job
// rather than picking our own.
function targetIsContract(target: HintResolution): boolean {
  return target.selector.startsWith("[data-tutorial-accept-job");
}

// When the engine wants the player to do action X but they haven't
// touched contracts yet, override the engine and surface a contract
// instead. The cargo phase requires the player to walk through accept +
// deliver before graduating, but `getGuidedHint` only recommends a
// contract when it's the highest-EV move — for many world states it
// never bubbles up. Without this override the tutorial would hang
// waiting on a verb the engine never asks for.
//
// Only fires when (a) the player still needs to accept, (b) the engine
// is NOT already recommending a contract, and (c) a local job is
// posted here. We pick the highest-tier local job so our spotlight
// agrees with how the existing UI sorts the contracts table — that
// keeps the orb on the same row the player would intuitively look at.
function contractOverrideIfNeeded(
  world: World,
  ship: Trader,
  plannedBuyGoods: ReadonlySet<GoodId>,
): ResolvedCargoHint | null {
  const t = world.player?.tutorial;
  if (!t) return null;
  const accepted = t.perTypeCount.accept_contract ?? 0;
  if (accepted >= 1) return null;
  if (ship.state !== "idle") return null;

  const tierRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  // Filter out jobs whose good is something the engine already wants
  // the player to buy here — surfacing the contract first would put
  // the spotlight on something the player can't fulfill until they
  // grab the cargo. Let the buy fire first; the contract surfaces
  // naturally once cargo is on board.
  const candidates = listLocalJobs(world, ship.location)
    .filter(j => j.kind !== "trade" && j.acceptedBy == null)
    .filter(j => !j.good || !plannedBuyGoods.has(j.good))
    .sort((a, b) => (tierRank[a.tier] - tierRank[b.tier]) || (a.expiresAt - b.expiresAt));
  const local = candidates[0];
  if (!local) return null;

  const res = acceptResolution(world, local.id);
  return {
    hint: { kind: "accept_job", jobId: local.id, reason: "", expectedNet: 0, ticks: 0 },
    selector: res.selector,
    requiredTab: "player",
    requiredFleetTab: res.fleetTab,
    subTabSelector: res.subTabSelector,
    title: res.title,
    body: res.body,
    focus: res.focus,
  };
}

export function resolveCargoHint(world: World, ship: Trader): ResolvedCargoHint | null {
  const hint = getGuidedHint(world, ship);
  const target = resolveHintTarget(hint, world, ship);

  // Engine is already pointing at a contract row — emit it as-is so the
  // orb's selector matches the engine's actual choice. Important: we
  // never substitute a different job here, otherwise the spotlight
  // diverges from the in-game guidance highlight on the same table.
  if (target && targetIsContract(target)) {
    return {
      hint,
      selector: target.selector,
      requiredTab: "player",
      requiredFleetTab: target.fleetTab,
      subTabSelector: target.subTabSelector,
      title: target.title,
      body: target.body,
      focus: target.focus,
    };
  }

  // Engine isn't recommending a contract but the player still needs to
  // try one. Force a step on the highest-tier local job — but skip
  // jobs whose good is something the engine wants the player to buy
  // first; deferring keeps the orb pointing at the immediately doable
  // step (the buy) instead of dangling a contract for cargo the
  // player hasn't picked up yet.
  const plannedBuyGoods = new Set<GoodId>();
  if (hint.kind === "buy_for_route" && hint.good) {
    plannedBuyGoods.add(hint.good);
  } else if (hint.kind === "route_plan") {
    for (const buy of hint.buys ?? []) plannedBuyGoods.add(buy.good);
  }
  const override = contractOverrideIfNeeded(world, ship, plannedBuyGoods);
  if (override) return override;

  if (!target) return null;
  return {
    hint,
    selector: target.selector,
    requiredTab: "player",
    requiredFleetTab: target.fleetTab,
    subTabSelector: target.subTabSelector,
    title: target.title,
    body: target.body,
    focus: target.focus,
  };
}

// --- exchange phase -------------------------------------------------------

export interface ResolvedStockHint {
  hint: StockExchangeHint;
  selector: string;
  requiredTab: Tab;
  body: string;
  title: string;
}

// Short imperatives — the action label from the engine is already
// terse ("Buy 50 sh"), so we lean on it instead of writing a wrapper.
const STOCK_HINT_TITLES: Partial<Record<StockExchangeHint["kind"], string>> = {
  open_long: "Buy",
  close_long: "Sell",
  open_short: "Short",
  cover_short: "Cover",
  open_long_future: "Long future",
  open_short_future: "Short future",
  close_future: "Close future",
  watch: "Watch",
};

export function resolveStockHint(world: World, shipId?: string): ResolvedStockHint | null {
  const hint = getStockExchangeHint(world, shipId);
  if (!hint) return null;
  return {
    hint,
    selector: `[data-tutorial-equity="${hint.equityId}"]`,
    requiredTab: "stocks",
    title: STOCK_HINT_TITLES[hint.kind] ?? "Trade",
    body: `${hint.actionLabel} ${hint.ticker}.`,
  };
}

// --- phase transitions ----------------------------------------------------

// One full buy → travel → sell cycle is a "loop". Default goal is 1 —
// with the voiced first-time intros for buy / sell / contract carrying
// most of the teaching, a single supervised lap is enough to graduate.
// The fork prompt fires after that one loop and either bumps loopGoal
// (player picked "Another logistics route") or graduates to the
// exchange. The fork is the only path out of cargo coaching short of
// the manual skip button.
export const TUTORIAL_DEFAULT_LOOPS = 1;

export function tutorialLoopsCompleted(world: World): number {
  const t = world.player?.tutorial;
  if (!t) return 0;
  // A complete logistics loop is buy → travel → sell. Including travel
  // in the min ensures freebie starter cargo (player begins the cargo
  // phase already holding goods, which yields a sell with no preceding
  // travel) doesn't accidentally satisfy a loop on its own. Same for
  // tutorial replays where prior buy/sell counts are wiped to zero —
  // the player has to perform all three actions in sequence to count.
  const buy = t.perTypeCount.buy ?? 0;
  const sell = t.perTypeCount.sell ?? 0;
  const travel = t.perTypeCount.travel ?? 0;
  return Math.min(buy, sell, travel);
}

// Fork condition: the player has completed `loopGoal` full buy+sell
// loops and touched the contract pipeline at least once. The fork
// stays open from that moment forward — until the player picks an
// option — so they can't accidentally fly past it. "Continue" bumps
// loopGoal so the fork only re-fires after another full loop.
export function shouldShowLoopFork(world: World): boolean {
  const t = world.player?.tutorial;
  if (!t || t.phase !== "cargo") return false;
  const accept = t.perTypeCount.accept_contract ?? 0;
  const deliver = t.perTypeCount.deliver_contract ?? 0;
  // ?? TUTORIAL_DEFAULT_LOOPS handles older saves that pre-date the
  // loopGoal field — they fall through to the current default.
  const goal = t.loopGoal ?? TUTORIAL_DEFAULT_LOOPS;
  return tutorialLoopsCompleted(world) >= goal && accept >= 1 && deliver >= 1;
}

// Exchange phase exit: three stock trades — same rhythm as the cargo
// phase (3 buy/sell loops). One trade is enough to learn the panel,
// but three reinforces the muscle memory: pick a row, fill the inputs
// (or trust the autofill), submit, repeat.
export const TUTORIAL_EXCHANGE_TRADES = 3;
export function shouldExitExchangePhase(world: World): boolean {
  const t = world.player?.tutorial;
  if (!t) return false;
  return (t.perTypeCount.stock_trade ?? 0) >= TUTORIAL_EXCHANGE_TRADES;
}

// Resolve a tour stop's symbolic focus keyword to a concrete focus the
// store can pin. We pick from the current player state so the info
// panel always has data to display: the player's docked station for
// "currentStation", a cargo good for "anyCargoGood", and the first
// stocked market good as the fallback "anyMarketGood".
export function resolveTourFocus(
  keyword: InterfaceTourStop["focus"],
  world: World,
  ship: Trader | null,
): TutorialFocus {
  if (!keyword || !ship) return null;
  switch (keyword) {
    case "currentStation":
      return { kind: "station", loc: ship.location, source: "station" };
    case "anyCargoGood": {
      // Prefer real cargo (non-fuel) so the route-profit lines have
      // meaningful values. Plasma fuel is excluded because the player
      // typically holds it as fuel, not for trade — but we fall back
      // to it if cargo bay is otherwise empty so the section still
      // populates.
      const tradable = ship.cargo.find(lot => lot.good !== "plasma") ?? ship.cargo[0];
      if (tradable) return { kind: "good", good: tradable.good, source: "cargo" };
      return resolveTourFocus("anyMarketGood", world, ship);
    }
    case "anyMarketGood": {
      const market = world.markets[ship.location];
      if (!market) return null;
      const good = Object.keys(market.stock).find(g => (market.stock[g] ?? 0) > 1);
      return good ? { kind: "good", good, source: "market" } : null;
    }
  }
}

// Reset to the fresh-start state. Used by the "Replay tutorial" menu.
// Replay starts at "tour" rather than "setup" since the new-game wizard
// has already run for the existing world.
export function resetTutorial(world: World): void {
  if (!world.player) return;
  world.player.tutorial = {
    phase: "tour",
    tourStop: 0,
    perTypeCount: {},
    loopGoal: TUTORIAL_DEFAULT_LOOPS,
  };
}
