import {
  GiCargoCrate,
  GiChart,
  GiFactory,
  GiPathDistance,
  GiRadarSweep,
  GiReceiveMoney,
  GiShipWheel,
  GiTrade,
  GiUpgrade,
} from "react-icons/gi";
import { MdArrowForward, MdPlayArrow } from "react-icons/md";

const screenshots = [
  {
    title: "My Fleet",
    label: "Ship operations",
    image: "/site/screenshots/fleet.png",
    description: "Manage a growing roster of trading ships, from hands-on haulers to automated routes that keep earning.",
  },
  {
    title: "Exchange",
    label: "Asset market",
    image: "/site/screenshots/exchange.png",
    description: "Trade station, syndicate, commodity, basis, futures, and index assets in a full market desk.",
  },
  {
    title: "Markets",
    label: "Commodity logistics",
    image: "/site/screenshots/markets.png",
    description: "See who needs what, where supply is piling up, and which goods are worth moving across the sector.",
  },
  {
    title: "Atlas",
    label: "Route planning",
    image: "/site/screenshots/atlas.png",
    description: "View stations, lanes, and ships, then plan routes and guide vessels through the network.",
  },
];

const loops = [
  {
    title: "Click the profitable move",
    icon: GiReceiveMoney,
    text: "Start hands-on: scan prices, buy low, carry cargo, sell high, and collect contract bonuses.",
  },
  {
    title: "Automate the route",
    icon: GiShipWheel,
    text: "Hire crew, unlock auto-pilot behavior, and let captains keep ships moving while you tune the network.",
  },
  {
    title: "Scale into logistics",
    icon: GiPathDistance,
    text: "Grow from a single hauler to a managed fleet that feeds shortages, rescues stranded traders, and supplies advanced chains.",
  },
];

const features = [
  { icon: GiTrade, title: "Trading", text: "Commodity prices react to local stockpiles, production, and incoming cargo." },
  { icon: GiCargoCrate, title: "Shipping", text: "Ships have cargo, fuel, maintenance debt, wallets, and route constraints." },
  { icon: GiUpgrade, title: "Upgrades", text: "Modules, crew, and automation create steady idle progression without hiding the numbers." },
  { icon: GiFactory, title: "Economy", text: "Stations produce, consume, tax, replenish treasuries, and move money in a closed loop." },
  { icon: GiChart, title: "Markets", text: "A stock exchange lets players invest in the same station economy they influence." },
  { icon: GiRadarSweep, title: "Readable sim", text: "Clamped price bands and deterministic ticks keep long runs understandable." },
];

const stats = [
  { label: "Core loop", value: "Ship -> Trade -> Automate" },
  { label: "Session style", value: "Clicker-friendly idle sim" },
  { label: "Perspective", value: "Single-player browser game" },
  { label: "Current focus", value: "Fleet, contracts, markets" },
];

const footerGroups = [
  {
    title: "Game",
    links: [
      { label: "Screenshots", href: "#screens" },
      { label: "Gameplay loop", href: "#loop" },
      { label: "Systems", href: "#systems" },
      { label: "Wiki", href: "/wiki.html" },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "Discord", href: "/website.html" },
      { label: "Steam page", href: "/website.html" },
      { label: "Dev updates", href: "/website.html" },
      { label: "Press kit", href: "/website.html" },
    ],
  },
  {
    title: "Build",
    links: [
      { label: "Roadmap", href: "/website.html" },
      { label: "Wiki", href: "/wiki.html" },
      { label: "Changelog", href: "/website.html" },
      { label: "Bug reports", href: "/website.html" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/website.html" },
      { label: "Terms", href: "/website.html" },
      { label: "Contact", href: "/website.html" },
      { label: "Credits", href: "/website.html" },
    ],
  },
];

export function Site() {
  return (
    <main className="site-shell">
      <section className="site-hero" aria-labelledby="site-title">
        <header className="site-nav" aria-label="Website navigation">
          <a className="site-brand" href="/website.html" aria-label="Logics website home">
            <img className="site-brand-wordmark" src="/site/logics-wordmark.svg" alt="" />
            <img className="site-brand-mark" src="/site/logics-mark.svg" alt="" />
          </a>
          <nav className="site-nav-links" aria-label="Page sections">
            <a href="#screens">Screens</a>
            <a href="#loop">Loop</a>
            <a href="#systems">Systems</a>
            <a href="/wiki.html">Wiki</a>
          </nav>
          <a className="site-link-button" href="/" aria-label="Open game">
            <MdPlayArrow aria-hidden="true" />
            <span>Open game</span>
          </a>
        </header>

        <div className="site-hero-content">
          <div className="site-hero-copy">
            <span className="site-kicker">Space logistics trading idle clicker</span>
            <h1 id="site-title">Logics</h1>
            <p>
              An easy-to-play space logistics game about spotting profitable cargo, shipping it across a
              living station economy, and automating the routes that keep your fleet earning.
            </p>
            <div className="site-hero-actions">
              <a className="site-primary-action" href="/">
                <MdPlayArrow aria-hidden="true" />
                <span>Play the current build</span>
              </a>
              <a className="site-secondary-action" href="#screens">
                <span>View screenshots</span>
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

      <section className="site-section site-screens-band" id="screens" aria-labelledby="screens-title">
        <div className="site-section-inner">
          <div className="site-section-head">
            <span className="site-kicker">Operations</span>
            <h2 id="screens-title">Four tabs for the whole route network</h2>
            <p>
              Move between fleet control, asset trading, commodity logistics, and the sector map without
              losing sight of what your ships should do next.
            </p>
          </div>

          <div className="screenshot-grid">
            {screenshots.map((shot) => (
              <figure className="screenshot-card" key={shot.title}>
                <img src={shot.image} alt={`${shot.title} gameplay screenshot`} />
                <figcaption>
                  <span>{shot.label}</span>
                  <strong>{shot.title}</strong>
                  <p>{shot.description}</p>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <section className="site-section site-loop-band" id="loop" aria-labelledby="loop-title">
        <div className="site-section-inner">
          <div className="site-section-head">
            <span className="site-kicker">Gameplay loop</span>
            <h2 id="loop-title">Simple actions, compounding systems</h2>
            <p>
              Logics starts like a clicker: make clear, satisfying shipping decisions. The depth comes from
              deciding which repeated moves deserve automation.
            </p>
          </div>

          <div className="loop-grid">
            {loops.map((item, index) => {
              const Icon = item.icon;
              return (
                <article className="loop-step" key={item.title}>
                  <span className="loop-index">{String(index + 1).padStart(2, "0")}</span>
                  <Icon aria-hidden="true" />
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="site-section site-systems-band" id="systems" aria-labelledby="systems-title">
        <div className="site-section-inner site-systems-layout">
          <div className="site-section-head">
            <span className="site-kicker">What you manage</span>
            <h2 id="systems-title">Trading, shipping, automation</h2>
            <p>
              The game is approachable at the surface, but it keeps the simulation legible for players who
              want to optimize routes, contracts, and passive market positions.
            </p>
          </div>

          <div className="feature-grid">
            {features.map((feature) => {
              const Icon = feature.icon;
              return (
                <article className="feature-card" key={feature.title}>
                  <Icon aria-hidden="true" />
                  <h3>{feature.title}</h3>
                  <p>{feature.text}</p>
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
            <h2 id="cta-title">Run routes now, automate the fleet next.</h2>
          </div>
          <div className="stat-strip" aria-label="Game summary">
            {stats.map((stat) => (
              <div key={stat.label}>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </div>
            ))}
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
            <a className="footer-brand" href="/website.html" aria-label="Logics website home">
              <img src="/site/logics-wordmark.svg" alt="" />
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
          <span>Copyright 2026 Logics</span>
          <span>Gameplay screenshots captured from the current local build.</span>
        </div>
      </footer>
    </main>
  );
}
