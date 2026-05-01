import { hasCrew } from "../crew";
import type { EquityId, Trader, TraderId, World } from "../types";
import { coverShares, placeLimitBuy, placeLimitSell, shortShares } from "../stock";
import { listStockExchangeHints, type StockExchangeHint, type StockExchangeHintAction } from "./suggestions";

export const PLAYER_STOCK_AUTOPILOT_MAX_ACTIONS_PER_TICK = 3;

const PLAYER_STOCK_AUTOPILOT_ACTIONS = new Set<StockExchangeHintAction>([
  "buy",
  "sell",
  "short",
  "cover",
]);

export interface PlayerStockAutopilotAction {
  shipId: TraderId;
  equityId: EquityId;
  action: StockExchangeHintAction;
  ok: boolean;
  reason?: string;
}

export function runPlayerStockAutopilot(
  world: World,
  maxActions = PLAYER_STOCK_AUTOPILOT_MAX_ACTIONS_PER_TICK,
): PlayerStockAutopilotAction[] {
  const ships = eligibleStockAutopilotShips(world);
  const actions: PlayerStockAutopilotAction[] = [];
  const attempts = Math.max(0, Math.floor(maxActions));
  const attemptedKeys = new Set<string>();
  if (ships.length === 0 || attempts <= 0) return actions;

  for (let i = 0; i < attempts; i++) {
    const next = bestExecutableHint(world, ships, attemptedKeys);
    if (!next) break;

    const key = hintAttemptKey(next.ship.id, next.hint);
    attemptedKeys.add(key);
    const result = executePlayerStockHint(world, next.ship, next.hint);
    actions.push({
      shipId: next.ship.id,
      equityId: next.hint.equityId,
      action: next.hint.action,
      ok: result.ok,
      reason: result.ok ? undefined : result.reason,
    });
  }

  return actions;
}

function eligibleStockAutopilotShips(world: World): Trader[] {
  const ids = world.player?.shipIds ?? [];
  return ids
    .map(id => world.traders[id])
    .filter((ship): ship is Trader => !!ship
      && ship.pilot === "auto"
      && ship.state === "idle"
      && hasCrew(ship, "captain")
      && hasCrew(ship, "navigator"));
}

function bestExecutableHint(
  world: World,
  ships: Trader[],
  attemptedKeys: Set<string>,
): { ship: Trader; hint: StockExchangeHint } | null {
  let best: { ship: Trader; hint: StockExchangeHint } | null = null;
  const limit = Math.max(1, Object.keys(world.equities).length);

  for (const ship of ships) {
    const hint = listStockExchangeHints(world, ship.id, limit)
      .find(h => h.executable
        && PLAYER_STOCK_AUTOPILOT_ACTIONS.has(h.action)
        && !attemptedKeys.has(hintAttemptKey(ship.id, h)));
    if (!hint) continue;
    if (!best || hint.score > best.hint.score) best = { ship, hint };
  }

  return best;
}

function executePlayerStockHint(
  world: World,
  ship: Trader,
  hint: StockExchangeHint,
): { ok: true } | { ok: false; reason: string } {
  const units = Math.max(1, Math.floor(hint.suggestedUnits ?? 1));
  const limitPrice = hint.suggestedLimitPrice ?? hint.price;

  switch (hint.action) {
    case "buy":
      return runAsAutopilotAction(world, () => placeLimitBuy(world, hint.equityId, units, limitPrice, ship.id));
    case "sell":
      return runAsAutopilotAction(world, () => placeLimitSell(world, hint.equityId, units, limitPrice, ship.id));
    case "short":
      return runAsAutopilotAction(world, () => shortShares(world, hint.equityId, units, ship.id));
    case "cover":
      return runAsAutopilotAction(world, () => coverShares(world, hint.equityId, units, undefined, ship.id));
    default:
      return { ok: false, reason: `${hint.action} is not enabled for stock autopilot.` };
  }
}

function runAsAutopilotAction<T extends { ok: boolean }>(world: World, action: () => T): T {
  const before = world.player?.manualActionCount;
  const result = action();
  if (world.player) {
    if (before == null) delete world.player.manualActionCount;
    else world.player.manualActionCount = before;
  }
  return result;
}

function hintAttemptKey(shipId: TraderId, hint: StockExchangeHint): string {
  return `${shipId}:${hint.equityId}:${hint.action}`;
}
