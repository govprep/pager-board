import { featureCollection, multiPolygon, point, polygon } from "@turf/helpers";
import intersect from "@turf/intersect";
import voronoi from "@turf/voronoi";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import land from "./fire-weather-land.json";
import type { CurrentFireWeatherStation } from "./fire-weather-observations";

export type FireWeatherCoverageProperties = {
  id: string;
  maxFbi: number;
  maxFdr: number;
  incomplete: boolean;
  radiusKm: 20 | 40 | 60;
};

export type FireWeatherCoverage = FeatureCollection<
  Polygon | MultiPolygon,
  FireWeatherCoverageProperties
>;

export const EMPTY_FIRE_WEATHER_COVERAGE: FireWeatherCoverage = {
  type: "FeatureCollection",
  features: [],
};

const RADII_KM = [60, 40, 20] as const;
const REFERENCE_LAT = -33;
const X_SCALE = Math.cos(REFERENCE_LAT * Math.PI / 180);
const BBOX: [number, number, number, number] = [140, -38.5, 169, -27];
const EARTH_RADIUS_KM = 6371.0088;

const landPolygons = land.features.map((feature) => feature.geometry.coordinates);
const landMask = multiPolygon(landPolygons);

function circle(lng: number, lat: number, radiusKm: number): Feature<Polygon> {
  const angular = radiusKm / EARTH_RADIUS_KM;
  const lat1 = lat * Math.PI / 180;
  const lng1 = lng * Math.PI / 180;
  const ring: [number, number][] = [];
  for (let step = 0; step <= 32; step++) {
    const bearing = step / 32 * Math.PI * 2;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lng2 = lng1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
    ring.push([lng2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
  }
  return polygon([ring]);
}

function eligible(station: CurrentFireWeatherStation): station is CurrentFireWeatherStation & {
  maxFbi: number;
  maxFdr: number;
} {
  return station.maxFbi != null && station.maxFbi >= 0 && station.maxFdr != null &&
    !station.olderThan30Min && Number.isFinite(station.lng) && Number.isFinite(station.lat);
}

function uniqueLocations(stations: CurrentFireWeatherStation[]) {
  const unique = new Map<string, CurrentFireWeatherStation & { maxFbi: number; maxFdr: number }>();
  for (const station of stations) {
    if (!eligible(station)) continue;
    const key = `${station.lng.toFixed(5)},${station.lat.toFixed(5)}`;
    const held = unique.get(key);
    // Co-located instruments cannot own distinct polygons. Use the higher FBI,
    // which is the conservative and deterministic choice for the shared site.
    if (!held || station.maxFbi > held.maxFbi) unique.set(key, station);
  }
  return [...unique.values()];
}

/**
 * Build bounded observation influence areas, not a forecast field.
 *
 * Voronoi cells stop stations painting over a nearer station; 20/40/60 km
 * buffers express declining confidence and impose a hard outer limit. The
 * longitude scaling avoids the east/west bias of doing nearest-neighbour work
 * directly in degrees at NSW latitudes. Finally, every band is clipped to the
 * ABS NSW/ACT, Lord Howe and Norfolk Island land polygons.
 */
export function buildFireWeatherCoverage(stations: CurrentFireWeatherStation[]): FireWeatherCoverage {
  const contributors = uniqueLocations(stations);
  if (contributors.length < 2) return EMPTY_FIRE_WEATHER_COVERAGE;

  const points = featureCollection(contributors.map((station) => point(
    [station.lng * X_SCALE, station.lat],
    {
      id: station.id,
      lng: station.lng,
      lat: station.lat,
      maxFbi: station.maxFbi,
      maxFdr: station.maxFdr,
      incomplete: station.incomplete,
    },
  )));
  const cells = voronoi(points, {
    bbox: [BBOX[0] * X_SCALE, BBOX[1], BBOX[2] * X_SCALE, BBOX[3]],
  });
  const features: Array<Feature<Polygon | MultiPolygon, FireWeatherCoverageProperties>> = [];

  for (const cell of cells.features) {
    const props = cell.properties;
    if (!props || typeof props.id !== "string" || typeof props.lng !== "number" ||
      typeof props.lat !== "number" || typeof props.maxFbi !== "number" ||
      typeof props.maxFdr !== "number") continue;

    // Return the Voronoi geometry to geographic longitude before combining it
    // with geodesic buffers and the geographic land boundary.
    const geographicCell: Feature<Polygon> = {
      ...cell,
      geometry: {
        ...cell.geometry,
        coordinates: cell.geometry.coordinates.map((ring) =>
          ring.map(([x, y]) => [x / X_SCALE, y]),
        ),
      },
    };
    // Clip the owner cell once. Intersecting each of the three bands with the
    // full state boundary separately is equivalent but needlessly expensive.
    const ownedLand = intersect(featureCollection<Polygon | MultiPolygon>([
      geographicCell,
      landMask,
    ]));
    if (!ownedLand) continue;

    for (const radiusKm of RADII_KM) {
      const outputProps: FireWeatherCoverageProperties = {
        id: props.id,
        maxFbi: props.maxFbi,
        maxFdr: props.maxFdr,
        incomplete: props.incomplete === true,
        radiusKm,
      };
      const clipped = intersect(
        featureCollection<Polygon | MultiPolygon>([
          ownedLand,
          circle(props.lng, props.lat, radiusKm),
        ]),
        { properties: outputProps },
      );
      if (clipped) features.push(clipped);
    }
  }

  return featureCollection(features);
}
