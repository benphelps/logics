# Markets

Markets is the commodity logistics screen. Use it when you want to compare goods across the whole sector before deciding what the Cargo screen should actually move.

Unlike Exchange, Markets is not an order-entry screen. It reads physical station markets and turns them into a commodity desk: universe spot price, stock depth, low asks, high bids, spread, spot history, producers, and consumers.

## Screen Layout

The screen has two main zones:

- The left browser lists commodities and category tabs.
- The right detail column explains the selected commodity with art, quote, chart, spot stats, logistics stats, best asks, best bids, producers, and consumers.

Clicking a row selects that good. The selected good also controls the detail chart and the lists underneath it.

## Commodity Browser

The browser is sortable. Each commodity row shows:

- commodity name and category
- universe spot price
- total stock depth across active markets
- lowest station ask
- highest station bid
- spread between the best ask and best bid

High spread is a route-finding signal. It does not guarantee a profitable route by itself because Cargo still needs to account for distance, fuel, maintenance, docking, cargo mass, station stock, and ship funds.

## Category Tabs

The tabs filter the commodity list:

| Tab | What it shows |
|---|---|
| Commodities | All non-upgrade goods. |
| Food | Food goods. |
| Raw | Raw inputs. |
| Parts | Intermediate goods. |
| Fuel | Fuel goods that can refill compatible ships. |
| Advanced | Advanced production goods. |
| Luxury | Luxury goods. |
| Upgrades | Upgrade-module goods. |

Upgrade goods can appear in Markets because they are goods in the economy, but buying and installing modules still happens from Cargo at a station or shipyard.

## Spot Chart

The Universe Spot chart tracks the selected good's volume-weighted station price history. It is separate from the Exchange's commodity listing chart, which is smoothed through the tradable market system.

The base-price reference line helps show whether the current sector price is rich or cheap compared with the good's catalog base price.

## Spot And Logistics

The Spot panel shows:

- current universe spot price
- base price and spot/base ratio
- unit mass
- total stock and target stock
- stock health
- spread

The Logistics panel shows:

- active markets
- producer count
- consumer count
- total production per tick
- total consumption per tick
- net production minus consumption
- estimated ticks of supply at current consumption

These panels are best for deciding whether a good is scarce, oversupplied, or simply volatile.

## Best Asks And Best Bids

Best Asks lists stations selling the good at the lowest prices. Best Bids lists stations where the target stock suggests demand and price support.

Use the pair together:

- Low ask plus high bid means the good may be worth hauling.
- High bid at a far station may still be bad if route costs are high.
- Low ask at a station with tiny stock may be hard to scale.
- A good spread is only a starting point; confirm the route in Cargo's trade helper.

## Producers And Consumers

Top Producers lists stations producing the selected good and their production rate per tick. Top Consumers lists stations consuming it and their consumption rate per tick.

Producer and consumer lists explain why a spread exists. A shortage at a high-consumption station is more durable than a one-tick price spike, while a large producer can keep restocking a low ask.

## Related Pages

- [`MY_FLEET.md`](MY_FLEET.md) for buying, selling, and route-aware profit checks.
- [`EXCHANGE.md`](EXCHANGE.md) for tradable commodity listings, futures, basis, and indices.
- [`ATLAS.md`](ATLAS.md) for station context and route geography.

## Source Notes

This page is based on:

- `src/ui/views/MarketsView.tsx`
- `src/ui/views/StockMarketView.tsx`
- `src/sim/stock.ts`
- `src/sim/pricing.ts`
- `src/sim/economy.ts`
- `src/sim/types.ts`
