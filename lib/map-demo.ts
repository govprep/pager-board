import type { FireWeatherCoverage } from "@/lib/fire-weather-coverage";
import type {
  CurrentFireWeatherStation,
  StationFuelObservation,
} from "@/lib/fire-weather-observations";
import type { Incident } from "@/lib/types";

function fdrForFbi(fbi: number): number {
  if (fbi >= 100) return 4;
  if (fbi >= 50) return 3;
  if (fbi >= 24) return 2;
  if (fbi >= 12) return 1;
  return 0;
}

function fuelWithFbi(fuel: StationFuelObservation, fbi: number): StationFuelObservation {
  return { ...fuel, fbi, fdr: fdrForFbi(fbi) };
}

/**
 * Turn the real station locations and coverage geometry into an unmistakably
 * synthetic display. No result from this function is written back to storage.
 */
export function demoFireWeather(
  stations: CurrentFireWeatherStation[],
  coverage: FireWeatherCoverage,
  now = Date.now(),
): { stations: CurrentFireWeatherStation[]; coverage: FireWeatherCoverage } {
  const observedAt = new Date(now).toISOString();
  const demoStations = stations.map((station, index) => {
    const north = station.lat > -32.6;
    const central = station.lat > -34.7;
    const maxFbi = north
      ? 58 + (index * 7) % 34
      : central
        ? 28 + (index * 5) % 21
        : 9 + index % 12;
    const primaryFbi = Math.max(0, maxFbi - 7);
    return {
      ...station,
      observedAt,
      primary: fuelWithFbi(station.primary, primaryFbi),
      secondary: fuelWithFbi(station.secondary, maxFbi),
      maxFbi,
      maxFdr: fdrForFbi(maxFbi),
      maxFuel: "secondary" as const,
      olderThan30Min: false,
      incomplete: false,
    };
  });

  const byId = new Map(demoStations.map((station) => [station.id, station]));
  const demoCoverage: FireWeatherCoverage = {
    ...coverage,
    features: coverage.features.map((feature) => {
      const station = byId.get(feature.properties.id);
      if (!station || station.maxFbi == null || station.maxFdr == null) return feature;
      return {
        ...feature,
        properties: {
          ...feature.properties,
          maxFbi: station.maxFbi,
          maxFdr: station.maxFdr,
          incomplete: false,
        },
      };
    }),
  };

  return { stations: demoStations, coverage: demoCoverage };
}

const DEMO_JOBS = [
  ["26-900101", "GRASS FIRE", "BELLINGEN", 152.90, -30.45],
  ["26-900102", "BUSH FIRE", "ARMIDALE", 151.67, -30.51],
  ["26-900103", "MVA", "TAMWORTH", 150.93, -31.09],
  ["26-900104", "STRUCTURE FIRE", "GRAFTON", 152.94, -29.69],
  ["26-900105", "AFA", "COFFS HARBOUR", 153.11, -30.30],
  ["26-900106", "HAZMAT", "DUBBO", 148.60, -32.25],
  ["26-900107", "GRASS FIRE", "MUDGEE", 149.59, -32.59],
  ["26-900108", "RESCUE", "MUSWELLBROOK", 150.89, -32.27],
  ["26-900109", "BUSH FIRE", "TENTERFIELD", 152.02, -29.05],
  ["26-900110", "MVA", "MOREE", 149.84, -29.46],
  ["26-900111", "STRUCTURE FIRE", "NEWCASTLE", 151.78, -32.93],
  ["26-900112", "MEDICAL", "ORANGE", 149.10, -33.28],
] as const;

export function demoIncidents(now = Date.now()): Incident[] {
  return DEMO_JOBS.map(([id, type, place, lng, lat], index) => ({
    id,
    incidentNo: id,
    type,
    unit: `TEST${index + 1}`,
    location: `${place}, NSW`,
    coords: { lng, lat },
    receivedAt: new Date(now - index * 4 * 60_000).toISOString(),
    fields: { demo: "true" },
    raw: `SYNTHETIC PREVIEW ${id}`,
    stoppedAt: null,
    fireWeather: null,
  }));
}
