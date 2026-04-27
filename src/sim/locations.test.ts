import { describe, it, expect } from "vitest";
import { createWorld } from "./world";
import {
  isNetExporter,
  isNetImporter,
  locationsAtTechLevel,
  locationsByFaction,
  locationsByTag,
  locationsExporting,
  locationsImporting,
  netProductionRate,
} from "./locations";

describe("net production helpers", () => {
  const w = createWorld({ traders: {} });

  it("netProductionRate is produces - consumes", () => {
    expect(netProductionRate(w.locations.verdant, "grain")).toBe(22);
    expect(netProductionRate(w.locations.haven, "grain")).toBe(-8);
    expect(netProductionRate(w.locations.haven, "fiber")).toBe(4);
  });

  it("ironhold consumes its own plasma — net production is positive surplus", () => {
    expect(netProductionRate(w.locations.ironhold, "plasma")).toBe(10);
  });

  it("isNetExporter / isNetImporter classify correctly", () => {
    expect(isNetExporter(w.locations.verdant, "grain")).toBe(true);
    expect(isNetImporter(w.locations.haven, "grain")).toBe(true);
    expect(isNetExporter(w.locations.haven, "grain")).toBe(false);
  });

  it("locationsExporting collects all net producers of a good", () => {
    const grainExporters = locationsExporting(w, "grain").map(l => l.id);
    expect(grainExporters).toEqual(["verdant"]);

    const plasmaExporters = locationsExporting(w, "plasma").map(l => l.id);
    expect(plasmaExporters).toEqual(["haven", "ironhold", "verdant", "saffron"]);
  });

  it("locationsImporting collects all net consumers of a good", () => {
    const grainImporters = locationsImporting(w, "grain").map(l => l.id).sort();
    expect(grainImporters).toEqual(["haven", "ironhold", "saffron"]);
  });
});

describe("trait-based location queries", () => {
  const w = createWorld({ traders: {} });

  it("locationsByTag finds locations with a matching tag", () => {
    expect(locationsByTag(w, "agricultural").map(l => l.id)).toEqual(["verdant"]);
    expect(locationsByTag(w, "core").map(l => l.id).sort()).toEqual(["haven", "ironhold", "verdant"]);
    expect(locationsByTag(w, "rim").map(l => l.id)).toEqual(["saffron"]);
  });

  it("locationsByFaction filters on the faction trait", () => {
    expect(locationsByFaction(w, "League").map(l => l.id).sort()).toEqual(["haven", "ironhold", "verdant"]);
    expect(locationsByFaction(w, "Outerguild").map(l => l.id)).toEqual(["saffron"]);
  });

  it("locationsAtTechLevel returns locations meeting or exceeding the threshold", () => {
    expect(locationsAtTechLevel(w, 8).map(l => l.id)).toEqual(["ironhold"]);
    expect(locationsAtTechLevel(w, 5).map(l => l.id).sort()).toEqual(["haven", "ironhold", "saffron"]);
    expect(locationsAtTechLevel(w, 10)).toEqual([]);
  });
});

describe("declared exports/imports vs derived", () => {
  const w = createWorld({ traders: {} });

  it("every declared primaryExport is a net exporter in the production data", () => {
    for (const loc of Object.values(w.locations)) {
      for (const goodId of loc.primaryExports) {
        expect(isNetExporter(loc, goodId)).toBe(true);
      }
    }
  });

  it("every declared primaryImport is a net importer in the production data", () => {
    for (const loc of Object.values(w.locations)) {
      for (const goodId of loc.primaryImports) {
        expect(isNetImporter(loc, goodId)).toBe(true);
      }
    }
  });

  it("location traits round-trip through createWorld unchanged", () => {
    const haven = w.locations.haven;
    expect(haven.traits.techLevel).toBe(6);
    expect(haven.traits.tags).toContain("trade-hub");
    expect(haven.traits.faction).toBe("League");
    expect(haven.primaryExports).toEqual(["protein", "fiber", "medkits", "plasma"]);
  });
});
