import type { ExpressionSpecification } from "mapbox-gl";

/**
 * Fade a weather band out as the map reaches local zoom.
 *
 * Mapbox requires a camera expression's `zoom` lookup to be the input of the
 * top-level step/interpolate expression. Keeping the data-dependent case in
 * the stop value makes this a valid composite expression.
 */
export function weatherFillOpacity(base: number): ExpressionSpecification {
  return [
    "interpolate", ["linear"], ["zoom"],
    8, ["case", ["==", ["get", "incomplete"], true], base * 0.72, base],
    9.6, 0,
  ];
}
