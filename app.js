/* Photography & Bird Activity Monitor
   All figures come from two real data sources:
   - Built-in solar position model (Meeus low-precision solar algorithm; astronomical
     geometry for sun position, twilight/golden/blue hour times, no network call needed)
   - Open-Meteo (observed/forecast weather: cloud cover, wind, temp, pressure)
   The bird activity score is a heuristic model built from those real inputs plus
   date-of-year, not a live feed of actual bird counts. See the "Model Notes" tab.
*/

const DEFAULT_LOC = { lat: 40.5853, lon: -105.0844, label: "Fort Collins, CO (default)" };
const LS_LOC_KEY = "pbam_location";
const LS_LOG_KEY = "pbam_log";
const LS_EBIRD_KEY = "pbam_ebird_key";
const LS_HORIZON_PREFIX = "pbam_horizon_";
const LS_CACHE_KEY = "pbam_last_good";
const LS_TEMP_UNIT_KEY = "pbam_temp_unit";
const FETCH_TIMEOUT_MS = 9000; // field connections drop or crawl - fail fast with a clear
                                // message instead of a spinner that hangs indefinitely.

// Every network call in this app goes through this wrapper. AbortController
// enforces the timeout; a plain fetch() on a dead mobile connection can hang
// far longer than a user will wait, and the browser gives no error until it
// finally gives up on its own (which can be a minute or more).
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out - weak signal?");
    throw err;
  } finally {
    clearTimeout(id);
  }
}

let state = {
  loc: null,
  now: new Date(),
  sunTimes: null,
  sunTimesTomorrow: null,
  weather: null,
  birdScore: null
};

// ---------- Location ----------
function loadLocation() {
  const saved = localStorage.getItem(LS_LOC_KEY);
  if (saved) {
    try { return JSON.parse(saved); } catch (e) { /* fall through */ }
  }
  return DEFAULT_LOC;
}
function saveLocation(loc) {
  localStorage.setItem(LS_LOC_KEY, JSON.stringify(loc));
}

// ---------- Units ----------
// All internal computation (weatherFactor's temperature thresholds, etc.)
// stays in Celsius, since that's what Open-Meteo returns and what the
// science-cited thresholds were tuned against - this only controls the
// DISPLAYED text, defaulting to Fahrenheit with Celsius as an opt-in.
function loadTempUnit() {
  const saved = localStorage.getItem(LS_TEMP_UNIT_KEY);
  return saved === "C" ? "C" : "F"; // default Fahrenheit
}
function saveTempUnit(unit) {
  localStorage.setItem(LS_TEMP_UNIT_KEY, unit === "C" ? "C" : "F");
}
function formatTemp(celsius) {
  if (typeof celsius !== "number" || isNaN(celsius)) return "--";
  if (loadTempUnit() === "F") {
    return Math.round(celsius * 9 / 5 + 32) + "°F";
  }
  return Math.round(celsius) + "°C";
}

// ---------- Sun / light ----------
function computeSun(loc, date) {
  const times = SunCalcLite.getTimes(date, loc.lat, loc.lon);
  const pos = SunCalcLite.getPosition(date, loc.lat, loc.lon);
  const elevationDeg = pos.altitude * (180 / Math.PI);
  return { times, elevationDeg };
}

// Blue hour approximated as nautical twilight -> civil twilight boundary,
// matching common photographic convention (sun between about -6 deg and -8 deg).
function classifyPhase(date, times) {
  const t = date.getTime();
  const order = [
    ["night", -Infinity, times.nightEnd],
    ["astronomical twilight", times.nightEnd, times.nauticalDawn],
    ["blue hour (dawn)", times.nauticalDawn, times.dawn],
    ["civil twilight", times.dawn, times.sunrise],
    ["golden hour (sunrise)", times.sunrise, times.goldenHourEnd],
    ["daylight", times.goldenHourEnd, times.goldenHour],
    ["golden hour (sunset)", times.goldenHour, times.sunset],
    ["civil twilight", times.sunset, times.dusk],
    ["blue hour (dusk)", times.dusk, times.nauticalDusk],
    ["astronomical twilight", times.nauticalDusk, times.night],
    ["night", times.night, Infinity]
  ];
  for (const [name, start, end] of order) {
    const s = start instanceof Date ? start.getTime() : start;
    const e = end instanceof Date ? end.getTime() : end;
    if (t >= s && t < e) return name;
  }
  return "unknown";
}

// Formats a Date in the LOCATION's local time, not the device's. Without a
// known UTC offset for the coordinates (before the first weather response
// arrives), it falls back to the device's own timezone as a best guess -
// correct for the common case of checking your current location, wrong if
// you're scoping a location in a different timezone before weather loads.
function fmtTime(d, utcOffsetSeconds) {
  if (!(d instanceof Date) || isNaN(d)) return "--";
  if (utcOffsetSeconds == null) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const shifted = new Date(d.getTime() + utcOffsetSeconds * 1000);
  let h = shifted.getUTCHours();
  const m = shifted.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ---------- Weather ----------
async function fetchWeather(loc) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_direction_10m,surface_pressure,precipitation` +
    `&hourly=surface_pressure,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility` +
    `&past_days=1&forecast_days=7&timezone=auto`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Weather request failed: " + res.status);
  const data = await res.json();
  return data;
}

// Find the hourly index whose timestamp is closest to `date`.
function nearestHourIndex(hourly, date) {
  const target = date.getTime();
  let bestIdx = -1, bestDiff = Infinity;
  for (let i = 0; i < hourly.time.length; i++) {
    const t = new Date(hourly.time[i]).getTime();
    const diff = Math.abs(t - target);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  return bestIdx;
}

// ---------- Sunrise/sunset color quality ----------
// Physical basis: high/mid clouds catch and scatter low-angle light into visible
// color; low clouds sit on the horizon and block the sun's light path entirely
// before it can light anything up; humidity/haze scatters and mutes saturation.
// This mirrors the logic used by sunset-prediction tools (e.g. SunsetWx-style
// models), built here directly from Open-Meteo's altitude-banded cloud cover.
function triangularScore(pct, peak = 40, width = 55) {
  // 100 at `peak`, falling linearly to 0 at peak +/- width
  return Math.max(0, 100 - Math.abs(pct - peak) * (100 / width));
}

// obstructionDeg is accepted for API compatibility with callers that also
// track terrain (see "Terrain horizon" below) but is NOT used to discount
// this score. Earlier this docked points for a nearby ridge on the theory
// that it "cuts the color show short" - that doesn't hold up: sky color at
// sunset comes from sunlight scattering through the atmosphere as the sun
// descends toward and below the GEOMETRIC horizon (color often peaks a few
// minutes after the disc visually disappears, through civil twilight around
// -6deg), and that process continues whether or not a mountain blocks your
// direct line of sight to the disc itself. A mountain sunset is a different
// photographic subject (ridgeline silhouette, layered light) - not a
// physically worse one. Terrain's real, documented effect is on USABLE
// DIRECT LIGHT duration (you lose golden hour earlier), which is what the
// terrain-adjusted times in renderSun are for - it does not belong in this
// color-quality number.
function computeSunQuality(low, mid, high, humidity, obstructionDeg) {
  const base = triangularScore(high, 40, 60) * 0.55 + triangularScore(mid, 35, 60) * 0.45;
  const lowMult = Math.max(0, 1 - low / 65);
  const humMult = Math.max(0.35, 1 - Math.max(0, humidity - 55) / 60);
  const score = Math.round(Math.max(0, Math.min(100, base * lowMult * humMult)));
  const terrainNote = (typeof obstructionDeg === "number" && obstructionDeg > 1.5)
    ? `~${obstructionDeg.toFixed(1)}° ridge nearby - direct light ends earlier than a flat horizon, color show is unaffected`
    : null;
  let label;
  if (score >= 75) label = "Great";
  else if (score >= 55) label = "Good";
  else if (score >= 32) label = "Fair";
  else label = "Poor";
  return { score, label, terrainNote };
}

function qualityAt(hourly, date, obstructionDeg) {
  const idx = nearestHourIndex(hourly, date);
  if (idx === -1) return { score: 0, label: "n/a" };
  return computeSunQuality(
    hourly.cloud_cover_low[idx],
    hourly.cloud_cover_mid[idx],
    hourly.cloud_cover_high[idx],
    hourly.relative_humidity_2m[idx],
    obstructionDeg
  );
}

// ---------- Terrain horizon ----------
// Real elevation data, not a visual flourish: this determines when the sun
// actually disappears behind a ridge/skyline and by how much that shortens
// the usable color window, versus the flat-horizon assumption every purely
// weather-based sunset model (including this app's own quality score before
// this) implicitly makes. Method is the standard one used by horizon/terrain
// masking tools (e.g. heywhatsthat.com): sample terrain elevation along the
// bearing of interest at several distances, compute the angle above true
// horizontal to each sample point (correcting for Earth's curvature), and
// take the maximum - that's the angle of the tallest obstruction actually in
// the way.
const EARTH_RADIUS_M = 6371000;
const HORIZON_DISTANCES_KM = [3, 8, 18, 35];

function haversineDestination(lat, lon, bearingDeg, distKm) {
  const R = 6371; // km
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const dR = distKm / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(dR) * Math.cos(lat1),
    Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
}

// SunCalcLite's azimuth is radians measured from south, positive toward west
// (0 = south, +90deg = west) - convert to a standard compass bearing (0 = north,
// clockwise) so it can drive a great-circle destination point.
function bearingFromAzimuth(azimuthRad) {
  return ((azimuthRad * 180 / Math.PI) + 180 + 360) % 360;
}

function obstructionAngleDeg(observerElevM, targetElevM, distKm) {
  const distM = distKm * 1000;
  const drop = (distM * distM) / (2 * EARTH_RADIUS_M); // curvature drop in meters over that distance
  return Math.atan2((targetElevM - observerElevM) - drop, distM) * 180 / Math.PI;
}

async function fetchElevations(points) {
  const lats = points.map(p => p.lat.toFixed(5)).join(",");
  const lons = points.map(p => p.lon.toFixed(5)).join(",");
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Elevation HTTP " + res.status);
  const data = await res.json();
  return data.elevation;
}

// Terrain doesn't move - once fetched for a location (rounded to ~110m,
// plenty precise for a horizon profile sampled kilometers out), it's cached
// indefinitely rather than re-fetched on every refresh. This is both a
// reliability win (one fewer network round-trip per refresh, matters on a
// weak field connection) and considerate of Open-Meteo's free tier.
function horizonCacheKey(loc) {
  return LS_HORIZON_PREFIX + loc.lat.toFixed(3) + "_" + loc.lon.toFixed(3);
}
function loadCachedHorizon(loc) {
  try {
    const raw = localStorage.getItem(horizonCacheKey(loc));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveCachedHorizon(loc, data) {
  try { localStorage.setItem(horizonCacheKey(loc), JSON.stringify(data)); } catch (e) { /* storage full/unavailable - non-fatal */ }
}

// Computes (or loads cached) real horizon-obstruction angles toward the
// sunrise and sunset points on the compass for this location, from actual
// elevation data - not estimated from the map tiles.
async function getHorizonData(loc, sunTimes) {
  const cached = loadCachedHorizon(loc);
  if (cached) return cached;
  const sunsetPos = SunCalcLite.getPosition(sunTimes.sunset, loc.lat, loc.lon);
  const sunrisePos = SunCalcLite.getPosition(sunTimes.sunrise, loc.lat, loc.lon);
  const sunsetBearing = bearingFromAzimuth(sunsetPos.azimuth);
  const sunriseBearing = bearingFromAzimuth(sunrisePos.azimuth);

  const sunsetProfile = HORIZON_DISTANCES_KM.map(d => haversineDestination(loc.lat, loc.lon, sunsetBearing, d));
  const sunriseProfile = HORIZON_DISTANCES_KM.map(d => haversineDestination(loc.lat, loc.lon, sunriseBearing, d));
  const allPoints = [{ lat: loc.lat, lon: loc.lon }].concat(sunsetProfile, sunriseProfile);
  const elevations = await fetchElevations(allPoints);
  const observerElevM = elevations[0];
  const n = HORIZON_DISTANCES_KM.length;
  let sunsetObstructionDeg = -90, sunriseObstructionDeg = -90;
  for (let i = 0; i < n; i++) {
    const a = obstructionAngleDeg(observerElevM, elevations[1 + i], HORIZON_DISTANCES_KM[i]);
    if (a > sunsetObstructionDeg) sunsetObstructionDeg = a;
  }
  for (let i = 0; i < n; i++) {
    const a = obstructionAngleDeg(observerElevM, elevations[1 + n + i], HORIZON_DISTANCES_KM[i]);
    if (a > sunriseObstructionDeg) sunriseObstructionDeg = a;
  }
  const data = { observerElevM, sunsetObstructionDeg, sunriseObstructionDeg, sunsetBearing, sunriseBearing };
  saveCachedHorizon(loc, data);
  return data;
}

// Finds the real time the sun's elevation crosses a given angle (the
// obstruction angle, instead of 0deg) near an initial guess (the flat-horizon
// sunset/sunrise time) - i.e. when it actually drops behind/clears the ridge,
// not just the geometric horizon. direction -1 searches backward in time
// (sun descending, for sunset), +1 forward (sun ascending, for sunrise).
function findHorizonCrossing(loc, guessTime, targetDeg, direction) {
  const stepMs = 30 * 1000;
  const maxSteps = 300; // +/- 150 minutes - generous enough for real-world ridgelines
  let t = guessTime.getTime();
  let prevAlt = SunCalcLite.getPosition(new Date(t), loc.lat, loc.lon).altitude * 180 / Math.PI;
  for (let i = 1; i <= maxSteps; i++) {
    t += direction * stepMs;
    const alt = SunCalcLite.getPosition(new Date(t), loc.lat, loc.lon).altitude * 180 / Math.PI;
    if (direction < 0 && prevAlt >= targetDeg && alt < targetDeg) return new Date(t);
    if (direction > 0 && prevAlt <= targetDeg && alt > targetDeg) return new Date(t);
    prevAlt = alt;
  }
  return null;
}

// Kept in sync with the .tier-* colors in style.css so ring sweeps, outlook
// scores, and the verdict text all read as one consistent color language.
function qualityColor(label) {
  switch (label) {
    case "Great": return "#9c6a14"; // Ink gold
    case "Good": return "#1f6b5c";  // Ink teal
    case "Fair": return "#8a6a3d";  // muted tan
    default: return "#a8371f";      // Ink rust
  }
}

// Ring sweep is driven by a CSS custom property (--p, registered via
// @property in style.css as an animatable <number>) so the browser animates
// the conic-gradient sweep itself on any change - no JS animation loop needed.
function paintRing(el, score, label) {
  const color = qualityColor(label);
  el.style.setProperty("--ring-color", color);
  el.style.setProperty("--p", score);
}

// Animates a number counting up/down to its new value. Used for score/percent
// readouts so an update reads as motion rather than a jump-cut.
const _animatedEls = new WeakMap();
function animateNumber(el, to, opts) {
  const suffix = (opts && opts.suffix) || "";
  const duration = (opts && opts.duration) || 700;
  const from = _animatedEls.has(el) ? _animatedEls.get(el) : 0;
  if (from === to) { el.textContent = to + suffix; _animatedEls.set(el, to); return; }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3); // ease-out cubic
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const val = Math.round(from + (to - from) * ease(t));
    el.textContent = val + suffix;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
  _animatedEls.set(el, to);
}

function pressureTrend(data) {
  // compare current surface pressure to reading ~3 hours prior from hourly series
  try {
    const times = data.hourly.time;
    const pressures = data.hourly.surface_pressure;
    const nowIso = data.current.time;
    const idxNow = times.indexOf(nowIso);
    if (idxNow === -1 || idxNow < 3) return 0;
    return pressures[idxNow] - pressures[idxNow - 3]; // hPa change over 3h
  } catch (e) {
    return 0;
  }
}

function exposureGuidance(elevationDeg, cloudCoverPct) {
  // Light level proxy: higher sun elevation and clearer skies = more light.
  // Bird/BIF photography assumes a fast shutter (~1/1600-1/2500) is non-negotiable,
  // so ISO is the variable that absorbs light loss.
  let lightScore = Math.max(0, elevationDeg) * (1 - cloudCoverPct / 100 * 0.5);
  // elevationDeg can be negative (below horizon); floor at 0 contribution from sun angle,
  // twilight shooting is base-ISO-unfriendly regardless of cloud cover.
  if (elevationDeg <= 0) lightScore = 0;

  let isoLow, isoHigh, verdict, tier;
  if (elevationDeg <= 0) {
    isoLow = 3200; isoHigh = 12800;
    verdict = "Below horizon - twilight/high-ISO conditions";
    tier = "poor";
  } else if (lightScore > 35) {
    isoLow = 100; isoHigh = 400;
    verdict = "Strong direct light - base ISO viable";
    tier = "great";
  } else if (lightScore > 15) {
    isoLow = 400; isoHigh = 1600;
    verdict = cloudCoverPct > 60 ? "Overcast but bright - soft even light" : "Moderate light";
    tier = "good";
  } else if (lightScore > 5) {
    isoLow = 1600; isoHigh = 6400;
    verdict = "Low light - fast shutter will cost you ISO";
    tier = "fair";
  } else {
    isoLow = 6400; isoHigh = 25600;
    verdict = "Very low light - expect heavy noise at BIF shutter speeds";
    tier = "poor";
  }
  return { verdict, isoLow, isoHigh, tier };
}

// ---------- Bird activity model ----------
function hoursBetween(a, b) {
  return (a.getTime() - b.getTime()) / 3600000;
}

// Daylight/twilight activity potential (0-100), the model's foundation.
// This is deliberately tuned for diurnal/crepuscular species (passerines,
// woodpeckers, raptors, waterfowl) - not owls or nocturnal migrants, which
// this tool is not built for.
// Shape: a daytime baseline (activity all day, but with the well-documented
// midday lull), a sharp bonus right at sunrise/sunset (dawn chorus, pre-roost
// feeding), ramping down through twilight, and a low floor at full night.
// This is a GATE, not just one of several additive terms - weather and
// season below can only modulate it, not manufacture activity at 2 AM.
// The three factors below (diel position, weather, season) are a HEURISTIC
// proxy model, used only when no eBird API key is set or eBird has no recent
// reports nearby. It cannot know what birds are actually present - it
// estimates activity probability from documented behavioral patterns:
//   - Circadian activity curve (dawn chorus peak, midday lull, dusk peak,
//     low nocturnal floor): Staicer, Spector & Horn (1996), "The dawn chorus
//     and other diel patterns in acoustic signaling", in Ecology and
//     Evolution of Acoustic Communication in Birds.
//   - Barometric pressure and pre-frontal foraging/migratory departure
//     behavior, wind support for flight: Newton, I. (2008), The Migration
//     Ecology of Birds, Academic Press - chapters on weather effects on
//     departure decisions and flight costs.
//   - Suppressed flight/foraging activity in strong wind and active
//     precipitation, and the general weather-correlation approach: the
//     public methodology notes behind Cornell Lab's BirdCast nocturnal
//     migration forecasts (birdcast.info/science/).
// This is real published behavioral ecology, but it is still a probability
// estimate, not an observation - see the eBird-backed score above for that.
function dielFactor(elevationDeg, now, times) {
  const sigma = 1.5;
  const gauss = (h) => Math.exp(-(h * h) / (2 * sigma * sigma));
  const hrSunrise = hoursBetween(now, times.sunrise);
  const hrSunset = hoursBetween(now, times.sunset);
  const twilightBonus = Math.max(gauss(hrSunrise), gauss(hrSunset)) * 55;

  let base;
  if (elevationDeg > 0) {
    base = 45; // daytime baseline, sits below the twilight peaks (midday lull)
  } else if (elevationDeg > -12) {
    const t = (elevationDeg + 12) / 12; // 0 at -12deg, 1 at 0deg (civil/nautical twilight)
    base = 10 + t * 35;
  } else {
    const t = Math.min(1, Math.max(0, (elevationDeg + 18) / 6)); // ramps out by -18deg (astronomical night)
    base = 3 + t * 7; // low floor - not zero (owls, nocturnal flight calls exist) but near it
  }
  return Math.round(Math.min(100, base + twilightBonus));
}

// Expected supportive ("tailwind") bearing for migratory movement by season -
// spring migrants push north (want wind FROM the south, ~180deg), fall
// migrants push south (want wind FROM the north, ~0/360deg). Wind support is
// one of the most consistently documented predictors of migratory departure
// intensity (Newton 2008; this is also the core physical variable behind
// Cornell's BirdCast nocturnal migration forecasts, birdcast.info/science).
// Outside the migration windows this returns null - there's no single
// "supportive" bearing for local/resident movement, so the factor is skipped.
function expectedTailwindBearing(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const doyFrac = month + day / 31;
  if (doyFrac >= 3.0 && doyFrac <= 6.3) return 180;   // spring: moving north
  if (doyFrac >= 8.3 && doyFrac <= 11.3) return 0;    // fall: moving south
  return null;
}
function angularDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function weatherFactor(current, trendHpa, now) {
  let score = 100;
  const wind = current.wind_speed_10m; // km/h from Open-Meteo default
  const precip = current.precipitation; // mm
  const temp = current.temperature_2m; // C

  // Wind speed: activity drops sharply above ~20 km/h, birds shelter in high wind.
  if (wind > 35) score -= 45;
  else if (wind > 20) score -= 25;
  else if (wind > 10) score -= 8;

  // Wind DIRECTION relative to the season's typical migratory bearing - a
  // true tailwind measurably increases departure likelihood and flight
  // efficiency; a headwind suppresses it. Only applied in migration windows,
  // and only meaningfully once wind has some speed to actually carry a push.
  const expectedBearing = expectedTailwindBearing(now);
  if (expectedBearing !== null && typeof current.wind_direction_10m === "number" && wind >= 5) {
    // Open-Meteo's wind_direction is the direction the wind is blowing FROM;
    // a tailwind for a bird moving in direction D comes FROM the opposite
    // bearing, so compare against (D + 180).
    const diff = angularDiff(current.wind_direction_10m, (expectedBearing + 180) % 360);
    if (diff <= 45) score += 15;       // strong tailwind
    else if (diff <= 80) score += 6;   // partial tailwind
    else if (diff >= 135) score -= 12; // headwind
  }

  // Precipitation: active rain suppresses foraging/flight activity.
  if (precip > 2) score -= 40;
  else if (precip > 0.2) score -= 15;

  // Pressure trend: falling pressure ahead of a front is associated with
  // increased pre-frontal foraging activity; sharply rising pressure (post-front,
  // clearing cold air) often follows a lull.
  if (trendHpa <= -1.5) score += 12;
  else if (trendHpa >= 2) score -= 8;

  // Temperature: extreme cold or heat suppresses activity relative to moderate.
  if (temp < -10 || temp > 35) score -= 20;
  else if (temp < 0 || temp > 30) score -= 8;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function seasonalFactor(date) {
  // Northern Hemisphere migration-window bump (relevant for IL/CO): more species
  // and higher movement volume in Apr-May and Sep-Oct.
  const month = date.getMonth() + 1; // 1-12
  const day = date.getDate();
  const doyFrac = month + day / 31;
  const inSpring = doyFrac >= 4.0 && doyFrac <= 5.8;
  const inFall = doyFrac >= 9.0 && doyFrac <= 10.8;
  if (inSpring || inFall) return 100;
  if (month === 6 || month === 7) return 70; // breeding season, still active but past peak movement
  if (month === 12 || month === 1 || month === 2) return 45; // winter baseline, species-dependent
  return 60;
}

function computeBirdScore(now, times, weatherData, elevationDeg) {
  const diel = dielFactor(elevationDeg, now, times);
  const trend = pressureTrend(weatherData);
  const weather = weatherFactor(weatherData.current, trend, now);
  const season = seasonalFactor(now);

  // Weather and season are MODIFIERS on the diel gate (roughly +-45% and
  // +-30% swings), not independent additive scores - that's what stops
  // "great weather + migration season" from producing a nonzero score at
  // 2 AM when there is no diurnal activity potential to modulate.
  const weatherMult = 0.55 + (weather / 100) * 0.6;   // 0.55 - 1.15
  const seasonMult = 0.7 + (season / 100) * 0.5;      // 0.70 - 1.20

  const total0to100 = Math.max(0, Math.min(100, diel * weatherMult * seasonMult));
  const total = Math.round(total0to100 * 10); // reported on a 0-1000 scale

  let verdict, tier;
  if (total >= 750) { verdict = "High activity likely (model estimate)"; tier = "great"; }
  else if (total >= 500) { verdict = "Moderate activity likely (model estimate)"; tier = "good"; }
  else if (total >= 250) { verdict = "Low activity likely (model estimate)"; tier = "fair"; }
  else { verdict = "Quiet period likely (model estimate)"; tier = "poor"; }

  return {
    total, verdict, tier, source: "heuristic",
    factors: {
      "Daylight/twilight position": diel,
      "Weather modifier": `x${weatherMult.toFixed(2)}`,
      "Season/migration modifier": `x${seasonMult.toFixed(2)}`,
      "Pressure trend (3h)": `${trend.toFixed(2)} hPa`
    }
  };
}

// ---------- Real bird activity (eBird) ----------
// When the user has set a free eBird API key, this replaces the heuristic
// above with a score built from actual, recently-submitted checklist
// observations near their coordinates - genuine reported sightings, not a
// model. Its real limitation is birder-coverage bias: a popular birding spot
// will read higher than a rarely-visited one even at similar bird density.
// That's disclosed in the UI rather than corrected for, since there's no
// free way to normalize for observer effort per location.
function loadEbirdKey() { return (localStorage.getItem(LS_EBIRD_KEY) || "").trim(); }
function saveEbirdKey(key) { localStorage.setItem(LS_EBIRD_KEY, key.trim()); }
function refreshEbirdKeyStatus() {
  const key = loadEbirdKey();
  const statusEl = document.getElementById("ebird-key-status");
  if (!statusEl) return;
  if (key) {
    statusEl.textContent = `Key saved (ends ...${key.slice(-4)}) - Bird Activity Meter will use real eBird sightings.`;
    statusEl.className = "ebird-key-status is-live";
  } else {
    statusEl.textContent = "No key set - Bird Activity Meter is using the weather/astronomy model.";
    statusEl.className = "ebird-key-status";
  }
}

// dist/back are near eBird's practical ceiling for a still-local sample: 25km
// keeps results relevant to where someone would actually go shoot, 7 days
// gives enough checklists in most places to be statistically meaningful
// without going so stale it stops reflecting current conditions.
const EBIRD_DIST_KM = 25;
const EBIRD_BACK_DAYS = 7;
const EBIRD_MIN_CHECKLISTS = 3; // below this, effort is too thin to trust - fall back instead of reporting noise

async function fetchEbirdObservations(loc, apiKey) {
  const url = `https://api.ebird.org/v2/data/obs/geo/recent?lat=${loc.lat.toFixed(4)}&lng=${loc.lon.toFixed(4)}` +
    `&dist=${EBIRD_DIST_KM}&back=${EBIRD_BACK_DAYS}&includeProvisional=true&hotspot=false`;
  const res = await fetchWithTimeout(url, { headers: { "X-eBirdApiToken": apiKey } });
  if (res.status === 403) throw new Error("eBird rejected the API key");
  if (!res.ok) throw new Error("eBird HTTP " + res.status);
  return res.json();
}

// Converts real eBird observations into a 0-1000 score, normalized for
// birder effort rather than raw sighting counts - this is the actual fix for
// the coverage bias (a popular spot generating 40 checklists shouldn't just
// win on volume against a quiet spot generating 4). Two effort-normalized
// numbers drive it: species seen PER CHECKLIST and individuals PER CHECKLIST,
// plus an exponential recency decay (half-life ~36h) so a five-day-old
// report barely counts while this morning's does. Below
// EBIRD_MIN_CHECKLISTS, the sample is too thin to say anything reliable, so
// this returns null and the caller falls back to the model - still exposing
// the raw counts for transparency, not silently discarding them.
function computeEbirdScore(observations, now) {
  if (!observations || observations.length === 0) {
    return { total: null, reliable: false, checklistCount: 0, speciesCount: 0 };
  }
  const species = new Set();
  const checklists = new Set();
  let totalIndividuals = 0;
  let recencyWeightedActivity = 0;
  const nowMs = now.getTime();
  const HALF_LIFE_HOURS = 36;

  observations.forEach(obs => {
    species.add(obs.speciesCode);
    if (obs.subId) checklists.add(obs.subId);
    const count = typeof obs.howMany === "number" ? obs.howMany : 1;
    totalIndividuals += count;
    const obsMs = new Date(String(obs.obsDt).replace(" ", "T")).getTime();
    if (!isNaN(obsMs)) {
      const ageHours = Math.max(0, (nowMs - obsMs) / 3600000);
      const weight = Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
      recencyWeightedActivity += count * weight;
    }
  });

  const checklistCount = checklists.size || observations.length;
  const speciesCount = species.size;

  if (checklistCount < EBIRD_MIN_CHECKLISTS) {
    return { total: null, reliable: false, checklistCount, speciesCount };
  }

  const speciesPerChecklist = speciesCount / checklistCount;
  const activityPerChecklist = recencyWeightedActivity / checklistCount;

  // Saturating (diminishing-returns) curves, not linear: going from 2 to 5
  // species per checklist is a much bigger jump in confidence than 12 to 15.
  const richness = 500 * (1 - Math.exp(-speciesPerChecklist / 6));
  const activity = 350 * (1 - Math.exp(-activityPerChecklist / 8));
  // A small, capped confidence bonus for having a genuinely large sample -
  // deliberately minor so it can't dominate the effort-normalized terms above.
  const confidence = 150 * (1 - Math.exp(-checklistCount / 15));
  const total = Math.round(Math.min(1000, richness + activity + confidence));

  let verdict, tier;
  if (total >= 750) { verdict = "High activity - confirmed by recent sightings"; tier = "great"; }
  else if (total >= 500) { verdict = "Moderate activity - confirmed by recent sightings"; tier = "good"; }
  else if (total >= 250) { verdict = "Low activity - confirmed by recent sightings"; tier = "fair"; }
  else { verdict = "Quiet - very few sightings even after normalizing for effort"; tier = "poor"; }

  return {
    total, verdict, tier, source: "ebird", reliable: true, checklistCount, speciesCount,
    factors: {
      [`Species reported (${EBIRD_BACK_DAYS}d, ${EBIRD_DIST_KM}km)`]: speciesCount,
      "Species per checklist": speciesPerChecklist.toFixed(1),
      "Recency-weighted activity/checklist": activityPerChecklist.toFixed(1),
      "Checklists sampled": checklistCount
    }
  };
}

// ---------- Rendering ----------
// Maps a real sun phase to one of a handful of background moods. Purely
// cosmetic, but it is driven by the same phase classification the rest of
// the app uses - the background actually reflects what's happening outside,
// rather than an arbitrary decorative animation.
function applyPhaseTheme(phase) {
  let mood = "day";
  if (phase === "night") mood = "night";
  else if (phase.startsWith("astronomical") || phase.startsWith("blue hour")) mood = "blue";
  else if (phase.startsWith("golden hour") || phase === "civil twilight") mood = "golden";
  document.body.setAttribute("data-mood", mood);
}

function renderSun(loc, now, sunToday, sunTomorrow, utcOffsetSeconds, horizon) {
  const phase = classifyPhase(now, sunToday.times);
  document.getElementById("sun-phase").textContent = phase;
  document.getElementById("sun-elevation").textContent = `Elevation: ${sunToday.elevationDeg.toFixed(1)}°`;
  applyPhaseTheme(phase);

  const t = sunToday.times;
  const ft = (d) => fmtTime(d, utcOffsetSeconds);
  const blueIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v3M4.2 6.2l2 2M2 13h3M19 13h3M17.8 8.2l2-2"/><path d="M6 19a6 6 0 0 1 12 0"/></svg>';
  const goldIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="13" r="3.4"/><path d="M12 6.5V4M5.6 9.6 4 8M18.4 9.6 20 8M3 17h18"/></svg>';
  const noonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
  const terrainIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 18 9 7l4 6 2-3 6 8H3Z"/></svg>';
  const rows = [
    [blueIcon, "Blue hour (dawn)", `${ft(t.nauticalDawn)} - ${ft(t.dawn)}`],
    [goldIcon, "Golden hour (sunrise)", `${ft(t.sunrise)} - ${ft(t.goldenHourEnd)}`],
    [noonIcon, "Solar noon", ft(t.solarNoon)],
    [goldIcon, "Golden hour (sunset)", `${ft(t.goldenHour)} - ${ft(t.sunset)}`],
    [blueIcon, "Blue hour (dusk)", `${ft(t.dusk)} - ${ft(t.nauticalDusk)}`]
  ];

  // Real terrain, not just the astronomical horizon: if there's a meaningful
  // ridge/hillside in the sunrise or sunset direction, show when the sun
  // actually appears/disappears behind it, from real elevation data.
  if (horizon) {
    if (horizon.sunsetObstructionDeg > 1.5) {
      const visibleSunset = findHorizonCrossing(loc, t.sunset, horizon.sunsetObstructionDeg, -1);
      if (visibleSunset) {
        rows.push([terrainIcon, `Sunset behind terrain (${horizon.sunsetObstructionDeg.toFixed(1)}° ridge)`, ft(visibleSunset)]);
      }
    }
    if (horizon.sunriseObstructionDeg > 1.5) {
      const visibleSunrise = findHorizonCrossing(loc, t.sunrise, horizon.sunriseObstructionDeg, 1);
      if (visibleSunrise) {
        rows.push([terrainIcon, `Sunrise clears terrain (${horizon.sunriseObstructionDeg.toFixed(1)}° ridge)`, ft(visibleSunrise)]);
      }
    }
  }

  const tbody = document.querySelector("#sun-times tbody");
  tbody.innerHTML = rows.map(([icon, k, v], i) =>
    `<tr style="--stagger-delay:${i * 35}ms"><td><span class="row-icon">${icon}</span>${k}</td><td>${v}</td></tr>`
  ).join("");
  if (utcOffsetSeconds == null) {
    tbody.innerHTML += `<tr><td colspan="2" style="color:var(--muted);font-size:0.78rem;">Times shown in your device's timezone until weather data confirms the location's actual timezone.</td></tr>`;
  }
  return phase;
}

function renderTodayQuality(times, weatherData, horizon) {
  const qSunrise = qualityAt(weatherData.hourly, times.sunrise, horizon && horizon.sunriseObstructionDeg);
  const qSunset = qualityAt(weatherData.hourly, times.sunset, horizon && horizon.sunsetObstructionDeg);
  animateNumber(document.getElementById("q-sunrise"), qSunrise.score, { suffix: "%" });
  document.getElementById("q-sunrise-label").textContent = qSunrise.label;
  animateNumber(document.getElementById("q-sunset"), qSunset.score, { suffix: "%" });
  document.getElementById("q-sunset-label").textContent = qSunset.label;
  paintRing(document.getElementById("ring-sunrise"), qSunrise.score, qSunrise.label);
  paintRing(document.getElementById("ring-sunset"), qSunset.score, qSunset.label);
}

function renderOutlook(loc, weatherData, horizon) {
  const grid = document.getElementById("outlook-grid");
  grid.innerHTML = "";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let d = 0; d < 7; d++) {
    const day = new Date();
    day.setDate(day.getDate() + d);
    const { times } = computeSun(loc, day);
    // Terrain doesn't change day to day, so the same cached obstruction
    // angles apply across the whole outlook - no repeated elevation calls.
    const qSunrise = qualityAt(weatherData.hourly, times.sunrise, horizon && horizon.sunriseObstructionDeg);
    const qSunset = qualityAt(weatherData.hourly, times.sunset, horizon && horizon.sunsetObstructionDeg);
    const el = document.createElement("div");
    el.className = "outlook-day" + (d === 0 ? " is-today" : "");
    el.style.setProperty("--stagger-delay", (d * 45) + "ms");
    el.innerHTML = `
      <div class="oday-name">${dayNames[day.getDay()]} ${day.getMonth() + 1}/${day.getDate()}</div>
      <div class="orow"><span>Sunrise <span class="otime">${fmtTime(times.sunrise, weatherData.utc_offset_seconds)}</span></span>
        <span class="oscore" style="color:${qualityColor(qSunrise.label)}">${qSunrise.score}% ${qSunrise.label}</span></div>
      <div class="orow"><span>Sunset <span class="otime">${fmtTime(times.sunset, weatherData.utc_offset_seconds)}</span></span>
        <span class="oscore" style="color:${qualityColor(qSunset.label)}">${qSunset.score}% ${qSunset.label}</span></div>
    `;
    grid.appendChild(el);
  }
}

function renderWeather(sunToday, weatherData) {
  const c = weatherData.current;
  const trend = pressureTrend(weatherData);
  const exp = exposureGuidance(sunToday.elevationDeg, c.cloud_cover);
  const expEl = document.getElementById("exposure-verdict");
  expEl.textContent = exp.verdict;
  expEl.className = "big-stat tier-" + exp.tier;
  document.getElementById("iso-suggestion").textContent = `Suggested ISO range: ${exp.isoLow}-${exp.isoHigh}`;

  const rowIcons = {
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 16.5a4 4 0 0 1 .5-8 5 5 0 0 1 9.7-1.5A4.5 4.5 0 0 1 17.5 16H7Z"/></svg>',
    wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8h9a2.5 2.5 0 1 0-2-4"/><path d="M3 12h13a2.5 2.5 0 1 1-2 4"/><path d="M3 16h7a2 2 0 1 1-1.6 3.2"/></svg>',
    temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a2 2 0 0 0-2 2v9.2a4 4 0 1 0 4 0V5a2 2 0 0 0-2-2Z"/><circle cx="12" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>',
    humid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3c3 4 6 7.7 6 11a6 6 0 1 1-12 0c0-3.3 3-7 6-11Z"/></svg>',
    pressure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 12l4-2.4M12 7v.01"/></svg>'
  };
  const rows = [
    ["cloud", "Cloud cover", `${c.cloud_cover}%`],
    ["wind", "Wind", `${c.wind_speed_10m} km/h`],
    ["temp", "Temperature", formatTemp(c.temperature_2m)],
    ["humid", "Humidity", `${c.relative_humidity_2m}%`],
    ["pressure", "Pressure trend (3h)", `${trend >= 0 ? "+" : ""}${trend.toFixed(2)} hPa`]
  ];
  const tbody = document.querySelector("#weather-table tbody");
  tbody.innerHTML = rows.map(([icon, k, v], i) =>
    `<tr style="--stagger-delay:${i * 35}ms"><td><span class="row-icon">${rowIcons[icon]}</span>${k}</td><td>${v}</td></tr>`
  ).join("");
}

function renderBird(score) {
  animateNumber(document.getElementById("bird-score"), score.total);
  const verdictEl = document.getElementById("bird-verdict");
  verdictEl.textContent = score.verdict;
  verdictEl.className = "big-stat small tier-" + score.tier;
  document.getElementById("bird-fill").style.width = (score.total / 10) + "%";
  const sourceEl = document.getElementById("bird-source");
  if (score.source === "ebird") {
    sourceEl.textContent = `Live eBird sightings (${score.checklistCount} checklists, ${EBIRD_DIST_KM}km)`;
    sourceEl.className = "bird-source is-live";
  } else if (score.ebirdContext && score.ebirdContext.checklistCount > 0) {
    sourceEl.textContent = `Weather/astronomy model - only ${score.ebirdContext.checklistCount} eBird checklist${score.ebirdContext.checklistCount === 1 ? "" : "s"} nearby (need ${EBIRD_MIN_CHECKLISTS}+ to trust)`;
    sourceEl.className = "bird-source is-model";
  } else if (score.ebirdContext) {
    sourceEl.textContent = "Weather/astronomy model - no recent eBird checklists nearby";
    sourceEl.className = "bird-source is-model";
  } else {
    sourceEl.textContent = "Weather/astronomy model";
    sourceEl.className = "bird-source is-model";
  }
  const grid = document.getElementById("bird-factors");
  grid.innerHTML = Object.entries(score.factors).map(([k, v], i) =>
    `<div class="factor" style="--stagger-delay:${i * 45}ms"><div class="fname">${k}</div><div class="fval">${v}</div></div>`
  ).join("");
}

function renderAbout() {
  document.getElementById("about-content").innerHTML = `
    <h3>Sun &amp; light</h3>
    <p>Sun position and twilight/golden/blue hour boundaries are computed on-device from the standard low-precision solar position algorithm (Jean Meeus, <em>Astronomical Algorithms</em>) using your coordinates and the current time - pure astronomical geometry, no network call and no external script required. Blue hour is approximated as the window between nautical twilight and civil twilight (sun roughly -6&deg; to -8&deg; below the horizon), matching common photographic convention.</p>
    <h3>Sunrise/sunset quality (%)</h3>
    <p>Built from Open-Meteo's altitude-banded cloud cover (low/mid/high) and humidity at the exact sunrise/sunset hour, for today and the next 7 days. The logic: high and mid clouds are what catch and scatter low-angle sunlight into color, so a moderate amount of them (roughly 30-50%, not zero, not solid overcast) scores highest; low clouds sitting on the horizon block the sun's light path before it can light anything up, so more low cloud cover drags the score toward zero regardless of the high/mid layers; high humidity scatters and mutes saturation, so it further discounts the score. This is the same category of model commercial sunset-prediction apps use, built here from the raw altitude-banded data rather than a proprietary formula - it is a genuine physical estimate, not a guess, but it is not calibrated against photographed outcomes the way a paid app with a large feedback dataset might be.</p>
    <h3>Terrain horizon (new)</h3>
    <p>Cloud-based quality alone assumes a flat horizon, which is wrong anywhere near real relief (Colorado's Front Range, a river bluff, a valley). The app samples real elevation data (Open-Meteo's elevation API) along the actual compass bearing of sunrise and sunset from your coordinates, at four distances out to 35km, and computes the angle above true horizontal of the tallest obstruction in that line of sight - correcting for Earth's curvature the same way horizon/terrain-masking tools like heywhatsthat.com do. That feeds the Sun &amp; Light table's "behind terrain"/"clears terrain" times, which show when the sun actually disappears behind or clears that ridge - genuinely earlier/later than the flat-horizon time, and directly relevant to how long you have usable direct light and can shoot at low ISO.</p>
    <p><strong>What it deliberately does NOT do:</strong> discount the sunrise/sunset quality (color) score. Sky color at sunset comes from sunlight scattering through the atmosphere as the sun continues descending toward and below the geometric horizon - color development often peaks a few minutes after the disc visually disappears, through civil twilight around -6&deg; - and that keeps happening whether or not a nearby ridge blocks your direct line of sight to the disc. A mountain sunset is a different photographic subject (ridgeline silhouette, layered light across the peaks), not a physically worse one for color, so obstruction only affects the timing numbers here, never the quality percentage. On flat ground (DuPage County, for instance) the obstruction comes back near zero and nothing changes. Terrain doesn't move, so it's fetched once per location and cached rather than re-fetched every refresh.</p>
    <h3>Weather &amp; exposure</h3>
    <p>Cloud cover, wind, temperature, humidity, and pressure come from <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (no API key, hourly-resolution model/observation blend). The ISO suggestion assumes bird-in-flight shutter speeds (~1/1600-1/2500s) are fixed, so ISO is the variable absorbing light loss - it is a heuristic based on sun elevation and cloud cover, not a light-meter reading.</p>
    <h3>Bird activity meter (0-1000) - two different sources</h3>
    <p><strong>With an eBird API key set (Bird data source, above):</strong> the score comes from actual eBird checklists within ${EBIRD_DIST_KM}km over the last ${EBIRD_BACK_DAYS} days - genuine reported sightings, not a model. To fight down the biggest problem with this kind of data - that a spot with more birders visiting just generates more raw sightings, regardless of actual bird density - every number is normalized <strong>per checklist</strong> rather than used as a raw total: species-per-checklist, and a recency-weighted individuals-per-checklist figure (each observation's weight halves every 36 hours, so a report from this morning counts for far more than one from five days ago). A small, capped bonus rewards having a genuinely large sample, but it's deliberately too small to let raw volume win on its own. If fewer than ${EBIRD_MIN_CHECKLISTS} checklists were submitted nearby in that window, the sample is too thin to say anything - the tool falls back to the model below rather than report noise as signal, and shows the actual checklist count next to "model" so you know real data existed but wasn't enough to trust.</p>
    <p><strong>What this still can't fix:</strong> if a location is never birded, it will always show as "quiet" here regardless of what's actually present - there is no free substitute for on-the-ground observation. Per-checklist normalization corrects for volume bias between two visited spots, not for a spot nobody visits at all.</p>
    <p><strong>Without a key, or when eBird's sample is too thin:</strong> the meter falls back to a heuristic probability model built from real, cited inputs - not a live feed, and it says so in the verdict text ("model estimate"):</p>
    <p><strong>Daylight/twilight position</strong> is the gate, not just one input among several: a daytime baseline (with the documented midday activity lull), a sharp bonus right at sunrise/sunset for the dawn-chorus and pre-roost feeding peaks, and a low floor at full night, based on published circadian activity research (Staicer, Spector &amp; Horn 1996). Weather and season only modulate this gate - they cannot manufacture a "moderate activity" reading at 2 AM just because the barometric trend looks good.</p>
    <p><strong>Weather modifier (~0.55x-1.15x)</strong> - penalizes wind above ~20 km/h and active precipitation (both suppress flight/foraging activity, consistent with Newton's <em>The Migration Ecology of Birds</em> and BirdCast's published forecasting approach), and gives a bonus for falling barometric pressure (pre-frontal foraging increase) with a penalty for sharply rising pressure. During the spring and fall migration windows it also checks wind DIRECTION, not just speed: a true tailwind for that season's typical migratory bearing (south winds in spring, north winds in fall) adds a bonus, a headwind subtracts one - wind support is one of the most consistently documented predictors of migratory departure intensity, and is the same physical variable behind Cornell's BirdCast forecasts.</p>
    <p><strong>Season/migration modifier (~0.70x-1.20x)</strong> - a fixed calendar bump for Northern Hemisphere spring (Apr-May) and fall (Sep-Oct) migration windows, moderate for breeding season (Jun-Jul), lower baseline for winter.</p>
    <p>The heuristic is tuned for diurnal and crepuscular species - passerines, woodpeckers, raptors, waterfowl - not owls or nocturnal migrants; the night floor is a deliberate low baseline, not a claim nothing moves after dark. Either way, treat the number as a planning aid, not certainty: the eBird-backed score is real, effort-normalized data with one uncorrectable gap (unvisited locations), and the fallback is a cited behavioral model with no ground truth at all.</p>
  `;
}

// ---------- Log ----------
function loadLog() {
  try { return JSON.parse(localStorage.getItem(LS_LOG_KEY)) || []; }
  catch (e) { return []; }
}
function saveLog(entries) {
  localStorage.setItem(LS_LOG_KEY, JSON.stringify(entries));
}
function renderLog(highlightFirst) {
  const entries = loadLog();
  const tbody = document.querySelector("#log-table tbody");
  if (entries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px 0;">No shoots logged yet - conditions at the time of your next entry will be captured automatically.</td></tr>`;
    return;
  }
  tbody.innerHTML = entries.map((e, i) => `
    <tr class="${highlightFirst && i === 0 ? "is-new" : ""}">
      <td>${new Date(e.ts).toLocaleString()}</td>
      <td>${e.species}</td>
      <td>${e.gear || ""}</td>
      <td>${e.sunPhase || ""}</td>
      <td>${e.birdScore ?? ""}</td>
      <td>${e.notes || ""}</td>
      <td><button data-idx="${i}" class="del-log">x</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".del-log").forEach(btn => {
    btn.addEventListener("click", () => {
      const entries = loadLog();
      entries.splice(Number(btn.dataset.idx), 1);
      saveLog(entries);
      renderLog();
    });
  });
}
function exportCsv() {
  const entries = loadLog();
  const header = ["timestamp", "species", "gear", "sun_phase", "bird_score", "notes"];
  const rows = entries.map(e => [
    new Date(e.ts).toISOString(), e.species, e.gear || "", e.sunPhase || "", e.birdScore ?? "", (e.notes || "").replace(/"/g, '""')
  ]);
  const csv = [header, ...rows].map(r => r.map(f => `"${f}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "shoot_log.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Main refresh ----------
// Sun/light geometry needs zero network access, so it is computed and rendered
// first and unconditionally. Weather (and everything derived from it - exposure
// guidance, quality rings, outlook, bird score) is fetched separately and
// degrades gracefully on failure, since this is meant for field use where a
// signal drop shouldn't take down the whole dashboard.
// Persists the last successful reading so the dashboard has something real
// to show immediately on load, or if a later refresh fails outright on a
// weak field connection - a blank dashboard on a signal drop is a worse
// failure mode than a clearly-labeled stale one.
function saveGoodState(now, loc, weatherData, score, horizon) {
  try {
    localStorage.setItem(LS_CACHE_KEY, JSON.stringify({ ts: now.getTime(), loc, weatherData, score, horizon }));
  } catch (e) { /* storage full/unavailable - non-fatal, just skip the cache */ }
}
function loadGoodState() {
  try {
    const raw = localStorage.getItem(LS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function setStaleBanner(visible, text) {
  const banner = document.getElementById("stale-banner");
  if (!banner) return;
  banner.hidden = !visible;
  if (visible) document.getElementById("stale-banner-text").textContent = text;
}

async function refreshAll() {
  // Guard against overlapping fetches - a double-tap on Refresh, or the auto
  // -refresh timer landing mid-request, would otherwise fire two full
  // request chains and let whichever resolves last silently win.
  if (state.refreshing) return;
  state.refreshing = true;

  const statusEl = document.getElementById("status-msg");
  const refreshBtn = document.getElementById("refresh-btn");
  refreshBtn.classList.add("is-loading");
  refreshBtn.disabled = true;
  const loc = state.loc;
  const now = new Date();
  const sunToday = computeSun(loc, now);
  const tomorrow = new Date(now.getTime() + 86400000);
  const sunTomorrow = computeSun(loc, tomorrow);

  state.now = now;
  state.sunTimes = sunToday;

  const phase = renderSun(loc, now, sunToday, sunTomorrow);
  state.lastPhase = phase;

  statusEl.textContent = "Fetching weather...";
  try {
    const weatherData = await fetchWeather(loc);
    state.weather = weatherData;

    // Real terrain horizon for this location - cached after the first fetch,
    // and never allowed to block the rest of the dashboard if it's slow or
    // fails, since it's a refinement on top of the core numbers, not a
    // dependency of them.
    let horizon = null;
    try {
      horizon = await getHorizonData(loc, sunToday.times);
    } catch (err) {
      console.warn("Terrain horizon lookup failed, using flat-horizon assumption:", err);
    }
    state.horizon = horizon;

    // re-render with the location's real UTC offset now that we have it
    renderSun(loc, now, sunToday, sunTomorrow, weatherData.utc_offset_seconds, horizon);
    renderTodayQuality(sunToday.times, weatherData, horizon);
    renderOutlook(loc, weatherData, horizon);
    renderWeather(sunToday, weatherData);

    let score = null;
    let ebirdContext = null;
    const ebirdKey = loadEbirdKey();
    if (ebirdKey) {
      try {
        const observations = await fetchEbirdObservations(loc, ebirdKey);
        const ebirdScore = computeEbirdScore(observations, now);
        if (ebirdScore.reliable) {
          score = ebirdScore;
        } else {
          // Real data came back, just too thin a sample to trust as the
          // primary number - keep it as visible context rather than
          // discarding it, and fall back to the model below.
          ebirdContext = ebirdScore;
        }
      } catch (err) {
        console.warn("eBird fetch failed, falling back to the weather/astronomy model:", err);
      }
    }
    if (!score) {
      score = computeBirdScore(now, sunToday.times, weatherData, sunToday.elevationDeg);
      score.ebirdContext = ebirdContext;
    }
    state.birdScore = score;
    renderBird(score);

    setStaleBanner(false);
    saveGoodState(now, loc, weatherData, score, horizon);

    statusEl.textContent = "Updated " + now.toLocaleTimeString();
    liveTick(); // refresh the live-clock line immediately - otherwise it can
                // still show "(weather offline)" from the pre-fetch tick
                // until the next 15s interval fires
  } catch (err) {
    console.error(err);
    const cached = loadGoodState();
    const sameSpot = cached && Math.abs(cached.loc.lat - loc.lat) < 0.01 && Math.abs(cached.loc.lon - loc.lon) < 0.01;
    if (sameSpot) {
      // Show the last known-good reading rather than a blank dashboard -
      // clearly labeled as stale so it's never mistaken for current
      // conditions, which matters most exactly when signal is bad in the field.
      const cachedAgeMin = Math.round((now.getTime() - cached.ts) / 60000);
      state.weather = cached.weatherData;
      state.horizon = cached.horizon;
      state.birdScore = cached.score;
      renderSun(loc, now, sunToday, sunTomorrow, cached.weatherData.utc_offset_seconds, cached.horizon);
      renderTodayQuality(sunToday.times, cached.weatherData, cached.horizon);
      renderOutlook(loc, cached.weatherData, cached.horizon);
      renderWeather(sunToday, cached.weatherData);
      renderBird(cached.score);
      setStaleBanner(true, `No connection - showing weather/bird data from ${cachedAgeMin < 1 ? "under a minute" : cachedAgeMin + " min"} ago.`);
      statusEl.textContent = "Weather unavailable (" + err.message + ") - showing last known reading.";
    } else {
      statusEl.textContent = "Sun/light times updated. Weather unavailable (" + err.message + ") - exposure, quality rings, outlook, and bird score need a connection.";
      showWeatherUnavailable();
    }
  } finally {
    refreshBtn.classList.remove("is-loading");
    refreshBtn.disabled = false;
    state.refreshing = false;
  }
}

// Lightweight live update: recomputes sun position/phase and (if weather is
// already cached) the bird score's time-of-day component every few seconds,
// with zero network calls. This is what makes elevation, phase, and the
// bird meter track real time instead of only updating on a 10-minute cycle.
function liveTick() {
  const loc = state.loc;
  const now = new Date();
  const prevTimes = state.sunTimes;
  const sunToday = computeSun(loc, now);

  // If local calendar date rolled over, sunrise/sunset/outlook dates are
  // stale - force a full refresh (including a fresh weather fetch) instead
  // of patching in place.
  const dayRolled = prevTimes && (
    prevTimes.times.solarNoon.getFullYear() !== sunToday.times.solarNoon.getFullYear() ||
    prevTimes.times.solarNoon.getMonth() !== sunToday.times.solarNoon.getMonth() ||
    prevTimes.times.solarNoon.getDate() !== sunToday.times.solarNoon.getDate()
  );
  if (dayRolled) {
    refreshAll();
    return;
  }

  state.now = now;
  state.sunTimes = sunToday;
  const utcOffset = state.weather ? state.weather.utc_offset_seconds : undefined;
  const phase = renderSun(loc, now, sunToday, null, utcOffset, state.horizon);
  state.lastPhase = phase;

  // Only live-update the heuristic score between fetches - it's time-of-day
  // driven, so it should track the clock. An eBird-backed score reflects a
  // multi-day observation window, not the current second, so it stays as-is
  // until the next full refresh instead of flapping every 15s.
  if (state.weather && (!state.birdScore || state.birdScore.source !== "ebird")) {
    const score = computeBirdScore(now, sunToday.times, state.weather, sunToday.elevationDeg);
    // Carry the "N checklists nearby, too few to trust" note across this
    // recompute - otherwise it would vanish for up to 15s at a time and only
    // reappear right after a full refresh, which reads as a flaky bug.
    score.ebirdContext = state.birdScore ? state.birdScore.ebirdContext : null;
    state.birdScore = score;
    renderBird(score);
  }

  document.getElementById("live-clock-text").textContent =
    "Live - " + now.toLocaleTimeString() + (state.weather ? "" : " (weather offline)");
}

function showWeatherUnavailable() {
  setStaleBanner(false);
  const expEl = document.getElementById("exposure-verdict");
  expEl.textContent = "No connection";
  expEl.className = "big-stat";
  document.getElementById("iso-suggestion").textContent = "Weather data unavailable";
  document.querySelector("#weather-table tbody").innerHTML = "";
  document.getElementById("q-sunrise").textContent = "--";
  document.getElementById("q-sunset").textContent = "--";
  document.getElementById("q-sunrise-label").textContent = "n/a";
  document.getElementById("q-sunset-label").textContent = "n/a";
  document.getElementById("bird-score").textContent = "--";
  const sourceEl = document.getElementById("bird-source");
  sourceEl.textContent = "--";
  sourceEl.className = "bird-source";
  const verdictEl = document.getElementById("bird-verdict");
  verdictEl.textContent = "Needs weather data";
  verdictEl.className = "big-stat small";
  document.getElementById("bird-fill").style.width = "0%";
  document.getElementById("bird-factors").innerHTML = "";
  document.getElementById("outlook-grid").innerHTML = "<p class=\"sub-stat\">Weather data unavailable - check your connection and hit Refresh.</p>";
}

function setLocationLabel() {
  document.getElementById("loc-label").textContent =
    `${state.loc.label || "Custom"} (${state.loc.lat.toFixed(4)}, ${state.loc.lon.toFixed(4)})`;
}

// ---------- Terrain / activity map ----------
// Real topographic base layer (OpenTopoMap, free/no-key) plus a small grid of
// nearby points genuinely sampled from Open-Meteo in one batched request, so
// the color you see at each dot reflects that cell's own cloud cover, wind
// and precipitation rather than one number painted across the whole area.
// There is no live feed of actual bird locations (see the Notes tab) - the
// "Bird Activity" layer is the same heuristic model as the dashboard, just
// evaluated once per grid cell using that cell's local weather.
const mapState = { map: null, markers: [], layer: "sunset", cells: null, loading: false };
const GRID_RADIUS = 2;       // -2..+2 -> 5x5 grid
const GRID_STEP_KM = 9;      // spacing between sample points

function buildGrid(loc) {
  const points = [];
  const dLat = GRID_STEP_KM / 111; // ~km per degree latitude
  const dLon = GRID_STEP_KM / (111 * Math.max(0.15, Math.cos(loc.lat * Math.PI / 180)));
  for (let i = -GRID_RADIUS; i <= GRID_RADIUS; i++) {
    for (let j = -GRID_RADIUS; j <= GRID_RADIUS; j++) {
      points.push({ lat: loc.lat + i * dLat, lon: loc.lon + j * dLon, isCenter: i === 0 && j === 0 });
    }
  }
  return points;
}

async function fetchGridWeather(points) {
  const lats = points.map(p => p.lat.toFixed(4)).join(",");
  const lons = points.map(p => p.lon.toFixed(4)).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
    `&current=wind_speed_10m,wind_direction_10m,precipitation,cloud_cover,temperature_2m` +
    `&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,wind_speed_10m,precipitation,surface_pressure` +
    `&forecast_days=1&timezone=auto`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : [data]; // single-point requests aren't wrapped in an array
}

// Real per-cell terrain horizon for the grid, not just the visual topo tiles
// underneath it - one batched elevation call covering every cell's own
// sightline toward the sunset. All cells share one sunset bearing (computed
// once from the grid center) since it barely shifts over a few kilometers.
async function fetchGridHorizon(points, sunsetBearing) {
  const n = HORIZON_DISTANCES_KM.length;
  const allPoints = [];
  points.forEach(p => {
    allPoints.push({ lat: p.lat, lon: p.lon });
    HORIZON_DISTANCES_KM.forEach(d => allPoints.push(haversineDestination(p.lat, p.lon, sunsetBearing, d)));
  });
  const elevations = await fetchElevations(allPoints);
  return points.map((p, c) => {
    const base = c * (n + 1);
    const observerElevM = elevations[base];
    let maxAngle = -90;
    for (let i = 0; i < n; i++) {
      const a = obstructionAngleDeg(observerElevM, elevations[base + 1 + i], HORIZON_DISTANCES_KM[i]);
      if (a > maxAngle) maxAngle = a;
    }
    return { observerElevM, obstructionDeg: maxAngle };
  });
}

function scoreGridCell(point, weather, now, obstructionDeg) {
  const sun = computeSun(point, now);
  const sunset = qualityAt(weather.hourly, sun.times.sunset, obstructionDeg);
  const bird = computeBirdScore(now, sun.times, weather, sun.elevationDeg);
  return { point, sunset, bird, current: weather.current, obstructionDeg };
}

function renderGridMarkers() {
  if (!mapState.map || !mapState.cells) return;
  mapState.markers.forEach(m => mapState.map.removeLayer(m));
  mapState.markers = [];
  mapState.cells.forEach(cell => {
    const isSunset = mapState.layer === "sunset";
    const label = isSunset ? cell.sunset.label : cell.bird.tier[0].toUpperCase() + cell.bird.tier.slice(1);
    const scoreVal = isSunset ? cell.sunset.score : cell.bird.total;
    const color = isSunset ? qualityColor(cell.sunset.label) : qualityColor(
      cell.bird.tier === "great" ? "Great" : cell.bird.tier === "good" ? "Good" : cell.bird.tier === "fair" ? "Fair" : "Poor"
    );
    const marker = L.circleMarker([cell.point.lat, cell.point.lon], {
      radius: cell.point.isCenter ? 12 : 9,
      color: "rgba(255,255,255,0.65)",
      weight: cell.point.isCenter ? 2.5 : 1.5,
      fillColor: color,
      fillOpacity: 0.82,
      className: "grid-marker"
    }).addTo(mapState.map);
    const terrainLine = (isSunset && typeof cell.obstructionDeg === "number" && cell.obstructionDeg > 1.5)
      ? `<br>Terrain: ~${cell.obstructionDeg.toFixed(1)}&deg; ridge nearby - direct light ends earlier here (color show unaffected)`
      : "";
    marker.bindPopup(
      `<b>${cell.point.isCenter ? "Your location" : "Nearby sample"}</b><br>` +
      `${isSunset ? "Sunset quality" : "Bird activity"}: <b>${scoreVal}${isSunset ? "%" : "/1000"}</b> (${label})<br>` +
      `Wind ${cell.current.wind_speed_10m} km/h &middot; Cloud ${cell.current.cloud_cover}% &middot; Precip ${cell.current.precipitation} mm` +
      terrainLine
    );
    mapState.markers.push(marker);
  });
}

async function loadMapGrid() {
  if (mapState.loading) return;
  mapState.loading = true;
  const loadingEl = document.getElementById("map-loading");
  const statusEl = document.getElementById("map-status");
  const refreshBtn = document.getElementById("map-refresh-btn");
  loadingEl.hidden = false;
  refreshBtn.classList.add("is-loading");
  try {
    const points = buildGrid(state.loc);
    const now = new Date();
    const results = await fetchGridWeather(points);

    // Terrain horizon per cell - real elevation data, not just decoration
    // from the topo tiles. Degrades gracefully: a failed/slow elevation
    // fetch just means the sunset layer falls back to the flat-horizon
    // assumption for this load rather than blocking the map entirely.
    let obstructions = null;
    const terrainNoteEl = document.getElementById("map-terrain-note");
    try {
      const centerTimes = computeSun(state.loc, now).times;
      const sunsetBearing = bearingFromAzimuth(SunCalcLite.getPosition(centerTimes.sunset, state.loc.lat, state.loc.lon).azimuth);
      obstructions = await fetchGridHorizon(points, sunsetBearing);
      if (terrainNoteEl) {
        const maxObs = Math.max(...obstructions.map(o => o.obstructionDeg));
        terrainNoteEl.textContent = maxObs > 1.5
          ? `Real terrain checked along the sunset sightline for each point - up to ${maxObs.toFixed(1)}° of ridge nearby shortens direct light, not the color show.`
          : "Real terrain checked along the sunset sightline for each point - essentially flat horizon here.";
      }
    } catch (err) {
      console.warn("Grid terrain lookup failed, sunset layer using flat-horizon assumption:", err);
      if (terrainNoteEl) terrainNoteEl.textContent = "Terrain lookup unavailable this load - sunset layer using a flat-horizon assumption.";
    }

    mapState.cells = points.map((p, i) => scoreGridCell(p, results[i], now, obstructions ? obstructions[i].obstructionDeg : 0));
    renderGridMarkers();
    statusEl.textContent = `Sampled ${points.length} points in a ${GRID_STEP_KM}km grid around your location, from Open-Meteo, just now.`;
  } catch (err) {
    statusEl.textContent = "Couldn't sample the terrain grid (" + err.message + "). Check your connection and hit Resample.";
    console.error(err);
  } finally {
    loadingEl.hidden = true;
    refreshBtn.classList.remove("is-loading");
    mapState.loading = false;
  }
}

function initMapTab() {
  if (!window.L) {
    document.getElementById("map-status").textContent = "Map library failed to load - check your connection and reopen this tab.";
    return;
  }
  if (!mapState.map) {
    mapState.map = L.map("leaflet-map", { attributionControl: true }).setView([state.loc.lat, state.loc.lon], 11);
    L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 16,
      attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)"
    }).addTo(mapState.map);

    document.querySelectorAll(".map-layer-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".map-layer-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        mapState.layer = btn.dataset.layer;
        renderGridMarkers();
      });
    });
    document.getElementById("map-refresh-btn").addEventListener("click", loadMapGrid);
  } else {
    // Panel was display:none - Leaflet measured a zero-size container on
    // creation, so it needs a nudge now that it's actually visible.
    setTimeout(() => mapState.map.invalidateSize(), 60);
  }
  if (!mapState.cells) loadMapGrid();
}

// ---------- Wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  state.loc = loadLocation();
  setLocationLabel();
  renderAbout();
  renderLog();
  refreshEbirdKeyStatus();

  // Paint the last known-good reading immediately, before the network round
  // trip even starts - on a slow mobile connection this is the difference
  // between an instant (if stale-labeled) dashboard and several seconds of
  // dashes. refreshAll() below still runs and replaces it with live data
  // (or a fresher stale notice) as soon as it resolves.
  const cachedOnLoad = loadGoodState();
  if (cachedOnLoad && Math.abs(cachedOnLoad.loc.lat - state.loc.lat) < 0.01 && Math.abs(cachedOnLoad.loc.lon - state.loc.lon) < 0.01) {
    const now0 = new Date();
    const sunToday0 = computeSun(state.loc, now0);
    state.weather = cachedOnLoad.weatherData;
    state.horizon = cachedOnLoad.horizon;
    state.birdScore = cachedOnLoad.score;
    renderSun(state.loc, now0, sunToday0, null, cachedOnLoad.weatherData.utc_offset_seconds, cachedOnLoad.horizon);
    renderTodayQuality(sunToday0.times, cachedOnLoad.weatherData, cachedOnLoad.horizon);
    renderOutlook(state.loc, cachedOnLoad.weatherData, cachedOnLoad.horizon);
    renderWeather(sunToday0, cachedOnLoad.weatherData);
    renderBird(cachedOnLoad.score);
    const ageMin = Math.round((now0.getTime() - cachedOnLoad.ts) / 60000);
    setStaleBanner(true, `Loading... showing cached data from ${ageMin < 1 ? "under a minute" : ageMin + " min"} ago until it refreshes.`);
  }

  refreshAll();
  liveTick();

  const tempUnitToggle = document.getElementById("temp-unit-toggle");
  if (tempUnitToggle) {
    const savedUnit = loadTempUnit();
    tempUnitToggle.querySelectorAll(".map-layer-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.unit === savedUnit);
      btn.addEventListener("click", () => {
        saveTempUnit(btn.dataset.unit);
        tempUnitToggle.querySelectorAll(".map-layer-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        // Display-only change - re-render from already-fetched data instead
        // of a network refresh.
        if (state.weather && state.sunTimes) renderWeather(state.sunTimes, state.weather);
      });
    });
  }

  document.getElementById("save-ebird-key").addEventListener("click", () => {
    const val = document.getElementById("ebird-key-input").value;
    saveEbirdKey(val);
    document.getElementById("ebird-key-input").value = "";
    refreshEbirdKeyStatus();
    refreshAll();
  });

  // Splash is pure CSS (fades itself out via animation-fill-mode), but pull
  // it out of the layout/tab order once it's done so it can't intercept
  // anything or confuse a screen reader.
  const splash = document.getElementById("intro-splash");
  if (splash) splash.addEventListener("animationend", () => splash.remove());

  const tabOrder = Array.from(document.querySelectorAll(".tab-btn")).map(b => b.dataset.tab);
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const fromIdx = tabOrder.indexOf(document.querySelector(".tab-btn.active").dataset.tab);
      const toIdx = tabOrder.indexOf(btn.dataset.tab);
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active", "dir-fwd", "dir-back"));
      btn.classList.add("active");
      const panel = document.getElementById(btn.dataset.tab);
      panel.classList.add("active", toIdx >= fromIdx ? "dir-fwd" : "dir-back");
      if (btn.dataset.tab === "map") initMapTab();
    });
  });

  document.getElementById("refresh-btn").addEventListener("click", refreshAll);

  document.getElementById("set-loc").addEventListener("click", () => {
    const val = document.getElementById("loc-input").value.trim();
    const parts = val.split(",").map(s => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      state.loc = { lat: parts[0], lon: parts[1], label: "Custom" };
      saveLocation(state.loc);
      setLocationLabel();
      refreshAll();
    } else {
      document.getElementById("status-msg").textContent = "Enter coordinates as: lat, lon";
    }
  });

  document.getElementById("use-gps").addEventListener("click", () => {
    if (!navigator.geolocation) {
      document.getElementById("status-msg").textContent = "Geolocation not supported in this browser.";
      return;
    }
    navigator.geolocation.getCurrentPosition(pos => {
      state.loc = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "GPS" };
      saveLocation(state.loc);
      setLocationLabel();
      refreshAll();
    }, err => {
      document.getElementById("status-msg").textContent = "GPS error: " + err.message;
    });
  });

  document.getElementById("log-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const species = document.getElementById("log-species").value.trim();
    if (!species) return;
    const entries = loadLog();
    entries.unshift({
      ts: Date.now(),
      species,
      gear: document.getElementById("log-gear").value.trim(),
      notes: document.getElementById("log-notes").value.trim(),
      sunPhase: state.lastPhase || "",
      birdScore: state.birdScore ? state.birdScore.total : ""
    });
    saveLog(entries);
    renderLog(true);
    e.target.reset();
  });

  document.getElementById("export-csv").addEventListener("click", exportCsv);
  document.getElementById("clear-log").addEventListener("click", () => {
    if (confirm("Clear the entire shoot log?")) {
      saveLog([]);
      renderLog();
    }
  });

  // Live tick (no network) keeps sun position, phase, and the bird score's
  // time-of-day component current every 15s. Weather itself changes on the
  // order of minutes, so it's refetched on its own, slower cycle.
  setInterval(liveTick, 15 * 1000);
  setInterval(refreshAll, 5 * 60 * 1000);

  // Timers throttle or pause in a backgrounded tab, so catch up immediately
  // when the tab becomes visible again instead of waiting for the next tick -
  // relevant for a field app someone checks by unlocking their phone.
  let lastVisibleRefresh = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      liveTick();
      if (Date.now() - lastVisibleRefresh > 2 * 60 * 1000) {
        lastVisibleRefresh = Date.now();
        refreshAll();
      }
    }
  });
});
