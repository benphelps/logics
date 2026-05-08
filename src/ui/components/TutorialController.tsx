import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";
import {
  INTERFACE_TOUR,
  TUTORIAL_EXCHANGE_TRADES,
  TUTORIAL_CUES,
  TUTORIAL_HINT_TITLE_ACCEPT,
  TUTORIAL_HINT_TITLE_BUY,
  TUTORIAL_HINT_TITLE_COLLECT,
  TUTORIAL_HINT_TITLE_REFUEL,
  TUTORIAL_HINT_TITLE_SELL,
  TUTORIAL_HINT_TITLE_TRAVEL,
  TUTORIAL_INTROS,
  quickTravelBody,
  resolveCargoHint,
  resolveStockHint,
  resolveTourFocus,
  shouldExitExchangePhase,
  shouldShowLoopFork,
  tutorialLoopsCompleted,
} from "../../sim/tutorial";
import { TutorialOverlay } from "./TutorialOverlay";
import { TutorialHelper, type TutorialHelperProps } from "./TutorialHelper";
import { formatTutorialBody } from "../tutorialMarkdown";
import { useTutorialAudio } from "../useTutorialAudio";

// Top-level orchestrator. Each render reads world.player.tutorial.phase
// and the matching suggestion engine; the helper + spotlight are driven
// from a single render path so React keeps the same component instances
// across phase transitions — without that, the model-viewer would
// re-init on every step swap and the player would see the orb flicker.
//
// Tab switching is NOT automatic — when the player is on a different
// tab from where the action lives, the orb spotlights the tab button
// itself (every tab already shows a "has-suggestion" pip from the
// existing guidance system) so clicking it is a guided step. Once the
// right tab is active, the orb advances to the actual action target.
//
// We deliberately don't gate the stock engine on a navigator — the
// tutorial uses the suggestion APIs directly so a brand-new player
// gets coached before that 50-action milestone unlocks the in-UI
// guidance hints.

interface OverlayConfig {
  selector: string | null;
  padding?: number;
  radius?: number;
  fullDim?: boolean;
  interactive?: boolean;
}

interface RenderConfig {
  overlay?: OverlayConfig;
  helper: TutorialHelperProps;
}

export function TutorialController() {
  // Subscribing to tickEpoch keeps us re-rendering after every store
  // mutation. The world is mutated in place; tickEpoch is the change
  // sentinel useMemo / useEffect deps need to actually re-fire.
  const tickEpoch = useStore(s => s.tickEpoch);
  const world = useStore(s => s.world);
  const selectedTab = useStore(s => s.selectedTab);
  const fleetTab = useStore(s => s.fleetTab);
  const stockKindFilter = useStore(s => s.stockKindFilter);
  const selectedEquity = useStore(s => s.selectedEquity);
  const advanceSetup = useStore(s => s.advanceTutorialSetup);
  const advanceTour = useStore(s => s.advanceTutorialTour);
  const skipTour = useStore(s => s.skipTutorialTour);
  const skipPhase = useStore(s => s.skipTutorialPhase);
  const finish = useStore(s => s.finishTutorial);
  const dismiss = useStore(s => s.dismissTutorial);
  const ackFork = useStore(s => s.acknowledgeTutorialFork);
  const advanceCombat = useStore(s => s.advanceCombatTutorial);
  const finishCombat = useStore(s => s.finishCombatTutorial);
  const encounterPhase = useStore(s => s.encounterPhase);
  const bidFarewell = useStore(s => s.bidFarewell);
  const setTutorialFocus = useStore(s => s.setTutorialFocus);
  const pendingNewGame = useStore(s => s.pendingNewGame);
  const pendingSeed = useStore(s => s.pendingSeed);

  const player = world.player;
  const tutorial = player?.tutorial;

  // Anchor decisions on the player's currently-selected ship, falling
  // back to the first ship in their fleet. When the player has no ship
  // (transition states), the controller renders nothing.
  const selectedTraderId = useStore(s => s.selectedTrader);
  const ship = useMemo(() => {
    if (!player) return null;
    const id = selectedTraderId && player.shipIds.includes(selectedTraderId)
      ? selectedTraderId
      : player.shipIds[0];
    return id ? world.traders[id] ?? null : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- world is mutated in place; tickEpoch is the change sentinel.
  }, [world, player, selectedTraderId, tickEpoch]);

  // Resolve the current hint per phase. Each is recomputed on every
  // tickEpoch bump so the orb tracks the engine's recommendations live
  // (e.g. as the player buys cargo, the next "sell here" hint slides in
  // with no input from the controller).
  const cargoHint = useMemo(() => {
    if (!tutorial || tutorial.phase !== "cargo" || !ship) return null;
    if (ship.state === "transit") return null;
    return resolveCargoHint(world, ship);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- world is mutated in place; tickEpoch is the change sentinel.
  }, [tutorial, ship, world, tickEpoch]);

  const stockHint = useMemo(() => {
    if (!tutorial || tutorial.phase !== "exchange") return null;
    return resolveStockHint(world, ship?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- world is mutated in place; tickEpoch is the change sentinel.
  }, [tutorial, ship, world, tickEpoch]);

  // Auto exchange→done transition. The cargo→exchange jump goes
  // through the fork prompt instead — see the fork branch below — so
  // the player chooses when (and whether) to graduate.
  useEffect(() => {
    if (!tutorial) return;
    if (tutorial.phase === "exchange" && shouldExitExchangePhase(world)) {
      finish();
    }
  }, [tutorial, world, finish, tickEpoch]);

  // Auto setup→tour transition. The new-game wizard drives "setup"
  // while it's mounted; once both the wizard AND the seeding loop are
  // done (pendingNewGame and pendingSeed both null) we move into the
  // interface tour with the freshly-built world. Holding through
  // seeding keeps the orb on the wait-message instead of trying to
  // start the tour against a centred seeding modal.
  useEffect(() => {
    if (!tutorial) return;
    if (tutorial.phase === "setup" && !pendingNewGame && !pendingSeed) {
      advanceSetup();
    }
  }, [tutorial, pendingNewGame, pendingSeed, advanceSetup]);

  // Combat sub-tutorial advancement effects.
  //   1) Player clicks an action card (or otherwise leaves "choosing")
  //      while still on the intro stop — auto-advance past the intro
  //      so the orb tracks the modal's actual phase instead of
  //      monologuing through the dice roll.
  //   2) When the encounter transitions from present → cleared, mark
  //      combat as seen. We use a ref to detect the transition so
  //      mounting with no encounter (the common case) doesn't retire
  //      a tutorial that's never run.
  const pendingEncounter = world.pendingEncounter;
  useEffect(() => {
    if (!tutorial || tutorial.combatSeen) return;
    const stop = tutorial.combatStop ?? 0;
    if (stop === 0 && encounterPhase && encounterPhase !== "choosing") {
      advanceCombat();
    }
  }, [tutorial, encounterPhase, advanceCombat]);

  const prevEncounterRef = useRef(false);
  useEffect(() => {
    const had = prevEncounterRef.current;
    const has = !!pendingEncounter;
    prevEncounterRef.current = has;
    if (!tutorial || tutorial.combatSeen) return;
    if (had && !has) finishCombat();
  }, [tutorial, pendingEncounter, finishCombat]);

  // Push the tutorial's desired info-panel focus into the store. Tour
  // stops with focus pin the relevant entity so the section the stop
  // is calling out actually renders. Action steps only pin when the
  // player is already on the right tab/sub-tab, otherwise the pinned
  // focus would be invisible (DockedView isn't mounted).
  useEffect(() => {
    if (!tutorial) {
      setTutorialFocus(null);
      return;
    }
    if (tutorial.phase === "tour") {
      const stop = INTERFACE_TOUR[tutorial.tourStop];
      setTutorialFocus(stop ? resolveTourFocus(stop.focus, world, ship) : null);
      return;
    }
    if (tutorial.phase !== "cargo" || !cargoHint) {
      setTutorialFocus(null);
      return;
    }
    const onRightTab = selectedTab === cargoHint.requiredTab;
    const onRightSubTab = !cargoHint.requiredFleetTab || fleetTab === cargoHint.requiredFleetTab;
    if (onRightTab && onRightSubTab) {
      setTutorialFocus(cargoHint.focus);
    } else {
      setTutorialFocus(null);
    }
  }, [tutorial, cargoHint, selectedTab, fleetTab, setTutorialFocus, world, ship, tickEpoch]);

  // Tour stop pre-navigation. Tour clicks happen on the orb's "Next"
  // button — we still auto-switch the main tab here because the tour
  // is explanatory rather than guided-by-action.
  const tourStopDef = tutorial?.phase === "tour" ? INTERFACE_TOUR[tutorial.tourStop] : null;
  const selectTab = useStore(s => s.selectTab);
  useEffect(() => {
    if (tourStopDef?.switchTab) selectTab(tourStopDef.switchTab);
  }, [tourStopDef, selectTab]);

  // Resolve the first-time-mechanic intro (if any) the cargo phase
  // should be playing right now. One per major action — buy, sell,
  // accept-contract, refuel — fires the very first time the engine
  // surfaces that action and reverts to the snappy flavor copy once
  // the player has moved past the introductory phase.
  //
  // Buy/sell intros gate on tutorialLoopsCompleted === 0 (no full
  // buy → travel → sell cycle yet) rather than the per-action counter,
  // so the panel stays parked through every additional buy at the
  // source station and every sell at the destination — long enough for
  // the ~30s audio to play through without the bubble swapping out
  // mid-sentence after the very first transaction.
  //
  // Gate on subtab match: the intro's body talks about the panel the
  // player is staring at, so the audio shouldn't fire while they're
  // still being told to switch tabs. Once they're on the right subtab,
  // the intro lands cleanly with audio + body in sync.
  const activeIntro = (() => {
    if (tutorial?.phase !== "cargo" || !cargoHint) return null;
    if (cargoHint.requiredFleetTab && fleetTab !== cargoHint.requiredFleetTab) return null;
    const counts = tutorial.perTypeCount;
    const introLoop = tutorialLoopsCompleted(world) === 0;
    if (cargoHint.title === TUTORIAL_HINT_TITLE_BUY && introLoop) {
      return TUTORIAL_INTROS.buy;
    }
    if (cargoHint.title === TUTORIAL_HINT_TITLE_SELL && introLoop) {
      return TUTORIAL_INTROS.sell;
    }
    if (cargoHint.title === TUTORIAL_HINT_TITLE_REFUEL && (counts.refuel ?? 0) === 0) {
      return TUTORIAL_INTROS.refuel;
    }
    if (cargoHint.title === TUTORIAL_HINT_TITLE_ACCEPT && (counts.accept_contract ?? 0) === 0) {
      return TUTORIAL_INTROS.contract;
    }
    return null;
  })();

  // Tab-nav intro — the "Next we'll learn about X" voiced cue that
  // fires on the Switch panel step BEFORE a first-time mechanic
  // intro. Mutually exclusive with activeIntro: that one fires once
  // the player is on the right subtab; this one fires while they're
  // still being asked to click the tab.
  const activeNextIntro = (() => {
    if (tutorial?.phase !== "cargo" || !cargoHint) return null;
    if (!cargoHint.requiredFleetTab) return null;
    if (fleetTab === cargoHint.requiredFleetTab) return null;
    const counts = tutorial.perTypeCount;
    if (cargoHint.title === TUTORIAL_HINT_TITLE_BUY && tutorialLoopsCompleted(world) === 0) {
      return TUTORIAL_INTROS.nextBuy;
    }
    if (cargoHint.title === TUTORIAL_HINT_TITLE_SELL && tutorialLoopsCompleted(world) === 0) {
      return TUTORIAL_INTROS.nextSell;
    }
    if (cargoHint.title === TUTORIAL_HINT_TITLE_ACCEPT && (counts.accept_contract ?? 0) === 0) {
      return TUTORIAL_INTROS.nextContract;
    }
    if (cargoHint.title === TUTORIAL_HINT_TITLE_COLLECT && tutorialLoopsCompleted(world) === 0) {
      return TUTORIAL_INTROS.nextCollect;
    }
    return null;
  })();

  // Audio-only cues: short voiced one-liners played over the engine's
  // body copy without overriding it. Fires when no full intro is
  // active. Each cue gates on a one-shot condition; once the matching
  // perTypeCount tick rolls past, the cue stays silent forever.
  const activeCue = (() => {
    if (activeIntro) return null;
    if (tutorial?.phase !== "cargo") return null;
    const counts = tutorial.perTypeCount;

    // Quick-travel cue fires during the player's FIRST transit only.
    // travel was bumped on departure, so === 1 means "in flight on the
    // first hop". cargoHint is null while in transit, so this branch
    // doesn't depend on it.
    if (ship?.state === "transit" && ship.pilot === "manual" && (counts.travel ?? 0) === 1) {
      return TUTORIAL_CUES.quickTravel;
    }

    if (!cargoHint) return null;
    if (cargoHint.requiredFleetTab && fleetTab !== cargoHint.requiredFleetTab) return null;

    if (cargoHint.title === TUTORIAL_HINT_TITLE_BUY && (counts.buy ?? 0) === 1) {
      return TUTORIAL_CUES.buyFill;
    }
    if (cargoHint.title === TUTORIAL_HINT_TITLE_TRAVEL && (counts.travel ?? 0) === 0) {
      return TUTORIAL_CUES.departure;
    }
    return null;
  })();

  // Combat sub-tutorial audio gates: the encounter modal pauses the
  // universe, so this branch supersedes everything else. Only the
  // intro, choosing-phase, and revealed-phase stops are voiced — the
  // rolling state is too brief (~1s) for audio to land cleanly.
  const combatAudioId = (() => {
    if (!world.pendingEncounter || tutorial?.combatSeen) return null;
    const stop = tutorial?.combatStop ?? 0;
    if (stop === 0) return TUTORIAL_INTROS.combatIntro.id;
    if (encounterPhase === "rolling") return null;
    if (encounterPhase === "revealed") return TUTORIAL_INTROS.combatRevealed.id;
    return TUTORIAL_INTROS.combatChoosing.id;
  })();

  // Voice clip for whatever the orb is monologuing right now. Combat
  // takes priority because the modal pauses everything else; then tour
  // stops, first-time mechanic intros, audio cues. Other phases stay
  // silent — action coaching reuses engine flavor copy that wasn't
  // pre-rendered, and the wizard / seeding stops let the modal carry
  // the message. Hook is called unconditionally so React's rules stay
  // happy across phase swaps.
  const audioSrc = (() => {
    if (combatAudioId) return `/audio/tutorial/${combatAudioId}.ogg`;
    if (tutorial?.phase === "tour" && tourStopDef) {
      return `/audio/tutorial/${tourStopDef.id}.ogg`;
    }
    if (activeNextIntro) {
      return `/audio/tutorial/${activeNextIntro.id}.ogg`;
    }
    if (activeIntro) {
      return `/audio/tutorial/${activeIntro.id}.ogg`;
    }
    if (activeCue) {
      return `/audio/tutorial/${activeCue.id}.ogg`;
    }
    return null;
  })();
  const audioControls = useTutorialAudio(audioSrc);

  // Resolve the current step into a single config object so the JSX
  // below mounts ONE TutorialHelper and ONE TutorialOverlay across all
  // transitions. React reuses the same component instances; only props
  // change, which lets the orb's drift / look-at logic carry across
  // step swaps without unmount/remount artifacts.
  const config: RenderConfig | null = (() => {
    if (!tutorial) return null;

    // Setup phase: pre-game wizard companion. The orb sits centered
    // (no lookAtSelector → centered placement) and reacts to which
    // wizard panel is open. We don't render an overlay here — the
    // modal already has its own dim backdrop, and adding ours on top
    // would obscure the wizard content. Once pendingNewGame goes null
    // the auto-flip above moves us into "tour".
    if (tutorial.phase === "setup") {
      // Seeding window: wizard has committed but the universe is still
      // being built. The seeding modal owns the centre — pin the orb to
      // the bottom-left and have him narrate the wait so he doesn't
      // disappear (or worse, start the tour) while the player stares
      // at a progress bar.
      if (!pendingNewGame && pendingSeed) {
        const isBackstory = pendingSeed.phase === "backstory";
        return {
          helper: {
            title: isBackstory ? "Drafting your universe" : "Settling the sector",
            body: isBackstory
              ? "Hang tight — the wire desk is sketching the political and economic shape of your sector. I'll start the tour the second it's ready."
              : "Almost there — the freighters are running their first laps so the markets have some history when you arrive. Hold on a beat.",
            onDismiss: dismiss,
            dismissLabel: "Skip tutorial",
            fallbackPlacement: "bottom-left",
          },
        };
      }
      if (!pendingNewGame) return null;
      switch (pendingNewGame.phase) {
        case "intro":
          return {
            helper: {
              title: "Welcome aboard",
              body: "I'm your onboard helper — I'll keep showing up while you find your feet. Skim the cards, then hit Continue when you're ready.",
              onDismiss: dismiss,
              dismissLabel: "Skip tutorial",
              fallbackPlacement: "bottom-left",
            },
          };
        case "pilot":
          return {
            helper: {
              title: "Build your captain",
              body: "Roll a name with the dice if nothing's coming to you. Pick traits, then click reroll for a portrait — takes about fifteen seconds. Hit Continue when you're set.",
              onDismiss: dismiss,
              dismissLabel: "Skip tutorial",
              fallbackPlacement: "bottom-left",
            },
          };
        case "syndicate":
          return {
            helper: {
              title: "Pick your faction",
              body: "Each syndicate sets your colors and your starting station. The trait card shows their edge. Click one and hit Begin — you're stuck with the choice.",
              onDismiss: dismiss,
              dismissLabel: "Skip tutorial",
              fallbackPlacement: "bottom-left",
            },
          };
      }
    }

    // Combat sub-tutorial: fires the first time an encounter pops up,
    // regardless of main tutorial phase. Renders ON TOP of the encounter
    // modal — the helper bubble sits in its usual fixed position; the
    // overlay's spotlight points at action cards / continue button
    // inside the modal. Once combatSeen flips true, this branch is
    // permanently retired and the rest of the tutorial resumes.
    //
    // Sub-stop progression is driven by combatStop (intro vs in-modal)
    // AND the modal's encounterPhase ("choosing" vs "rolling" vs
    // "revealed"), so the orb tracks the modal state rather than racing
    // a 1.2s dice roll on its own.
    // Encounter in progress AFTER the combat sub-tutorial has played
    // — orb stays parked in the corner so he doesn't disappear, but
    // doesn't try to coach. Without this branch the controller falls
    // through to the cargo phase logic, which immediately tries to
    // spotlight the quick-travel button — pointing the player at a
    // control they can't reach while the encounter modal is up.
    if (world.pendingEncounter && tutorial.combatSeen) {
      return {
        helper: {
          title: "Your move",
          body: null,
          fallbackPlacement: "bottom-left",
        },
      };
    }

    if (world.pendingEncounter && !tutorial.combatSeen) {
      const stop = tutorial.combatStop ?? 0;
      const inMainTutorial =
        tutorial.phase !== "done" && tutorial.phase !== "skipped";

      // Combat orb sits parked in the bottom-left for every sub-stop.
      // The encounter modal owns the centre; spotlights highlight the
      // action cards / continue button via overlay.selector but the
      // orb itself never tracks them — we'd just be pulling it toward
      // a target the player is also being told to read.
      const combatPlacement = "bottom-left" as const;

      // Stop 0: intro monologue, no spotlight inside the modal — let
      // the player read the stat card, then click Next.
      if (stop === 0) {
        const intro = TUTORIAL_INTROS.combatIntro;
        return {
          helper: {
            title: intro.title,
            body: formatTutorialBody(intro.body),
            fallbackPlacement: combatPlacement,
            onAdvance: advanceCombat,
            advanceLabel: inMainTutorial ? "Tips, please" : "Walk me through it",
            onSkip: finishCombat,
            skipLabel: "I've got this",
            audioControls,
          },
        };
      }

      // Past intro — modal phase decides what to surface.
      if (encounterPhase === "rolling") {
        // Dice are spinning — about a second of animation. No body
        // text and no audio: nothing fits in that window cleanly.
        // Helper stays mounted with a bare title so the bubble
        // doesn't unmount/remount across the dice roll.
        return {
          helper: {
            title: "Rolling…",
            body: null,
            fallbackPlacement: combatPlacement,
          },
        };
      }

      if (encounterPhase === "revealed") {
        // Resolution panel is up — spotlight the Continue button so
        // the player knows where to head next, but keep the orb in the
        // corner reading the gains / losses summary aloud.
        const continueSelector = `[data-tutorial="encounter-continue"]`;
        const revealed = TUTORIAL_INTROS.combatRevealed;
        return {
          overlay: { selector: continueSelector, padding: 6 },
          helper: {
            title: revealed.title,
            body: formatTutorialBody(revealed.body),
            fallbackPlacement: combatPlacement,
            onSkip: finishCombat,
            skipLabel: "Got it",
            audioControls,
          },
        };
      }

      // Default: choosing phase (or stale state) — spotlight the
      // recommended action card. The card already wears a `.recommended`
      // class and a green-glow visual treatment; we just point at it.
      const recommendedSelector = `[data-tutorial-encounter-recommended="true"]`;
      const choosing = TUTORIAL_INTROS.combatChoosing;
      return {
        overlay: { selector: recommendedSelector, padding: 6 },
        helper: {
          title: choosing.title,
          body: formatTutorialBody(choosing.body),
          fallbackPlacement: combatPlacement,
          onSkip: finishCombat,
          skipLabel: "I've got this",
          audioControls,
        },
      };
    }

    if (tutorial.phase === "done" || tutorial.phase === "skipped") return null;

    if (tutorial.phase === "farewell") {
      return {
        overlay: { selector: null, fullDim: true, interactive: true, padding: 8 },
        helper: {
          title: "That's a wrap",
          body: "You've got the rhythm, the panel reading, and a few credits to show for it. I'd give you a graduation hat but the budget didn't cover props. Go make some terrible decisions in peace.",
          onAdvance: bidFarewell,
          advanceLabel: "Off I go",
        },
      };
    }

    if (tutorial.phase === "tour") {
      if (!tourStopDef) return null;
      const isLast = tutorial.tourStop >= INTERFACE_TOUR.length - 1;
      return {
        overlay: {
          selector: tourStopDef.selector,
          fullDim: tourStopDef.fullDim,
          interactive: true,
          padding: 8,
        },
        helper: {
          title: tourStopDef.title,
          body: formatTutorialBody(tourStopDef.body),
          lookAtSelector: tourStopDef.selector,
          onAdvance: advanceTour,
          advanceLabel: isLast ? "Start playing" : "Next",
          onSkip: skipTour,
          skipLabel: "Skip tour",
          onDismiss: dismiss,
          dismissLabel: "Skip tutorial",
          audioControls,
        },
      };
    }

    if (tutorial.phase === "cargo") {
      // Quick Travel callout — the previous orb told the player travel
      // takes time ("we don't do warp"). When they're actually in
      // transit, we follow up with a snarky reminder that they can
      // skip the wait. The Quick Travel button only mounts for manual
      // ships in transit, so the spotlight resolves to the right
      // element without extra checks.
      if (ship && ship.state === "transit" && ship.pilot === "manual") {
        const ticks = ship.ticksRemaining ?? 0;
        return {
          overlay: { selector: `[data-tutorial="quick-travel"]`, padding: 6 },
          helper: {
            title: "Skip the wait",
            body: quickTravelBody(world, ticks),
            lookAtSelector: `[data-tutorial="quick-travel"]`,
            onSkip: skipPhase,
            skipLabel: "Skip section",
            onDismiss: dismiss,
            dismissLabel: "Skip tutorial",
            // First-transit cue rides on top of the engine body — show
            // the audio controls so the player can mute / replay.
            audioControls: activeCue ? audioControls : undefined,
          },
        };
      }

      // End-of-loop fork — the player has bought their N-th cargo and
      // would normally now travel + sell + start the next loop. We
      // intercept here and let them choose: another lap, graduate to
      // the exchange, or bail. Spotlight the Exchange tab so the path
      // out is obvious.
      if (shouldShowLoopFork(world)) {
        const exchangeTabSelector = `[data-tutorial="tab-stocks"]`;
        return {
          overlay: { selector: exchangeTabSelector, padding: 4 },
          helper: {
            title: "Brains over backache",
            body: "You've got the rhythm of manual trade. Past a point, hauling crates is a chump's game — the exchange is where smart money buys what fools haul. Your call.",
            lookAtSelector: exchangeTabSelector,
            // Move to the exchange is the recommended forward path —
            // it lives on the green advance slot. "Another route" is
            // a neutral lateral choice (no color); skip-tutorial keeps
            // its red.
            onAdvance: () => ackFork("exchange"),
            advanceLabel: "Move to the exchange",
            onSkip: () => ackFork("continue"),
            skipLabel: "Another logistics route",
            neutralSkip: true,
            onDismiss: () => ackFork("skip"),
            dismissLabel: "Skip tutorial",
          },
        };
      }

      if (!ship) return null;

      // Always anchor on the Cargo tab during the cargo phase. If the
      // player wandered off, prompt them back before doing anything else
      // (including shipyard / no-recommendation fallbacks below — those
      // assume the panels we'd point at are mounted).
      if (selectedTab !== "player") {
        const tabSelector = `[data-tutorial="tab-player"]`;
        return {
          overlay: { selector: tabSelector, padding: 4 },
          helper: {
            title: "Open tab",
            body: `Open the ${TAB_LABELS.player} tab.`,
            lookAtSelector: tabSelector,
            onSkip: skipPhase,
            skipLabel: "Skip section",
            onDismiss: dismiss,
            dismissLabel: "Skip tutorial",
          },
        };
      }

      // Shipyards trade ship blueprints, not goods — no `data-tutorial-buy-good`
      // rows exist in their version of the markets pane. The engine doesn't
      // know that and will happily recommend a buy here, leaving the orb
      // pointing at nothing. Override with a clear "head out" nudge so
      // the player isn't stranded with a dead spotlight.
      const loc = world.locations[ship.location];
      const isShipyard = loc?.traits.tags.includes("shipyard") ?? false;
      if (ship.state === "idle" && isShipyard) {
        const travelSelector = `[data-tutorial="travel-panel"]`;
        return {
          overlay: { selector: travelSelector, padding: 8 },
          helper: {
            title: "Wrong stop",
            body: "Shipyards trade hulls, not goods. Pick a neighbour from the travel panel and we'll resume coaching wherever you land.",
            lookAtSelector: travelSelector,
            onSkip: skipPhase,
            skipLabel: "Skip section",
            onDismiss: dismiss,
            dismissLabel: "Skip tutorial",
          },
        };
      }

      // No engine recommendation right now (engine returned `wait`, or
      // everything resolved to nothing). Keep the orb visible with a
      // generic nudge instead of vanishing — disappearing tutorial reads
      // as "the game broke".
      if (!cargoHint) {
        const travelSelector = `[data-tutorial="travel-panel"]`;
        return {
          overlay: { selector: travelSelector, padding: 8 },
          helper: {
            title: "Catch your breath",
            body: "No clear move from here right now. Browse the travel panel and pick somewhere — I'll pop back in once there's something to act on.",
            lookAtSelector: travelSelector,
            onSkip: skipPhase,
            skipLabel: "Skip section",
            onDismiss: dismiss,
            dismissLabel: "Skip tutorial",
          },
        };
      }

      if (cargoHint.requiredFleetTab && fleetTab !== cargoHint.requiredFleetTab) {
        // Resolution can override the spotlight target when the named
        // fleet tab is ambiguous between cards (e.g. "contracts" exists
        // on both the ship card and the markets card, but only the
        // markets-card version has the actionable Take button).
        const subTabSelector = cargoHint.subTabSelector
          ?? `[data-tutorial-fleet-tab="${cargoHint.requiredFleetTab}"]`;
        const subTabName = FLEET_TAB_LABELS[cargoHint.requiredFleetTab];

        // First-time-mechanic tab nav: voiced "Next we'll learn about X"
        // cue that hands off to the action intro on the next render.
        // Plain "Switch panel" prompt is the fallback for repeated
        // navigation later in the run.
        if (activeNextIntro) {
          return {
            overlay: { selector: subTabSelector, padding: 4 },
            helper: {
              title: activeNextIntro.title,
              body: formatTutorialBody(activeNextIntro.body),
              lookAtSelector: subTabSelector,
              onSkip: skipPhase,
              skipLabel: "Skip section",
              onDismiss: dismiss,
              dismissLabel: "Skip tutorial",
              audioControls,
            },
          };
        }

        return {
          overlay: { selector: subTabSelector, padding: 4 },
          helper: {
            title: "Switch panel",
            body: `Open the ${subTabName} panel.`,
            lookAtSelector: subTabSelector,
            onSkip: skipPhase,
            skipLabel: "Skip section",
            onDismiss: dismiss,
            dismissLabel: "Skip tutorial",
          },
        };
      }

      const loopsDone = tutorialLoopsCompleted(world);
      const goal = tutorial.loopGoal ?? 1;
      // Default goal is 1, so a "Loop 1/1" prefix is just noise. We
      // only surface the lap counter when the player has opted into
      // extra laps via the fork ("Another logistics route") — at that
      // point seeing "Lap 2/2" tells them where they are in the run
      // they explicitly asked for.
      const loopLabel = goal > 1 ? `Lap ${Math.min(loopsDone + 1, goal)}/${goal}` : null;

      // First-time intro override: replace the snappy one-line body with
      // the full mechanic explanation + voice. Drop the loop label so
      // the intro reads as a single teaching beat rather than "Loop 1/3
      // — Take a contract." Once the player accepts, perTypeCount flips
      // and we fall back through to the standard render below.
      if (activeIntro) {
        return {
          overlay: { selector: cargoHint.selector, padding: 8 },
          helper: {
            title: activeIntro.title,
            body: formatTutorialBody(activeIntro.body),
            lookAtSelector: cargoHint.selector,
            onSkip: skipPhase,
            skipLabel: "Skip section",
            onDismiss: dismiss,
            dismissLabel: "Skip tutorial",
            audioControls,
          },
        };
      }

      return {
        overlay: { selector: cargoHint.selector, padding: 8 },
        helper: {
          title: loopLabel ? `${loopLabel} · ${cargoHint.title}` : cargoHint.title,
          body: cargoHint.body,
          lookAtSelector: cargoHint.selector,
          onSkip: skipPhase,
          skipLabel: "Skip section",
          onDismiss: dismiss,
          dismissLabel: "Skip tutorial",
          // Cues ride on top of the engine's body copy — when one is
          // playing, surface the audio controls so the player can mute
          // / replay it without anywhere to put the body intro UI.
          audioControls: activeCue ? audioControls : undefined,
        },
      };
    }

    // exchange phase
    const tradesDone = tutorial.perTypeCount.stock_trade ?? 0;
    const tradeLabel = `Trade ${Math.min(tradesDone + 1, TUTORIAL_EXCHANGE_TRADES)}/${TUTORIAL_EXCHANGE_TRADES}`;
    if (selectedTab !== "stocks") {
      const tabSelector = `[data-tutorial="tab-stocks"]`;
      return {
        overlay: { selector: tabSelector, padding: 4 },
        helper: {
          title: `${tradeLabel} · Open Exchange`,
          body: "Open the Exchange tab.",
          lookAtSelector: tabSelector,
          onSkip: finish,
          skipLabel: "Finish tutorial",
          onDismiss: dismiss,
          dismissLabel: "Skip tutorial",
        },
      };
    }
    if (!stockHint) {
      return {
        overlay: { selector: `[data-tutorial="stocks-list"]`, padding: 8 },
        helper: {
          title: `${tradeLabel} · Watch the tape`,
          body: "No clear edge right now. Browse the equities — a hint will appear when one shows up.",
          lookAtSelector: `[data-tutorial="stocks-list"]`,
          onSkip: finish,
          skipLabel: "Finish tutorial",
          onDismiss: dismiss,
          dismissLabel: "Skip tutorial",
        },
      };
    }
    // Kind-filter gate — if the player has narrowed the equity list to a
    // kind that doesn't include the recommended row, the spotlight target
    // would be hidden behind the filter (the row is unmounted). The
    // matching kind tab already wears a .has-suggestion indicator from
    // the existing guidance pipeline, so spotlighting THAT tab is a clean
    // hand-off — once the player clicks it, the row mounts and the orb
    // pivots to the action target.
    const equityKind = stockHint.hint.equityKind;
    const playerHasPosition = !!world.player?.positions?.[stockHint.hint.equityId];
    const filterIncludesEquity =
      stockKindFilter === "all"
      || stockKindFilter === equityKind
      || (stockKindFilter === "positions" && playerHasPosition);
    if (!filterIncludesEquity) {
      const kindTabSelector = `[data-tutorial-stock-kind="${equityKind}"]`;
      return {
        overlay: { selector: kindTabSelector, padding: 4 },
        helper: {
          title: `${tradeLabel} · Switch filter`,
          body: `The recommended trade is hiding behind the filter. Open the ${KIND_TAB_LABELS[equityKind]} tab to see ${stockHint.hint.ticker}.`,
          lookAtSelector: kindTabSelector,
          onSkip: finish,
          skipLabel: "Finish tutorial",
          onDismiss: dismiss,
          dismissLabel: "Skip tutorial",
        },
      };
    }
    // Once the player clicks the recommended row, the InfoColumn on the
    // right mounts the trade controls (Buy / Short / Sell / Cover). Move
    // the spotlight onto the actual button so the rest of the workflow
    // — qty input + click — is guided too. Engine action names map to
    // the data-tutorial-trade-action values we tag in TradeSide and the
    // positions-panel close button.
    const hintAction = stockHint.hint.action;
    const tradeButtonAction =
      hintAction === "buy" ? "buy"
      : hintAction === "short" ? "short"
      : hintAction === "sell" ? "sell"
      : hintAction === "cover" ? "cover"
      : null;
    if (selectedEquity === stockHint.hint.equityId && tradeButtonAction) {
      const actionSelector = `[data-tutorial-trade-action="${tradeButtonAction}"]`;
      return {
        overlay: { selector: actionSelector, padding: 6 },
        helper: {
          title: `${tradeLabel} · ${stockHint.title}`,
          body: stockHint.body,
          lookAtSelector: actionSelector,
          onSkip: finish,
          skipLabel: "Finish tutorial",
          onDismiss: dismiss,
          dismissLabel: "Skip tutorial",
        },
      };
    }
    return {
      overlay: { selector: stockHint.selector, padding: 8 },
      helper: {
        title: `${tradeLabel} · ${stockHint.title}`,
        body: stockHint.body,
        lookAtSelector: stockHint.selector,
        onSkip: finish,
        skipLabel: "Finish tutorial",
        onDismiss: dismiss,
        dismissLabel: "Skip tutorial",
      },
    };
  })();

  if (!config) return null;

  // Single render path: the same TutorialHelper / TutorialOverlay
  // instances stay mounted across all step transitions. Only their
  // props change, so React reconciles in place — no model-viewer
  // re-init, no bubble fade replay, no orientation reset.
  return (
    <>
      <TutorialOverlay
        selector={config.overlay?.selector ?? null}
        padding={config.overlay?.padding}
        radius={config.overlay?.radius}
        fullDim={config.overlay?.fullDim ?? false}
        interactive={config.overlay?.interactive ?? false}
      />
      <TutorialHelper {...config.helper} />
    </>
  );
}

const KIND_TAB_LABELS: Record<"station" | "syndicate" | "commodity" | "basis" | "futures" | "index", string> = {
  station: "Stations",
  syndicate: "Syndicates",
  commodity: "Commodities",
  basis: "Basis",
  futures: "Futures",
  index: "Index",
};

const TAB_LABELS: Record<"player" | "stocks" | "markets" | "locations" | "charters", string> = {
  player: "Cargo",
  stocks: "Exchange",
  markets: "Markets",
  locations: "Atlas",
  charters: "Ledger",
};

const FLEET_TAB_LABELS: Record<"cargo" | "upgrades" | "crew" | "contracts", string> = {
  cargo: "Cargo",
  upgrades: "Upgrades",
  crew: "Crew",
  contracts: "Contracts",
};
