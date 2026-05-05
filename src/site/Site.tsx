import {
  GiCargoCrate,
  GiChart,
  GiFactory,
  GiPathDistance,
  GiRadarSweep,
  GiReceiveMoney,
  GiShipWheel,
  GiTrade,
} from "react-icons/gi";
import { MdArrowForward, MdPlayArrow } from "react-icons/md";

const tabSections = [
  {
    id: "cargo",
    title: "Cargo",
    label: "Ship operations",
    image: "/site/screenshots/cargo.png",
    intro:
      "The working screen for ships, cargo, contracts, upgrades, crew, and the dockside decisions that keep a route profitable.",
    cards: [
      { icon: GiCargoCrate, title: "Move freight", text: "Buy low, sell into demand, accept station contracts, and watch cargo, fuel, and hull condition." },
      { icon: GiShipWheel, title: "Delegate routes", text: "Crew turns proven manual decisions into auto-pilot work when a ship is ready." },
      { icon: GiPathDistance, title: "Scale the fleet", text: "Shipyards and charters push the run from one hauler into coordinated operations." },
    ],
  },
  {
    id: "exchange",
    title: "Exchange",
    label: "Asset market",
    image: "/site/screenshots/exchange.png",
    intro:
      "A market layer built on the same station economy you ship through, with order books, positions, futures, and readable trade history.",
    cards: [
      { icon: GiChart, title: "Read listings", text: "Filter station, syndicate, commodity, basis, futures, and index instruments." },
      { icon: GiTrade, title: "Place orders", text: "Work bids, asks, stops, take-profits, and active positions from one trading desk." },
      { icon: GiReceiveMoney, title: "Track exposure", text: "Insights and history show what filled, what is reserved, and where the account stands." },
    ],
  },
  {
    id: "atlas",
    title: "Atlas",
    label: "Route planning",
    image: "/site/screenshots/atlas.png",
    intro:
      "The sector view for understanding where ships can go, what each station does, and where the next hull or route should come from.",
    cards: [
      { icon: GiRadarSweep, title: "Plan routes", text: "Compare lanes, station roles, active ships, syndicate control, and travel constraints." },
      { icon: GiFactory, title: "Inspect stations", text: "Open local markets, production, consumption, contracts, and shipyard inventory." },
      { icon: GiPathDistance, title: "Avoid friction", text: "Lane danger and route state make long-running automated work easier to read." },
    ],
  },
];

const footerGroups = [
  {
    title: "Game",
    links: [
      { label: "Cargo", href: "#cargo" },
      { label: "Exchange", href: "#exchange" },
      { label: "Atlas", href: "#atlas" },
      { label: "Wiki", href: "/wiki.html" },
    ],
  },
  {
    title: "Build",
    links: [
      { label: "Open game", href: "/" },
      { label: "Wiki", href: "/wiki.html" },
      { label: "Website home", href: "/website.html" },
    ],
  },
];

export function Site() {
  return (
    <main className="site-shell">
      <section className="site-hero" aria-labelledby="site-title">
        <header className="site-nav" aria-label="Website navigation">
          <a className="site-brand" href="/website.html" aria-label="Ledgway website home">
            <img className="site-brand-wordmark" src="/site/ledgway-wordmark.svg" alt="" />
            <img className="site-brand-mark" src="/site/ledgway-mark.svg" alt="" />
          </a>
          <nav className="site-nav-links" aria-label="Page sections">
            <a href="#cargo">Cargo</a>
            <a href="#exchange">Exchange</a>
            <a href="#atlas">Atlas</a>
          </nav>
          <a className="site-link-button" href="/" aria-label="Open game">
            <MdPlayArrow aria-hidden="true" />
            <span>Open game</span>
          </a>
        </header>

        <div className="site-hero-content">
          <div className="site-hero-copy">
            <span className="site-kicker">Space trucking, coordination, and markets</span>
            <h1 id="site-title">Ledgway</h1>
            <p>
              A compact space logistics game built around three working screens: run cargo, trade the
              Exchange, and use the Atlas to plan the next move.
            </p>
            <div className="site-hero-actions">
              <a className="site-primary-action" href="/">
                <MdPlayArrow aria-hidden="true" />
                <span>Play the current build</span>
              </a>
              <a className="site-secondary-action" href="#cargo">
                <span>Tour the tabs</span>
                <MdArrowForward aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="site-hero-terminal" aria-label="Live route summary">
            <div className="terminal-bar">
              <span>Fleet Dispatch</span>
              <strong>Tick 12,840</strong>
            </div>
            <div className="route-readout">
              <span>Haven</span>
              <i />
              <span>Ironhold</span>
              <i />
              <span>Saffron Rim</span>
            </div>
            <dl className="terminal-grid">
              <div><dt>Cargo</dt><dd>Parts x42</dd></div>
              <div><dt>Spread</dt><dd>+31%</dd></div>
              <div><dt>Fuel</dt><dd>Plasma</dd></div>
              <div><dt>Mode</dt><dd>Auto</dd></div>
            </dl>
          </div>
        </div>
      </section>

      <section className="site-section site-tabs-band" aria-labelledby="tabs-title">
        <div className="site-section-inner">
          <div className="site-section-head">
            <span className="site-kicker">Current focus</span>
            <h2 id="tabs-title">Three tabs carry the route network</h2>
            <p>
              Cargo handles the ship work, Exchange handles the money work, and Atlas keeps the sector
              readable without burying the core loop.
            </p>
          </div>

          <div className="tab-feature-list">
            {tabSections.map((section, index) => {
              return (
                <article
                  className={`tab-feature ${index % 2 === 1 ? "tab-feature-reverse" : ""}`}
                  id={section.id}
                  key={section.title}
                >
                  <figure className="tab-feature-media">
                    <img src={section.image} alt={`${section.title} gameplay screenshot`} />
                  </figure>
                  <div className="tab-feature-copy">
                    <span className="site-kicker">{section.label}</span>
                    <h3>{section.title}</h3>
                    <p>{section.intro}</p>
                    <div className="tab-card-grid">
                      {section.cards.map((card) => {
                        const Icon = card.icon;
                        return (
                          <div className="tab-card" key={card.title}>
                            <Icon aria-hidden="true" />
                            <strong>{card.title}</strong>
                            <span>{card.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="site-section site-cta-band" aria-labelledby="cta-title">
        <div className="site-section-inner cta-layout">
          <div>
            <span className="site-kicker">Current build</span>
            <h2 id="cta-title">Run cargo, trade assets, map the sector.</h2>
          </div>
          <a className="site-primary-action" href="/">
            <MdPlayArrow aria-hidden="true" />
            <span>Open the game</span>
          </a>
        </div>
      </section>

      <footer className="site-footer" aria-label="Footer">
        <div className="site-footer-inner">
          <div className="footer-brand-block">
            <a className="footer-brand" href="/website.html" aria-label="Ledgway website home">
              <img src="/site/ledgway-wordmark.svg" alt="" />
            </a>
            <p>
              Space logistics trading, shipping, and automation in a compact browser idle game.
            </p>
          </div>

          <nav className="footer-links" aria-label="Footer links">
            {footerGroups.map((group) => (
              <section key={group.title} aria-labelledby={`footer-${group.title.toLowerCase()}`}>
                <h3 id={`footer-${group.title.toLowerCase()}`}>{group.title}</h3>
                {group.links.map((link) => (
                  <a href={link.href} key={link.label}>{link.label}</a>
                ))}
              </section>
            ))}
          </nav>
        </div>
        <div className="site-footer-bottom">
          <span>Copyright 2026 Ledgway</span>
          <span>Gameplay screenshots captured from the current local build.</span>
        </div>
      </footer>
    </main>
  );
}
