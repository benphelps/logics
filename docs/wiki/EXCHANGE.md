# Exchange

Exchange is the market screen for trading Ledgway assets from the selected player ship. It now covers station shares, syndicate shares, commodity spot listings, station basis pairs, futures contracts, and indices.

The screen is not a separate bank. Order entry, margin, short proceeds, fees, and settlement cash all use the active ship's wallet.

## Screen Layout

The Exchange has two working zones:

- The left side contains the listing browser and the player account panel.
- The right side contains the selected market's quote, chart, fundamentals, live book, tape, and order entry.

The listing browser stays visible while you inspect a market. The account panel below it switches between Positions, Orders, Futures, and History so you can manage exposure without leaving the selected quote.

## Listing Browser

The browser lists every tradable instrument and groups them with filter tabs.

Each row shows:

- ticker
- listing name
- asset kind
- current price
- current percent move

Rows with player exposure are pushed toward the top. After that, listings sort by the largest current move, then by name. Station rows can move into an Out of range group when the selected ship is too far away to trade that station.

## Asset Types

### Station Shares

Station shares represent one station's local economy. Their fair value is driven mainly by treasury health, with a smaller net-trade modifier.

Strong stations usually have healthy treasuries, active logistics flow, and prices above IPO. Drained stations can trade lower and may become short candidates.

Station shares are the only current asset type with route-range trading access. The ship must be within 3 hops of the listed station.

### Syndicate Shares

Syndicate shares represent NPC shipping groups. Their price reacts to member ship wealth, syndicate treasury, and recent revenue.

Syndicate books use network access, so they can be traded from any docked location.

### Commodity Spot Listings

Commodity listings track a universe-wide spot index for a good. The price is based on volume-weighted station prices and stock.

These are useful when you want exposure to the whole logistics economy for a good instead of one station's local market.

### Basis Pairs

Basis listings connect one station and one good. The detail panel shows the station, good, local price, spread versus universe spot, and local stock.

The basis listing itself trades like an Exchange asset, while the underlying panel tells you whether the local station price is rich or cheap versus the broader market.

### Futures Contracts

Futures are listed per good with near and far expiries. A futures row has a matching contract record that defines the underlying commodity, contract size, expiry tick, margin fraction, open interest, and delivery station.

Opening a futures position locks initial margin and pays the broker fee. Mark-to-market runs every 4 ticks against the underlying spot commodity price.

Short futures can settle by physical delivery at expiry when the selected ship is at the delivery station with enough matching cargo.

### Indices

Index listings summarize baskets instead of one entity. Sector indices track groups of commodity listings. The Treasury Index Note summarizes station treasury health across the world.

Indices use network access.

## Access And Wallet

Exchange actions use the active player ship as the anchor.

Rules:

- The ship must be docked for order entry.
- Station shares require the ship to be within 3 hops of the station.
- Syndicate, commodity, basis, futures, and index listings use network access.
- Buy limits reserve cash plus fee from the ship wallet.
- Sell limits reserve shares from an existing long position.
- Futures reserve margin plus fee.
- Shorts credit proceeds to the ship wallet when opened, then charge borrow fees while held.

If a listing is visible but not tradable, the order form explains the blocker.

## Detail Column

The selected listing's detail column is the main work area.

It includes:

- art and listing identity
- current quote and price change
- price and volume chart
- KPI panel
- underlying panel
- order book
- time and sales
- spot order form or futures order form

If the player has a position in the selected asset, the chart can show entry, stop-loss, and take-profit reference lines.

## KPI And Underlying

The KPI panel summarizes live trading conditions.

It shows:

- best bid
- best ask
- spread
- price versus IPO anchor
- recent volume
- recent high and low
- shares outstanding
- latest dividend per share
- ticks until the next dividend window

The Underlying panel changes by asset type:

| Asset | Underlying data |
|---|---|
| Station | treasury, target, population, tech level, net trade |
| Syndicate | ship count, member wealth, treasury, recent revenue, lead ship |
| Commodity | category, base price, spot index, universe stock |
| Basis | station, good, local price, spread versus spot, local stock |
| Futures | good, contract size, expiry, spot, notional, margin, open interest |
| Index | sector basket members, or aggregate treasury health |

## Order Book And Tape

The order book shows visible bid and ask depth.

- Asks are sell orders above the spread.
- Bids are buy orders below the spread.
- Size is the quantity at that level.
- Cum is cumulative depth as you move away from the spread.

Matching uses price-time priority. Crossing orders fill at the resting order's price, older orders at the same price fill first, and self-trades are prevented.

The time and sales tape shows recent fills for the selected listing. A buy-side tape row means the buyer took liquidity from asks. A sell-side tape row means the seller hit bids.

## Placing Orders

Spot-style assets use the Place order form.

Buy:

- creates a limit buy order
- reserves quantity times limit price plus broker fee
- opens or adds to a long position when filled
- cannot be used while already short the same ticker

Sell:

- creates a limit sell order
- requires an existing long position
- reserves shares until filled or canceled
- reduces or closes the long when filled

Short:

- opens or adds to a short with a market order
- cannot be used while already long the same ticker
- receives short proceeds minus fee
- later needs to be covered by buying back shares

The Use spot button copies the current quote into the limit price field. It does not turn the order into a guaranteed market fill.

## Positions Tab

Positions lists open long and short spot positions.

The collapsed row shows:

- ticker
- side
- shares
- average entry
- unrealized profit or loss

Expanding a row shows mark, value, exposure, P&L, held ticks, close controls, stop-loss, take-profit, and abandon.

Longs close by selling. Shorts close by covering. Place limit posts a closing limit order; Sell all or Cover all tries to close immediately against the current book.

## Stops And Takes

Every spot position can have a stop-loss and a take-profit.

For a long:

- stop-loss triggers when price is at or below the stop
- take-profit triggers when price is at or above the target

For a short:

- stop-loss triggers when price is at or above the stop
- take-profit triggers when price is at or below the target

Triggers are checked after price updates. A triggered close attempts the normal close path for the entire position. If the close cannot complete, the emergency abandon path can settle the position with the abandon penalty.

## Orders Tab

Orders lists the player's resting spot limit orders.

Each row shows:

- ticker
- side
- remaining shares
- limit price
- order age

Expanding an order lets you adjust quantity, adjust price, use the current spot quote, or cancel.

Adjust is a cancel-and-replace operation. Buy cancellations refund unfilled reserved cash. Sell cancellations release unfilled reserved shares.

## Futures Contracts

Futures have a separate order form because they use contracts instead of shares.

The form shows:

- contract count
- current spot mark
- contract size
- notional value
- required margin
- broker fee
- ticks to expiry
- Open Long and Open Short actions

You can add to an existing futures position in the same direction. You cannot flip directly from long to short, or short to long; close the existing position first.

## Futures Positions Tab

The Futures tab lists open futures positions.

The expanded row shows:

- mark
- entry
- contract size
- notional
- posted margin
- unrealized P&L
- ticks to expiry
- ticks held
- delivery station

Short futures also show whether physical delivery is ready. Physical delivery requires the ship to be at the contract delivery station with contract size times contracts of the underlying good in cargo when the contract expires.

## History Tab

History is the player trade ledger.

Rows include:

- tick
- action
- ticker
- quantity
- execution price
- cash flow
- realized P&L when applicable

Trade actions include open long, add long, close long, open short, add short, and cover short. Triggered exits can be tagged as stop-loss or take-profit.

## Dividends Borrow Fees And Settlements

Dividends run every 200 ticks.

Station dividends come from treasury surplus. Syndicate dividends come from syndicate treasury. Commodity, basis, futures, and index listings do not currently pay dividends.

Long spot positions receive dividends. Short spot positions owe dividends back to the underlying. Some ship modifiers can increase long-position dividend payouts.

Short positions also pay a per-tick borrow fee based on notional value.

Closing station shares can create Exchange settlement jobs. Profits and loss-review payments may need to be collected at the station unless the ship has remote settlement collection. Non-station assets settle directly through the ship wallet.

Abandon is the emergency spot-position exit. It settles at the current mark with an extra 5% penalty and records the result in the ledger.

## Important Numbers

| Rule | Current value |
|---|---:|
| Station equity trade range | 3 hops |
| Broker fee | 1% per trade leg |
| Dividend interval | 200 ticks |
| Dividend payout fraction | 5% |
| Short borrow fee | 0.01% of notional per tick |
| Abandon penalty | 5% |
| Price clamp | 0.1x to 10x IPO anchor |
| Price smoothing | 10% toward fair value per stock tick |
| Price noise | +/-0.25% per tick |
| Shares outstanding per spot listing | 10,000 |
| Equity history cap | 150 points |
| Recent fills cap | 100 trades |
| Visible order book levels | 6 per side |
| Time and sales rows | 13 |
| Basis listings | 2 per station, capped at 20 |
| Futures expiries | near 500 ticks, far 1500 ticks |
| Default futures margin | 10% |
| Default futures contract size | 100 units |
| Futures mark-to-market cadence | every 4 ticks |
| NPC stock-agent decision interval | 4 ticks |
| NPC stock-agent order TTL | 8 ticks |
| NPC stock-agent starting wallet | Ç100,000 |
| Synthetic market-maker half-spread | 2% |
| Synthetic market-maker depth | 250 |

## Source Notes

This page is based on the current Exchange UI and mechanics in:

- `src/ui/views/StockMarketView.tsx`
- `src/ui/store.ts`
- `src/sim/stock.ts`
- `src/sim/stock/futures.ts`
- `src/sim/stock/orderbook.ts`
- `src/sim/stock/agents.ts`
- `src/sim/stock/market-maker.ts`
- `src/sim/types.ts`
