import { parentPort } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

if (!parentPort) throw new Error("Fire weather coverage worker started without a parent port");

const loaded = await tsImport("../lib/fire-weather-coverage.ts", import.meta.url);
const buildFireWeatherCoverage = loaded.buildFireWeatherCoverage ?? loaded.default?.buildFireWeatherCoverage;
if (typeof buildFireWeatherCoverage !== "function") {
  throw new Error("Fire weather coverage builder could not be loaded");
}

parentPort.once("message", (stations) => {
  parentPort.postMessage(buildFireWeatherCoverage(stations));
});
