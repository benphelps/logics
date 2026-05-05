import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";
import {
  INTERFACE_TOUR,
  TUTORIAL_EXCHANGE_TRADES,
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
  // while it's mounted; the moment confirmNewGame fires (or the player
  // cancels) pendingNewGame goes null and we move into the interface
  // tour with the freshly-built world.
  useEffect(() => {
    if (!tutorial) return;
    if (tutorial.phase === "setup" && !pendingNewGame) {
      advanceSetup();
    }
  }, [tutorial, pendingNewGame, advanceSetup]);

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
      if (!pendingNewGame) return null;
      switch (pendingNewGame.phase) {
        case "intro":
          return {
            helper: {
              title: "Welcome aboard",
              body: "I'm your onboard helper — I'll keep showing up while you find your feet. Skim the cards, then hit Continue when you're ready.",
              onDismiss: dismiss,
              dismissLabel: "Skip tutorial",
              fallbackPlacement: "bottom-right",
            },
          };
        case "pilot":
          return {
            helper: {
              title: "Build your captain",
              body: "Roll a name with the dice if nothing's coming to you. Pick traits, then click reroll for a portrait — takes about fifteen seconds. Hit Continue when you're set.",
              onDismiss: dismiss,
              dismissLabel: "Skip tutorial",
              fallbackPlacement: "bottom-right",
            },
          };
        case "syndicate":
          return {
            helper: {
              title: "Pick your faction",
              body: "Each syndicate sets your colors and your starting station. The trait card shows their edge. Click one and hit Begin — you're stuck with the choice.",
              onDismiss: dismiss,
              dismissLabel: "Skip tutorial",
              fallbackPlacement: "bottom-right",
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
    if (world.pendingEncounter && !tutorial.combatSeen) {
      const stop = tutorial.combatStop ?? 0;
      const inMainTutorial =
        tutorial.phase !== "done" && tutorial.phase !== "skipped";

      // Stop 0: intro monologue, no spotlight inside the modal — let
      // the player read the stat card, then click Next.
      if (stop === 0) {
        const intro = inMainTutorial
          ? "I knew this was going to happen! Looks like we got into a bit of a scuffle. Want some tips on getting out alive?"
          : "Hey, it's you again! First combat encounter — let me run you through the basics real quick.";
        return {
          helper: {
            title: "Combat 101",
            body: intro,
            onAdvance: advanceCombat,
            advanceLabel: "Tips, please",
            onSkip: finishCombat,
            skipLabel: "I've got this",
          },
        };
      }

      // Past intro — modal phase decides what to surface.
      if (encounterPhase === "rolling") {
        // Dice are spinning — too fast to spotlight anything useful.
        // Drop a quick easter-egg line so the orb has personality
        // through the gap.
        return {
          helper: {
            title: "Rolling…",
            body: "Don't blink. The dice gods are voting.",
          },
        };
      }

      if (encounterPhase === "revealed") {
        // Resolution panel is up — spotlight the Continue button and
        // tell the player to read the message above it. The reveal
        // contains the loss/gain summary — players actually want to
        // see that, so we don't cover the panel itself.
        const continueSelector = `[data-tutorial="encounter-continue"]`;
        return {
          overlay: { selector: continueSelector, padding: 6 },
          helper: {
            title: "Read it and weep (or cheer)",
            body: "The panel above tells you what just happened — gains, losses, hull damage. Once you've taken it in, hit Continue to wrap up.",
            lookAtSelector: continueSelector,
            onSkip: finishCombat,
            skipLabel: "Got it",
          },
        };
      }

      // Default: choosing phase (or stale state) — spotlight the
      // recommended action card. The card already wears a `.recommended`
      // class and a green-glow visual treatment; we just point at it.
      const recommendedSelector = `[data-tutorial-encounter-recommended="true"]`;
      return {
        overlay: { selector: recommendedSelector, padding: 6 },
        helper: {
          title: "Pick the recommended move",
          body: "Each option shows your odds and what it'll cost if it flops. The highlighted one is the engine's pick — usually flee, but trust it either way.",
          lookAtSelector: recommendedSelector,
          onSkip: finishCombat,
          skipLabel: "I've got this",
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
          body: tourStopDef.body,
          lookAtSelector: tourStopDef.selector,
          onAdvance: advanceTour,
          advanceLabel: isLast ? "Start playing" : "Next",
          onSkip: skipTour,
          skipLabel: "Skip tour",
          onDismiss: dismiss,
          dismissLabel: "Skip tutorial",
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
        const subTabSelector = `[data-tutorial-fleet-tab="${cargoHint.requiredFleetTab}"]`;
        const subTabName = FLEET_TAB_LABELS[cargoHint.requiredFleetTab];
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
      const goal = tutorial.loopGoal ?? 3;
      const loopLabel = `Loop ${Math.min(loopsDone + 1, goal)}/${goal}`;
      return {
        overlay: { selector: cargoHint.selector, padding: 8 },
        helper: {
          title: `${loopLabel} · ${cargoHint.title}`,
          body: cargoHint.body,
          lookAtSelector: cargoHint.selector,
          onSkip: skipPhase,
          skipLabel: "Skip section",
          onDismiss: dismiss,
          dismissLabel: "Skip tutorial",
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
