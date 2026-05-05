import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { IconType } from "react-icons";
import {
  GiCargoCrate,
  GiChart,
  GiCrossedSwords,
  GiFamilyHouse,
  GiMapleLeaf,
  GiNotebook,
  GiRadarSweep,
  GiShipWheel,
  GiUpgrade,
} from "react-icons/gi";
import { MdClose, MdOpenInNew, MdSearch } from "react-icons/md";
import wikiIndexSource from "../../docs/WIKI.md?raw";
import atlasSource from "../../docs/wiki/ATLAS.md?raw";
import combatSource from "../../docs/wiki/COMBAT.md?raw";
import exchangeSource from "../../docs/wiki/EXCHANGE.md?raw";
import ledgerSource from "../../docs/wiki/LEDGER.md?raw";
import marketsSource from "../../docs/wiki/MARKETS.md?raw";
import myFleetSource from "../../docs/wiki/MY_FLEET.md?raw";
import upgradesCrewSource from "../../docs/wiki/UPGRADES_AND_CREW.md?raw";

type MarkdownBlock =
  | { type: "heading"; level: number; text: string; id: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

interface WikiCapture {
  image: string;
  alt: string;
  label: string;
  title: string;
  text: string;
  focus?: CaptureFocus;
}

interface CaptureFocus {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WikiPageSource {
  id: string;
  title: string;
  kicker: string;
  summary: string;
  sourcePath: string;
  sourceText: string;
  icon: IconType;
  sectionCaptures?: Record<string, WikiCapture[]>;
}

interface WikiPage extends WikiPageSource {
  blocks: MarkdownBlock[];
  headings: Extract<MarkdownBlock, { type: "heading" }>[];
  wordCount: number;
}

type WikiCaptureCatalog = Partial<Record<string, Record<string, WikiCapture[]>>>;

interface WikiCaptureManifest {
  shots?: Array<WikiCapture & { id?: string; section?: string }>;
}

const captureManifestUrls = {
  cargo: "/site/screenshots/wiki/my-fleet/manifest.json",
  exchange: "/site/screenshots/wiki/exchange/manifest.json",
  markets: "/site/screenshots/wiki/markets/manifest.json",
  atlas: "/site/screenshots/wiki/atlas/manifest.json",
  combat: "/site/screenshots/wiki/combat/manifest.json",
  ledger: "/site/screenshots/wiki/ledger/manifest.json",
} as const;

function buildPageSources(captureCatalog: WikiCaptureCatalog): WikiPageSource[] {
  return [
    {
      id: "overview",
      title: "Overview",
      kicker: "Start here",
      summary: "The main tabs, shared systems, and where to go next when a mechanic needs a deeper answer.",
      sourcePath: "docs/WIKI.md",
      sourceText: wikiIndexSource,
      icon: GiMapleLeaf,
    },
    {
      id: "cargo",
      title: "Cargo",
      kicker: "Ship operations",
      summary: "How ships, cargo, fuel, stations, contracts, suggestions, and auto-pilot work.",
      sourcePath: "docs/wiki/MY_FLEET.md",
      sourceText: myFleetSource,
      icon: GiShipWheel,
      sectionCaptures: captureCatalog.cargo,
    },
    {
      id: "exchange",
      title: "Exchange",
      kicker: "Market desk",
      summary: "How listings, order books, spot positions, limit orders, futures, stops, dividends, and settlement jobs work.",
      sourcePath: "docs/wiki/EXCHANGE.md",
      sourceText: exchangeSource,
      icon: GiChart,
      sectionCaptures: captureCatalog.exchange,
    },
    {
      id: "markets",
      title: "Markets",
      kicker: "Commodity logistics",
      summary: "How to read universe spot prices, best asks, best bids, producers, consumers, and supply pressure.",
      sourcePath: "docs/wiki/MARKETS.md",
      sourceText: marketsSource,
      icon: GiCargoCrate,
      sectionCaptures: captureCatalog.markets,
    },
    {
      id: "atlas",
      title: "Atlas",
      kicker: "Map and stations",
      summary: "How to use the station map, syndicate control, lane danger, news, station sheets, and shipyards.",
      sourcePath: "docs/wiki/ATLAS.md",
      sourceText: atlasSource,
      icon: GiRadarSweep,
      sectionCaptures: captureCatalog.atlas,
    },
    {
      id: "combat",
      title: "Combat",
      kicker: "Hostile contacts",
      summary: "How transit encounters fire, how fight, flee, and negotiation choices resolve, and where danger is recorded.",
      sourcePath: "docs/wiki/COMBAT.md",
      sourceText: combatSource,
      icon: GiCrossedSwords,
      sectionCaptures: captureCatalog.combat,
    },
    {
      id: "ledger",
      title: "Ledger",
      kicker: "Career and history",
      summary: "How career charters, syndicate reputation, combat history, fleet logs, and the captain ledger work.",
      sourcePath: "docs/wiki/LEDGER.md",
      sourceText: ledgerSource,
      icon: GiNotebook,
      sectionCaptures: captureCatalog.ledger,
    },
    {
      id: "upgrades-crew",
      title: "Upgrades & Crew",
      kicker: "Progression",
      summary: "Tables for modules, crew roles, modifiers, automation unlocks, maintenance, wages, and shipyard hull traits.",
      sourcePath: "docs/wiki/UPGRADES_AND_CREW.md",
      sourceText: upgradesCrewSource,
      icon: GiUpgrade,
    },
  ];
}

function groupManifestCaptures(manifest: WikiCaptureManifest): Record<string, WikiCapture[]> {
  const grouped: Record<string, WikiCapture[]> = {};
  for (const shot of manifest.shots ?? []) {
    const section = shot.section ?? shot.id;
    if (!section) continue;
    const { id: _id, section: _section, ...capture } = shot;
    void _id;
    void _section;
    grouped[section] ??= [];
    grouped[section].push(capture);
  }
  return grouped;
}

async function fetchCaptureManifest(pageId: string, url: string): Promise<[string, Record<string, WikiCapture[]>]> {
  try {
    const response = await fetch(url);
    if (!response.ok) return [pageId, {}];
    const manifest = await response.json() as WikiCaptureManifest;
    return [pageId, groupManifestCaptures(manifest)];
  } catch {
    return [pageId, {}];
  }
}

function useWikiCaptureCatalog(): WikiCaptureCatalog {
  const [catalog, setCatalog] = useState<WikiCaptureCatalog>({});

  useEffect(() => {
    let active = true;
    void Promise
      .all(Object.entries(captureManifestUrls).map(([pageId, url]) => fetchCaptureManifest(pageId, url)))
      .then((entries) => {
        if (!active) return;
        setCatalog(Object.fromEntries(entries) as WikiCaptureCatalog);
      });
    return () => {
      active = false;
    };
  }, []);

  return catalog;
}

const sidebarQuickLinks = [
  {
    title: "Shipyards",
    icon: GiFamilyHouse,
    text: "Ship buying lives in Atlas station detail and Cargo dockside markets.",
    href: "#atlas-shipyards",
  },
  {
    title: "Combat",
    icon: GiCrossedSwords,
    text: "Fight, flee, negotiate, then read outcomes in Ledger and Atlas.",
    href: "#combat",
  },
];

const quickQuestions = [
  { question: "How do I automate a ship?", pageId: "cargo", section: "auto-pilot" },
  { question: "Why can't a ship depart?", pageId: "cargo", section: "stations-and-travel" },
  { question: "How do Exchange orders fill?", pageId: "exchange", section: "order-book-and-tape" },
  { question: "What do stop-loss and take-profit do?", pageId: "exchange", section: "stops-and-takes" },
  { question: "Where do I buy another ship?", pageId: "atlas", section: "shipyards" },
  { question: "What happens when combat fires?", pageId: "combat", section: "encounter-modal" },
  { question: "Where are combat encounters recorded?", pageId: "combat", section: "ledger-and-atlas-history" },
  { question: "Which crew member unlocks auto-pilot?", pageId: "upgrades-crew", section: "automation-and-guidance" },
  { question: "What does each upgrade modifier mean?", pageId: "upgrades-crew", section: "shared-modifier-rules" },
];

export function Wiki() {
  const captureCatalog = useWikiCaptureCatalog();
  const pages = useMemo(() => buildPageSources(captureCatalog).map(buildWikiPage), [captureCatalog]);
  const [activeId, setActiveId] = useState(() => pageIdFromHash(pages));
  const [query, setQuery] = useState("");
  const [modalCapture, setModalCapture] = useState<WikiCapture | null>(null);

  useEffect(() => {
    const updateFromHash = () => setActiveId(pageIdFromHash(pages));
    window.addEventListener("hashchange", updateFromHash);
    updateFromHash();
    return () => window.removeEventListener("hashchange", updateFromHash);
  }, [pages]);

  useEffect(() => {
    if (!modalCapture) return undefined;

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModalCapture(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [modalCapture]);

  const activePage = pages.find((page) => page.id === activeId) ?? pages[0];
  const searchResults = useMemo(() => buildSearchResults(pages, query), [pages, query]);
  const activeQuestions = quickQuestions.filter((item) => item.pageId === activePage.id);

  return (
    <main className="wiki-shell">
      <header className="wiki-topbar">
        <a className="site-brand wiki-brand" href="/website.html" aria-label="Ledgway website home">
          <img className="site-brand-wordmark" src="/site/ledgway-wordmark.svg" alt="" />
          <img className="site-brand-mark" src="/site/ledgway-mark.svg" alt="" />
        </a>
        <nav className="wiki-top-links" aria-label="Wiki navigation">
          <a href="/website.html">Website</a>
          <a href="/">Game</a>
          <a className="active" href="/wiki.html">Wiki</a>
        </nav>
        <a className="site-link-button wiki-game-link" href="/">
          <span>Open game</span>
          <MdOpenInNew aria-hidden="true" />
        </a>
      </header>

      <section className="wiki-hero" aria-labelledby="wiki-title">
        <div>
          <span className="site-kicker">Player wiki</span>
          <h1 id="wiki-title">Learn the current build</h1>
          <p>
            Guides for fleet control, trading, upgrades, crew, automation, and the numbers behind the UI.
          </p>
        </div>
        <label className="wiki-search">
          <MdSearch aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search wiki"
          />
        </label>
      </section>

      <div className="wiki-layout">
        <aside className="wiki-sidebar" aria-label="Wiki pages">
          <div className="wiki-sidebar-section">
            <span className="wiki-sidebar-label">Pages</span>
            <nav className="wiki-page-list">
              {pages.map((page) => {
                const Icon = page.icon;
                return (
                  <a
                    key={page.id}
                    className={`wiki-page-link ${page.id === activePage.id ? "active" : ""}`}
                    href={`#${page.id}`}
                  >
                    <Icon aria-hidden="true" />
                    <span>
                      <strong>{page.title}</strong>
                      <small>{page.kicker}</small>
                    </span>
                  </a>
                );
              })}
            </nav>
          </div>

          <div className="wiki-sidebar-section">
            <span className="wiki-sidebar-label">Quick Links</span>
            <div className="wiki-coming-list">
              {sidebarQuickLinks.map((page) => {
                const Icon = page.icon;
                return (
                  <a href={page.href} key={page.title}>
                    <Icon aria-hidden="true" />
                    <span>
                      <strong>{page.title}</strong>
                      <small>{page.text}</small>
                    </span>
                  </a>
                );
              })}
            </div>
          </div>

          {query.trim() && (
            <div className="wiki-sidebar-section wiki-results">
              <span className="wiki-sidebar-label">Search Results</span>
              {searchResults.length === 0 ? (
                <p>No matching pages or sections.</p>
              ) : (
                searchResults.map((result) => (
                  <a href={result.href} key={`${result.href}-${result.label}`}>
                    <strong>{result.title}</strong>
                    <span>{result.label}</span>
                  </a>
                ))
              )}
            </div>
          )}
        </aside>

        <WikiArticle page={activePage} onOpenCapture={setModalCapture} />

        <aside className="wiki-right-rail" aria-label="Article contents">
          <section>
            <span className="wiki-sidebar-label">On This Page</span>
            <nav className="wiki-toc">
              {activePage.headings.map((heading) => (
                <a
                  className={`level-${heading.level}`}
                  href={`#${activePage.id}-${heading.id}`}
                  key={`${heading.level}-${heading.id}`}
                >
                  {heading.text}
                </a>
              ))}
            </nav>
          </section>

          <section>
            <span className="wiki-sidebar-label">Quick Answers</span>
            <div className="wiki-question-list">
              {(activeQuestions.length > 0 ? activeQuestions : quickQuestions).map((item) => {
                const page = pages.find((candidate) => candidate.id === item.pageId);
                return (
                  <a href={`#${item.pageId}-${item.section}`} key={`${item.pageId}-${item.section}`}>
                    <strong>{item.question}</strong>
                    <span>{page?.title}</span>
                  </a>
                );
              })}
            </div>
          </section>
        </aside>
      </div>

      {modalCapture && (
        <WikiCaptureModal capture={modalCapture} onClose={() => setModalCapture(null)} />
      )}
    </main>
  );
}

function WikiArticle({ page, onOpenCapture }: { page: WikiPage; onOpenCapture: (capture: WikiCapture) => void }) {
  const Icon = page.icon;
  return (
    <article className="wiki-article">
      <header className="wiki-article-head">
        <div className="wiki-article-icon">
          <Icon aria-hidden="true" />
        </div>
        <div>
          <span>{page.kicker}</span>
          <h2>{page.title}</h2>
          <p>{page.summary}</p>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>{page.sourcePath}</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>{page.wordCount.toLocaleString()} words</dd>
            </div>
          </dl>
        </div>
      </header>

      <div className="wiki-article-body">
        {page.blocks.map((block, index) => (
          <ArticleBlock
            block={block}
            blockKey={`${page.id}-${index}`}
            captures={block.type === "heading" ? page.sectionCaptures?.[block.id] : undefined}
            onOpenCapture={onOpenCapture}
            pageId={page.id}
            key={`${page.id}-${index}`}
          />
        ))}
      </div>
    </article>
  );
}

function ArticleBlock({ block, blockKey, captures, onOpenCapture, pageId }: {
  block: MarkdownBlock;
  blockKey: string;
  captures?: WikiCapture[];
  onOpenCapture: (capture: WikiCapture) => void;
  pageId: string;
}) {
  return (
    <>
      {renderBlock(block, blockKey, pageId)}
      {captures && <WikiCaptureGrid captures={captures} onOpenCapture={onOpenCapture} />}
    </>
  );
}

function WikiCaptureGrid({ captures, onOpenCapture }: {
  captures: WikiCapture[];
  onOpenCapture: (capture: WikiCapture) => void;
}) {
  return (
    <div className={`wiki-capture-grid capture-count-${captures.length}`} aria-label="Section screenshots">
      {captures.map((capture) => (
        <WikiCaptureFigure capture={capture} key={capture.image} onOpen={() => onOpenCapture(capture)} />
      ))}
    </div>
  );
}

function WikiCaptureFigure({ capture, onOpen }: { capture: WikiCapture; onOpen: () => void }) {
  const focus = capture.focus;
  const focusX = focus?.x ?? 0;
  const focusY = focus?.y ?? 0;
  const focusWidth = focus?.width ?? 0;
  const focusHeight = focus?.height ?? 0;
  const style = focus ? {
    "--focus-x": `${focusX}%`,
    "--focus-y": `${focusY}%`,
    "--focus-width": `${focusWidth}%`,
    "--focus-height": `${focusHeight}%`,
  } as CSSProperties : undefined;

  return (
    <figure className={`wiki-capture ${focus ? "has-focus" : ""}`} style={style}>
      <button
        className="wiki-capture-open"
        type="button"
        onClick={onOpen}
        aria-label={`Open full screenshot: ${capture.title}`}
      >
        <span className="wiki-capture-viewport">
          <span className="wiki-capture-stage">
            <img src={capture.image} alt={capture.alt} />
            {focus && <span className="wiki-capture-focus-box" aria-hidden="true" />}
          </span>
        </span>
      </button>
      <figcaption>
        <span>{capture.label}</span>
        <strong>{capture.title}</strong>
        <p>{capture.text}</p>
      </figcaption>
    </figure>
  );
}

function WikiCaptureModal({ capture, onClose }: { capture: WikiCapture; onClose: () => void }) {
  const [imageWidth, setImageWidth] = useState<number | null>(null);
  const style = imageWidth ? {
    "--modal-image-width": `${imageWidth}px`,
  } as CSSProperties : undefined;

  return (
    <div className="wiki-capture-modal" role="dialog" aria-modal="true" aria-label={capture.title} onClick={onClose}>
      <div className="wiki-capture-modal-panel" style={style} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>{capture.label}</span>
            <strong>{capture.title}</strong>
          </div>
          <button type="button" onClick={onClose} aria-label="Close screenshot">
            <MdClose aria-hidden="true" />
          </button>
        </header>
        <img
          src={capture.image}
          alt={capture.alt}
          onLoad={(event) => setImageWidth(event.currentTarget.naturalWidth)}
        />
        <p>{capture.text}</p>
      </div>
    </div>
  );
}

function buildWikiPage(source: WikiPageSource): WikiPage {
  const blocks = parseMarkdown(source.sourceText);
  return {
    ...source,
    blocks,
    headings: blocks.filter((block): block is Extract<MarkdownBlock, { type: "heading" }> => block.type === "heading"),
    wordCount: source.sourceText.trim().split(/\s+/).length,
  };
}

function pageIdFromHash(pages: WikiPage[]): string {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return pages[0].id;
  if (hash === "my-fleet" || hash.startsWith("my-fleet-")) return "cargo";
  return pages.find((page) => hash === page.id || hash.startsWith(`${page.id}-`))?.id ?? pages[0].id;
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  const slugCounts = new Map<string, number>();
  let index = 0;

  const uniqueId = (text: string) => {
    const base = slugify(text);
    const count = slugCounts.get(base) ?? 0;
    slugCounts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = stripMarkdown(heading[2].trim());
      if (level > 1) blocks.push({ type: "heading", level, text, id: uniqueId(text) });
      index += 1;
      continue;
    }

    if (looksLikeTableStart(lines, index)) {
      const headers = parseTableRow(lines[index]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|")) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (trimmed.startsWith("- ")) {
      const items: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("- ")) {
        items.push(lines[index].trim().slice(2).trim());
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().match(/^(#{1,4})\s+(.+)$/) &&
      !lines[index].trim().startsWith("- ") &&
      !looksLikeTableStart(lines, index)
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

function renderBlock(block: MarkdownBlock, key: string, pageId: string): ReactNode {
  if (block.type === "heading") {
    const HeadingTag = `h${Math.min(block.level, 4)}` as "h2" | "h3" | "h4";
    return (
      <HeadingTag id={`${pageId}-${block.id}`} key={key}>
        {block.text}
      </HeadingTag>
    );
  }

  if (block.type === "paragraph") {
    return <p key={key}>{renderInline(block.text)}</p>;
  }

  if (block.type === "list") {
    return (
      <ul key={key}>
        {block.items.map((item) => (
          <li key={item}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }

  return (
    <div className="wiki-table-wrap" key={key}>
      <table>
        <thead>
          <tr>
            {block.headers.map((header) => (
              <th key={header}>{renderInline(header)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`${key}-${rowIndex}`}>
              {block.headers.map((header, columnIndex) => (
                <td key={`${header}-${columnIndex}`}>{renderInline(row[columnIndex] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  return text.split(tokenPattern).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }

    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }

    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = mapDocHref(link[2]);
      return (
        <a href={href} key={index}>
          {renderInline(link[1])}
        </a>
      );
    }

    return part;
  });
}

function looksLikeTableStart(lines: string[], index: number): boolean {
  const current = lines[index]?.trim() ?? "";
  const next = lines[index + 1]?.trim() ?? "";
  return current.includes("|") && looksLikeTableSeparator(next);
}

function looksLikeTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function slugify(text: string): string {
  return stripMarkdown(text)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function mapDocHref(href: string): string {
  if (/MY_FLEET|CARGO/i.test(href)) return "#cargo";
  if (/EXCHANGE/i.test(href)) return "#exchange";
  if (/MARKETS/i.test(href)) return "#markets";
  if (/ATLAS|LOCATIONS/i.test(href)) return "#atlas";
  if (/COMBAT/i.test(href)) return "#combat";
  if (/LEDGER|CHARTERS/i.test(href)) return "#ledger";
  if (/UPGRADES_AND_CREW/i.test(href)) return "#upgrades-crew";
  if (/WIKI/i.test(href)) return "#overview";
  if (/COMMODITIES|STOCK_MARKET_REVIEW|STOCK_ORDERBOOK/i.test(href)) return "#exchange";
  return href;
}

function buildSearchResults(pages: WikiPage[], query: string): Array<{ title: string; label: string; href: string }> {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

  const results: Array<{ title: string; label: string; href: string }> = [];
  for (const page of pages) {
    if (normalize(`${page.title} ${page.summary}`).includes(normalizedQuery)) {
      results.push({ title: page.title, label: page.summary, href: `#${page.id}` });
    }

    for (const heading of page.headings) {
      if (normalize(heading.text).includes(normalizedQuery)) {
        results.push({
          title: page.title,
          label: heading.text,
          href: `#${page.id}-${heading.id}`,
        });
      }
    }
  }

  return results.slice(0, 8);
}

function normalize(text: string): string {
  return stripMarkdown(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
