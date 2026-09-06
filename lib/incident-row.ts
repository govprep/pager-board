import type { Incident } from "./types";

// The `incidents` row shape (snake_case) → Incident (camelCase).
//
// Deliberately free of any Supabase import, because both sides of the wire need
// it: the server reads rows out of the table (lib/store.ts, feeder/slack.ts,
// feeder/push.ts) and the browser receives the very same row shape as a Realtime
// `postgres_changes` payload, which carries every column rather than the subset
// the list endpoint selects. Anything missing reads as absent, so a payload from
// a database that predates a column maps the same as a queried row does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toIncident(row: any): Incident {
  return {
    id: row.id,
    incidentNo: row.incident_no,
    type: row.type,
    unit: row.unit,
    location: row.location,
    coords: row.coords ?? null,
    receivedAt: row.received_at,
    fields: row.fields ?? {},
    raw: row.raw,
    stoppedAt: row.stopped_at ?? null,
    fireWeather:
      row.primary_fbi != null
        ? {
            primaryFbi: row.primary_fbi,
            secondaryFbi: row.secondary_fbi,
            stationName: row.fbi_station ?? "",
            distanceKm: row.fbi_distance_km,
            observedAt: row.fbi_observed_at,
            tempC: row.fbi_observation?.tempC ?? null,
            humidityPct: row.fbi_observation?.humidityPct ?? null,
            windDir: row.fbi_observation?.windDir ?? null,
            windSpdKmh: row.fbi_observation?.windSpdKmh ?? null,
            windGustKmh: row.fbi_observation?.windGustKmh ?? null,
            primaryFuelModel: row.fbi_observation?.primaryFuelModel ?? null,
            primaryFuelName: row.fbi_observation?.primaryFuelName ?? null,
            secondaryFuelModel: row.fbi_observation?.secondaryFuelModel ?? null,
            secondaryFuelName: row.fbi_observation?.secondaryFuelName ?? null,
          }
        : null,
  };
}
