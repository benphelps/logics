export type GoodId = string;
export type LocationId = string;
export type TraderId = string;

export type GoodCategory = "food" | "raw" | "intermediate" | "luxury" | "fuel" | "advanced" | "upgrade";

export interface Good {
  id: GoodId;
  name: string;
  category: GoodCategory;
  basePrice: number;
  weight: number;
}

export interface ProductionEntry {
  good: GoodId;
  ratePerTick: number;
  inputs?: { good: GoodId; perUnit: number }[];
  requiresTechLevel?: number;
}

export interface ConsumptionEntry {
  good: GoodId;
  ratePerTick: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface LocationTraits {
  techLevel: number;
  tags: string[];
  faction?: string;
}

export interface LocationDef {
  id: LocationId;
  name: string;
  position: Position;
  population: number;
  traits: LocationTraits;
  primaryExports: GoodId[];
  primaryImports: GoodId[];
  produces: ProductionEntry[];
  consumes: ConsumptionEntry[];
  targetStock: Partial<Record<GoodId, number>>;
}

export type LaneMap = Record<LocationId, Record<LocationId, number>>;

export interface MarketState {
  stock: Record<GoodId, number>;
  prices: Record<GoodId, number>;
  // Local "city wallet" — every buy from this market deposits, every sell
  // withdraws. Replenished per tick from the abstract local economy
  // (residents earning + spending money outside the trader system) up to
  // `treasuryTarget`. When treasury runs low, sale prices get haircut so
  // the city can't pay infinite revenue forever — closes the money loop.
  treasury: number;
  treasuryTarget: number;
}

export type TraderState = "idle" | "transit";
export type PilotMode = "npc" | "manual" | "auto";

export interface FuelType {
  good: GoodId;
  perDistance: number;
}

export interface CargoLot {
  good: GoodId;
  qty: number;
  source: LocationId;       // where it was loaded (most recent for incremental adds)
  unitPrice: number;        // weighted-average cost basis per unit
  purchasedAt: number;      // tick of first purchase (oldest, for age calculations)
  unloadTicksRemaining?: number; // only set for lots in trader.unloadingCargo — each lot drips on its own schedule
}

export type CrewRole = "captain" | "navigator" | "mechanic";    // captain is displayed as Pilot; mercenary reserved for combat-era

// Modifiers a crew member contributes to the ship. Each field is additive
// across all hired crew. Stat-touching fields (cargo/speed/fuel/range) are
// recomputed onto the ship via recomputeShipStats(); action-time fields
// (buy/sell/contract %) are read at the moment of action — they're scaffolded
// here so future hires can carry them without a type change.
export interface CrewModifiers {
  cargoCapacityBonus?: number;        // +N flat cargo capacity
  fuelCapacityBonus?: number;         // +N flat fuel tank
  speedBonus?: number;                // +N flat ship speed
  hullBonus?: number;                 // +N structural rating; future dangerous jobs read this
  weaponPowerBonus?: number;          // +N weapon rating; future dangerous jobs read this
  rangeEfficiency?: number;           // 0.10 = 10% reduction in fuel-per-distance
  unloadSpeedBonus?: number;          // 1.00 = unload in half the normal ticks
  instantUnload?: number;             // >=1 = cargo sale/arrival unload settles immediately
  remoteSettlementCollection?: number;// >=1 = completed exchange settlements pay immediately
  instantTravel?: number;             // >=1 = plotted travel resolves on departure
  fuelFreeTravel?: number;            // >=1 = travel needs/burns no fuel
  buyDiscount?: number;               // 0.05 = 5% off buy price at markets
  sellPremium?: number;               // 0.05 = 5% bonus on sell to markets
  maintenanceDiscount?: number;       // 0.10 = 10% off maintenance/tick
  contractRewardBonus?: number;       // 0.10 = +10% contract reward on completion
  // Phase B additions — passive perks that tick alongside the trader pass.
  dockingDiscount?: number;           // 0.10 = 10% off docking fee
  fuelRegenIdle?: number;             // 0.5 = +0.5 fuel/tick passive top-up while docked
  treasuryYield?: number;             // 0.0005 = +0.05%/tick interest on idle ship funds
  dividendBonus?: number;             // 0.05 = +5% bonus on long-position dividend payouts
}

export interface CrewMember {
  id: string;
  role: CrewRole;
  name: string;
  tier: number;                       // 1-5, drives base price scaling
  hireCost: number;                   // one-time cost to sign on
  wagePerTick: number;                // ongoing cost charged each tick
  modifiers: CrewModifiers;
}

export type ShipCrew = Partial<Record<CrewRole, CrewMember>>;

export type HireId = string;

// A crew offer posted at a station. Same structural shape as CrewMember plus
// location + expiry — once hired, a CrewMember snapshot is copied onto the
// ship (so firing later doesn't accidentally re-list the offer).
export interface Hire {
  id: HireId;
  role: CrewRole;
  name: string;
  tier: number;
  hireCost: number;
  wagePerTick: number;
  modifiers: CrewModifiers;
  location: LocationId;
  postedTick: number;
  expiresAt: number;
}

export type UpgradeSlot = "cargo" | "engine" | "fuel" | "hull" | "weapon" | "systems";
export type UpgradeTier = 1 | 2 | 3 | 4;
export type ShipUpgradeSlots = Partial<Record<UpgradeSlot, GoodId>>;

export interface Trader {
  id: TraderId;
  name: string;

  // Effective stats (used by the sim — recomputed when crew/upgrades change).
  capacity: number;
  speed: number;
  fuelCapacity: number;

  // Base stats (the ship's intrinsic numbers — never change from crew/upgrades).
  // Optional for back-compat with traders constructed inline by older tests;
  // recomputeShipStats falls back to current effective values if base is unset.
  baseCapacity?: number;
  baseSpeed?: number;
  baseFuelCapacity?: number;
  baseHull?: number;
  baseWeaponPower?: number;
  hull?: number;
  weaponPower?: number;
  upgrades?: ShipUpgradeSlots;

  fuelTypes: FuelType[];
  currentFuel: { good: GoodId; qty: number } | null;
  funds: number;
  location: LocationId;
  state: TraderState;
  cargo: CargoLot[];                // active hold — what the player can sell, travel with, or display in the cargo card.
  unloadingCargo?: CargoLot[];      // lots committed to the in-progress drip-unload at the current location. Counts toward mass like cargo, but can't be retrieved.
  destination: LocationId | null;
  ticksRemaining: number;
  pilot: PilotMode;
  stuckTicks?: number;              // ticks the trader has been stuck (out of fuel + isolated). Drives rescue-job tier.
  noOpportunityTicks?: number;      // autonomous idle streak after finding no profitable work; drives repositioning.
  log: ShipLogEntry[];              // capped action history (oldest entries dropped). Drives the per-ship log card.
  crew?: ShipCrew;                  // player-only — NPCs operate without a crew model.
  maintenanceDebt?: number;         // accrued unpaid maintenance for player ships missing a mechanic.
  stockState?: ShipTraderState;     // Phase 2: agent stock-trading state (style, risk, positions). Optional so non-trading ships have nothing.
}

// --- agent stock-trading state ------------------------------------------
// Phase 2 of the order-book migration. Each NPC trader can carry an agent
// "personality" used by stock/agents.ts to post orders into the book each
// decision tick. The player ship does NOT use stockState; its positions
// live on world.player.positions with richer features (stops/takes/etc.).

export type AgentStyle = "value" | "momentum" | "contrarian" | "noise";

export interface AgentPosition {
  shares: number;             // signed: positive = long, negative = short
  avgEntryPrice: number;
  openedAt: number;           // tick when the position first opened
}

export interface ShipTraderState {
  style: AgentStyle;
  riskAppetite: number;       // 0..1, scales how much capital this agent commits per order
  // Dedicated stock-trading wallet, separate from trader.funds (which is the
  // cargo-trading wallet). This isolation prevents share-trading from
  // entangling with cargo flows and lets agents have meaningful trading
  // capital regardless of their cargo profitability. Initialized at world
  // creation; cash flows only between stockWallet and other stockWallets
  // (or the player ship.funds when player is the counterparty).
  stockWallet: number;
  positions: Record<EquityId, AgentPosition>;
  lastDecisionAt?: number;    // last world-tick on which this agent ran a decision
}

export type ShipLogTone = "good" | "bad" | "warn" | "info";

export interface ShipLogEntry {
  tick: number;
  kind: string;                     // "buy" | "sell" | "depart" | "arrive" | "refuel" | "stuck" | "job_accepted" | "job_completed" | "job_expired" | "job_abandoned"
  message: string;                  // pre-formatted, plain text
  tone?: ShipLogTone;
}

// TraderEvent lives here (not in traders.ts) so log.ts and other consumers
// can reference it without dragging in the trader runtime.
export interface TraderEvent {
  trader: string;
  kind: "buy" | "sell" | "depart" | "arrive" | "idle" | "refuel" | "stuck";
  good?: GoodId;
  qty?: number;
  unitPrice?: number;
  from?: LocationId;
  to?: LocationId;
}

export interface Player {
  funds: number;
  shipIds: TraderId[];
  // Long-only legacy holdings, kept around for save migration. Replaced by
  // `positions`. New writes always go through positions; this field is
  // backfilled from positions on read so downstream readers don't break
  // mid-migration. Will be removed once all consumers migrate.
  portfolio?: Record<EquityId, number>;
  // Modern position record: at most one position per equity, tagged long
  // or short, with weighted-average entry price + open tick.
  positions?: Record<EquityId, StockPosition>;
  // Trade ledger — chronological log of opens, adds, closes, covers, with
  // realized P&L on closes. Capped (oldest dropped) at TRADE_LEDGER_MAX.
  trades?: TradeRecord[];
  // Phase 4 — shares reserved against open sell limits, per equity.
  // sellableShares = position.shares − reservedShares[eqId]. Decrements on
  // sell-limit fill or cancel.
  reservedShares?: Record<EquityId, number>;
}

export type PositionKind = "long" | "short";

// A stock position. Named StockPosition (not just Position) because the
// existing Position interface is the coordinate type for locations.
export interface StockPosition {
  equityId: EquityId;
  kind: PositionKind;
  shares: number;          // always positive — sign carried by `kind`
  avgEntryPrice: number;   // weighted-average cost basis per share (pre-fee)
  openedAt: number;        // tick of the first entry
  // Optional auto-close thresholds. The semantics flip with the side:
  //   long  · stopLoss   triggers when price ≤ stopLoss
  //          takeProfit triggers when price ≥ takeProfit
  //   short · stopLoss   triggers when price ≥ stopLoss
  //          takeProfit triggers when price ≤ takeProfit
  // Triggers are evaluated per tick after price recompute. The first to fire
  // closes the entire position (no partial). Fall-back is `abandonPosition`
  // if the regular close path can't execute (e.g. treasury starved for a long
  // sell, player broke for a short cover).
  stopLoss?: number;
  takeProfit?: number;
}

export type TriggerKind = "stop_loss" | "take_profit";

export type TradeAction =
  | "open_long"
  | "add_long"
  | "close_long"
  | "open_short"
  | "add_short"
  | "cover_short";

export interface TradeRecord {
  id: string;
  tick: number;
  equityId: EquityId;
  ticker: string;
  action: TradeAction;
  shares: number;
  price: number;           // execution price per share, pre-fee
  fee: number;
  cashFlow: number;        // signed: +ve = into player wallet, -ve = out
  realizedPnl?: number;    // present on close_long / cover_short
  trigger?: TriggerKind;   // present when an auto-close fired the trade
}

// --- stock market types ----------------------------------------------------

export type EquityId = string;
export type EquityKind = "station" | "syndicate" | "commodity" | "basis";

export interface Equity {
  id: EquityId;
  kind: EquityKind;
  name: string;
  ticker: string;          // 3-4 char trading symbol, e.g., "HVN", "IRO"
  sharesOutstanding: number;
  // Current public quote per share. Recomputed each tick from the
  // underlying entity's economic health (treasury, traffic, etc.).
  price: number;
  // Anchor (IPO) price, used as the price clamp pivot. Clamped to
  // [0.1×, 10×] of anchor.
  anchorPrice: number;
  // Previous tick's price — surfaced for delta display.
  prevPrice?: number;
  // Reference to the underlying entity. For "station" equities this is the
  // LocationId. For "syndicate" equities, it's a SyndicateId pointing into
  // world.syndicates.
  underlyingId: string;
  // Recent history (capped) — used by the UI to draw sparklines.
  history?: { tick: number; price: number }[];
  // Last dividend paid per share (tick stamped). Anchor for "yield"
  // calculations in the UI.
  lastDividend?: { tick: number; perShare: number };
  // Recent fills against this equity's order book — capped sliding window
  // used by the UI for the Time & Sales tape, volume summary, and per-tick
  // volume histogram. Newest entries appended to the end; older entries
  // dropped once the cap is hit.
  recentTrades?: BookTrade[];
}

export type SyndicateId = string;

export interface Syndicate {
  id: SyndicateId;
  name: string;
  // The NPC ships that belong to this syndicate. The syndicate's "wealth"
  // is the sum of these ships' funds + an explicit treasury (the syndicate's
  // own cash float). Dividends are paid from the syndicate treasury.
  memberShipIds: TraderId[];
  treasury: number;
  // Trade volume tally over recent ticks (decays). Drives share-price drift —
  // active syndicates trade at a premium.
  recentRevenue: number;
}

export type JobKind = "shortage" | "rescue" | "trade";
export type JobTier = "low" | "medium" | "high";
export type JobId = string;

export interface TradeJobMeta {
  equityId: EquityId;
  ticker: string;
  action: Extract<TradeAction, "close_long" | "cover_short">;
  shares: number;
  realizedPnl: number;
  settlementKind: "profit" | "loss_forgiveness";
}

export interface Job {
  id: JobId;
  kind: JobKind;
  tier: JobTier;
  good?: GoodId;
  qty: number;
  destination: LocationId;
  reward: number;
  penalty: number;          // currency penalty if accepted-then-failed (0 for low tier)
  postedTick: number;
  expiresAt: number;
  acceptedBy: TraderId | null;
  delivered: number;        // running tally of delivered qty (for partial deliveries)
  rescueTarget?: TraderId;  // for rescue jobs only — informational
  trade?: TradeJobMeta;     // for exchange settlement jobs only
}

export interface World {
  tick: number;
  goods: Record<GoodId, Good>;
  locations: Record<LocationId, LocationDef>;
  markets: Record<LocationId, MarketState>;
  lanes: LaneMap;
  traders: Record<TraderId, Trader>;
  player: Player | null;
  jobs: Record<JobId, Job>;
  nextJobId: number;
  hires: Record<HireId, Hire>;
  nextHireId: number;
  // Stock market: the listed equities (stations + syndicates) and the
  // syndicate definitions themselves. Initialized in createWorld.
  equities: Record<EquityId, Equity>;
  syndicates: Record<SyndicateId, Syndicate>;
  // Order books: one per equity. Phase 1 of the order-book migration —
  // populated lazily by ensureOrderBook() and ticked alongside the rest of
  // the stock market. nextOrderId is a global monotonic counter for stable
  // ordering / determinism.
  orderBooks?: Record<EquityId, OrderBook>;
  nextOrderId?: number;
}

// --- order book ----------------------------------------------------------
// Phase 1 of the real-market migration. Each equity has a book of resting
// limit orders; market orders walk the book at fill time. See
// docs/STOCK_ORDERBOOK.md for the full design.

export type OrderId = string;
export type OrderSide = "bid" | "ask";
// "synthetic-mm" is the built-in market-maker that quotes both sides each
// tick to keep books liquid in Phase 1. Phase 2 will introduce real ship
// agents with TraderId-typed agentIds.
export type AgentId = TraderId | "synthetic-mm";

export interface Order {
  id: OrderId;
  equityId: EquityId;
  side: OrderSide;
  qty: number;          // remaining (decrements as it fills)
  limitPrice: number;
  agentId: AgentId;     // who placed it (used for self-trade prevention + ledger attribution)
  postedAt: number;     // world.tick when the order entered the book; ties broken by id afterward
  ttl?: number;         // ticks-to-live; if undefined, sits until matched or cancelled
}

export interface OrderBook {
  equityId: EquityId;
  bids: Order[];        // descending price (best at index 0); ties broken by postedAt then id
  asks: Order[];        // ascending price (best at index 0); same tie-break
}

export interface BookTrade {
  equityId: EquityId;
  qty: number;
  price: number;        // the resting order's limit price (taker pays the resting maker's quote)
  buyer: AgentId;
  seller: AgentId;
  takerSide: OrderSide; // which side aggressed
  tick: number;
}
