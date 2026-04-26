import "./PlayerView.css";

export function PlayerView() {
  return (
    <section>
      <h2>Player</h2>
      <div className="player-stub">
        <div className="stub-card">
          <h3>My Ships</h3>
          <p className="dim">No fleet yet.</p>
          <ul className="planned dim">
            <li>Ships you own, fully under your control</li>
            <li>Manual destination + cargo selection (vs NPC arbitrage)</li>
            <li>Upgrade slots: engines, fuel system, hull, sensors</li>
            <li>Crew assignments + traits</li>
          </ul>
        </div>

        <div className="stub-card">
          <h3>Bank</h3>
          <p className="dim">Ç0 — no balance yet.</p>
          <ul className="planned dim">
            <li>Player credits, separate from fleet wallets</li>
            <li>Ship purchase + retrofit costs</li>
            <li>Contract earnings + reputation tracking</li>
          </ul>
        </div>

        <div className="stub-card">
          <h3>Job Board</h3>
          <p className="dim">No active contracts.</p>
          <ul className="planned dim">
            <li>Persistent shortages → "Deliver N grain to Saffron"</li>
            <li>Stranded NPC traders → "Rescue Mantis at Saffron"</li>
            <li>Faction missions (gated by reputation)</li>
            <li>Escort, smuggling, scouting jobs</li>
          </ul>
        </div>

        <div className="stub-card">
          <h3>Reputation</h3>
          <p className="dim">No standings.</p>
          <ul className="planned dim">
            <li>Per-faction relations affect port access + prices</li>
            <li>Earned through completed contracts</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
