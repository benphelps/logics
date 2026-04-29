# Art Placement Report

This report tracks where existing art can be placed in the current UI, using the info-card art treatment as the reference pattern.

## Implemented Surfaces

| Surface | Art Resolver | Asset Family | Notes |
| --- | --- | --- | --- |
| Fleet info card | `shipArtUrl`, `stationArtUrl`, `goodArtUrl` | ships, stations, goods, upgrades | Existing primary info-card pattern. |
| Exchange/company info panel | `equityArtUrl` | stations, ships | Existing stock sidebar pattern; station equities use station art, syndicates reuse lead-ship art until dedicated company art exists. |
| Fleet ship card | `shipArtUrl` | ships | Added subtle background art behind status/cargo controls. |
| Fleet station exchange card | `stationArtUrl` | stations | Added station art behind markets/upgrades/offers/contracts. |
| Fleet travel card | `stationArtUrl` | stations | Added current-station art behind reachable-station list. |
| Markets commodity detail | `goodArtUrl` | goods, upgrades | Added selected-good art to the commodity sidebar. |
| Atlas selected port detail | `stationArtUrl` | stations | Added selected-station art to the Atlas detail sidebar. |
| Active/local contract rows | `jobArtUrl` | goods, stations, ships | Added compact thumbnails derived from existing art: shortage goods, rescue target ships, and trade settlement destination stations. |
| Fleet section headers | `headerArtUrl` | headers | Station goods, modules, crew board, local contracts, and active contracts now use matching header backdrops. |
| Markets board header | `headerArtUrl("marketBazaar")` | headers | Added a futuristic bazaar backdrop to the commodity board header. |
| Exchange panel headers | `headerArtUrl` | headers | Tape, positions, and trades now use trading-floor, portfolio, and settlement desk backdrops. |
| Atlas panel headers | `headerArtUrl` | headers | Stations and sector inset now use station-overview and sector-map backdrops. |

## Future Location Coverage

Generated and future locations are covered by `stationArtUrl`.

- Known generated archetypes resolve through subtype and scale keys, such as `mining:foundry` or `research:compact`.
- Unknown station-like locations fall back through `station:compact`, `station`, or `station:large`.
- Unique per-location portraits are optional polish rather than required coverage.

## Missing Pieces

Current runtime asset coverage is complete: ships, station archetypes/subtypes/scales, trade goods, upgrade slots, and header backdrops all resolve to existing files. Contract rows and syndicate panels reuse the same covered families.

New generation would only be needed for future surfaces that do not have a current resolver family:

- crew role or per-crew-member portraits
- company-specific logos or portraits beyond lead-ship art
- dedicated job-type art if row thumbnails need to distinguish jobs independently from goods, ships, and stations
- optional UI backdrops such as save slots or sector-map texture
- dedicated POI art if POIs become distinct from stations
- unique per-entity art if the game moves beyond archetype/family reuse

## Placement Guidance

Use art on focused/detail surfaces first. Avoid adding images to dense repeated table rows unless they are very small and carry clear meaning.

The working pattern is:

- art sits in the upper card area
- lower content remains dark and readable
- text gets shadow only when it overlays the art region
- repeated lists stay mostly table-like
- fallbacks use `src/ui/art.ts` rather than hard-coded image paths
