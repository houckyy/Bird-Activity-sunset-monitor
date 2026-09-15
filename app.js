/* Photography & Bird Activity Monitor
   All figures come from two real data sources:
   - Built-in solar position model (Meeus low-precision solar algorithm; astronomical
     geometry for sun position, twilight/golden/blue hour times, no network call needed)
   - Open-Meteo (observed/forecast weather: cloud cover, wind, temp, pressure)
   The bird activity score is a heuristic model built from those real inputs plus
   date-of-year, not a live feed of actual bird counts. See the "Model Notes" tab.
*/

const DEFAULT_LOC = { lat: 39.8283, lon: -98.5795, label: "Default location - set yours above" };
const LS_LOC_KEY = "pbam_location";
const LS_LOG_KEY = "pbam_log";
const LS_CALIB_KEY = "pbam_calibration";
// A logged shoot only feeds calibration once you've rated at least one of
// the two outcomes below it; fewer than this many rated entries and a
// single lucky/unlucky log could swing the correction too hard, so no
// correction is applied yet.
const CALIB_MIN_SAMPLES = 3;
// Correction is capped so one run of bad-weather-day outliers can't drag
// every future prediction far from what the model itself is actually
// computing from real data. Sized to roughly one rating tier's worth of
// movement - full scale divided by the number of rating options in the
// dropdowns below (5, since "Legendary" was added as a tier on top of the
// original 4), not an arbitrary number.
const CALIB_MAX_LIGHT_CORRECTION = 20;   // points, on the 0-100 light scale (100 / 5 tiers)
const CALIB_MAX_BIRD_CORRECTION = 200;   // points, on the 0-1000 bird scale (1000 / 5 tiers)
// Actual-outcome ratings map to the same score bands the model itself uses
// (see computeSunQuality/computeBirdScore below), so a rating of "Good"
// compares against a predicted score using the same definition of "Good".
const LIGHT_RATING_SCORES = { poor: 16, fair: 43, good: 65, great: 87, legendary: 98 };
const BIRD_RATING_SCORES = { none: 100, low: 375, moderate: 625, high: 875, legendary: 975 };

// Turns a computed sun-quality result into the matching option value in the
// Shoot Log's "Rate the sunset/sunrise" dropdown, so the dropdown can be
// pre-filled with the app's own live prediction instead of always starting
// at "Didn't rate it".
function lightKeyForQuality(q) {
  if (!q || typeof q.score !== "number") return "";
  if (q.legendary) return "legendary";
  return q.label ? q.label.toLowerCase() : "";
}
// Same idea for the bird-activity dropdown - bands roughly match the
// verdict tiers computeBirdScore already uses (see its 750/500/250
// thresholds), plus a top "legendary" band for a score high enough to be
// genuinely rare on the 0-1000 scale.
function birdKeyForTotal(total) {
  if (typeof total !== "number") return "";
  if (total >= 950) return "legendary";
  if (total >= 750) return "high";
  if (total >= 500) return "moderate";
  if (total >= 250) return "low";
  return "none";
}
// Whichever of today's sun events (sunrise or sunset) is closer to right
// now is the one a shoot happening "right now" should be judged against.
// Top-level (not scoped to the DOMContentLoaded handler) so both the Shoot
// Log wiring and the periodic liveTick() auto-fill can call it.
function nearestSunQ() {
  if (!state.sunTimes || !state.qSunrise || !state.qSunset) return null;
  const now = state.now || new Date();
  const dSunrise = Math.abs(now - state.sunTimes.times.sunrise);
  const dSunset = Math.abs(now - state.sunTimes.times.sunset);
  return dSunrise <= dSunset ? state.qSunrise : state.qSunset;
}
// Pre-fills both rating dropdowns with the app's own current prediction
// (nearest sunrise/sunset quality, live bird-activity score) so logging a
// shoot is normally "does this look right, tap Add Entry" rather than two
// blind picks starting from "Didn't rate it" - these dropdowns exist to
// capture ground truth AGAINST a prediction, so starting from the
// prediction and letting the user correct or clear it is the natural
// default. Never overwrites a value the user has actually changed
// themselves this session (state.logTouched, set by the change listeners
// in the DOMContentLoaded wiring) or a value already set by the photo-color
// pre-fill.
function autoFillLogRatings() {
  const lightSelect = document.getElementById("log-actual-light");
  const birdSelect = document.getElementById("log-actual-bird");
  if (lightSelect && !state.logTouched.light && !lightSelect.value) {
    const key = lightKeyForQuality(nearestSunQ());
    if (key) lightSelect.value = key;
  }
  if (birdSelect && !state.logTouched.bird && !birdSelect.value) {
    const key = birdKeyForTotal(state.birdScore ? state.birdScore.total : null);
    if (key) birdSelect.value = key;
  }
}
// v2: bumped when the horizon math changed (single-ray -> bearing-fan) so
// old cached results using the weaker method don't linger indefinitely.
const LS_HORIZON_PREFIX = "pbam_horizon_v2_";
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
  birdScore: null,
  // Keyed "sunrise-2026-09-13" / "sunset-2026-09-13" - remembers which
  // epic sunrise/sunset the celebration effect has already fired for, so
  // it plays once per newly-detected epic event rather than replaying on
  // every 15-second liveTick() re-render or tab switch.
  epicCelebrated: {},
  // Keyed the same way as epicCelebrated, but tracks whether the device
  // notification for that specific epic reading has already been sent -
  // separate because the notification fires immediately (background
  // refreshes included), while epicCelebrated deliberately waits for the
  // person to actually be looking at the app.
  epicNotified: {},
  // Tracks whether the person has manually changed a Shoot Log rating
  // dropdown themselves, so autoFillLogRatings() never overwrites their own
  // choice with a fresh prediction on the next tick/tab switch. Reset after
  // a successful submit, since the next entry should start from a fresh
  // prediction again.
  logTouched: { light: false, bird: false }
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
// True while the app is still sitting on the Kansas center-of-US fallback -
// i.e. GPS/manual location has never actually landed. Every location-derived
// reading (current temp, today's high/low, barometer, sun times, bird score)
// is correct FOR that coordinate, so when this is true the fix is never a
// code bug in those readings - it's getting a real location set at all.
function isDefaultLocation(loc) {
  return !!loc && Math.abs(loc.lat - DEFAULT_LOC.lat) < 0.05 && Math.abs(loc.lon - DEFAULT_LOC.lon) < 0.05;
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

// Wind speed unit - Open-Meteo returns km/h; mph is the more familiar unit
// for a US audience, so it's the default, with km/h as an opt-in, same
// pattern as the temperature toggle. Internal wind-speed thresholds in the
// bird activity model stay in km/h regardless - this only changes displayed text.
const LS_WIND_UNIT_KEY = "pbam_wind_unit";
function loadWindUnit() {
  const saved = localStorage.getItem(LS_WIND_UNIT_KEY);
  return saved === "kmh" ? "kmh" : "mph"; // default mph
}
function saveWindUnit(unit) {
  localStorage.setItem(LS_WIND_UNIT_KEY, unit === "kmh" ? "kmh" : "mph");
}
function formatWind(kmh) {
  if (typeof kmh !== "number" || isNaN(kmh)) return "--";
  if (loadWindUnit() === "mph") {
    return Math.round(kmh * 0.621371) + " mph";
  }
  return Math.round(kmh) + " km/h";
}

// Pressure unit - Open-Meteo returns hectopascals (hPa), the standard
// meteorological/scientific unit, but most US consumer barometers and
// weather reports (NWS included) read out in inches of mercury (inHg), so
// that's the default here to match the temperature/wind defaults. Internal
// bird-model thresholds (pressureTrend, weatherFactor) stay in hPa
// regardless - this only changes displayed text.
const LS_PRESSURE_UNIT_KEY = "pbam_pressure_unit";
const HPA_PER_INHG = 33.8639;
function loadPressureUnit() {
  const saved = localStorage.getItem(LS_PRESSURE_UNIT_KEY);
  return saved === "hpa" ? "hpa" : "inhg"; // default inHg
}
function savePressureUnit(unit) {
  localStorage.setItem(LS_PRESSURE_UNIT_KEY, unit === "hpa" ? "hpa" : "inhg");
}
function formatPressure(hpa) {
  if (typeof hpa !== "number" || isNaN(hpa)) return "--";
  if (loadPressureUnit() === "inhg") return (hpa / HPA_PER_INHG).toFixed(2) + " inHg";
  return Math.round(hpa) + " hPa";
}
function formatPressureTrend(hpaTrend) {
  if (typeof hpaTrend !== "number" || isNaN(hpaTrend)) return "--";
  const sign = hpaTrend >= 0 ? "+" : "";
  if (loadPressureUnit() === "inhg") return sign + (hpaTrend / HPA_PER_INHG).toFixed(3) + " inHg";
  return sign + hpaTrend.toFixed(2) + " hPa";
}

// Auto-refresh (the silent 5-minute background pull) can be turned off for
// anyone who'd rather only ever refresh by hand - on by default.
const LS_AUTOREFRESH_KEY = "pbam_autorefresh";
function loadAutoRefreshEnabled() { return localStorage.getItem(LS_AUTOREFRESH_KEY) !== "0"; }
function saveAutoRefreshEnabled(v) { localStorage.setItem(LS_AUTOREFRESH_KEY, v ? "1" : "0"); }

// ---------- Sun / light ----------
function computeSun(loc, date) {
  const times = SunCalcLite.getTimes(date, loc.lat, loc.lon);
  const pos = SunCalcLite.getPosition(date, loc.lat, loc.lon);
  const elevationDeg = pos.altitude * (180 / Math.PI);
  return { times, elevationDeg };
}

// ---------- Moon phase ----------
// Pure astronomical geometry, same category as the solar position model
// above - no network call, no external service. Uses the standard synodic-
// month method: days elapsed since a known new moon (2000-01-06 18:14 UTC,
// a commonly used reference epoch), modulo the synodic month length
// (29.530588853 days, the real average new-moon-to-new-moon period).
// Relevant here for two real, cited reasons: night/astro photographers plan
// around it directly (a bright near-full moon washes out star visibility
// and the Milky Way but adds usable ambient light for handheld night shots;
// a new moon is the opposite trade), and it's a documented influence on
// nocturnal bird migration - many nocturnal migrants fly higher and in
// greater numbers on brighter moonlit nights, plausibly tied to visual
// orientation (Norevik et al. 2019, Emlen 1967 orientation cage
// experiments). This app does not fold moon phase into the bird activity
// score below since that migration-brightness link is real but not yet
// consistently quantified enough to responsibly weight into the model -
// it's shown as information a birder or photographer can weigh themselves.
const SYNODIC_MONTH_DAYS = 29.530588853;
const KNOWN_NEW_MOON_UTC = Date.UTC(2000, 0, 6, 18, 14, 0);
function computeMoonPhase(date) {
  const daysSince = (date.getTime() - KNOWN_NEW_MOON_UTC) / 86400000;
  const age = ((daysSince % SYNODIC_MONTH_DAYS) + SYNODIC_MONTH_DAYS) % SYNODIC_MONTH_DAYS;
  const illumination = (1 - Math.cos((2 * Math.PI * age) / SYNODIC_MONTH_DAYS)) / 2;
  let name;
  if (age < 1.84566) name = "New Moon";
  else if (age < 5.53699) name = "Waxing Crescent";
  else if (age < 9.22831) name = "First Quarter";
  else if (age < 12.91963) name = "Waxing Gibbous";
  else if (age < 16.61096) name = "Full Moon";
  else if (age < 20.30228) name = "Waning Gibbous";
  else if (age < 23.99361) name = "Last Quarter";
  else if (age < 27.68493) name = "Waning Crescent";
  else name = "New Moon";
  return { ageDays: age, illumination, name };
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

// Breaks a Date down into the wall-clock calendar fields it reads as AT THE
// LOCATION (year/month/day/hour/minute), using the same shift-then-read-UTC
// trick as fmtTime, rather than the device's own fields. This is what makes
// it possible to do calendar math ("this same location-local hour, one day
// later") without the device's timezone leaking in - critical for anyone
// who splits time between two timezones (e.g. checking an Illinois location
// while physically in Colorado), where device-local and location-local can
// disagree by a full hour or more.
function locationLocalParts(d, utcOffsetSeconds) {
  if (utcOffsetSeconds == null) {
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hours: d.getHours(), minutes: d.getMinutes() };
  }
  const shifted = new Date(d.getTime() + utcOffsetSeconds * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate(), hours: shifted.getUTCHours(), minutes: shifted.getUTCMinutes() };
}

// Inverse of locationLocalParts: given wall-clock date/time fields AS SEEN
// AT THE LOCATION, returns the actual UTC instant (a real Date) they
// correspond to - so a UI control like a time-of-day slider can be read and
// written entirely in the location's own clock.
function locationLocalToUtc(year, month, day, hours, minutes, utcOffsetSeconds) {
  const utcMs = Date.UTC(year, month, day, hours, minutes, 0, 0);
  return new Date(utcMs - (utcOffsetSeconds || 0) * 1000);
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Same location-vs-device distinction as fmtTime, formatted as a full
// date+time ("Sep 14, 2:30 PM") for the Direction tab's date/time readout.
function fmtLocationDateTime(d, utcOffsetSeconds) {
  if (!(d instanceof Date) || isNaN(d)) return "--";
  const p = locationLocalParts(d, utcOffsetSeconds);
  let h = p.hours % 12; if (h === 0) h = 12;
  const ampm = p.hours >= 12 ? "PM" : "AM";
  return `${MONTH_ABBR[p.month]} ${p.day}, ${h}:${String(p.minutes).padStart(2, "0")} ${ampm}`;
}

// ---------- Weather ----------
async function fetchWeather(loc) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_direction_10m,surface_pressure,precipitation,uv_index` +
    `&hourly=surface_pressure,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility,precipitation` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&past_days=1&forecast_days=7&timezone=auto`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Weather request failed: " + res.status);
  const data = await res.json();
  return data;
}

// Separate free, no-key Open-Meteo service (particulate/AQI modeling, not
// the general weather forecast). Real atmospheric haze data - PM2.5 is the
// same particulate measure US AQI is built from, and haze is a genuine,
// physical reason a sunset can look flat and desaturated even under a
// technically "good" cloud-cover score. Treated as a nice-to-have: if this
// call fails, the rest of the dashboard renders normally without it.
//
// aerosol_optical_depth and dust are also pulled here, hourly across the
// same 7-day window as the outlook, specifically to feed the sunrise/sunset
// quality score below - PM2.5/AQI stay display-only (they're measured at
// ground level, which is a much noisier proxy for what's actually
// scattering light at the horizon than a real column-integrated optical
// depth reading is).
async function fetchAirQuality(loc) {
  try {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat}&longitude=${loc.lon}&current=pm2_5,us_aqi,aerosol_optical_depth&hourly=aerosol_optical_depth,dust&forecast_days=7`;
    const res = await fetchWithTimeout(url, {}, 6000);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.current) return null;
    return { ...data.current, hourly: data.hourly || null };
  } catch (e) {
    return null;
  }
}

// Nearest hourly aerosol reading to a given moment, from the air-quality
// service's own hourly.time array - kept as a separate lookup from
// nearestHourIndex/the main weather data because this comes from an
// entirely different Open-Meteo service with its own timestamp array, not
// guaranteed to share indices with the general forecast's hourly arrays.
function nearestAodAtDate(airQualityHourly, date) {
  if (!airQualityHourly || !airQualityHourly.time || !airQualityHourly.aerosol_optical_depth) return null;
  const idx = nearestHourIndex(airQualityHourly, date);
  if (idx === -1) return null;
  const aod = airQualityHourly.aerosol_optical_depth[idx];
  return typeof aod === "number" ? aod : null;
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
function lightLabelFor(score) {
  if (score >= 75) return "Great";
  if (score >= 55) return "Good";
  if (score >= 32) return "Fair";
  return "Poor";
}

// Aerosol optical depth (AOD): a real, physical measure of how much haze -
// smoke, dust, general atmospheric particulate - is suspended in the whole
// air column, at 550nm, from Open-Meteo's air quality model. Its effect on
// sunset color is genuinely two-sided, not a simple "more haze = worse"
// penalty like humidity gets: light-to-moderate aerosol loading scatters
// more blue/green light out of the sun's low-angle path than clean air
// does, which is exactly why a bit of smoke or dust often makes for a MORE
// vivid, deeper-red sunset (a well-documented effect - see the visibly
// intensified sunsets reported downwind of wildfires and Saharan dust
// events). Past a point, though, the same loading gets thick enough to
// flatten color into a murky, low-contrast haze and cut visibility outright.
// This is a genuine refinement, not a primary factor - kept as a mild
// multiplier (0.55-1.12x) rather than something that can zero out the score
// on its own the way total cloud cover can.
function aerosolMultiplier(aod) {
  if (typeof aod !== "number" || isNaN(aod)) return 1; // no reading for this hour/location - stay neutral, never guess
  if (aod <= 0.6) {
    return 1 + (triangularScore(aod, 0.25, 0.45) / 100) * 0.12;
  }
  return Math.max(0.55, 1 - (aod - 0.6) * 0.5);
}

function computeSunQuality(low, mid, high, humidity, obstructionDeg, aod) {
  // Widths widened and the low-cloud/humidity penalties eased from an
  // earlier version of this formula that was checked with a 200,000-sample
  // Monte Carlo sweep and turned out too strict: needing high AND mid cloud
  // both within a narrow band of their peaks, simultaneously with near-zero
  // low cloud and low humidity, made a "Great" score (75+) come up in under
  // 4% of realistic cloud/humidity combinations and pushed the median score
  // down into "Poor" territory. These wider tents and gentler penalty slopes
  // move the median into "Fair" and roughly double how often "Great" is
  // actually reachable, while true washout conditions (near-total cloud
  // cover at every altitude, or heavy smoke) still correctly score near
  // zero, and the textbook-ideal combination still hits 100.
  const base = triangularScore(high, 40, 78) * 0.55 + triangularScore(mid, 35, 72) * 0.45;
  const lowMult = Math.max(0, 1 - low / 90);
  const humMult = Math.max(0.5, 1 - Math.max(0, humidity - 65) / 75);
  const aodMult = aerosolMultiplier(aod);
  const rawScore = Math.round(Math.max(0, Math.min(100, base * lowMult * humMult * aodMult)));
  const score = calibrateLightScore(rawScore);
  const terrainNote = (typeof obstructionDeg === "number" && obstructionDeg > 1.5)
    ? `~${obstructionDeg.toFixed(1)}° ridge nearby - direct light ends earlier than a flat horizon, color show is unaffected`
    : null;
  const aodNote = typeof aod === "number"
    ? (aod > 0.6 ? `haze/smoke is heavy enough (AOD ${aod.toFixed(2)}) to be muting color, not enhancing it`
      : aod > 0.12 ? `light haze/aerosol (AOD ${aod.toFixed(2)}) likely deepening the color` : null)
    : null;
  // "Legendary" is a distinct tier above Great, not just a relabeled 75+ -
  // the point is that it be genuinely rare, so it means something when it
  // fires. Set higher than the original "Epic" cutoff (90) specifically to
  // be reserved for a handful of truly exceptional conditions rather than a
  // once-every-couple-weeks occurrence - versus Great (75+) at roughly the
  // top 9-10% of realistic cloud/humidity/aerosol combinations. It's still
  // reachable (textbook-ideal inputs hit 100), just rare.
  const legendary = score >= 95;
  // Raw inputs kept on the result (not just the derived notes) so the UI can
  // build a full plain-language breakdown on demand - e.g. the Outlook's
  // "why" panel - without recomputing anything or guessing at the numbers
  // that actually went into this particular score.
  return { score, rawScore, label: lightLabelFor(score), terrainNote, aodNote, legendary, inputs: { low, mid, high, humidity, aod } };
}

// Turns one quality result's raw inputs into short, plain-language lines -
// what the Outlook's "why" panel shows when someone taps a score, so a 22%
// or a 91% is never just a number to take on faith. Each line names the
// actual reading and which way it pushed the score, using the same peak/
// band values the formula itself uses (kept in sync by reading them out of
// the same computeSunQuality above rather than hardcoding a second copy).
function explainQuality(q) {
  if (!q || !q.inputs) return [];
  const { low, mid, high, humidity, aod } = q.inputs;
  const lines = [];
  const bandNote = (name, pct, peak, width) => {
    if (typeof pct !== "number") return null;
    const d = Math.abs(pct - peak);
    const fit = d <= width * 0.25 ? "near the ideal band - helping the score"
      : d <= width * 0.65 ? "off the ideal band - a mild drag on the score"
      : "far outside the ideal band - a heavy drag on the score";
    return `${name} cloud ${Math.round(pct)}% (ideal ~${peak}%): ${fit}`;
  };
  lines.push(bandNote("High", high, 40, 78));
  lines.push(bandNote("Mid", mid, 35, 72));
  if (typeof low === "number") {
    lines.push(low <= 10 ? `Low cloud ${Math.round(low)}%: mostly clear - not blocking the show`
      : low <= 40 ? `Low cloud ${Math.round(low)}%: partly blocking the show - a mild drag`
      : `Low cloud ${Math.round(low)}%: heavily blocking the show - a heavy drag on the score`);
  }
  if (typeof humidity === "number") {
    lines.push(humidity <= 65 ? `Humidity ${Math.round(humidity)}%: not high enough to mute color`
      : `Humidity ${Math.round(humidity)}%: high enough to be washing color out`);
  }
  lines.push(q.aodNote ? `Aerosol/haze: ${q.aodNote}` : (typeof aod === "number" ? `Aerosol/haze (AOD ${aod.toFixed(2)}): too clean to matter either way` : "Aerosol/haze: no reading for this hour"));
  if (q.terrainNote) lines.push(`Terrain: ${q.terrainNote}`);
  return lines.filter(Boolean);
}

function qualityAt(hourly, date, obstructionDeg, airQualityHourly) {
  const idx = nearestHourIndex(hourly, date);
  if (idx === -1) return { score: 0, label: "n/a" };
  return computeSunQuality(
    hourly.cloud_cover_low[idx],
    hourly.cloud_cover_mid[idx],
    hourly.cloud_cover_high[idx],
    hourly.relative_humidity_2m[idx],
    obstructionDeg,
    nearestAodAtDate(airQualityHourly, date)
  );
}

// ---------- Golden hour intensity ----------
// A deliberately separate score from the sunrise/sunset quality percentage
// above, because it measures a different thing: quality is about whether
// the SKY shows color (wants clouds to catch light). Golden hour intensity
// is about whether the DIRECT, low-angle, warm sunlight itself is strong and
// unobstructed - the light photographers actually meter and white-balance
// for - which wants the sun's disc clear, not clouds.
// Window bounds (-0.833deg to 6deg) match suncalc-lite.js's own
// sunrise/goldenHourEnd/goldenHour/sunset definitions exactly, so "active"
// here always agrees with the golden-hour times already shown in the Sun &
// Light card.
const GOLDEN_HOUR_LOW_DEG = -0.833;
const GOLDEN_HOUR_HIGH_DEG = 6;

function isGoldenHourActive(elevationDeg) {
  return typeof elevationDeg === "number" && elevationDeg >= GOLDEN_HOUR_LOW_DEG && elevationDeg <= GOLDEN_HOUR_HIGH_DEG;
}

// Correlated color temperature estimate from solar elevation alone. Real
// physics behind it: as elevation drops, the direct beam's air mass grows
// (Kasten-Young: m = 1 / (sin(h) + 0.50572*(h+6.07995)^-1.6364)), scattering
// out progressively more short-wavelength (blue/green) light and leaving a
// warmer, redder direct beam - which is the entire reason "golden" hour
// looks golden. This is a simplified curve fit to that well-documented
// trend (roughly 2000K right at the horizon rising toward ~5300K by 6deg,
// where it's approaching ordinary daylight), not a spectroradiometer
// reading - it doesn't know the local aerosol mix, which shifts the real
// number further. Rounded to the nearest 50K so it doesn't imply more
// precision than that.
function estimateColorTemp(elevationDeg) {
  const h = Math.max(0, elevationDeg);
  const cct = 5500 - 3500 * Math.exp(-h / 2.2);
  return Math.round(cct / 50) * 50;
}

// Rough blackbody-radiator-to-RGB approximation (the standard Tanner
// Helland fit), used only to paint a small "what color is this light"
// swatch next to the Kelvin number - not meant as colorimetric ground truth.
function kelvinToRgb(kelvin) {
  const temp = Math.max(1000, Math.min(12000, kelvin)) / 100;
  let r, g, b;
  if (temp <= 66) {
    r = 255;
    g = 99.47 * Math.log(temp) - 161.12;
  } else {
    r = 329.7 * Math.pow(temp - 60, -0.133);
    g = 288.12 * Math.pow(temp - 60, -0.0755);
  }
  if (temp >= 66) b = 255;
  else if (temp <= 19) b = 0;
  else b = 138.52 * Math.log(temp - 10) - 305.04;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

function goldenIntensityLabel(score) {
  if (score >= 70) return "Excellent";
  if (score >= 45) return "Good";
  if (score >= 20) return "Weak";
  return "Flat";
}

function computeGoldenHourIntensity(elevationDeg, cloudCoverPct, aod) {
  // Peaks at 2.5deg - a few degrees up from the horizon, where the beam is
  // still warm and low but strong enough to actually read as "intense"
  // rather than a dim afterglow - and tapers toward both edges of the
  // -0.833 to 6deg window.
  const elevationFactor = triangularScore(elevationDeg, 2.5, 5);
  // Direct light needs a mostly clear sky in the sun's direction. Total
  // cloud cover is the only cloud data tied to "right now" rather than a
  // specific altitude band, so it's used as-is here; by 60% cover the sun
  // is blocked often enough that direct light can't be relied on.
  const cloudCoverVal = typeof cloudCoverPct === "number" ? cloudCoverPct : 0;
  const cloudFactor = Math.max(0, 1 - cloudCoverVal / 60);
  const aodMult = aerosolMultiplier(aod);
  const rawScore = Math.round(Math.max(0, Math.min(100, elevationFactor * cloudFactor * aodMult)));
  const cct = estimateColorTemp(elevationDeg);

  let note;
  if (cloudCoverVal >= 60) {
    note = `${Math.round(cloudCoverVal)}% cloud cover is blocking most direct sunlight`;
  } else if (cloudCoverVal >= 30) {
    note = `${Math.round(cloudCoverVal)}% cloud cover is cutting into direct light`;
  } else if (typeof aod === "number" && aod > 0.12) {
    note = aod > 0.6
      ? `haze/smoke (AOD ${aod.toFixed(2)}) is thick enough to dim and flatten the light`
      : `light haze (AOD ${aod.toFixed(2)}) is deepening the warm color`;
  } else {
    note = "clear sky, direct light";
  }

  return { active: true, score: rawScore, label: goldenIntensityLabel(rawScore), cct, note };
}

// When golden hour isn't happening right now, find the next window (start
// AND end, checking today's remaining windows, then tomorrow's) so the
// Dashboard can forecast what THAT window will actually be like instead of
// just counting down to it with no information.
function nextGoldenWindow(now, timesToday, timesTomorrow) {
  const candidates = [
    { start: timesToday.sunrise, end: timesToday.goldenHourEnd, label: "sunrise" },
    { start: timesToday.goldenHour, end: timesToday.sunset, label: "sunset" }
  ];
  if (timesTomorrow) candidates.push({ start: timesTomorrow.sunrise, end: timesTomorrow.goldenHourEnd, label: "sunrise" });
  for (const c of candidates) {
    if (c.start instanceof Date && c.start.getTime() > now.getTime()) return c;
  }
  return null;
}

function formatMinutesUntil(now, target) {
  const mins = Math.round((target.getTime() - now.getTime()) / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// A forecast version of computeGoldenHourIntensity for a window that hasn't
// started yet: reads forecast cloud cover/aerosol at the window's midpoint
// (a short ~20-40min window, so the midpoint is a fine stand-in for "the
// peak moment") from the same hourly forecast series the rest of the app
// already fetches, rather than only ever describing "right now."
function forecastGoldenWindow(loc, window, weatherHourly, airQualityHourly) {
  if (!window || !weatherHourly || !weatherHourly.cloud_cover) return null;
  const peakTime = new Date((window.start.getTime() + window.end.getTime()) / 2);
  const idx = nearestHourIndex(weatherHourly, peakTime);
  if (idx === -1) return null;
  const cloudCover = weatherHourly.cloud_cover[idx];
  const aod = nearestAodAtDate(airQualityHourly, peakTime);
  const pos = SunCalcLite.getPosition(peakTime, loc.lat, loc.lon);
  const elevationDeg = pos.altitude * 180 / Math.PI;
  return computeGoldenHourIntensity(elevationDeg, cloudCover, aod);
}

function renderGoldenHour(loc, now, elevationDeg, weatherData, airQuality, timesToday, timesTomorrow) {
  const verdictEl = document.getElementById("golden-verdict");
  const subEl = document.getElementById("golden-sub");
  const scoreEl = document.getElementById("golden-score");
  const fillEl = document.getElementById("golden-fill");
  const cctEl = document.getElementById("golden-cct");
  const swatchEl = document.getElementById("golden-cct-swatch");
  const noteEl = document.getElementById("golden-note");

  if (!weatherData || !isGoldenHourActive(elevationDeg)) {
    const next = weatherData ? nextGoldenWindow(now, timesToday, timesTomorrow) : null;
    const forecast = next ? forecastGoldenWindow(loc, next, weatherData.hourly, airQuality && airQuality.hourly) : null;

    if (forecast) {
      // Forecasting, not measuring - label it as a prediction for a
      // specific upcoming window rather than a live reading, so it's never
      // mistaken for "this is happening right now."
      verdictEl.textContent = `${forecast.label} expected at next ${next.label}`;
      verdictEl.className = "big-stat verdict-line tier-" + forecast.label.toLowerCase();
      scoreEl.textContent = forecast.score;
      fillEl.style.width = forecast.score + "%";
      cctEl.textContent = `Expected color temp: ~${forecast.cct}K`;
      swatchEl.style.background = kelvinToRgb(forecast.cct);
      noteEl.textContent = forecast.note;
      subEl.textContent = `Forecast for ${next.label} in ${formatMinutesUntil(now, next.start)} (not live - updates as the forecast does)`;
    } else {
      verdictEl.textContent = "Not golden hour";
      verdictEl.className = "big-stat verdict-line";
      scoreEl.textContent = "--";
      fillEl.style.width = "0%";
      cctEl.textContent = "Color temp: --";
      swatchEl.style.background = "#e8e8e8";
      noteEl.textContent = "";
      subEl.textContent = next ? `Next golden hour (${next.label}) in ${formatMinutesUntil(now, next.start)}` : "--";
    }
    return;
  }

  const c = weatherData.current;
  const result = computeGoldenHourIntensity(elevationDeg, c ? c.cloud_cover : null, airQuality ? airQuality.aerosol_optical_depth : null);
  verdictEl.textContent = result.label + " golden hour light";
  verdictEl.className = "big-stat verdict-line tier-" + result.label.toLowerCase();
  scoreEl.textContent = result.score;
  fillEl.style.width = result.score + "%";
  cctEl.textContent = `Color temp: ~${result.cct}K`;
  swatchEl.style.background = kelvinToRgb(result.cct);
  noteEl.textContent = result.note;
  const windowEnd = elevationDeg <= 2.5 && now.getTime() < timesToday.goldenHourEnd.getTime() ? timesToday.goldenHourEnd : timesToday.sunset;
  subEl.textContent = `Sun at ${elevationDeg.toFixed(1)}° - about ${formatMinutesUntil(now, windowEnd)} of this window left`;
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
// A single ray at the exact sunset/sunrise azimuth, sampled at only 4 fixed
// distances, can genuinely miss a real peak that's a few degrees off that
// exact bearing or sitting between two sampled rings (rather than on one) -
// real mountain silhouettes aren't a single point at a single distance. A
// small fan of bearings around the exact azimuth, each checked at more
// distances out to 55km (real mountain ranges can have significant peaks
// well past a shorter cutoff), makes it much harder for the model to step
// around a real ridge.
const HORIZON_DISTANCES_KM = [3, 8, 18, 35, 55];
const HORIZON_BEARING_SPREAD_DEG = [-5, 0, 5];

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

// ---------- Direction (sun compass) tab ----------
// A pure compass dial, no map tiles - a real street map needs a paid tile
// provider key and a per-load/per-user cost that doesn't fit a flat one-time
// purchase, and every number here is the exact same solar-position model
// already used everywhere else in the app (SunCalcLite), just displayed as
// altitude/azimuth instead of feeding the light-quality or bird-score math.
state.direction = {
  mode: "live",
  date: new Date(),
  lastBearing: null,     // most recently computed sun bearing, cached so the
                          // high-frequency compass-heading handler below has
                          // something cheap to compare against instead of
                          // recomputing solar position on every sensor event
  compassOn: false,
  lastRawHeading: null,  // last raw 0-360 heading, for the wrap-around unwrap below
  unwrappedRotation: 0,  // accumulated rotation with no 359->0 jump, safe to feed a CSS transition
  manualBearing: null    // degrees, dial-local frame; null = no user-drawn mark set. Session-only,
                          // not persisted - it's a live comparison aid, not a saved reading.
};

function polarPoint(cx, cy, r, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function compassPointName(deg) {
  const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                 "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// Ticks/labels are static geometry (they never move) - drawn once, lazily,
// the first time the tab is actually visited rather than on every load.
let dirCompassDrawn = false;
function drawDirCompassFace() {
  if (dirCompassDrawn) return;
  const ticksG = document.getElementById("dir-ticks");
  const cardG = document.getElementById("dir-cardinals");
  if (!ticksG || !cardG) return;
  const labels = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
  for (let deg = 0; deg < 360; deg += 15) {
    const isMajor = deg % 45 === 0;
    const outer = polarPoint(150, 150, 140, deg);
    const inner = polarPoint(150, 150, isMajor ? 116 : 128, deg);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", outer.x); line.setAttribute("y1", outer.y);
    line.setAttribute("x2", inner.x); line.setAttribute("y2", inner.y);
    line.setAttribute("class", isMajor ? "dir-tick-major" : "dir-tick");
    ticksG.appendChild(line);
    if (labels[deg]) {
      const p = polarPoint(150, 150, 100, deg);
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", p.x); text.setAttribute("y", p.y);
      text.setAttribute("class", "dir-cardinal" + (deg === 0 ? " dir-cardinal-n" : ""));
      text.textContent = labels[deg];
      cardG.appendChild(text);
    }
  }
  dirCompassDrawn = true;
}

// Shortest signed angular step from a to b, in (-180, 180]. Used to draw the
// blue-hour arcs without the wraparound glitch a plain (b-a) would hit near
// 0/360deg, and to pick which way (clockwise/counter-clockwise) the arc
// should sweep.
function shortAngleDelta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

// One SVG arc path between two compass bearings, always taking the SHORT
// way around - correct here because the two bearings being connected
// (nautical dawn -> dawn, or dusk -> nautical dusk) are only ~20-60 minutes
// apart in real time, so the sun's azimuth between them never actually
// moves anywhere near half the compass.
function describeArc(cx, cy, r, fromDeg, toDeg) {
  const delta = shortAngleDelta(fromDeg, toDeg);
  const start = polarPoint(cx, cy, r, fromDeg);
  const end = polarPoint(cx, cy, r, fromDeg + delta);
  const sweepFlag = delta >= 0 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 0 ${sweepFlag} ${end.x} ${end.y}`;
}

// Marks where the sun actually sits on the compass for sunrise, sunset, and
// both blue-hour windows on whichever day is currently shown (respects the
// Direction tab's day-forward/back navigation, not just "today") - drawn
// inside #dir-face-rotator so the marks turn with the dial exactly like the
// N/E/S/W ticks do when the live phone-heading rotation is active.
function renderDirSunEvents(loc, d) {
  const g = document.getElementById("dir-sun-events");
  if (!g) return;
  g.innerHTML = "";
  const sunDay = computeSun(loc, d);
  const t = sunDay.times;
  const bearingAt = (date) => {
    if (!(date instanceof Date) || isNaN(date.getTime())) return null;
    const pos = SunCalcLite.getPosition(date, loc.lat, loc.lon);
    return bearingFromAzimuth(pos.azimuth);
  };
  const brSunrise = bearingAt(t.sunrise);
  const brSunset = bearingAt(t.sunset);
  const brNauticalDawn = bearingAt(t.nauticalDawn);
  const brDawn = bearingAt(t.dawn);
  const brDusk = bearingAt(t.dusk);
  const brNauticalDusk = bearingAt(t.nauticalDusk);

  const RING_R = 140;
  const ARC_R = 146;
  const LABEL_R = 122;
  const NS = "http://www.w3.org/2000/svg";

  const addArc = (fromB, toB) => {
    if (fromB == null || toB == null) return;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", describeArc(150, 150, ARC_R, fromB, toB));
    path.setAttribute("class", "dir-event-arc");
    g.appendChild(path);
  };
  const addMarker = (bearing, cls, label) => {
    if (bearing == null) return;
    const p = polarPoint(150, 150, RING_R, bearing);
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y); dot.setAttribute("r", 6);
    dot.setAttribute("class", "dir-event-dot " + cls);
    g.appendChild(dot);
    const lp = polarPoint(150, 150, LABEL_R, bearing);
    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", lp.x); text.setAttribute("y", lp.y);
    text.setAttribute("class", "dir-event-label " + cls);
    text.textContent = label;
    g.appendChild(text);
  };

  addArc(brNauticalDawn, brDawn);
  addArc(brDusk, brNauticalDusk);
  // Labels are plain text, not a "☀ Sunrise" emoji-prefixed label - the sun
  // emoji is itself a small circle, so paired with the dir-event-dot marker
  // right next to it, it read as two overlapping circle icons per event
  // rather than one clear marker.
  addMarker(brSunrise, "dir-dot-sunrise", "Sunrise");
  addMarker(brSunset, "dir-dot-sunset", "Sunset");
}

function directionEnterManual() {
  if (state.direction.mode === "live") state.direction.date = new Date();
  state.direction.mode = "manual";
}

function renderDirection() {
  const loc = state.loc;
  if (!loc) return;
  drawDirCompassFace();

  const d = state.direction.mode === "live" ? new Date() : state.direction.date;
  renderDirSunEvents(loc, d);
  const pos = SunCalcLite.getPosition(d, loc.lat, loc.lon);
  const altitudeDeg = pos.altitude * 180 / Math.PI;
  const bearing = bearingFromAzimuth(pos.azimuth);
  const belowHorizon = altitudeDeg < 0;
  state.direction.lastBearing = bearing; // cached for the live-compass handler, which fires far more often than this function

  const altEl = document.getElementById("dir-altitude");
  const azEl = document.getElementById("dir-azimuth");
  if (altEl) altEl.textContent = altitudeDeg.toFixed(2) + "°";
  if (azEl) azEl.textContent = bearing.toFixed(2) + "°";

  const needle = document.getElementById("dir-needle");
  const tip = document.getElementById("dir-needle-tip");
  if (needle) {
    needle.style.transform = `rotate(${bearing}deg)`;
    needle.classList.toggle("is-below-horizon", belowHorizon);
  }
  if (tip) {
    tip.style.transform = `rotate(${bearing}deg)`;
    tip.classList.toggle("is-below-horizon", belowHorizon);
  }

  const statusEl = document.getElementById("dir-status-label");
  if (statusEl) {
    const pointName = compassPointName(bearing);
    statusEl.textContent = belowHorizon
      ? `Sun is ${Math.abs(altitudeDeg).toFixed(1)}° below the horizon - bearing ${pointName} (${Math.round(bearing)}°)`
      : `${altitudeDeg.toFixed(1)}° above the horizon, facing ${pointName} (${Math.round(bearing)}°)`;
  }

  // Both the readout and the slider below read the LOCATION's wall clock,
  // not the device's - otherwise scrubbing to "2:00 PM" while checking a
  // location in a different timezone than the device would silently compute
  // the sun position for 2:00 PM device-local time instead.
  const utcOffset = state.weather ? state.weather.utc_offset_seconds : null;
  const labelEl = document.getElementById("dir-datetime-label");
  if (labelEl) {
    labelEl.textContent = fmtLocationDateTime(d, utcOffset) + (state.direction.mode === "live" ? " (live)" : "");
  }

  const slider = document.getElementById("dir-time-slider");
  if (slider && document.activeElement !== slider) {
    const p = locationLocalParts(d, utcOffset);
    slider.value = String(p.hours * 60 + p.minutes);
  }

  updateFacingBadge();
}

// ---------- Live compass (device orientation) ----------
// Rotates the whole dial to match which way the phone is actually pointing,
// like a real handheld compass, rather than always showing north at the
// top. The sun's needle keeps its true bearing on the dial - rotating the
// dial is what makes "facing the needle" mean "facing the sun" in real life.
//
// This only works on a phone with an orientation/compass sensor exposed to
// the browser, over HTTPS (the API is blocked on plain http:// as a privacy
// measure), and iOS 13+ requires an explicit permission grant from a real
// tap - Apple's rule, not something this code can skip. None of this can be
// exercised on a desktop browser, which has no compass hardware at all.
let dirHeadingRafPending = false;
let dirLatestRawHeading = null;

function unwrapHeading(rawHeading) {
  // Turns a 0-360 wrap-around reading into a continuous angle, so a CSS
  // rotation transition never has to visibly spin the long way around when
  // the heading crosses 0/360.
  const d = state.direction;
  if (d.lastRawHeading == null) {
    d.lastRawHeading = rawHeading;
    d.unwrappedRotation = rawHeading;
    return d.unwrappedRotation;
  }
  let delta = (rawHeading - d.lastRawHeading) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  d.unwrappedRotation += delta;
  d.lastRawHeading = rawHeading;
  return d.unwrappedRotation;
}

function updateFacingBadge() {
  const badge = document.getElementById("dir-facing-badge");
  if (!badge) return;
  const heading = dirLatestRawHeading;
  const bearing = state.direction.lastBearing;
  if (!state.direction.compassOn || heading == null || bearing == null) {
    badge.hidden = true;
    return;
  }
  const facing = angularDiff(heading, bearing) <= 8;
  if (facing && badge.hidden) feedbackTap(); // small buzz the moment it lines up, not on every frame
  badge.hidden = !facing;
}

function applyDirFaceRotation() {
  const rotator = document.getElementById("dir-face-rotator");
  if (rotator) rotator.style.transform = `rotate(${-state.direction.unwrappedRotation}deg)`;
  updateFacingBadge();
  dirHeadingRafPending = false;
}

function handleOrientationEvent(event) {
  // iOS Safari exposes a ready-to-use compass heading directly; everything
  // else has to derive one from the "absolute" alpha value (rotation around
  // the vertical axis), which uses the opposite rotation direction, hence
  // the 360-alpha flip.
  let heading = null;
  if (typeof event.webkitCompassHeading === "number") {
    heading = event.webkitCompassHeading;
  } else if (event.absolute && typeof event.alpha === "number") {
    heading = (360 - event.alpha) % 360;
  }
  if (heading == null || isNaN(heading)) return;

  dirLatestRawHeading = heading;
  unwrapHeading(heading);

  // Sensor events can fire far faster than the screen can usefully redraw -
  // batch to one DOM update per animation frame instead of one per event.
  if (!dirHeadingRafPending) {
    dirHeadingRafPending = true;
    requestAnimationFrame(applyDirFaceRotation);
  }
}

function setCompassStatus(text) {
  const el = document.getElementById("dir-compass-status");
  if (el) el.textContent = text;
}

function startLiveCompass() {
  const hasAbsolute = "ondeviceorientationabsolute" in window;
  window.addEventListener(hasAbsolute ? "deviceorientationabsolute" : "deviceorientation", handleOrientationEvent);
  state.direction.compassOn = true;
  const btn = document.getElementById("dir-enable-compass");
  if (btn) { btn.classList.add("is-live"); btn.textContent = "Live compass on"; }
  setCompassStatus("Reading your phone's compass sensor. Turn to line the dial's top marker up with the needle - that's the sun's direction.");

  // If no heading ever actually arrives, this is a device/browser without a
  // usable compass sensor (common on some Android browsers/hardware) - say
  // so plainly rather than leaving the dial silently doing nothing.
  setTimeout(() => {
    if (dirLatestRawHeading == null) {
      setCompassStatus("No compass reading came from this device - your browser or phone may not expose one. The dial stays fixed north-up instead.");
      state.direction.compassOn = false;
      if (btn) { btn.classList.remove("is-live"); btn.textContent = "Enable live compass"; }
    }
  }, 3000);
}

function wireLiveCompassButton() {
  const btn = document.getElementById("dir-enable-compass");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (state.direction.compassOn) return;
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      // iOS 13+: must be called directly from a user gesture, which this is.
      DOE.requestPermission().then(result => {
        if (result === "granted") startLiveCompass();
        else setCompassStatus("Compass permission was declined - the dial stays fixed north-up. You can allow motion & orientation access later in the app's permission settings, or just tap the button again.");
      }).catch(() => {
        setCompassStatus("Couldn't request compass permission on this device.");
      });
    } else if (window.DeviceOrientationEvent || "ondeviceorientationabsolute" in window) {
      startLiveCompass();
    } else {
      setCompassStatus("This browser doesn't expose a compass sensor - live rotation isn't available here. (Works on most phones; not on desktop.)");
    }
  });
}

function wireDirectionTab() {
  const prevBtn = document.getElementById("dir-day-prev");
  const nextBtn = document.getElementById("dir-day-next");
  const nowBtn = document.getElementById("dir-now-btn");
  const slider = document.getElementById("dir-time-slider");
  if (prevBtn) prevBtn.addEventListener("click", () => {
    directionEnterManual();
    state.direction.date = new Date(state.direction.date.getTime() - 24 * 3600 * 1000);
    renderDirection();
  });
  if (nextBtn) nextBtn.addEventListener("click", () => {
    directionEnterManual();
    state.direction.date = new Date(state.direction.date.getTime() + 24 * 3600 * 1000);
    renderDirection();
  });
  if (nowBtn) nowBtn.addEventListener("click", () => {
    state.direction.mode = "live";
    renderDirection();
  });
  if (slider) slider.addEventListener("input", () => {
    directionEnterManual();
    const mins = parseInt(slider.value, 10);
    const base = state.direction.date;
    const utcOffset = state.weather ? state.weather.utc_offset_seconds : null;
    const p = locationLocalParts(base, utcOffset);
    // Keeps the location-local calendar date the slider is already on, just
    // swaps in the location-local hour/minute it was dragged to - then
    // converts that wall-clock reading back to a real UTC instant.
    state.direction.date = locationLocalToUtc(p.year, p.month, p.day,
      Math.floor(mins / 60), mins % 60, utcOffset);
    renderDirection();
  });
}

// Lets a person tap or drag anywhere on the compass dial to drop a second,
// user-drawn pointer - their framing, a landmark, anything they want to
// compare directly against where the sun actually is. Lives inside
// #dir-face-rotator, same as the sun needle, so it turns with the dial for
// free when the live phone-heading rotation is active.
function renderManualMark() {
  const needle = document.getElementById("dir-manual-needle");
  const tip = document.getElementById("dir-manual-needle-tip");
  const readout = document.getElementById("dir-manual-readout");
  const bearingText = document.getElementById("dir-manual-bearing-text");
  if (!needle || !tip) return;
  const b = state.direction.manualBearing;
  const has = typeof b === "number";
  needle.hidden = !has;
  tip.hidden = !has;
  if (readout) readout.hidden = !has;
  if (!has) return;
  needle.style.transform = `rotate(${b}deg)`;
  tip.style.transform = `rotate(${b}deg)`;
  if (bearingText) bearingText.textContent = `${compassPointName(b)} (${Math.round(b)}°)`;
}

function wireManualCompassMark() {
  const svg = document.getElementById("dir-compass");
  const clearBtn = document.getElementById("dir-manual-clear");
  if (!svg) return;

  function svgPointFromEvent(evt) {
    const rect = svg.getBoundingClientRect();
    // viewBox is a fixed 300x300 regardless of the dial's rendered size, so
    // client coordinates have to be rescaled into that same 300x300 space
    // before the center-relative angle math below means anything.
    const scaleX = 300 / rect.width;
    const scaleY = 300 / rect.height;
    return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY };
  }

  function setManualBearingFromPoint(pt) {
    const dx = pt.x - 150;
    const dy = pt.y - 150;
    if (Math.hypot(dx, dy) < 12) return; // too close to the hub to mean a direction
    let screenBearing = Math.atan2(dx, -dy) * 180 / Math.PI;
    screenBearing = ((screenBearing % 360) + 360) % 360;
    // The dial can itself be rotated on-screen by the live phone-compass
    // handler (applyDirFaceRotation) - undo that rotation here so the
    // stored bearing is in the dial's own frame (matching how the sun
    // needle's bearing is stored), not wherever the tap happened to land
    // on-screen at that instant.
    const dialBearing = ((screenBearing + state.direction.unwrappedRotation) % 360 + 360) % 360;
    state.direction.manualBearing = dialBearing;
    renderManualMark();
  }

  let dragging = false;
  svg.addEventListener("pointerdown", (e) => {
    dragging = true;
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* not critical */ }
    setManualBearingFromPoint(svgPointFromEvent(e));
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    setManualBearingFromPoint(svgPointFromEvent(e));
  });
  svg.addEventListener("pointerup", () => { dragging = false; });
  svg.addEventListener("pointercancel", () => { dragging = false; });

  if (clearBtn) {
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.direction.manualBearing = null;
      renderManualMark();
    });
  }
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

  // Fan of rays around each exact bearing, not just the one exact azimuth.
  const sunsetProfile = [];
  const sunriseProfile = [];
  HORIZON_BEARING_SPREAD_DEG.forEach(spread => {
    HORIZON_DISTANCES_KM.forEach(d => {
      sunsetProfile.push(haversineDestination(loc.lat, loc.lon, sunsetBearing + spread, d));
      sunriseProfile.push(haversineDestination(loc.lat, loc.lon, sunriseBearing + spread, d));
    });
  });
  const allPoints = [{ lat: loc.lat, lon: loc.lon }].concat(sunsetProfile, sunriseProfile);
  const elevations = await fetchElevations(allPoints);
  const observerElevM = elevations[0];
  const raysPerEvent = HORIZON_BEARING_SPREAD_DEG.length * HORIZON_DISTANCES_KM.length;
  let sunsetObstructionDeg = -90, sunriseObstructionDeg = -90;
  for (let i = 0; i < raysPerEvent; i++) {
    const distKm = HORIZON_DISTANCES_KM[i % HORIZON_DISTANCES_KM.length];
    const a = obstructionAngleDeg(observerElevM, elevations[1 + i], distKm);
    if (a > sunsetObstructionDeg) sunsetObstructionDeg = a;
  }
  for (let i = 0; i < raysPerEvent; i++) {
    const distKm = HORIZON_DISTANCES_KM[i % HORIZON_DISTANCES_KM.length];
    const a = obstructionAngleDeg(observerElevM, elevations[1 + raysPerEvent + i], distKm);
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
    case "Great": return "#c17a52"; // Raylight terracotta
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
// readouts so an update reads as motion rather than a jump-cut. The count-up
// itself stays a plain ease-out (overshooting the actual number mid-count
// would show a momentarily WRONG value, which reads as a glitch, not as
// satisfying) - the "juicy" landing comes after, from a separate scale-pop
// applied to the element once the true value is showing.
const _animatedEls = new WeakMap();
// Runs fn() with body.no-refresh-fx applied for exactly one paint, then
// removes it - suppresses the CSS entrance animations on rebuilt list rows
// (factors, sun-times, outlook days, weather table) for a silent refresh.
// The double rAF is deliberate: the class has to still be present at the
// browser's NEXT paint (so the freshly-rebuilt elements are laid out with
// animation:none) before it's safe to remove it for the following one.
function withSilentRefreshFx(instant, fn) {
  if (!instant) { fn(); return; }
  document.body.classList.add("no-refresh-fx");
  fn();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.remove("no-refresh-fx");
  }));
}

function animateNumber(el, to, opts) {
  const suffix = (opts && opts.suffix) || "";
  const duration = (opts && opts.duration) || 700;
  const from = _animatedEls.has(el) ? _animatedEls.get(el) : 0;
  if (from === to) { el.textContent = to + suffix; _animatedEls.set(el, to); return; }
  // Auto-refresh (background timer, day rollover, live clock tick) should be
  // invisible - the number should just be correct next time you look, not
  // visibly count up or pop while you're looking at it. Only a refresh the
  // user actually triggered animates.
  if (opts && opts.instant) { el.textContent = to + suffix; _animatedEls.set(el, to); return; }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3); // ease-out cubic
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const val = Math.round(from + (to - from) * ease(t));
    el.textContent = val + suffix;
    if (t < 1) requestAnimationFrame(step);
    else popEl(el);
  }
  requestAnimationFrame(step);
  _animatedEls.set(el, to);
}

// ---------- Sensory feedback (haptic / sound / tactile pop) ----------
// All of this is feel, not function - it never gates or delays anything it's
// attached to, and every piece degrades to a silent no-op where the browser
// or device doesn't support it (no navigator.vibrate on iOS Safari, no
// AudioContext in some webviews, etc).
const LS_SOUND_KEY = "pbam_sound_fx";
function loadSoundEnabled() { return localStorage.getItem(LS_SOUND_KEY) !== "0"; } // on by default - requested explicitly
function saveSoundEnabled(v) { localStorage.setItem(LS_SOUND_KEY, v ? "1" : "0"); }

function haptic(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern || 10); } catch (e) { /* unsupported - fine */ }
}

// A soft two-oscillator "pad" tone through a lowpass filter, rather than a
// bare sine beep - the slight detune between the two oscillators plus the
// filter rolling off the harsh upper harmonics is what makes it read as warm
///"creamy" instead of a UI-testing-tool blip. type lets a caller reach for a
// brighter "triangle" timbre (used for the shutter click) when a little more
// bite is actually wanted.
let _audioCtx = null;
function playTone(freq, dur, vol, type) {
  if (!loadSoundEnabled()) return;
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = Math.max(900, freq * 2.4);
    filter.Q.value = 0.4;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(vol, now + 0.008); // tiny soft attack, not a hard click
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    filter.connect(gain); gain.connect(ctx.destination);

    const detunes = type === "triangle" ? [0] : [-4, 4]; // single voice for a crisper click tone, two detuned voices for warmth
    detunes.forEach(cents => {
      const osc = ctx.createOscillator();
      osc.type = type || "sine";
      osc.frequency.value = freq;
      osc.detune.value = cents;
      osc.connect(filter);
      osc.start(now);
      osc.stop(now + dur);
    });
  } catch (e) { /* no AudioContext - fine */ }
}
// Three feedback "flavors": a light tap for routine presses, a two-note
// rising chime for something completing successfully (a shoot log entry, a
// GPS fix), and a distinct descending chime reserved for a manually-
// triggered data refresh specifically - it needs to sound different so a
// deliberate refresh is obviously distinguishable from routine UI feedback,
// and it must ONLY fire when you tap Refresh Data yourself, never on the
// silent 5-minute auto-refresh or the midnight day-rollover refresh.
function feedbackTap() { haptic(10); playTone(640, 0.06, 0.045); }
function feedbackSuccess() { haptic([8, 26, 10]); playTone(660, 0.1, 0.04); setTimeout(() => playTone(880, 0.14, 0.04), 85); }
function feedbackRefreshDone() { haptic([10, 20, 10, 20]); playTone(980, 0.08, 0.045); setTimeout(() => playTone(700, 0.12, 0.045), 90); }
// A bigger, three-note rising fanfare for a genuinely rare event (an epic
// sunrise/sunset showing up) - distinct from the everyday feedbackSuccess
// so it actually reads as "this one's different," not just another confirm chime.
function feedbackEpic() {
  haptic([12, 30, 12, 30, 18]);
  playTone(660, 0.1, 0.045);
  setTimeout(() => playTone(830, 0.12, 0.045), 110);
  setTimeout(() => playTone(1046, 0.2, 0.05), 230);
}

// A soft mechanical-keyboard-style tick for actually typing - a short,
// randomized-pitch triangle blip per keystroke reads as a satisfying "clack"
// without the sustain of the UI tap tone, and stays cheap enough to fire on
// every single keydown without feeling laggy.
function feedbackKeyTick() {
  const freq = 520 + Math.random() * 160;
  playTone(freq, 0.028, 0.035, "triangle");
}

// A quick overshoot scale-bounce, retriggerable on an element that might
// already be mid-pop (restarts the CSS animation cleanly via reflow).
function popEl(el) {
  if (!el) return;
  el.classList.remove("value-pop");
  void el.offsetWidth; // force reflow so re-adding the class restarts the animation
  el.classList.add("value-pop");
}

// A small ink-blot ripple expanding from the touch/click point - the tactile
// "sensory" counterpart to the haptic buzz, themed as a spreading ink stamp
// rather than a generic material ripple. Purely decorative; removes itself.
function addInkRipple(e) {
  const btn = e.currentTarget;
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.8;
  const ripple = document.createElement("span");
  ripple.className = "ink-ripple";
  ripple.style.width = ripple.style.height = size + "px";
  const cx = (typeof e.clientX === "number" && e.clientX) ? e.clientX : rect.left + rect.width / 2;
  const cy = (typeof e.clientY === "number" && e.clientY) ? e.clientY : rect.top + rect.height / 2;
  ripple.style.left = (cx - rect.left - size / 2) + "px";
  ripple.style.top = (cy - rect.top - size / 2) + "px";
  btn.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove());
}
// Wires tap feedback (haptic + tone + ink ripple) onto every element
// matching the given selector, via ONE delegated listener on document
// rather than binding each element individually - so it also covers
// elements that don't exist yet at call time (log table delete buttons,
// Outlook rows, anything else rebuilt via innerHTML later), not just
// whatever matched the selector the moment this ran. Safe to call once at
// startup; call it with a broad selector ("button" catches virtually every
// tappable control in this app, since that's what they're all built as) to
// get haptics "everywhere" for free instead of hand-wiring each new button.
function wireTactileFeedback(selector) {
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(selector);
    if (!el || el.disabled) return;
    feedbackTap();
    addInkRipple({ currentTarget: el, clientX: e.clientX, clientY: e.clientY });
  });
}

// A lighter touch than a full tap - just the buzz, no tone/ripple - for
// controls where a click-sized ripple doesn't make sense (a dropdown, a
// range slider) but a small confirmation that something changed still
// helps, especially with gloves on or without looking at the screen.
function wireChangeHaptics(selector) {
  document.addEventListener("change", (e) => {
    if (e.target.closest && e.target.closest(selector)) haptic(6);
  });
}

// Literal camera-shutter feedback for a photography app: a quick warm flash
// plus, only on a manually-triggered refresh, a two-click shutter sound
// (distinct from the lighter UI tap tone and from feedbackRefreshDone()).
// The flash itself still fires on any successful LIVE data refresh - never
// on a cached/offline fallback, since that isn't actually new data landing -
// but the sound is silent on background/automatic refreshes so the app
// never makes noise the user didn't ask for.
function fireShutterFlash(playSound) {
  const el = document.getElementById("shutter-flash");
  if (!el) return;
  el.classList.remove("firing");
  void el.offsetWidth;
  el.classList.add("firing");
  if (playSound && loadSoundEnabled()) {
    playTone(1400, 0.025, 0.05, "triangle");
    setTimeout(() => playTone(900, 0.035, 0.05, "triangle"), 70);
  }
}

// Maps a tier keyword (as used on verdict-line elements throughout the
// dashboard - "great"/"good"/"fair"/anything else) to the same color
// language as qualityColor()'s Great/Good/Fair labels, so a refresh burst
// from any card always matches that card's own tier color.
function colorForTier(tier) {
  switch (tier) {
    case "great": return "#c17a52";
    case "good": return "#1f6b5c";
    case "fair": return "#8a6a3d";
    default: return "#a8371f";
  }
}

// A small confetti-style burst of tier-colored dots from wherever it's
// called - sized for a phone screen, not a full takeover. Particles are
// position:fixed so they fly freely over whatever's on screen, then remove
// themselves. Silently does nothing for a hidden/off-tab element (a
// zero-size bounding rect), so it's safe to call on cards that may not be
// the currently visible tab.
function fireParticleBurst(originEl, color, count) {
  if (!originEl) return;
  const rect = originEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const n = count || 14;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("span");
    p.className = "burst-particle";
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const dist = 46 + Math.random() * 58;
    p.style.setProperty("--bx", Math.cos(angle) * dist + "px");
    p.style.setProperty("--by", Math.sin(angle) * dist + "px");
    p.style.left = cx + "px";
    p.style.top = cy + "px";
    p.style.background = color;
    document.body.appendChild(p);
    p.addEventListener("animationend", () => p.remove());
  }
}

// Fires the "epic sunrise/sunset/bird activity" celebration on whatever
// dashboard element triggered it: glow pulse (via its own "-epic" CSS
// class, applied by the caller), a gold/warm particle burst from it, the
// badge below it, the distinct fanfare feedback, and - if the person has
// opted in in Settings - a real OS-level notification, so a genuinely rare
// reading reaches them even if the app isn't the open tab/foreground app
// right now. Kept as one function so the full treatment (visual + haptic +
// sound + notification) always fires together.
function celebrateEpic(originEl, badgeEl) {
  if (!originEl) return;
  badgeEl && badgeEl.removeAttribute("hidden");
  fireParticleBurst(originEl, "#c17a52");
  feedbackEpic();
}

// ---------- Epic condition device notifications ----------
// Opt-in (Settings > Epic condition alerts) since requesting notification
// permission unprompted is both bad practice and, on most browsers, simply
// refused/ignored outside a direct user gesture anyway.
const LS_EPIC_ALERTS_KEY = "pbam_epic_alerts";
function loadEpicAlertsEnabled() { return localStorage.getItem(LS_EPIC_ALERTS_KEY) === "1"; }
function saveEpicAlertsEnabled(v) { localStorage.setItem(LS_EPIC_ALERTS_KEY, v ? "1" : "0"); }

// Sends an actual device/OS notification (not just an in-page badge) for a
// newly-detected epic reading. Prefers the service worker registration's
// showNotification() - the path that actually works for a PWA on Android
// and reaches the system tray even when the app isn't the foreground tab -
// falling back to a bare `new Notification()` for a desktop browser with no
// active service worker. Every failure mode (permission never granted,
// Notification API missing entirely, no registered service worker yet) is a
// silent no-op: the in-app badge/burst/haptic above already covers "you're
// looking at the app right now," so this is purely a bonus reach when
// they're not.
function notifyEpic(title, body) {
  if (!loadEpicAlertsEnabled()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const opts = {
    body,
    icon: "assets/raylight-bird-icon-right.png",
    badge: "assets/raylight-bird-icon-right.png",
    tag: "raylight-epic", // replaces any still-showing epic notification instead of stacking duplicates
    renotify: true
  };
  const fallback = () => { try { new Notification(title, opts); } catch (e) { /* unsupported here either - fine */ } };
  if ("serviceWorker" in navigator) {
    // navigator.serviceWorker.ready is a Promise that only resolves once a
    // service worker is actually active for this origin - if registration
    // never completes (blocked, still installing, briefly offline), it
    // hangs forever rather than rejecting, which would otherwise mean this
    // notification silently never shows and never falls back either. Race
    // it against a short timeout so a slow/failed registration still ends
    // up going through the plain `new Notification()` path instead of
    // vanishing.
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("sw not ready")), 1500));
    Promise.race([navigator.serviceWorker.ready, timeout])
      .then(reg => reg.showNotification(title, opts))
      .catch(fallback);
  } else {
    fallback();
  }
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

// ---------- Bird activity model ----------
function hoursBetween(a, b) {
  return (a.getTime() - b.getTime()) / 3600000;
}

// Real nocturnal migratory flight - not modeled by the diurnal/crepuscular
// curve below at all - is often the single largest bird-activity signal at
// night during the spring/fall migration windows. Radar-tracked nocturnal
// migration traffic (Cornell's BirdCast, birdcast.info/science) consistently
// ramps up starting roughly an hour after local sunset, peaks a few hours
// into full darkness, then tapers off well before dawn. This bonus is
// additive on top of the low night floor below, gated to migration season
// AND to genuine darkness (past nautical twilight, elevationDeg <= -12) so
// it never touches the well-established dawn/dusk/midday shape the rest of
// the year - it only fills in the one real gap the diurnal model itself
// documents (see the "not built for nocturnal migrants" note below).
function nocturnalMigrationBonus(elevationDeg, now, times) {
  if (elevationDeg > -12) return 0; // still twilight - already covered by the curve below
  if (expectedTailwindBearing(now) === null) return 0; // outside spring/fall migration windows
  const hrSinceSunset = hoursBetween(now, times.sunset);
  if (!(hrSinceSunset > 0)) return 0; // guard against bad/missing sunset data
  const sigma = 2.5;
  const peakHours = 3.5; // radar migration traffic typically peaks a few hours after full dark
  const gauss = Math.exp(-Math.pow(hrSinceSunset - peakHours, 2) / (2 * sigma * sigma));
  return gauss * 55;
}

// Daylight/twilight activity potential (0-100), the model's foundation.
// This is deliberately tuned for diurnal/crepuscular species (passerines,
// woodpeckers, raptors, waterfowl), with nocturnalMigrationBonus() above
// covering the one nocturnal case that genuinely matters at this scale
// (migratory flight during the spring/fall windows) - it's still not built
// for owls or other non-migratory nocturnal behavior.
// Shape: a daytime baseline (activity all day, but with the well-documented
// midday lull), a sharp bonus right at sunrise/sunset (dawn chorus, pre-roost
// feeding), ramping down through twilight, a low floor at full night, and a
// migration-season night bump layered on top of that floor.
// This is a GATE, not just one of several additive terms - weather and
// season below can only modulate it, not manufacture activity at 2 AM outside
// migration season.
// The three factors below (diel position, weather, season) are a HEURISTIC
// proxy model - the sole basis for this score. It cannot know what birds are
// actually present; it estimates activity probability from documented
// behavioral patterns:
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
// estimate, not an observation of actual birds at this location.
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
  const nightMigration = nocturnalMigrationBonus(elevationDeg, now, times);
  return Math.round(Math.min(100, base + twilightBonus + nightMigration));
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

// Did it rain recently and stop? A well-documented field observation in
// foraging ecology: ground-foraging birds (robins and other thrushes,
// starlings, many sparrows) show a sharp, short-lived burst of activity
// right after rain lets up, because rain drives earthworms and other soil
// invertebrates to the surface where they're suddenly easy to find (see the
// American Robin account in Sallabanks & James (1999), Birds of North
// America, on rain-associated earthworm foraging). Detected from the hourly
// series: meaningful rain in the last two hours, essentially none right now.
function postRainForagingBonus(weatherData, now) {
  try {
    const hourly = weatherData.hourly;
    const idxNow = nearestHourIndex(hourly, now);
    if (idxNow < 2 || !hourly.precipitation) return 0;
    const currentPrecip = hourly.precipitation[idxNow];
    const recentPrecip = Math.max(hourly.precipitation[idxNow - 1] || 0, hourly.precipitation[idxNow - 2] || 0);
    if (currentPrecip <= 0.2 && recentPrecip >= 1.0) return 14;
    return 0;
  } catch (e) {
    return 0;
  }
}

// Dense fog suppresses activity that depends on sight: visual foragers
// (e.g. flycatching, aerial insectivory) and, especially, soaring flight,
// since raptors and other soaring migrants rely on visually locating rising
// thermals and can't safely stream through terrain in near-zero visibility
// (general behavioral basis discussed in Kerlinger, P. (1989), Flight
// Strategies of Migrating Hawks, University of Chicago Press). Below ~1km
// visibility is the conventional threshold for "dense fog" in aviation and
// meteorological reporting, reused here for the same reason it's used there.
function fogSuppressionPenalty(weatherData, now) {
  try {
    const hourly = weatherData.hourly;
    const idx = nearestHourIndex(hourly, now);
    if (idx === -1 || !hourly.visibility) return 0;
    const visM = hourly.visibility[idx];
    if (typeof visM !== "number") return 0;
    if (visM < 1000) return -18;
    if (visM < 3000) return -6;
    return 0;
  } catch (e) {
    return 0;
  }
}

// Overcast skies measurably reduce the midday activity dip that the diel
// curve otherwise bakes in: direct sun raises a bird's operative
// (radiative) temperature well above air temperature, and thermoregulatory
// heat-avoidance behavior (seeking shade, reducing activity) during the
// hottest, sunniest part of the day is well documented (Walsberg, G.E.
// (1993), "Thermal Consequences of Diurnal Microhabitat Selection in
// Birds," American Zoologist 33(6):618-629). Cloud cover cuts direct solar
// load, so warm+overcast middays see less of that heat-driven lull than
// warm+clear ones. Only applies when it's actually warm enough for heat
// avoidance to be a factor, and only near midday.
function overcastMiddayBonus(current, elevationDeg) {
  if (elevationDeg < 25) return 0; // not midday-high sun
  const temp = current.temperature_2m;
  if (temp < 22) return 0; // heat avoidance isn't a factor in cool weather
  if (current.cloud_cover >= 60) return 8;
  return 0;
}

function weatherFactor(weatherData, trendHpa, now, elevationDeg) {
  const current = weatherData.current;
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

  // Three additional real, independently-sourced signals - see each
  // function's own citation above.
  score += postRainForagingBonus(weatherData, now);
  score += fogSuppressionPenalty(weatherData, now);
  score += overcastMiddayBonus(current, elevationDeg);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function seasonalFactor(date) {
  // Northern Hemisphere migration-window bump: more species and higher
  // movement volume in Apr-May and Sep-Oct.
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
  const weather = weatherFactor(weatherData, trend, now, elevationDeg);
  const season = seasonalFactor(now);

  // Weather and season are MODIFIERS on the diel gate, not independent
  // additive scores - that's what stops "great weather + migration season"
  // from producing a nonzero score at 2 AM when there is no diurnal activity
  // potential to modulate.
  //
  // The bonus headroom above 1.0x on each modifier is intentionally kept
  // small (max +5% apiece, +10.25% combined) rather than the +15%/+20% this
  // originally shipped with. At +15%/+20%, diel only needed to reach ~72.5
  // (100/1.15/1.20) for a perfect-weather, peak-migration moment to already
  // saturate the 0-100 ceiling - and diel sits above 90 for a combined ~2
  // hours a day (about an hour either side of both sunrise and sunset,
  // twice a day, every day; see the gaussian twilight bonus above). Checking
  // the app near dawn or dusk during migration season - exactly when this
  // app is most likely to be opened - would hit a literal 1000/1000 far too
  // routinely for that to read as meaningful. With the combined multiplier
  // capped at 1.1025x, saturating now requires diel above ~90.7 (a
  // ~55-minute window around sunrise/sunset) AND weather at its literal
  // unpenalized best AND being inside one of the ~2-month migration windows,
  // all at once - a genuinely rare confluence rather than a routine one.
  const weatherMult = 0.6 + (weather / 100) * 0.45;   // 0.60 - 1.05
  const seasonMult = 0.75 + (season / 100) * 0.3;     // 0.75 - 1.05

  const total0to100 = Math.max(0, Math.min(100, diel * weatherMult * seasonMult));
  const rawTotal = Math.round(total0to100 * 10); // reported on a 0-1000 scale
  const total = calibrateBirdScore(rawTotal);

  let verdict, tier;
  if (total >= 750) { verdict = "High activity likely (model estimate)"; tier = "great"; }
  else if (total >= 500) { verdict = "Moderate activity likely (model estimate)"; tier = "good"; }
  else if (total >= 250) { verdict = "Low activity likely (model estimate)"; tier = "fair"; }
  else { verdict = "Quiet period likely (model estimate)"; tier = "poor"; }

  const factors = {
    "Daylight/twilight position": diel,
    "Weather modifier": `x${weatherMult.toFixed(2)}`,
    "Season/migration modifier": `x${seasonMult.toFixed(2)}`,
    "Pressure trend (3h)": formatPressureTrend(trend)
  };
  // Only surfaced when actually in play, so the factor grid doesn't fill up
  // with a wall of "0" rows for conditions that aren't currently relevant.
  const rainBonus = postRainForagingBonus(weatherData, now);
  if (rainBonus > 0) factors["Post-rain foraging pulse"] = `+${rainBonus}`;
  const fogPenalty = fogSuppressionPenalty(weatherData, now);
  if (fogPenalty < 0) factors["Fog suppression"] = `${fogPenalty}`;
  const overcastBonus = overcastMiddayBonus(weatherData.current, elevationDeg);
  if (overcastBonus > 0) factors["Overcast midday (less heat-avoidance)"] = `+${overcastBonus}`;

  return { total, rawTotal, verdict, tier, source: "heuristic", factors };
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

// "Elevation: -36.0°" means nothing to most people at a glance - a negative
// number reading as an error rather than "below the horizon." Spelling out
// above/below in plain words, plus a one-line plain-English translation of
// what that angle means for daylight, is what actually makes it legible.
function formatSunAngle(elevationDeg) {
  const abs = Math.abs(elevationDeg).toFixed(1);
  const direction = elevationDeg >= 0 ? "above horizon" : "below horizon";
  let note;
  if (elevationDeg > 20) note = "high in the sky";
  else if (elevationDeg > 0) note = "low in the sky - good light";
  else if (elevationDeg > -6) note = "civil twilight";
  else if (elevationDeg > -12) note = "nautical twilight";
  else if (elevationDeg > -18) note = "astronomical twilight";
  else note = "fully dark";
  return `Sun angle: ${abs}° ${direction} (${note})`;
}

function renderSun(loc, now, sunToday, sunTomorrow, utcOffsetSeconds, horizon) {
  const phase = classifyPhase(now, sunToday.times);
  document.getElementById("sun-phase").textContent = phase;
  document.getElementById("sun-elevation").textContent = formatSunAngle(sunToday.elevationDeg);
  const moon = computeMoonPhase(now);
  document.getElementById("moon-phase").textContent = `Moon: ${moon.name} (${Math.round(moon.illumination * 100)}% illuminated)`;
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

function renderTodayQuality(times, weatherData, horizon, airQuality, instant) {
  const aqHourly = airQuality && airQuality.hourly;
  const qSunrise = qualityAt(weatherData.hourly, times.sunrise, horizon && horizon.sunriseObstructionDeg, aqHourly);
  const qSunset = qualityAt(weatherData.hourly, times.sunset, horizon && horizon.sunsetObstructionDeg, aqHourly);
  // Kept on state so the Shoot Log can attach "what did the model actually
  // predict right now" to whichever entry gets logged next.
  state.qSunrise = qSunrise;
  state.qSunset = qSunset;
  animateNumber(document.getElementById("q-sunrise"), qSunrise.score, { suffix: "%", instant });
  document.getElementById("q-sunrise-label").textContent = qSunrise.label;
  animateNumber(document.getElementById("q-sunset"), qSunset.score, { suffix: "%", instant });
  document.getElementById("q-sunset-label").textContent = qSunset.label;
  const ringSunriseEl = document.getElementById("ring-sunrise");
  const ringSunsetEl = document.getElementById("ring-sunset");
  paintRing(ringSunriseEl, qSunrise.score, qSunrise.label);
  paintRing(ringSunsetEl, qSunset.score, qSunset.label);

  // Spells out WHY today's number is what it is, right where the number is -
  // specifically the two factors that don't just uniformly push the score
  // one direction (terrain and aerosol), since those are the ones that can
  // otherwise look like an unexplained swing from one day to the next.
  const noteFor = q => [q.terrainNote, q.aodNote].filter(Boolean).join(" · ");
  document.getElementById("q-sunrise-note").textContent = noteFor(qSunrise);
  document.getElementById("q-sunset-note").textContent = noteFor(qSunset);

  // Fills the click-to-expand breakdown behind each ring with the exact
  // same explainQuality() lines the Outlook uses, so "why is this score X"
  // always reads the same whether it's asked about today or a forecast day.
  const fillDetail = (kind, q) => {
    const list = document.querySelector("#ring-detail-" + kind + " .orow-detail-list");
    if (list) list.innerHTML = explainQuality(q).map(line => `<li>${line}</li>`).join("");
  };
  fillDetail("sunrise", qSunrise);
  fillDetail("sunset", qSunset);

  // Legendary (score >=95) treatment: the glow ring and badge stay up for as
  // long as the reading holds, but the burst/fanfare only fires once per
  // newly-detected legendary sunrise or sunset (keyed by calendar date), so
  // it doesn't replay on every 15-second background refresh or tab switch.
  const dateKey = times.sunrise instanceof Date ? times.sunrise.toISOString().slice(0, 10) : "unknown";
  applyEpicUi("sunrise", qSunrise.legendary, ringSunriseEl, document.getElementById("epic-badge-sunrise"), dateKey, instant,
    "Legendary sunrise conditions", "Today's sunrise is shaping up to be a rare one - worth getting up for.");
  applyEpicUi("sunset", qSunset.legendary, ringSunsetEl, document.getElementById("epic-badge-sunset"), dateKey, instant,
    "Legendary sunset conditions", "Tonight's sunset is shaping up to be a rare one - worth heading out for.");
}

function applyEpicUi(kind, isEpic, ringEl, badgeEl, dateKey, instant, notifyTitle, notifyBody, epicClass) {
  if (!ringEl) return;
  ringEl.classList.toggle(epicClass || "ring-epic", !!isEpic);
  if (!isEpic) {
    badgeEl && badgeEl.setAttribute("hidden", "");
    return;
  }
  const key = kind + "-" + dateKey;
  // The device notification fires the FIRST moment a reading crosses into
  // epic territory, on a silent background refresh included - that's the
  // entire point of a real notification instead of just an in-app badge:
  // reaching the person when they're not already looking at the app.
  // Tracked separately from the in-app celebration below, which
  // deliberately waits for a manual refresh instead.
  if (!state.epicNotified[key]) {
    state.epicNotified[key] = true;
    if (notifyTitle) notifyEpic(notifyTitle, notifyBody);
  }
  if (state.epicCelebrated[key]) {
    // Already celebrated this exact epic reading - keep the glow/badge up
    // (set right above) but skip the burst/fanfare replay.
    badgeEl && badgeEl.removeAttribute("hidden");
    return;
  }
  // A background auto-refresh is the wrong moment to spend the "first
  // celebration" of a newly-epic reading - it should stay unclaimed
  // (state.epicCelebrated left false) so the full burst/haptic/fanfare still
  // fires the next time a REAL (manual) refresh sees it, rather than being
  // silently consumed off-screen. The badge itself still shows either way -
  // only the one-off flourish is gated.
  badgeEl && badgeEl.removeAttribute("hidden");
  if (instant) return;
  state.epicCelebrated[key] = true;
  celebrateEpic(ringEl, badgeEl);
}

function renderOutlook(loc, weatherData, horizon, airQuality) {
  const grid = document.getElementById("outlook-grid");
  grid.innerHTML = "";
  const aqHourly = airQuality && airQuality.hourly;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let d = 0; d < 7; d++) {
    const day = new Date();
    day.setDate(day.getDate() + d);
    const { times } = computeSun(loc, day);
    // Terrain doesn't change day to day, so the same cached obstruction
    // angles apply across the whole outlook - no repeated elevation calls.
    const qSunrise = qualityAt(weatherData.hourly, times.sunrise, horizon && horizon.sunriseObstructionDeg, aqHourly);
    const qSunset = qualityAt(weatherData.hourly, times.sunset, horizon && horizon.sunsetObstructionDeg, aqHourly);
    // Golden hour intensity (direct warm light) is a deliberately separate
    // measure from the sky-color quality scores above - see the big comment
    // on computeGoldenHourIntensity. Forecast it at each day's morning and
    // evening window using the same forecastGoldenWindow() helper the
    // Dashboard's "next golden window" card already uses.
    const goldenAM = forecastGoldenWindow(loc, { start: times.sunrise, end: times.goldenHourEnd }, weatherData.hourly, aqHourly);
    const goldenPM = forecastGoldenWindow(loc, { start: times.goldenHour, end: times.sunset }, weatherData.hourly, aqHourly);
    const el = document.createElement("div");
    el.className = "outlook-day" + (d === 0 ? " is-today" : "");
    el.style.setProperty("--stagger-delay", (d * 45) + "ms");
    // Each row is a tappable toggle rather than a plain readout - clicking
    // it reveals exactly which real inputs (cloud bands, humidity, aerosol,
    // terrain) produced that specific number, using explainQuality() on the
    // same result object already computed above, so the breakdown always
    // matches the score shown, not a re-derived guess at it.
    const chevron = '<svg class="orow-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
    const detailHtml = (q) => `<ul class="orow-detail-list">${explainQuality(q).map(line => `<li>${line}</li>`).join("")}</ul>`;
    const goldenColor = (score) => score >= 70 ? "#1f6b5c" : score >= 45 ? "#c17a52" : score >= 20 ? "#8a6a3d" : "#a8371f";
    const goldenRow = (g, timeLabel, rowLabel) => {
      if (!g) return "";
      return `
      <button type="button" class="orow orow-toggle"><span>${rowLabel} <span class="otime">${timeLabel}</span></span>
        <span class="orow-right"><span class="oscore" style="color:${goldenColor(g.score)}">${g.score}% ${g.label}</span>${chevron}</span></button>
      <div class="orow-detail" hidden><ul class="orow-detail-list"><li>${g.note}</li><li>Estimated color temp ~${g.cct}K</li></ul></div>`;
    };
    el.innerHTML = `
      <div class="oday-name">${dayNames[day.getDay()]} ${day.getMonth() + 1}/${day.getDate()}</div>
      <button type="button" class="orow orow-toggle"><span>Sunrise <span class="otime">${fmtTime(times.sunrise, weatherData.utc_offset_seconds)}</span></span>
        <span class="orow-right"><span class="oscore${qSunrise.legendary ? " oscore-epic" : ""}" style="color:${qualityColor(qSunrise.label)}">${qSunrise.score}% ${qSunrise.label}</span>${chevron}</span></button>
      <div class="orow-detail" hidden>${detailHtml(qSunrise)}</div>
      ${goldenRow(goldenAM, fmtTime(times.sunrise, weatherData.utc_offset_seconds) + "–" + fmtTime(times.goldenHourEnd, weatherData.utc_offset_seconds), "Golden Hour (AM)")}
      <button type="button" class="orow orow-toggle"><span>Sunset <span class="otime">${fmtTime(times.sunset, weatherData.utc_offset_seconds)}</span></span>
        <span class="orow-right"><span class="oscore${qSunset.legendary ? " oscore-epic" : ""}" style="color:${qualityColor(qSunset.label)}">${qSunset.score}% ${qSunset.label}</span>${chevron}</span></button>
      <div class="orow-detail" hidden>${detailHtml(qSunset)}</div>
      ${goldenRow(goldenPM, fmtTime(times.goldenHour, weatherData.utc_offset_seconds) + "–" + fmtTime(times.sunset, weatherData.utc_offset_seconds), "Golden Hour (PM)")}
    `;
    el.querySelectorAll(".orow-toggle").forEach(btn => {
      btn.addEventListener("click", () => {
        const detail = btn.nextElementSibling;
        const open = !detail.hasAttribute("hidden");
        if (open) { detail.setAttribute("hidden", ""); btn.classList.remove("is-open"); }
        else { detail.removeAttribute("hidden"); btn.classList.add("is-open"); }
      });
    });
    grid.appendChild(el);
  }
}

function renderWeather(sunToday, weatherData, airQuality) {
  const c = weatherData.current;
  const trend = pressureTrend(weatherData);

  const rowIcons = {
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 16.5a4 4 0 0 1 .5-8 5 5 0 0 1 9.7-1.5A4.5 4.5 0 0 1 17.5 16H7Z"/></svg>',
    wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8h9a2.5 2.5 0 1 0-2-4"/><path d="M3 12h13a2.5 2.5 0 1 1-2 4"/><path d="M3 16h7a2 2 0 1 1-1.6 3.2"/></svg>',
    temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a2 2 0 0 0-2 2v9.2a4 4 0 1 0 4 0V5a2 2 0 0 0-2-2Z"/><circle cx="12" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>',
    humid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3c3 4 6 7.7 6 11a6 6 0 1 1-12 0c0-3.3 3-7 6-11Z"/></svg>',
    uv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.5"/><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>'
  };
  const uvVal = c.uv_index;
  const uvNote = uvVal == null ? "" : uvVal >= 8 ? " (very high)" : uvVal >= 6 ? " (high)" : uvVal >= 3 ? " (moderate)" : " (low)";
  // "Temperature" on its own used to read as ambiguous - is that right now,
  // or the day's high? It's always current.temperature_2m (Open-Meteo's
  // actual current reading, not a daily aggregate), but says so explicitly
  // now, plus shows today's real low/high right next to it for context -
  // found by matching today's location-local date against the daily
  // forecast's own date strings, not a hardcoded array index, so it's still
  // correct regardless of the past_days offset in the request.
  let todayHigh = null, todayLow = null;
  if (weatherData.daily && Array.isArray(weatherData.daily.time)) {
    const p = locationLocalParts(new Date(), weatherData.utc_offset_seconds);
    const todayStr = `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const idx = weatherData.daily.time.indexOf(todayStr);
    if (idx !== -1) {
      todayHigh = weatherData.daily.temperature_2m_max[idx];
      todayLow = weatherData.daily.temperature_2m_min[idx];
    }
  }
  const rangeText = (typeof todayHigh === "number" && typeof todayLow === "number")
    ? ` (today's range: L ${formatTemp(todayLow)} / H ${formatTemp(todayHigh)})`
    : "";
  const rows = [
    ["cloud", "Cloud cover", `${c.cloud_cover}%`],
    ["wind", "Wind", formatWind(c.wind_speed_10m)],
    ["temp", "Temperature (current)", formatTemp(c.temperature_2m) + rangeText],
    ["humid", "Humidity", `${c.relative_humidity_2m}%`],
    ["uv", "UV index", uvVal == null ? "--" : `${uvVal.toFixed(1)}${uvNote}`]
  ];
  // Visibility was already being fetched (hourly.visibility, in meters) but
  // never actually shown anywhere - real haze/fog data going unused. Haze
  // measurably flattens sunset color and contrast, so it belongs here.
  const visIdx = nearestHourIndex(weatherData.hourly, new Date());
  const visM = (weatherData.hourly.visibility && visIdx !== -1) ? weatherData.hourly.visibility[visIdx] : null;
  if (visM != null) {
    const visKm = visM / 1000;
    const visNote = visKm < 4 ? " (hazy/foggy)" : visKm < 10 ? " (some haze)" : " (clear)";
    rows.push(["cloud", "Visibility", `${visKm.toFixed(1)} km${visNote}`]);
  }
  if (airQuality && airQuality.pm2_5 != null) {
    const aqi = airQuality.us_aqi;
    const aqiNote = aqi == null ? "" : aqi > 150 ? " (unhealthy - expect washed-out color)" : aqi > 100 ? " (elevated haze)" : aqi > 50 ? " (moderate)" : " (clean air)";
    rows.push(["cloud", "Air quality (PM2.5)", `${airQuality.pm2_5.toFixed(0)} µg/m³${aqiNote}`]);
  }
  if (airQuality && typeof airQuality.aerosol_optical_depth === "number") {
    const aod = airQuality.aerosol_optical_depth;
    const aodNote = aod > 0.6 ? " (heavy - likely muting color)" : aod > 0.12 ? " (light haze - can deepen color)" : " (clear column)";
    rows.push(["cloud", "Atmospheric haze (AOD)", `${aod.toFixed(2)}${aodNote}`]);
  }
  const tbody = document.querySelector("#weather-table tbody");
  tbody.innerHTML = rows.map(([icon, k, v], i) =>
    `<tr style="--stagger-delay:${i * 35}ms"><td><span class="row-icon">${rowIcons[icon]}</span>${k}</td><td>${v}</td></tr>`
  ).join("");

  renderBarometer(c, trend);
}

// Split out from the general weather card into its own section - pressure
// trend is the one weather input that directly feeds the bird activity
// model (pre-frontal foraging bonus/penalty, see the About tab), so it
// earns its own read rather than being buried as one line in a list.
function renderBarometer(current, trend) {
  const verdictEl = document.getElementById("barometer-verdict");
  const subEl = document.getElementById("barometer-sub");
  const tbody = document.querySelector("#barometer-table tbody");
  let label, tier, note;
  if (trend <= -1) { label = "Falling"; tier = "good"; note = "Pre-frontal drop - foraging activity tends to pick up."; }
  else if (trend >= 1) { label = "Rising sharply"; tier = "fair"; note = "Sharp rise - activity tends to quiet down."; }
  else { label = "Steady"; tier = "good"; note = "No strong pressure swing right now."; }
  verdictEl.textContent = label;
  verdictEl.className = "big-stat verdict-line tier-" + tier;
  subEl.textContent = note;
  const pressureIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 12l4-2.4M12 7v.01"/></svg>';
  const rows = [
    ["Current pressure", formatPressure(current.surface_pressure)],
    ["3-hour trend", formatPressureTrend(trend)]
  ];
  tbody.innerHTML = rows.map(([k, v], i) =>
    `<tr style="--stagger-delay:${i * 35}ms"><td><span class="row-icon">${pressureIcon}</span>${k}</td><td>${v}</td></tr>`
  ).join("");
}

function renderBird(score, instant) {
  animateNumber(document.getElementById("bird-score"), score.total, { instant });
  const verdictEl = document.getElementById("bird-verdict");
  verdictEl.textContent = score.verdict;
  verdictEl.className = "big-stat small tier-" + score.tier;
  document.getElementById("bird-fill").style.width = (score.total / 10) + "%";
  const sourceEl = document.getElementById("bird-source");
  sourceEl.textContent = "Weather/astronomy model";
  sourceEl.className = "bird-source is-model";
  const grid = document.getElementById("bird-factors");
  grid.innerHTML = Object.entries(score.factors).map(([k, v], i) =>
    `<div class="factor" style="--stagger-delay:${i * 45}ms"><div class="fname">${k}</div><div class="fval">${v}</div></div>`
  ).join("");

  // Same "legendary" treatment as the sunrise/sunset rings (same threshold
  // used by birdKeyForTotal's top Shoot Log rating tier: >=950 on the
  // 0-1000 scale), applied to the meter bar instead of a ring. Keyed by
  // calendar date, same pattern as the light legendary keys, so it re-fires
  // once per day the score newly crosses into legendary territory rather
  // than once ever.
  const barEl = document.getElementById("bird-meter-bar");
  const badgeEl = document.getElementById("epic-badge-bird");
  const now = state.now || new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const isBirdLegendary = score.total >= 950;
  applyEpicUi("bird", isBirdLegendary, barEl, badgeEl, dateKey, instant,
    "Legendary bird activity", "Bird activity right now is forecast well above normal - worth getting out there.", "meter-epic");
}

function renderAbout() {
  document.getElementById("about-content").innerHTML = `
    <p class="sub-stat" style="margin-bottom:20px;">This app makes two kinds of prediction: how good the light will be, and how active birds are likely to be. Both are built from real astronomy and real weather data, not guesses. Below is a plain-language rundown of every single thing that feeds into each number, so you know exactly what you're looking at and why.</p>

    <h3>Sun position &amp; twilight times</h3>
    <p>Sunrise, sunset, and the golden/blue hour windows are calculated directly from your coordinates and the current time using standard astronomy math (the Meeus solar position formula). No internet connection is needed for this part; it is pure geometry, so it is always exact for your exact spot on Earth.</p>

    <h3>Direction tab (compass)</h3>
    <p>A plain compass dial showing where the sun sits in the sky: altitude (height above the horizon; negative means it's below the horizon) and azimuth (compass bearing, 0-360 degrees clockwise from north). The needle points along that bearing so you can physically face the right direction before the light shows up. Drag the slider or use the date arrows to preview any time, or tap the clock icon to snap back to the live moment. This is intentionally a compass, not a street map. A real map needs a paid tile subscription that would either raise the price or add an ongoing cost this app isn't built to carry, so it sticks to the same offline astronomy math used everywhere else instead.</p>
    <p>The dial also marks where the sun will actually be: a sun-icon dot for sunrise and one for sunset, plus a short teal arc on each side spanning how much the bearing shifts during blue hour (nautical dawn to dawn at sunrise, dusk to nautical dusk at sunset). These track whichever day is shown, so paging the day arrows moves them too, and they're calculated the same way as everything else here - real solar position for that exact moment, not an approximation.</p>

    <h3>Live compass</h3>
    <p>Tap "Enable live compass" on the Direction tab and the whole dial turns to match which way your phone is physically pointing, using its compass sensor, instead of always showing north at the top. The sun's needle stays at its true bearing on the dial, so once you turn until the needle lines up with the fixed marker at the top of the dial, you're facing exactly where the sun sits. A small badge appears when you're lined up within about 8 degrees. This needs a phone with a compass sensor and a secure connection; iPhones will ask for a one-time permission tap (an Apple privacy requirement, not optional), and it does nothing at all on a desktop or laptop, which has no compass hardware to read.</p>

    <h3>Sunset/sunrise photo score</h3>
    <p>In the Shoot Log, adding a photo runs a color analysis entirely on your device: it downsamples the image, measures average color saturation and how much of it falls in warm orange/pink/red tones, and combines those into a 0-100 score on the same scale as the sunrise/sunset quality prediction above, so the two can be compared directly. That score pre-fills the "Light quality - actually" dropdown as a starting guess. <strong>Use the raw, unedited photo</strong> for this - a filtered or edited photo scores however it now looks after editing, not how the sky actually looked, since the analysis has no way to know a filter was applied.</p>
    <p>Be clear-eyed about what this is: a color heuristic, not scene recognition. It looks at the whole photo, not just the sky, so a shot with a lot of dark foreground, a bird, or branches in frame will score lower even if the sky itself was vivid, and a filtered or edited photo scores however it now looks. That's exactly why it only pre-fills a suggestion instead of writing straight into calibration; always check the pre-filled rating and correct it if it doesn't match what you actually saw before saving, since a wrong rating there would otherwise teach the app the wrong lesson.</p>

    <h3>Sunrise/sunset quality score (0-100%)</h3>
    <p>This predicts how colorful the sky is likely to look, not just whether the sun is up. Three real inputs go into it, all pulled from Open-Meteo's weather data for the exact hour of sunrise or sunset:</p>
    <p><strong>High and mid-level clouds:</strong> these are what actually catch sunlight and turn it into color. A moderate amount (roughly a third to half the sky) scores highest. A completely clear sky has nothing to light up, and a fully overcast sky blocks the show entirely, so both score lower.</p>
    <p><strong>Low clouds:</strong> these sit right on the horizon and block sunlight before it can reach anything, regardless of what the high and mid clouds are doing. More low cloud always pulls the score down.</p>
    <p><strong>Humidity:</strong> haze in humid air scatters and washes out color, so higher humidity quietly lowers the score.</p>
    <p><strong>Aerosol optical depth (AOD):</strong> a real measurement of how much smoke, dust, or general haze is suspended in the whole air column, from Open-Meteo's air quality model. Its effect is genuinely two-sided, not a simple penalty: a light-to-moderate amount actually tends to deepen sunset reds and oranges (this is why sunsets often look more dramatic downwind of wildfire smoke or a dust event), while a heavy load gets thick enough to flatten color into a murky haze instead. The Weather &amp; Exposure card shows the current AOD reading directly, alongside a plain-language note on which way it's pulling.</p>
    <p>This is the same basic approach dedicated sunset-prediction apps use, calculated here from the raw weather data instead of a hidden formula.</p>

    <h3>Golden Hour Intensity</h3>
    <p>A separate 0-100 score from the sunrise/sunset quality percentage above, because it measures something different: quality is about whether the sky itself shows color, which wants some cloud to catch the light. This score is about whether the direct, low-angle, warm sunlight is strong and unobstructed right now - the light actually used for exposure and white balance - which wants a clear sky in the sun's direction instead.</p>
    <p>It's only active while the sun's elevation is within the same -0.833&deg; to 6&deg; band already used for the golden hour times shown above, combining how centered the sun is in that window, how much total cloud cover is blocking direct light (steep falloff past ~30-60% cover), and the same aerosol effect described below. It also shows an estimated color temperature in Kelvin, from a simplified physical model of how atmospheric path length warms the direct beam as the sun gets lower - not a spectroradiometer reading, and it doesn't know the local aerosol mix, so treat it as a ballpark for white balance, not a certified one.</p>

    <h3>Legendary conditions badge</h3>
    <p>A score of 95 or higher gets a distinct "Legendary conditions" treatment on the Dashboard - a pulsing glow on the ring, a badge, and a one-time burst/sound when it's first detected for that sunrise or sunset - separate from the everyday "Great" label (75+). It's set noticeably higher on purpose: a 200,000-sample simulation of realistic cloud/humidity/aerosol combinations against this exact formula puts "Great" at roughly the top 9-10% of conditions, and 95+ narrower still - reserved for a small handful of truly exceptional evenings, not a regular occurrence. It's still reachable (textbook-ideal inputs hit 100). It still shows up on the 7-day Outlook too, as a small flame mark next to the score, without the animation.</p>

    <h3>Terrain (hills, ridges, bluffs nearby)</h3>
    <p>A cloud-only prediction assumes flat ground in every direction, which is wrong if you're near real hills or mountains. This app checks real elevation data around your sunrise and sunset direction and figures out if anything tall is in the way. If it finds a ridge, ridge line, or bluff, it shows you the actual time the sun disappears behind it or clears it, which can be noticeably different from the flat-ground time and directly affects how long you actually have usable light to shoot in.</p>
    <p>One thing this deliberately does not do: lower your color-quality score. Sky color develops from sunlight scattering through the atmosphere, which keeps happening whether or not a hill blocks your direct view of the sun itself. A mountain sunset is a different shot (silhouettes, layered light) but not a worse one for color.</p>

    <h3>Weather card</h3>
    <p>Everything on this card comes from <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>, a free public weather service (no paid subscription behind it), except air quality which comes from Open-Meteo's separate air quality service. Here's what each row means and why it's here:</p>
    <p><strong>Cloud cover:</strong> how much of the sky is covered.</p>
    <p><strong>Wind:</strong> current wind speed. Matters for handholding a long lens steady and is one of the inputs to the bird activity score.</p>
    <p><strong>Temperature:</strong> current air temperature. Extreme cold or heat both affect gear (batteries drain faster in cold) and bird behavior.</p>
    <p><strong>Humidity:</strong> current relative humidity, also used in the sunrise/sunset color score above.</p>
    <p><strong>UV index:</strong> how strong the sun's ultraviolet light is right now. Useful for knowing when harsh midday light will be hardest to work with, and for basic sun protection in the field.</p>
    <p><strong>Visibility:</strong> how far you can see through the air right now. Low visibility means haze or fog, which flattens color and contrast in photos even on an otherwise "clear" day.</p>
    <p><strong>Air quality (PM2.5):</strong> a measure of fine particle pollution in the air. Higher readings mean more atmospheric haze, which washes out sunset color and contrast the same way fog does, just from smoke or pollution instead of water vapor.</p>
    <h3>Barometer</h3>
    <p>Air pressure gets its own card because it's the one weather reading that actually feeds the bird activity score below, not just a sky description. "Current pressure" is today's reading, shown in inches of mercury (inHg) by default since that's what most US home barometers and weather reports use, with hectopascals (hPa) available as an option in Settings; for reference, average sea-level pressure is about 29.92 inHg (1013 hPa). "3-hour trend" compares right now to three hours ago, and it's this trend, not the raw number, that matters for bird behavior.</p>
    <p>A falling trend usually means a weather front is approaching, and birds tend to feed more aggressively beforehand to build up reserves, so the verdict reads "Falling" and activity tends to pick up. A sharply rising trend usually means a front just passed and things are settling into calm, stable air, so activity tends to quiet down for a while. Anything in between reads "Steady," meaning no strong signal either way.</p>

    <h3>Moon phase</h3>
    <p>Shown for reference (useful for planning night shoots and for context on nocturnal migration), calculated the same way as sun position, with no internet connection needed. It is intentionally NOT used to score bird activity below. The evidence connecting moonlight to daytime bird behavior isn't solid enough to build a number on, so rather than fake a connection, it's just shown as its own honest fact.</p>

    <h3>Bird activity meter (0-1000)</h3>
    <p>This is a probability estimate built from real, documented bird behavior research, not a live feed of actual birds seen near you. Think of it the way a weather forecast predicts rain: a real, evidence-based estimate that can still turn out wrong on any given day. The verdict text always says "model estimate" as a reminder of this. It's built from four ingredients:</p>
    <p><strong>1. Time of day.</strong> This is the foundation everything else adjusts, not just one input among equals. Birds are most active right around sunrise and sunset (the "dawn chorus" and evening feeding push), moderately active through the day with a well-documented midday slowdown, and mostly quiet at night. Weather and season below can only turn this base level up or down, never invent activity that wouldn't exist at that time of day.</p>
    <p><strong>2. Current weather.</strong> Several real effects are combined here: strong wind (birds shelter rather than fly or forage in wind above about 20 km/h/12 mph), active rain (suppresses flight and foraging), a burst of extra activity right after rain stops (rain brings worms and insects to the surface, which is a well-known trigger for ground-feeding birds like robins), reduced activity in dense fog (birds that rely on sight to forage or soar are hampered by poor visibility), and less of a midday slowdown on warm, overcast days (direct sun on a hot day drives birds to rest in shade, and cloud cover removes that pressure). During spring and fall migration, wind direction is also checked: a tailwind in the direction birds are migrating gives a boost, since wind support is one of the best-documented predictors of when birds choose to migrate.</p>
    <p><strong>3. Barometric pressure trend.</strong> Explained above in the Barometer section: falling pressure ahead of a front tends to increase foraging activity, sharply rising pressure after a front tends to quiet things down.</p>
    <p><strong>4. Season.</strong> Spring (April-May) and fall (September-October) get a boost for Northern Hemisphere migration season, when far more species are moving and overall activity is higher. Summer breeding season is moderately active. Winter is the lowest baseline, though this varies a lot by species and region.</p>
    <p>This model is tuned for birds that are active by day, like songbirds, woodpeckers, raptors, and waterfowl - it is not built for owls or other non-migratory nocturnal behavior, which is why the score never fully bottoms out to zero after dark outside migration season: it accounts for the fact that some nocturnal activity always exists, without pretending to predict it accurately.</p>
    <p>The one nocturnal exception: during the spring (roughly early April-late May) and fall (roughly early September-mid November) migration windows, the score adds a real night-time bump timed to when radar-tracked nocturnal migration traffic (the same signal Cornell's BirdCast is built on) typically peaks - a few hours after full dark, tapering off well before dawn. That's why an evening check well past sunset during migration season can score meaningfully higher than the same time of night the rest of the year.</p>

    <h3>Calibration: teaching the app your own results</h3>
    <p>Every prediction above is a general model. Calibration is what makes it start reflecting reality at your own locations. Here's how it works: every time you log a shoot, you can rate what the light and bird activity were actually like. The app compares your rating against exactly what it had predicted at that moment. Once you've rated at least 3 shoots, it works out the average difference between predicted and actual, and starts applying that difference as a correction to every future prediction. Light-quality corrections are capped at 25 percentage points either direction, and bird-activity corrections are capped at 300 points (out of 1000), so a handful of unusual days can't swing things too far.</p>
    <p>Delete a bad log entry and the correction recalculates immediately from whatever's left. The more you rate, the more this app's predictions become genuinely yours, learned from real outcomes at real places you actually shoot, instead of a one-size-fits-all model.</p>
  `;
}

// ---------- Log ----------
function loadLog() {
  try { return JSON.parse(localStorage.getItem(LS_LOG_KEY)) || []; }
  catch (e) { return []; }
}
function saveLog(entries) {
  localStorage.setItem(LS_LOG_KEY, JSON.stringify(entries));
  recomputeCalibration(entries);
}

// ---------- Calibration ----------
// Real calibration against logged outcomes, not a cosmetic disclaimer: every
// Shoot Log entry can optionally record what light/bird activity was
// actually like, alongside the prediction the model made at that moment.
// Once there are enough rated entries, the average signed error (actual
// score minus predicted score) becomes a correction applied to every future
// prediction - if this app has been reading 10 points low on light quality
// at your locations, it starts adding 10 points back before it ever bands a
// score into Poor/Fair/Good/Great. Delete a bad log entry and the
// correction recomputes from what's left; nothing is baked in permanently.
function loadCalibration() {
  try { return JSON.parse(localStorage.getItem(LS_CALIB_KEY)) || null; }
  catch (e) { return null; }
}
function recomputeCalibration(entries) {
  const lightPairs = entries.filter(e => typeof e.predictedLight === "number" && typeof e.actualLight === "number");
  const birdPairs = entries.filter(e => typeof e.predictedBird === "number" && typeof e.actualBird === "number");
  const calib = {
    light: { n: lightPairs.length, bias: 0 },
    bird: { n: birdPairs.length, bias: 0 }
  };
  if (lightPairs.length) {
    const sum = lightPairs.reduce((s, e) => s + (e.actualLight - e.predictedLight), 0);
    calib.light.bias = Math.max(-CALIB_MAX_LIGHT_CORRECTION, Math.min(CALIB_MAX_LIGHT_CORRECTION, sum / lightPairs.length));
  }
  if (birdPairs.length) {
    const sum = birdPairs.reduce((s, e) => s + (e.actualBird - e.predictedBird), 0);
    calib.bird.bias = Math.max(-CALIB_MAX_BIRD_CORRECTION, Math.min(CALIB_MAX_BIRD_CORRECTION, sum / birdPairs.length));
  }
  localStorage.setItem(LS_CALIB_KEY, JSON.stringify(calib));
  return calib;
}
function calibrateLightScore(rawScore) {
  const calib = loadCalibration();
  if (!calib || calib.light.n < CALIB_MIN_SAMPLES) return rawScore;
  return Math.max(0, Math.min(100, Math.round(rawScore + calib.light.bias)));
}
function calibrateBirdScore(rawScore) {
  const calib = loadCalibration();
  if (!calib || calib.bird.n < CALIB_MIN_SAMPLES) return rawScore;
  return Math.max(0, Math.min(1000, Math.round(rawScore + calib.bird.bias)));
}
function renderLog(highlightFirst) {
  const entries = loadLog();
  const tbody = document.querySelector("#log-table tbody");
  renderCalibStatus();
  if (entries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="color:var(--muted);text-align:center;padding:24px 0;">No shoots logged yet - conditions at the time of your next entry will be captured automatically.</td></tr>`;
    return;
  }
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
  tbody.innerHTML = entries.map((e, i) => `
    <tr class="${highlightFirst && i === 0 ? "is-new" : ""}">
      <td>${new Date(e.ts).toLocaleString()}</td>
      <td>${e.species}</td>
      <td>${e.gear || ""}</td>
      <td>${e.sunPhase || ""}</td>
      <td>${e.birdScore ?? ""}</td>
      <td>${cap(e.actualLightLabel)}</td>
      <td>${typeof e.photoScore === "number" ? e.photoScore + " (" + cap(e.photoTier) + ")" : ""}</td>
      <td>${cap(e.actualBirdLabel)}</td>
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

// Shown above the Shoot Log form so the calibration state (and what it takes
// to move it forward) is visible right where entries get logged, not buried
// in the Notes tab.
function renderCalibStatus() {
  const el = document.getElementById("calib-status");
  if (!el) return;
  const calib = loadCalibration() || { light: { n: 0, bias: 0 }, bird: { n: 0, bias: 0 } };
  const line = (label, c, scale) => {
    if (c.n === 0) return `${label}: no rated shoots yet.`;
    if (c.n < CALIB_MIN_SAMPLES) return `${label}: ${c.n}/${CALIB_MIN_SAMPLES} rated shoots logged - need ${CALIB_MIN_SAMPLES - c.n} more before correcting predictions.`;
    const dir = c.bias > 0.5 ? "low" : c.bias < -0.5 ? "high" : "on target";
    const mag = Math.abs(c.bias).toFixed(scale === 1000 ? 0 : 1);
    return `${label}: calibrated from ${c.n} rated shoots - predictions were running ${mag}${scale === 1000 ? " pts" : "%"} ${dir}${dir !== "on target" ? ", now corrected" : ""}.`;
  };
  el.innerHTML = `<div>${line("Light quality", calib.light, 100)}</div><div>${line("Bird activity", calib.bird, 1000)}</div>`;
}

function exportCsv() {
  const entries = loadLog();
  const header = ["timestamp", "species", "gear", "sun_phase", "bird_score", "predicted_light_pct", "actual_light", "photo_score", "photo_score_tier", "predicted_bird_score", "actual_bird", "notes"];
  const rows = entries.map(e => [
    new Date(e.ts).toISOString(), e.species, e.gear || "", e.sunPhase || "", e.birdScore ?? "",
    e.predictedLight ?? "", e.actualLightLabel || "", e.photoScore ?? "", e.photoTier || "",
    e.predictedBird ?? "", e.actualBirdLabel || "",
    (e.notes || "").replace(/"/g, '""')
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

// ---------- Sunset/sunrise photo scoring ----------
// A plain color-pixel heuristic, not real image recognition: it samples the
// whole photo (downscaled for speed), converts each pixel to HSL, and
// combines average color saturation with how much of the image falls in
// warm orange/pink/red hues into a single 0-100 score using the exact same
// scale as the sunrise/sunset quality prediction, so the two are directly
// comparable. It runs entirely on-device via the Canvas API - no photo ever
// leaves the phone or gets uploaded anywhere.
//
// Known blind spots, on purpose kept simple rather than pretending to be
// smarter than it is: a photo dominated by a dark foreground (branches, a
// bird in frame, a silhouette) pulls the score down even if the sky itself
// was vivid, since there's no attempt to detect and exclude non-sky pixels.
// A filtered/edited photo will score however it now looks, not how the sky
// actually looked. This is exactly why its result only pre-fills the rating
// dropdown instead of writing straight into calibration - a person confirms
// it before it can influence future predictions.
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}

function photoScoreToTier(score) {
  if (score >= 78) return "great";
  if (score >= 55) return "good";
  if (score >= 30) return "fair";
  return "poor";
}
const PHOTO_TIER_LABELS = { poor: "Mostly flat/gray sky", fair: "Muted color", good: "Colorful", great: "Vivid" };

// How much local pixel-to-pixel contrast an image has, 0-255ish scale -
// used below to guess whether a photo is plausibly a sky/sunset at all
// before trusting its color score. A sunset, an open sky, even a hazy or
// cloudy horizon is dominated by smooth, slow-changing gradients with very
// little edge detail; a face, a document, a room, an object close-up, a
// bird in frame, etc all have dramatically more local contrast. This is
// NOT real scene recognition - a badly out-of-focus or heavily blurred
// non-sky photo can still slip through - but it catches the ordinary case
// this app was actually seeing: an unrelated warm/saturated photo (a wood
// floor, a orange wall, a face in warm light) getting auto-scored as if it
// were a vivid sky just because the colors happened to be warm.
// Horizontal-only on purpose: a real sky gradient changes smoothly TOP TO
// BOTTOM (that's just what a sky does, sunrise or not) but stays essentially
// uniform LEFT TO RIGHT at any given height. Counting vertical differences
// as "detail" (an earlier version of this did) penalized every normal sky
// gradient right along with real texture, and got noticeably worse once the
// horizon-cropped region above started running close to the actual treeline
// - the natural color shift into haze near a horizon has real vertical
// change that isn't foreground detail. Horizontal variation within a row
// isn't part of a sky's normal behavior, so it's what's left to flag real
// texture (foliage, a face, text) without also flagging the sky being a sky.
function averageEdgeEnergy(lum, W, H) {
  let edgeSum = 0, edgeCount = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      edgeSum += Math.abs(lum[y * W + x] - lum[y * W + x + 1]);
      edgeCount++;
    }
  }
  return edgeCount ? edgeSum / edgeCount : 0;
}
// A global average alone missed real non-sky photos where most of the frame
// is smooth (a plain backdrop, a shirt, a wall) and the actual detail - a
// face's eyes/mouth/hairline, a collar line - only occupies a small part of
// it: averaged across the whole image that detail gets diluted below the
// global threshold even though it's obviously there. This walks a grid of
// small blocks and reports what FRACTION of them are individually busy,
// rather than just the single busiest one - a lone branch/leaf sprig poking
// into a corner of an otherwise real sky (common in nature framing) lights
// up one or two blocks and shouldn't fail the whole photo, but a face or a
// frame genuinely full of detail lights up many of them.
function busyBlockFraction(lum, W, H, cols, rows, perBlockThreshold) {
  let busy = 0, total = 0;
  const bw = Math.max(1, Math.floor(W / cols)), bh = Math.max(1, Math.floor(H / rows));
  for (let by = 0; by < H; by += bh) {
    for (let bx = 0; bx < W; bx += bw) {
      let sum = 0, n = 0;
      const yEnd = Math.min(H, by + bh), xEnd = Math.min(W - 1, bx + bw);
      for (let y = by; y < yEnd; y++) {
        for (let x = bx; x < xEnd; x++) {
          sum += Math.abs(lum[y * W + x] - lum[y * W + x + 1]);
          n++;
        }
      }
      if (n) {
        total++;
        if (sum / n > perBlockThreshold) busy++;
      }
    }
  }
  return total ? busy / total : 0;
}
// Tuned conservatively against real photo textures: even a busy, cloud-
// filled or textured sky stays well under this, while an ordinary
// non-sky subject (anything with edges, text, foliage detail, a face)
// sits well above it.
const SKY_EDGE_THRESHOLD = 8;
// A block counts as "busy" past this per-block horizontal edge value -
// higher than the whole-region average threshold since any single small
// block naturally reads noisier than a big average.
const BUSY_BLOCK_THRESHOLD = 10;
// A real sky, even a dramatic/patchy one, can still have ONE or two busy
// blocks (a branch tip or leaf sprig poking into a corner, common in nature
// framing) without actually being a non-sky photo. A face, a document, a
// frame genuinely full of detail lights up a much larger share of the grid.
const SKY_MAX_BUSY_FRACTION = 0.12;
// Skin-tone detection catches the case edge-energy alone can miss entirely:
// a smooth, evenly-lit portrait (studio lighting, a plain backdrop) where a
// face has almost no internal edge detail once downscaled, but is still
// obviously a face - not a sky - because of where its color sits and how
// it's arranged in the frame. A face is a blob concentrated toward the
// HORIZONTAL center (portraits are subject-centered left-to-right); a sky's
// color, even when it happens to pass through a skin-like hue somewhere in
// its gradient (a very normal blue-to-pink-to-peach sunset band), varies by
// VERTICAL position, not horizontal, so it shows up just as much toward the
// left/right edges as the center at any given height. Comparing left/right
// edge columns against center columns - across the SAME rows for both, so
// a sky's normal top-to-bottom color change never factors in - is what
// actually tells a face apart from a same-hued sky gradient band.
function skinBlobCheck(data, W, H) {
  const cx0 = Math.floor(W * 0.25), cx1 = Math.ceil(W * 0.75);
  let centerSkin = 0, centerTotal = 0, edgeSkin = 0, edgeTotal = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      const isSkin = h >= 4 && h <= 35 && s >= 0.15 && s <= 0.62 && l >= 0.25 && l <= 0.85;
      if (x >= cx0 && x < cx1) { centerTotal++; if (isSkin) centerSkin++; }
      else { edgeTotal++; if (isSkin) edgeSkin++; }
    }
  }
  const centerFrac = centerTotal ? centerSkin / centerTotal : 0;
  const edgeFrac = edgeTotal ? edgeSkin / edgeTotal : 0;
  return centerFrac >= 0.15 && centerFrac >= edgeFrac * 2.2;
}

// Finds where the actual sky stops and foreground detail (a treeline, tall
// grass/foliage, a horizon silhouette, a bird) starts, instead of assuming a
// fixed fraction of the frame. A fixed cutoff either clips real sky off a
// photo where foreground reaches unusually high in frame, or leaves too much
// foreground in when it doesn't - both produce wrong results. This scans
// row by row from the top and reads horizontal-only edge energy per row (a
// gradient sky row is smooth left-to-right even though it changes smoothly
// top-to-bottom; foliage/branches are busy left-to-right), stopping at the
// first row that's clearly no longer smooth.
const ROW_EDGE_CUTOFF = 6;
function findSkyBottom(lum, W, H) {
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = 0; x < W - 1; x++) sum += Math.abs(lum[y * W + x] - lum[y * W + x + 1]);
    if (sum / (W - 1) > ROW_EDGE_CUTOFF) return y;
  }
  return H;
}

function analyzeSunsetPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const W = 140, H = 94; // downscaled for speed, but not so far that real detail (a face, text, foliage) gets smoothed away into looking sky-flat
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, W, H);
        const data = ctx.getImageData(0, 0, W, H).data;

        // Full-frame luminance first (needed to find the horizon), and hue/
        // sat cached per pixel so the second pass over just the sky rows
        // doesn't recompute rgbToHsl.
        const lum = new Float32Array(W * H);
        const hueArr = new Float32Array(W * H);
        const satArr = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const { h, s } = rgbToHsl(r, g, b);
            hueArr[y * W + x] = h;
            satArr[y * W + x] = s;
            lum[y * W + x] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          }
        }

        // Sky vs. non-sky is judged only above the detected horizon, not the
        // whole photo. A huge share of real sunrise/sunset shots - basically
        // all wildlife/nature framing - put a detailed silhouette (branches,
        // grass, a treeline, a bird) across the BOTTOM of the frame under a
        // smooth sky above it, and that foreground can reach well over half
        // the frame height. Scanning the whole image, or even a fixed top
        // fraction, for "is there any real detail anywhere" rejected those
        // as if they were an ordinary detailed photo, when the actual sky
        // portion was a completely genuine, smooth gradient.
        const skyH = findSkyBottom(lum, W, H);

        let satSum = 0, warmCount = 0, count = 0;
        for (let y = 0; y < skyH; y++) {
          for (let x = 0; x < W; x++) {
            const idx = y * W + x;
            satSum += satArr[idx];
            // Widened to include violet/magenta (roughly 250-300), not just
            // orange-red-pink - a purple "alpenglow" dawn/dusk sky is a very
            // real, very photogenic sunrise/sunset color, and scoring it as
            // if it were an ordinary blue daytime sky just because it isn't
            // literally orange badly understated genuinely vivid photos.
            const isWarmHue = hueArr[idx] <= 40 || hueArr[idx] >= 250;
            if (isWarmHue && satArr[idx] >= 0.15) warmCount++;
            count++;
          }
        }
        // A real sky photo has a meaningfully sized clear region, not just a
        // sliver above someone's hairline or a shelf's edge - if detail
        // starts almost immediately, this was never a sky shot to begin with.
        const hasEnoughSky = skyH >= H * 0.22;
        const avgSaturation = count ? satSum / count : 0;
        const warmFraction = count ? warmCount / count : 0;
        const avgEdge = count ? averageEdgeEnergy(lum, W, skyH) : 999;
        const busyFraction = count ? busyBlockFraction(lum, W, skyH, 10, Math.max(2, Math.round(skyH / 12)), BUSY_BLOCK_THRESHOLD) : 1;
        const hasSkinBlob = count ? skinBlobCheck(data, W, skyH) : false;
        const looksLikeSky = hasEnoughSky && avgEdge < SKY_EDGE_THRESHOLD && busyFraction <= SKY_MAX_BUSY_FRACTION && !hasSkinBlob;

        const score = Math.max(0, Math.min(100, Math.round(avgSaturation * 55 + warmFraction * 45)));
        const tier = photoScoreToTier(score);
        URL.revokeObjectURL(url);
        resolve({
          score, tier, label: PHOTO_TIER_LABELS[tier],
          avgSaturationPct: Math.round(avgSaturation * 100),
          warmPct: Math.round(warmFraction * 100),
          looksLikeSky,
          avgEdge: Math.round(avgEdge * 10) / 10,
          busyFraction: Math.round(busyFraction * 1000) / 1000,
          skyFraction: Math.round((skyH / H) * 100) / 100,
          hasSkinBlob,
          previewUrl: canvas.toDataURL("image/jpeg", 0.7)
        });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image file")); };
    img.src = url;
  });
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
function saveGoodState(now, loc, weatherData, score, horizon, airQuality) {
  try {
    localStorage.setItem(LS_CACHE_KEY, JSON.stringify({ ts: now.getTime(), loc, weatherData, score, horizon, airQuality }));
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
// Shows/hides the unmissable "you're on the default location" banner. Every
// number on the dashboard IS correct for whatever coordinate is active -
// this exists because the coordinate itself silently staying at the Kansas
// fallback (GPS denied/no signal/timed out, nothing ever manually set) is
// what actually looked like "wrong data" - now it's surfaced instead of
// hidden behind normal-looking cards.
function syncDefaultLocBanner() {
  const banner = document.getElementById("default-loc-banner");
  if (!banner) return;
  banner.hidden = !isDefaultLocation(state.loc);
}

async function refreshAll(opts) {
  // Guard against overlapping fetches - a double-tap on Refresh, or the auto
  // -refresh timer landing mid-request, would otherwise fire two full
  // request chains and let whichever resolves last silently win.
  if (state.refreshing) return;
  state.refreshing = true;
  // Silent by default: the 5-minute auto-refresh timer, the midnight
  // day-rollover refresh, and a location search/GPS fix all call this same
  // function, and only an explicit tap on the Refresh Data button should
  // make a sound - otherwise the app chimes on its own in the background,
  // which is what was happening before this flag existed.
  const playSound = !!(opts && opts.manual);

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

    // Same non-blocking treatment as horizon - a real add, not a
    // requirement, so a slow/unavailable air-quality service never holds up
    // the rest of the dashboard.
    let airQuality = null;
    try {
      airQuality = await fetchAirQuality(loc);
    } catch (err) {
      console.warn("Air quality lookup failed:", err);
    }
    state.airQuality = airQuality;

    // re-render with the location's real UTC offset now that we have it
    const instant = !playSound;
    let score;
    withSilentRefreshFx(instant, () => {
      renderSun(loc, now, sunToday, sunTomorrow, weatherData.utc_offset_seconds, horizon);
      renderTodayQuality(sunToday.times, weatherData, horizon, airQuality, instant);
      renderGoldenHour(loc, now, sunToday.elevationDeg, weatherData, airQuality, sunToday.times, sunTomorrow.times);
      renderOutlook(loc, weatherData, horizon, airQuality);
      renderWeather(sunToday, weatherData, airQuality);

      score = computeBirdScore(now, sunToday.times, weatherData, sunToday.elevationDeg);
      state.birdScore = score;
      renderBird(score, instant);
    });

    setStaleBanner(false);
    saveGoodState(now, loc, weatherData, score, horizon, airQuality);
    if (playSound) feedbackRefreshDone();
    fireShutterFlash(playSound);
    // Every card gets its own tier-colored burst on a real refresh now, not
    // just the bird meter - each guarded by fireParticleBurst's own
    // hidden-element check, so a card that isn't the active tab (Outlook,
    // Direction) just silently skips its burst instead of firing one at a
    // stray 0,0 position. Kept at a smaller particle count than the bird
    // meter's signature 14 so five-plus simultaneous bursts read as a
    // coordinated flourish rather than clutter. Gated to a real
    // user-triggered refresh only - a silent background refresh should be
    // completely undetectable, not throw confetti at whatever tab happens
    // to be open.
    if (playSound) {
      fireParticleBurst(document.getElementById("bird-fill"), colorForTier(score.tier));
      fireParticleBurst(document.getElementById("ring-sunrise"), qualityColor(state.qSunrise ? state.qSunrise.label : "Poor"), 9);
      fireParticleBurst(document.getElementById("ring-sunset"), qualityColor(state.qSunset ? state.qSunset.label : "Poor"), 9);
      const goldSwatchColor = document.getElementById("golden-cct-swatch").style.background || "#c17a52";
      fireParticleBurst(document.getElementById("golden-fill"), goldSwatchColor, 9);
      const barometerTierClass = [...document.getElementById("barometer-verdict").classList].find(c => c.startsWith("tier-"));
      fireParticleBurst(document.getElementById("barometer-verdict"), colorForTier(barometerTierClass ? barometerTierClass.slice(5) : ""), 9);
      fireParticleBurst(document.querySelector("#card-weather h2"), "#1f6b5c", 9);
      document.querySelectorAll(".grid .card").forEach(popEl);
    }

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
      withSilentRefreshFx(!playSound, () => {
        renderSun(loc, now, sunToday, sunTomorrow, cached.weatherData.utc_offset_seconds, cached.horizon);
        renderTodayQuality(sunToday.times, cached.weatherData, cached.horizon, cached.airQuality, !playSound);
        renderGoldenHour(loc, now, sunToday.elevationDeg, cached.weatherData, cached.airQuality, sunToday.times, sunTomorrow.times);
        renderOutlook(loc, cached.weatherData, cached.horizon, cached.airQuality);
        renderWeather(sunToday, cached.weatherData);
        renderBird(cached.score, !playSound);
      });
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

  // Live-updates the heuristic score between fetches - it's time-of-day
  // driven, so it should track the clock.
  if (state.weather) {
    const score = computeBirdScore(now, sunToday.times, state.weather, sunToday.elevationDeg);
    state.birdScore = score;
    renderBird(score, true); // per-second clock tick, never animated
  }
  // Elevation moves every second; weather/aerosol only refresh every few
  // minutes, so re-run the intensity calc on every tick using whatever
  // weather/air-quality data is already cached, rather than waiting on the
  // next full refresh to reflect the sun having climbed or dropped.
  const tomorrow = new Date(now.getTime() + 86400000);
  renderGoldenHour(loc, now, sunToday.elevationDeg, state.weather, state.airQuality, sunToday.times, computeSun(loc, tomorrow).times);

  document.getElementById("live-clock-text").textContent =
    "Live - " + now.toLocaleTimeString() + (state.weather ? "" : " (weather offline)");

  // Keeps the Direction tab's needle/readouts current even while it isn't
  // the visible tab, so switching to it never shows a stale moment - cheap,
  // since it's the same solar-position call already made above.
  if (state.direction.mode === "live") renderDirection();

  // Keeps the Shoot Log's rating dropdowns tracking the live prediction
  // while the tab sits open (e.g. someone has it up while waiting for
  // golden hour) - autoFillLogRatings() itself is a no-op for any dropdown
  // the person has already touched or set.
  autoFillLogRatings();
}

function showWeatherUnavailable() {
  setStaleBanner(false);
  document.querySelector("#weather-table tbody").innerHTML = "";
  document.getElementById("q-sunrise").textContent = "--";
  document.getElementById("q-sunset").textContent = "--";
  document.getElementById("q-sunrise-label").textContent = "n/a";
  document.getElementById("q-sunset-label").textContent = "n/a";
  document.getElementById("q-sunrise-note").textContent = "";
  document.getElementById("q-sunset-note").textContent = "";
  document.getElementById("ring-sunrise").classList.remove("ring-epic");
  document.getElementById("ring-sunset").classList.remove("ring-epic");
  document.getElementById("epic-badge-sunrise").setAttribute("hidden", "");
  document.getElementById("epic-badge-sunset").setAttribute("hidden", "");
  document.getElementById("golden-verdict").textContent = "--";
  document.getElementById("golden-verdict").className = "big-stat verdict-line";
  document.getElementById("golden-sub").textContent = "--";
  document.getElementById("golden-score").textContent = "--";
  document.getElementById("golden-fill").style.width = "0%";
  document.getElementById("golden-cct").textContent = "Color temp: --";
  document.getElementById("golden-cct-swatch").style.background = "#e8e8e8";
  document.getElementById("golden-note").textContent = "";
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
    `${state.loc.placeName || state.loc.label || "Custom"} (${state.loc.lat.toFixed(4)}, ${state.loc.lon.toFixed(4)})`;
  updateTopLocationBar();
}

function updateTopLocationBar() {
  const el = document.getElementById("top-location-text");
  if (!el || !state.loc) return;
  el.textContent = state.loc.placeName || state.loc.label || `${state.loc.lat.toFixed(2)}, ${state.loc.lon.toFixed(2)}`;
}

// Free, no-key, CORS-friendly reverse geocoding (BigDataCloud's client-side
// endpoint) so "GPS" or a typed lat/lon turns into an actual place name up
// top instead of raw coordinates. Best-effort only: on failure or offline it
// just leaves the coordinate-based label in place, since nothing else in the
// app depends on this succeeding.
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const res = await fetchWithTimeout(url, {}, 5000);
    if (!res.ok) return null;
    const data = await res.json();
    const city = data.city || data.locality || data.localityInfo?.administrative?.[3]?.name;
    const region = data.principalSubdivisionCode ? data.principalSubdivisionCode.split("-").pop() : data.principalSubdivision;
    if (!city && !region) return null;
    return [city, region].filter(Boolean).join(", ");
  } catch (e) {
    return null; // offline or blocked - fall back silently to coordinates
  }
}

async function refreshPlaceName() {
  if (!state.loc) return;
  const name = await reverseGeocode(state.loc.lat, state.loc.lon);
  if (name && state.loc) {
    state.loc.placeName = name;
    saveLocation(state.loc);
    setLocationLabel();
  }
}

// Forward geocoding (place name -> coordinates) via Open-Meteo's own free,
// no-key geocoding endpoint - already trusted elsewhere in this app for
// weather data, so no new third party to depend on. Returns the best match
// or null; the caller falls back to the "enter coordinates" error message.
async function geocodePlaceName(query) {
  const hits = await geocodePlaceNameMulti(query, 1);
  return hits[0] || null;
}

// Same endpoint, but returns up to `count` matches for the autocomplete
// dropdown instead of just the single best guess.
async function geocodePlaceNameMulti(query, count) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=${count}&language=en&format=json`;
    const res = await fetchWithTimeout(url, {}, 6000);
    if (!res.ok) return [];
    const data = await res.json();
    const results = (data && data.results) || [];
    return results.map(hit => {
      const parts = [hit.name, hit.admin1, hit.country].filter(Boolean);
      return { lat: hit.latitude, lon: hit.longitude, placeName: parts.slice(0, 2).join(", "), country: hit.country || "" };
    });
  } catch (e) {
    return [];
  }
}

// ---------- Wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  state.loc = loadLocation();
  setLocationLabel();
  syncDefaultLocBanner();
  if (!state.loc.placeName && (state.loc.label === "GPS" || state.loc.label === "Custom")) refreshPlaceName();
  renderAbout();
  renderLog();

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
    state.airQuality = cachedOnLoad.airQuality;
    renderSun(state.loc, now0, sunToday0, null, cachedOnLoad.weatherData.utc_offset_seconds, cachedOnLoad.horizon);
    renderTodayQuality(sunToday0.times, cachedOnLoad.weatherData, cachedOnLoad.horizon, cachedOnLoad.airQuality);
    renderGoldenHour(state.loc, now0, sunToday0.elevationDeg, cachedOnLoad.weatherData, cachedOnLoad.airQuality, sunToday0.times, null);
    renderOutlook(state.loc, cachedOnLoad.weatherData, cachedOnLoad.horizon, cachedOnLoad.airQuality);
    renderWeather(sunToday0, cachedOnLoad.weatherData, cachedOnLoad.airQuality);
    renderBird(cachedOnLoad.score);
    const ageMin = Math.round((now0.getTime() - cachedOnLoad.ts) / 60000);
    setStaleBanner(true, `Loading... showing cached data from ${ageMin < 1 ? "under a minute" : ageMin + " min"} ago until it refreshes.`);
  }

  refreshAll();
  liveTick();

  // Default-location banner: visible and unmissable any time the app is
  // still sitting on the Kansas center-of-US fallback, not just after a
  // failed silent attempt. This is what was missing before - GPS could fail
  // (denied, no signal, timed out) with zero UI, leaving current temp,
  // today's high/low, barometer, and everything else correctly computed for
  // Kansas while reading as "wrong" to someone looking at Fort Collins data.
  syncDefaultLocBanner();

  // Auto-attempt GPS on every launch as long as the active location is still
  // the default fallback (not just on the very first-ever launch) - so
  // granting permission later, or getting signal back, is picked up on the
  // next reload without the user having to remember to tap "Use GPS"
  // themselves. A returning user's own saved/custom/GPS location is never
  // overridden by this. Denied/unsupported/timed out surfaces a real,
  // visible message instead of failing silently.
  if (isDefaultLocation(state.loc) && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        applyLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: "GPS" });
        refreshPlaceName();
      },
      err => {
        setLocStatus("Couldn't auto-set your location from GPS (" + err.message + "). Tap \"Use GPS\" above, or type your town/city and hit Set.", "is-error");
        syncDefaultLocBanner();
      },
      { timeout: 8000 }
    );
  }

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
        if (state.weather && state.sunTimes) renderWeather(state.sunTimes, state.weather, state.airQuality);
      });
    });
  }

  const windUnitToggle = document.getElementById("wind-unit-toggle");
  if (windUnitToggle) {
    const savedUnit = loadWindUnit();
    windUnitToggle.querySelectorAll(".map-layer-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.unit === savedUnit);
      btn.addEventListener("click", () => {
        saveWindUnit(btn.dataset.unit);
        windUnitToggle.querySelectorAll(".map-layer-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        if (state.weather && state.sunTimes) renderWeather(state.sunTimes, state.weather, state.airQuality);
      });
    });
  }

  const pressureUnitToggle = document.getElementById("pressure-unit-toggle");
  if (pressureUnitToggle) {
    const savedUnit = loadPressureUnit();
    pressureUnitToggle.querySelectorAll(".map-layer-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.unit === savedUnit);
      btn.addEventListener("click", () => {
        savePressureUnit(btn.dataset.unit);
        pressureUnitToggle.querySelectorAll(".map-layer-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        // Two places show a pressure reading: the Barometer card (via
        // renderWeather) and the bird-factors "Pressure trend" tile (only
        // refreshed through a bird-score recompute, same as the live clock
        // tick) - both need to re-render for the unit switch to take
        // effect everywhere at once, not just on the next full refresh.
        if (state.weather && state.sunTimes) renderWeather(state.sunTimes, state.weather, state.airQuality);
        if (state.weather) liveTick();
      });
    });
  }

  const autoRefreshToggle = document.getElementById("autorefresh-toggle");
  if (autoRefreshToggle) {
    const savedOn = loadAutoRefreshEnabled();
    autoRefreshToggle.querySelectorAll(".map-layer-btn").forEach(btn => {
      btn.classList.toggle("active", (btn.dataset.autorefresh === "on") === savedOn);
      btn.addEventListener("click", () => {
        const on = btn.dataset.autorefresh === "on";
        saveAutoRefreshEnabled(on);
        autoRefreshToggle.querySelectorAll(".map-layer-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });
  }

  const clearCacheBtn = document.getElementById("clear-cache-btn");
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", () => {
      localStorage.removeItem(LS_CACHE_KEY);
      setLocStatus2("Cached dashboard data cleared - pulling a fresh reading now.");
      refreshAll({ manual: true });
    });
  }
  function setLocStatus2(text) {
    const el = document.getElementById("settings-status");
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(setLocStatus2._t);
    setLocStatus2._t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // Splash is pure CSS (fades itself out via animation-fill-mode), but pull
  // it out of the layout/tab order once it's done so it can't intercept
  // anything or confuse a screen reader.
  const splash = document.getElementById("intro-splash");
  if (splash) splash.addEventListener("animationend", () => splash.remove());

  const tabOrder = Array.from(document.querySelectorAll(".tab-btn")).map(b => b.dataset.tab);
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      feedbackTap();
      const fromIdx = tabOrder.indexOf(document.querySelector(".tab-btn.active").dataset.tab);
      const toIdx = tabOrder.indexOf(btn.dataset.tab);
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active", "dir-fwd", "dir-back"));
      btn.classList.add("active");
      const panel = document.getElementById(btn.dataset.tab);
      panel.classList.add("active", toIdx >= fromIdx ? "dir-fwd" : "dir-back");
      if (btn.dataset.tab === "direction") renderDirection();
      if (btn.dataset.tab === "log") autoFillLogRatings();
    });
  });

  wireDirectionTab();
  wireLiveCompassButton();
  wireManualCompassMark();

  // Tactile feedback (haptic buzz + tap tone + ink ripple) on every button
  // that doesn't already have its own bespoke feedback wired below.
  // Delegated, so this one call covers every button in the app - present
  // now and anything rebuilt/added later (log table rows, Outlook rows,
  // the manual compass mark's Clear button, etc) - without needing a
  // second call anywhere else.
  wireTactileFeedback("button");
  wireChangeHaptics("select, input[type=range]");

  // A soft key-tick on every text field, not just buttons - "keydown" rather
  // than "input" so it fires on backspace/delete too, and skips modifier-only
  // presses (Tab, Shift, arrow keys) so navigating a field doesn't clack.
  document.querySelectorAll('input[type="text"]').forEach(input => {
    input.addEventListener("keydown", (e) => {
      if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete" || e.key === "Enter") {
        feedbackKeyTick();
      }
    });
  });

  const soundToggle = document.getElementById("sound-fx-toggle");
  if (soundToggle) {
    const savedOn = loadSoundEnabled();
    soundToggle.querySelectorAll(".map-layer-btn").forEach(btn => {
      btn.classList.toggle("active", (btn.dataset.sound === "on") === savedOn);
      btn.addEventListener("click", () => {
        const on = btn.dataset.sound === "on";
        saveSoundEnabled(on);
        soundToggle.querySelectorAll(".map-layer-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        haptic(on ? [8, 20, 8] : 10);
        if (on) playTone(700, 0.07, 0.05); // audible confirmation the instant sound is turned back on
      });
    });
  }

  // Device notification opt-in. Requesting Notification permission needs a
  // real user gesture (this click), and can be refused/revoked by the OS at
  // any time - so "Enable" always re-checks/re-requests rather than trusting
  // a stale saved "on" state, and the toggle honestly reflects whatever the
  // browser actually granted, not just what was clicked.
  const epicToggle = document.getElementById("epic-alerts-toggle");
  const epicStatusEl = document.getElementById("epic-alerts-status");
  function setEpicAlertsStatus(text, kind) {
    if (!epicStatusEl) return;
    epicStatusEl.textContent = text || "";
    epicStatusEl.classList.remove("is-error", "is-ok");
    if (kind) epicStatusEl.classList.add(kind);
    epicStatusEl.hidden = !text;
  }
  function syncEpicToggleUi() {
    if (!epicToggle) return;
    const on = loadEpicAlertsEnabled() && "Notification" in window && Notification.permission === "granted";
    epicToggle.querySelectorAll(".map-layer-btn").forEach(b => {
      b.classList.toggle("active", (b.dataset.alerts === "on") === on);
    });
  }
  if (epicToggle) {
    syncEpicToggleUi();
    epicToggle.querySelectorAll(".map-layer-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const wantsOn = btn.dataset.alerts === "on";
        if (!wantsOn) {
          saveEpicAlertsEnabled(false);
          syncEpicToggleUi();
          setEpicAlertsStatus("");
          return;
        }
        if (!("Notification" in window)) {
          setEpicAlertsStatus("This browser doesn't support notifications.", "is-error");
          syncEpicToggleUi();
          return;
        }
        if (Notification.permission === "granted") {
          saveEpicAlertsEnabled(true);
          syncEpicToggleUi();
          setEpicAlertsStatus("Legendary alerts on - you'll get a notification even if the app isn't open.", "is-ok");
          return;
        }
        if (Notification.permission === "denied") {
          saveEpicAlertsEnabled(false);
          syncEpicToggleUi();
          setEpicAlertsStatus("Notifications are blocked for this app in your browser/OS settings - allow them there, then try again.", "is-error");
          return;
        }
        Notification.requestPermission().then(result => {
          const granted = result === "granted";
          saveEpicAlertsEnabled(granted);
          syncEpicToggleUi();
          setEpicAlertsStatus(granted
            ? "Legendary alerts on - you'll get a notification even if the app isn't open."
            : "Permission wasn't granted, so legendary alerts stayed off.", granted ? "is-ok" : "is-error");
        });
      });
    });
  }

  document.getElementById("refresh-btn").addEventListener("click", () => refreshAll({ manual: true }));

  // Feedback for the location search lives right at the search box itself
  // (#loc-status, in the header) rather than the old #status-msg, which sits
  // far down the Dashboard tab and is invisible from every other tab - that
  // mismatch was why setting a location could look like it silently did
  // nothing even when it worked.
  function setLocStatus(text, kind) {
    const el = document.getElementById("loc-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("is-error", "is-ok");
    if (kind) el.classList.add(kind);
    el.hidden = !text;
  }

  async function applyLocation(loc) {
    state.loc = loc;
    saveLocation(state.loc);
    setLocationLabel();
    await refreshAll();
    syncDefaultLocBanner();
    // Confirm the fetch actually landed, right at the search box, then let
    // the message fade rather than sit there permanently.
    const label = loc.placeName || `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`;
    setLocStatus(`Showing data for ${label}.`, "is-ok");
    clearTimeout(applyLocation._clearTimer);
    applyLocation._clearTimer = setTimeout(() => setLocStatus("", null), 4000);
  }

  function requestGps(onDone) {
    hideSuggestions();
    if (!navigator.geolocation) {
      setLocStatus("Geolocation not supported in this browser.", "is-error");
      return;
    }
    setLocStatus("Getting GPS position...", null);
    navigator.geolocation.getCurrentPosition(pos => {
      applyLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: "GPS" });
      refreshPlaceName();
      setLocStatus("Location set from GPS. Fetching data...", "is-ok");
      if (onDone) onDone(true);
    }, err => {
      setLocStatus("GPS error: " + err.message + ". Try again, or type your town/city and hit Set.", "is-error");
      if (onDone) onDone(false);
    });
  }

  async function handleSetLocation() {
    const input = document.getElementById("loc-input");
    const val = input.value.trim();
    if (!val) return;
    hideSuggestions();
    const parts = val.split(",").map(s => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      applyLocation({ lat: parts[0], lon: parts[1], label: "Custom" });
      refreshPlaceName();
      setLocStatus(`Location set to ${parts[0].toFixed(4)}, ${parts[1].toFixed(4)}. Fetching data...`, "is-ok");
      return;
    }
    // Not coordinates - treat it as a place name (a town, city, park) and
    // look it up. Loading state matters here since a name lookup is a real
    // network round-trip, unlike the instant coordinate path above.
    setLocStatus(`Looking up "${val}"...`, null);
    const hit = await geocodePlaceName(val);
    if (hit) {
      input.value = hit.placeName;
      applyLocation({ lat: hit.lat, lon: hit.lon, label: "Custom", placeName: hit.placeName });
      setLocStatus(`Set to ${hit.placeName}. Fetching data...`, "is-ok");
    } else {
      setLocStatus(`Couldn't find "${val}" - try a town/city name, or coordinates as: lat, lon`, "is-error");
    }
  }
  document.getElementById("set-loc").addEventListener("click", handleSetLocation);

  // ---- Town-name autocomplete ----
  // Debounced search-as-you-type against the same free Open-Meteo geocoder,
  // so picking a suggestion is one click instead of typing the exact name
  // and hoping the lookup matches.
  let suggestTimer = null;
  let currentSuggestions = [];
  let activeSuggestionIdx = -1;
  const suggestBox = document.getElementById("loc-suggestions");

  function hideSuggestions() {
    if (!suggestBox) return;
    suggestBox.hidden = true;
    suggestBox.innerHTML = "";
    currentSuggestions = [];
    activeSuggestionIdx = -1;
  }

  function renderSuggestions(hits) {
    if (!suggestBox) return;
    currentSuggestions = hits;
    activeSuggestionIdx = -1;
    if (!hits.length) { hideSuggestions(); return; }
    suggestBox.innerHTML = hits.map((hit, i) =>
      `<button type="button" class="loc-suggestion" data-idx="${i}">${hit.placeName}</button>`
    ).join("");
    suggestBox.hidden = false;
    suggestBox.querySelectorAll(".loc-suggestion").forEach(btn => {
      btn.addEventListener("click", () => chooseSuggestion(parseInt(btn.dataset.idx, 10)));
    });
  }

  function chooseSuggestion(idx) {
    const hit = currentSuggestions[idx];
    if (!hit) return;
    const input = document.getElementById("loc-input");
    input.value = hit.placeName;
    hideSuggestions();
    applyLocation({ lat: hit.lat, lon: hit.lon, label: "Custom", placeName: hit.placeName });
    setLocStatus(`Set to ${hit.placeName}. Fetching data...`, "is-ok");
  }

  const locInputEl = document.getElementById("loc-input");
  locInputEl.addEventListener("input", () => {
    const val = locInputEl.value.trim();
    clearTimeout(suggestTimer);
    // Coordinates typed directly don't need place-name suggestions.
    if (!val || /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(val)) { hideSuggestions(); return; }
    if (val.length < 2) { hideSuggestions(); return; }
    suggestTimer = setTimeout(async () => {
      const hits = await geocodePlaceNameMulti(val, 5);
      // Guard against a slow, stale response landing after the user kept typing.
      if (locInputEl.value.trim() === val) renderSuggestions(hits);
    }, 300);
  });
  locInputEl.addEventListener("keydown", (e) => {
    if (!suggestBox || suggestBox.hidden) {
      if (e.key === "Enter") { e.preventDefault(); handleSetLocation(); }
      return;
    }
    const items = suggestBox.querySelectorAll(".loc-suggestion");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeSuggestionIdx = Math.min(activeSuggestionIdx + 1, items.length - 1);
      items.forEach((it, i) => it.classList.toggle("is-active", i === activeSuggestionIdx));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeSuggestionIdx = Math.max(activeSuggestionIdx - 1, 0);
      items.forEach((it, i) => it.classList.toggle("is-active", i === activeSuggestionIdx));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeSuggestionIdx >= 0) chooseSuggestion(activeSuggestionIdx);
      else handleSetLocation();
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });
  document.addEventListener("click", (e) => {
    if (suggestBox && !suggestBox.hidden && !suggestBox.contains(e.target) && e.target !== locInputEl) hideSuggestions();
  });

  // Sun & Light ring click-to-expand: same explainQuality() breakdown the
  // Outlook rows use, just wired to the live dashboard's two rings instead
  // of a forecast day. Bound once here (not inside renderTodayQuality,
  // which reruns on every refresh/tick) so the open/closed state a user
  // left it in survives a background data refresh.
  ["sunrise", "sunset"].forEach(kind => {
    const btn = document.getElementById("ring-toggle-" + kind);
    const detail = document.getElementById("ring-detail-" + kind);
    const note = document.getElementById("q-" + kind + "-note");
    if (!btn || !detail) return;
    btn.addEventListener("click", () => {
      const isOpen = !detail.hidden;
      detail.hidden = isOpen;
      // The short terrain/aerosol note is part of "why is this score what
      // it is" too - it stays hidden alongside the full breakdown until the
      // ring is tapped, rather than always showing by default.
      if (note) note.hidden = isOpen;
      btn.setAttribute("aria-expanded", String(!isOpen));
      btn.classList.toggle("is-open", !isOpen);
    });
  });

  document.getElementById("use-gps").addEventListener("click", () => requestGps());
  const bannerGpsBtn = document.getElementById("default-loc-gps-btn");
  if (bannerGpsBtn) bannerGpsBtn.addEventListener("click", () => requestGps());

  // Whichever of today's sun events (sunrise or sunset) is closer to right
  // now is the one the log entry's "actual light" rating should be judged
  // against - that's the prediction that was actually live at shoot time.
  function nearestPredictedLight() {
    const q = nearestSunQ();
    return q ? q.rawScore : null;
  }

  function setLogStatus(text, kind) {
    const el = document.getElementById("log-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("is-error", "is-ok");
    if (kind) el.classList.add(kind);
    el.hidden = !text;
    clearTimeout(setLogStatus._t);
    if (text) setLogStatus._t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  const lightSelectEl = document.getElementById("log-actual-light");
  const birdSelectEl = document.getElementById("log-actual-bird");
  if (lightSelectEl) lightSelectEl.addEventListener("change", () => { state.logTouched.light = true; });
  if (birdSelectEl) birdSelectEl.addEventListener("change", () => { state.logTouched.bird = true; });
  autoFillLogRatings();

  let pendingPhotoScore = null; // set by the photo-analysis handler below, consumed and cleared on next log submit

  const photoInput = document.getElementById("log-photo-input");
  const photoRemoveBtnHtml = `<button type="button" class="photo-remove-btn" id="photo-remove-btn" aria-label="Remove photo">&times;</button>`;

  // Wipes a selected/analyzed photo back to nothing - for an accidental
  // upload, or after "that's not a sky photo" below. Also un-does the
  // photo's own auto-fill of the light rating (if it set one), falling
  // back to the normal weather-prediction auto-fill instead of leaving a
  // wrong photo-derived rating sitting in the dropdown.
  function clearPendingPhoto() {
    pendingPhotoScore = null;
    if (photoInput) photoInput.value = "";
    const resultEl = document.getElementById("photo-score-result");
    if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ""; }
    state.logTouched.light = false;
    autoFillLogRatings();
  }

  if (photoInput) {
    photoInput.addEventListener("change", () => {
      const file = photoInput.files && photoInput.files[0];
      const resultEl = document.getElementById("photo-score-result");
      if (!file || !resultEl) return;
      resultEl.hidden = false;
      resultEl.innerHTML = `<span class="photo-score-text">Analyzing photo...</span>`;
      analyzeSunsetPhoto(file).then(result => {
        if (!result.looksLikeSky) {
          // Doesn't look like a sky/sunset photo at all (too much local
          // detail/contrast for a smooth sky gradient) - don't trust its
          // color reading enough to auto-fill a rating from it. Leaves
          // whatever rating was already there (the weather prediction, or
          // nothing) untouched rather than silently mis-scoring an
          // unrelated photo.
          pendingPhotoScore = null;
          resultEl.innerHTML = `
            <img src="${result.previewUrl}" alt="">
            <span class="photo-score-text">This doesn't look like a sky/sunset photo, so it wasn't used to rate anything - pick a rating manually if you'd like.</span>
            ${photoRemoveBtnHtml}
          `;
          return;
        }
        pendingPhotoScore = result;
        // Breakdown of exactly how the 0-100 number was built, not just the
        // final tier - saturation and warm-hue fraction are weighted 55/45,
        // so showing both pieces (and the sky region they were measured
        // over) is what turns "trust me" into something you can actually
        // check against the photo yourself.
        const satPts = Math.round(result.avgSaturationPct / 100 * 55);
        const warmPts = Math.round(result.warmPct / 100 * 45);
        resultEl.innerHTML = `
          <img src="${result.previewUrl}" alt="">
          <span class="photo-score-text">Detected: <strong>${result.label}</strong> (${result.score}/100) &mdash; pre-filled the rating below, change it if it doesn't look right.
            <details class="photo-score-breakdown">
              <summary>How this number was calculated</summary>
              <ul>
                <li>Sky region analyzed: top ${Math.round(result.skyFraction * 100)}% of the frame (below that was treated as foreground)</li>
                <li>Color saturation: ${result.avgSaturationPct}% &rarr; ${satPts}/55 pts</li>
                <li>Warm sunset/sunrise hue (orange through violet): ${result.warmPct}% of that region &rarr; ${warmPts}/45 pts</li>
                <li>Total: ${satPts} + ${warmPts} = ${result.score}/100</li>
              </ul>
            </details>
          </span>
          ${photoRemoveBtnHtml}
        `;
        const lightSelect = document.getElementById("log-actual-light");
        if (lightSelect) { lightSelect.value = result.tier; state.logTouched.light = true; }
      }).catch(() => {
        resultEl.innerHTML = `<span class="photo-score-text">Couldn't read that photo - try a different file.</span>${photoRemoveBtnHtml}`;
        pendingPhotoScore = null;
      });
    });
  }
  // Delegated (the remove button is added/removed with resultEl's innerHTML
  // above, so it doesn't exist yet at wiring time).
  document.addEventListener("click", (e) => {
    if (e.target.closest("#photo-remove-btn")) clearPendingPhoto();
  });

  document.getElementById("log-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const species = document.getElementById("log-species").value.trim();
    const actualLightKey = document.getElementById("log-actual-light").value;
    const actualBirdKey = document.getElementById("log-actual-bird").value;
    // A quick "just rate the sunset/bird activity" entry, with none of the
    // species/gear/notes/photo detail filled in, is a completely valid log
    // entry on its own - it still feeds calibration - so the only thing that
    // blocks a submit is having literally nothing to log at all. That used
    // to fail completely silently (tap Add Entry, nothing visibly happens),
    // which reads as a broken button - now it says why.
    if (!species && !actualLightKey && !actualBirdKey) {
      setLogStatus("Pick a rating, or add a species/note below, before saving.", "is-error");
      return;
    }
    const entries = loadLog();
    const entry = {
      ts: Date.now(),
      species: species || "(rating only)",
      gear: document.getElementById("log-gear").value.trim(),
      notes: document.getElementById("log-notes").value.trim(),
      sunPhase: state.lastPhase || "",
      birdScore: state.birdScore ? state.birdScore.total : ""
    };
    if (pendingPhotoScore) {
      entry.photoScore = pendingPhotoScore.score;
      entry.photoTier = pendingPhotoScore.tier;
    }
    // Only entries with BOTH a prediction and a rating feed calibration -
    // predictedLight/predictedBird use the model's raw (uncalibrated) output
    // so an existing correction never gets baked into computing the next one.
    if (actualLightKey) {
      const predicted = nearestPredictedLight();
      entry.actualLightLabel = actualLightKey;
      entry.actualLight = LIGHT_RATING_SCORES[actualLightKey];
      if (predicted != null) entry.predictedLight = predicted;
    }
    if (actualBirdKey) {
      entry.actualBirdLabel = actualBirdKey;
      entry.actualBird = BIRD_RATING_SCORES[actualBirdKey];
      if (state.birdScore) entry.predictedBird = state.birdScore.rawTotal;
    }
    entries.unshift(entry);
    saveLog(entries);
    renderLog(true);
    feedbackSuccess();
    setLogStatus("Entry saved.", "is-ok");
    e.target.reset();
    pendingPhotoScore = null;
    const photoResultEl = document.getElementById("photo-score-result");
    if (photoResultEl) { photoResultEl.hidden = true; photoResultEl.innerHTML = ""; }
    if (photoInput) photoInput.value = "";
    // The form reset above clears both dropdowns back to "Didn't rate it" -
    // treat the next entry as untouched again and immediately re-fill it
    // with the current prediction, rather than leaving it blank until the
    // next tab switch or 15s tick.
    state.logTouched.light = false;
    state.logTouched.bird = false;
    autoFillLogRatings();
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
  setInterval(() => { if (loadAutoRefreshEnabled()) refreshAll(); }, 5 * 60 * 1000);

  // Timers throttle or pause in a backgrounded tab, so catch up immediately
  // when the tab becomes visible again instead of waiting for the next tick -
  // relevant for a field app someone checks by unlocking their phone.
  let lastVisibleRefresh = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      liveTick();
      if (loadAutoRefreshEnabled() && Date.now() - lastVisibleRefresh > 2 * 60 * 1000) {
        lastVisibleRefresh = Date.now();
        refreshAll();
      }
    }
  });
});

// ---------- Offline support ----------
// Service workers need a real http(s) origin - they can't register from a
// file:// page, and older/locked-down browsers may not expose the API at
// all. Both are silently skipped rather than shown as an error, since the
// app is fully usable without this; it's purely what lets the app shell
// itself (not the weather data) load with no connection at all.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell caching unavailable - fine */ });
  });
}

// ---------- In-app help assistant ----------
// This is a local, offline lookup over a fixed set of real answers about
// this app's own features - not a live/general AI, and it never claims to
// be one anywhere in its own UI. It works with no network connection and
// no ongoing cost, which matters for a one-time-purchase app with no
// backend: a genuine conversational AI would require sending every
// question to a paid LLM API, which means either shipping a developer API
// key inside client-side code that anyone can extract and abuse, or
// standing up and paying for a server indefinitely. This delivers the
// actual value people want from "ask the app a question" (a fast, correct
// answer about how a specific number works) without either problem.
//
// Matching: each entry lists a handful of keywords/phrases most likely to
// appear in a real question about that topic. The user's question is
// lowercased and checked for each entry's keywords; the entry with the
// most matches wins, and ties go to whichever entry appears first (broader
// topics are listed first). Below a minimum match count, a helpful
// fallback is shown instead of a wrong guess.
const ASK_KB = [
  {
    topic: "What this app does",
    keywords: ["what is this", "what does this app do", "what is this app", "purpose", "overview", "help"],
    answer: "This app predicts two things at your location: how good the light is likely to be for photography, and how active birds are likely to be. Both come from real astronomy math and real weather data, not guesses. Check the Notes tab for a full breakdown of every number."
  },
  {
    topic: "Direction tab / compass",
    keywords: ["direction tab", "compass", "azimuth", "altitude", "which way", "sun direction", "where is the sun", "bearing", "line up a shot", "sun finder"],
    answer: "The Direction tab is a compass that points where the sun sits in the sky, right now or at any time you pick. Altitude is how high above the horizon it is (negative means it's below the horizon); azimuth is the compass bearing, 0-360 degrees clockwise from north, which the needle also shows visually. Use the date arrows and slider to preview any time without waiting for it, or tap the clock icon to jump back to the live moment. It's a plain compass dial, not a street map, so it works offline and needs no location permission beyond whatever you've already set for the app."
  },
  {
    topic: "Sunrise/sunset/blue hour marks on the compass",
    keywords: ["where will the sun rise", "where will the sun set", "compass sunrise mark", "compass sunset mark", "blue hour arc", "sun position on compass", "compass markers"],
    answer: "The Direction tab's compass marks exactly where the sun will be: a sun-icon dot for sunrise and one for sunset, plus a short teal arc on each side showing how much the bearing shifts during blue hour (nautical dawn to dawn in the morning, dusk to nautical dusk in the evening). These are calculated for whichever day is currently shown, so using the day-forward/back arrows updates them, not just today's marks. They sit on the dial itself, so if you enable the live compass, they turn along with it exactly like the N/E/S/W ticks."
  },
  {
    topic: "Live compass (device orientation)",
    keywords: ["live compass", "enable live compass", "phone compass", "turn to face", "compass sensor", "facing the sun", "rotate compass", "point phone"],
    answer: "Tapping 'Enable live compass' on the Direction tab turns the whole dial to match which way your phone is actually pointing, using its compass sensor, so you can physically turn until the needle lines up at the top. This only works on a phone with a compass sensor, over a secure connection, and iPhones require you to tap Allow when it asks - that's an Apple privacy rule, not something the app can skip. It won't do anything on a desktop or laptop browser, since those have no compass hardware at all."
  },
  {
    topic: "Photo score breakdown",
    keywords: ["how is my photo score calculated", "photo score breakdown", "how this number was calculated", "photo math", "photo points", "score calculated", "calculated score"],
    answer: "Tap 'How this number was calculated' under any photo score to expand the exact math: what percent of the frame was treated as sky, the average color saturation in that region and how many points that earned (out of 55), and what percent of that region was a warm sunset/sunrise hue and how many points that earned (out of 45). Those two numbers always add up to the final score out of 100."
  },
  {
    topic: "Photo not detected as a sky/sunset photo",
    keywords: ["not a sky photo", "not detected as sunset", "didn't detect my sunset", "photo was rejected", "photo rejected", "rejected", "doesn't look like a sky", "photo not scored", "didn't score my photo", "wasn't detected", "not get detected", "not detected", "didn't get detected", "photo not detected"],
    answer: "The app looks for a smooth, low-detail region at the top of the frame (the sky) above a busier foreground (trees, a treeline, buildings, a person), and only scores the sky region. It gets rejected as 'not a sky photo' if that smooth region is too small, too busy (heavy clouds/texture read as detail), or if a face-like patch of skin-tone color is detected. If a genuine sunset shot gets rejected, it's almost always because the sky was a small sliver of the frame or had unusually heavy texture - cropping in tighter on the sky before uploading usually fixes it."
  },
  {
    topic: "Sunset photo score",
    keywords: ["photo score", "sunset photo", "analyze photo", "photo analysis", "detect photo", "how good was", "add a photo"],
    answer: "In the Shoot Log, adding a photo reads its actual color, average saturation plus how much warm orange/pink tone is in it, and turns that into a 0-100 score that pre-fills the 'Light quality - actually' rating for you. Use the raw, unedited photo straight off your camera or phone - a filtered or edited one scores how it looks after editing, not how the sky really looked. It's a color heuristic run entirely on your device (nothing uploaded anywhere), not real scene recognition, so it can also be thrown off by a photo with a lot of dark foreground - always glance at the pre-filled rating and correct it if it doesn't match what you actually saw before saving, since that rating is what teaches the app's calibration."
  },
  {
    topic: "Why bird score is low",
    keywords: ["score low", "score is low", "quiet period", "why is my score", "activity low", "no activity"],
    answer: "A low bird score usually means one or more of: it's the middle of the day or the middle of the night (activity naturally dips then), the weather has strong wind or active rain, or it's outside spring/fall migration season. Check the factor tiles under the meter, they show exactly which inputs are pulling the score down right now."
  },
  {
    topic: "Bird score meaning",
    keywords: ["bird score", "bird activity", "activity meter", "0-1000", "1000", "bird meter"],
    answer: "The Bird Activity Meter (0-1000) is a probability estimate built from time of day, current weather, barometric pressure trend, and season, all combined using documented bird-behavior research. It's a planning aid, like a weather forecast, not a live sightings feed - it can't know what birds are actually near you right now. See 'Bird activity meter' in the Notes tab for the full breakdown of all four ingredients."
  },
  {
    topic: "Sunrise/sunset quality score",
    keywords: ["sunrise quality", "sunset quality", "quality score", "sunrise percent", "sunset percent", "colorful sky", "sky color"],
    answer: "The sunrise/sunset percentage predicts how colorful the sky is likely to look, based on high/mid cloud cover (which catches color), low cloud cover (which blocks it), humidity (which mutes it), and aerosol/haze (which can go either way - see 'aerosol' below). A moderate amount of high/mid cloud, roughly a third to half the sky, scores highest - fully clear or fully overcast both score lower."
  },
  {
    topic: "Why is a sunrise/sunset score what it is (Outlook)",
    keywords: ["why is it 30%", "why is the score", "outlook breakdown", "tap to see why", "click outlook", "explain the score", "why is sunrise bad", "why is sunset good"],
    answer: "Tap any sunrise or sunset score in the 7-Day Outlook to expand a breakdown of exactly what produced that number for that hour: the high/mid/low cloud cover readings versus their ideal bands, humidity, aerosol/haze, and terrain, each with a one-line note on whether it helped or hurt the score. It's the same math as the Dashboard's live score, just made visible for every day instead of only today."
  },
  {
    topic: "Golden hour intensity",
    keywords: ["golden hour intensity", "golden hour score", "color temperature", "cct", "kelvin", "white balance", "warm light score"],
    answer: "Golden Hour Intensity is a separate 0-100 score from the sunrise/sunset quality percentage: quality is about whether the sky shows color, this is about whether the direct warm sunlight itself is strong and unobstructed right now. It's only active while the sun is within the -0.833 to 6 degree golden-hour band, and factors in how centered the sun is in that window, total cloud cover blocking direct light, and aerosol haze. It also shows an estimated color temperature in Kelvin for white balance - a simplified physics-based estimate from solar elevation, not a measured reading."
  },
  {
    topic: "Legendary conditions badge",
    keywords: ["legendary", "legendary conditions", "epic", "glow", "badge", "flame", "crazy sunset", "amazing sunset", "why did it glow", "why is it glowing"],
    answer: "A sunrise or sunset quality score of 95+ gets the 'Legendary conditions' treatment: a pulsing glow on its ring, a badge, and a one-time burst/sound the first time it's detected. It's set well above the 'Great' label (75+) on purpose - a 200,000-sample simulation of realistic conditions against this formula puts Great at roughly the top 9-10% of days, with 95+ reserved for a small handful of truly exceptional evenings - meant to flag something genuinely rare, not just another good evening. It also shows as a small flame mark on the 7-day Outlook, without the animation."
  },
  {
    topic: "Aerosol / haze in the quality score",
    keywords: ["aerosol", "aod", "smoke", "dust", "wildfire", "haze in the score", "why does smoke", "optical depth"],
    answer: "Aerosol optical depth (AOD) is a real measurement of how much smoke, dust, or general haze is in the whole air column, pulled from Open-Meteo's air quality model, and it now feeds the sunrise/sunset quality score directly. It's genuinely two-sided: a light-to-moderate amount tends to deepen sunset reds and oranges (which is why sunsets often look more dramatic downwind of wildfire smoke or a dust storm), while a heavy load flattens color into a murky haze instead. You can see the current reading on the Weather & Exposure card under 'Atmospheric haze (AOD)'."
  },
  {
    topic: "Terrain / horizon",
    keywords: ["terrain", "horizon", "ridge", "mountain", "hill", "behind terrain", "clears terrain"],
    answer: "If there's a real hill, ridge, or bluff near your sunrise/sunset direction, the app checks real elevation data and shows you the actual time the sun disappears behind it or clears it. This only affects the light-duration times, never the sunrise/sunset color score, since sky color keeps developing whether or not something blocks your direct view of the sun."
  },
  {
    topic: "UV index",
    keywords: ["uv index", "uv", "ultraviolet", "sun protection"],
    answer: "UV index shows how strong the sun's ultraviolet light is right now. Useful for knowing when midday light will be harshest, and for basic sun protection in the field."
  },
  {
    topic: "Visibility / haze",
    keywords: ["visibility", "haze", "hazy", "fog reading"],
    answer: "Visibility shows how far you can see through the air right now, in kilometers. Low visibility means haze or fog, which flattens color and contrast in photos even on a day that otherwise looks clear."
  },
  {
    topic: "Air quality / PM2.5",
    keywords: ["air quality", "pm2.5", "pm 2.5", "aqi", "smoke", "pollution"],
    answer: "Air quality (PM2.5) measures fine particle pollution. Higher readings mean more atmospheric haze from smoke or pollution, which washes out sunset color and contrast the same way fog does."
  },
  {
    topic: "Barometer",
    keywords: ["barometer", "pressure", "hpa", "pressure trend", "falling", "rising pressure"],
    answer: "The barometer shows current air pressure and its 3-hour trend. Falling pressure usually means a front is approaching, and birds tend to feed harder beforehand, so activity tends to pick up. Sharply rising pressure usually follows a front, and activity tends to quiet down. It's the trend, not the raw number, that matters for bird behavior, and it's the one weather reading that actually feeds the bird score."
  },
  {
    topic: "Moon phase",
    keywords: ["moon", "moon phase", "illuminated", "lunar"],
    answer: "Moon phase is shown for reference, useful for planning night shoots. It is intentionally NOT used in the bird activity score, the evidence linking moonlight to daytime bird behavior isn't solid enough to build a number on."
  },
  {
    topic: "Post-rain / fog / overcast factors",
    keywords: ["post-rain", "post rain", "rain pulse", "fog suppression", "overcast midday", "after rain", "worms"],
    answer: "Three extra bird-activity signals: a short activity boost right after rain stops (rain brings worms and insects to the surface, a well-known trigger for ground-feeding birds), a penalty in dense fog (visual foragers and soaring birds are hampered by poor visibility), and less of a midday slowdown on warm, overcast days (cloud cover removes the heat-avoidance pressure that drives birds to rest in full sun). These only show up in the factor tiles when they're actually in play."
  },
  {
    topic: "Calibration",
    keywords: ["calibration", "calibrate", "rate", "actual light", "actual bird", "correction", "learn"],
    answer: "Calibration is how the app learns from your own results. Rate what light or bird activity was actually like on a Shoot Log entry, and the app compares it to what it predicted at that moment. After 3+ rated shoots, the average difference becomes a correction applied to future predictions (capped at 20 points for light, 200 for bird activity - one rating tier's worth out of the 5 options each dropdown now has). Delete a bad entry and it recalculates instantly."
  },
  {
    topic: "Shoot Log",
    keywords: ["shoot log", "log entry", "export csv", "clear log", "add entry"],
    answer: "The Shoot Log records what you shot, when, and the conditions at the time, and it's how calibration learns your locations. Export CSV downloads the whole log as a spreadsheet file. Clear Log deletes every entry and resets calibration back to zero."
  },
  {
    topic: "inHg vs hPa",
    keywords: ["inhg", "inches of mercury", "hpa or inhg", "pressure unit", "default pressure"],
    answer: "inHg (inches of mercury) is the default here since it's what most US home barometers and weather reports use. hPa (hectopascals) is the international scientific unit Open-Meteo returns natively. Both are available in Settings under Barometric pressure, and switching just changes the display, not the underlying number."
  },
  {
    topic: "Settings - units",
    keywords: ["fahrenheit", "celsius", "temperature unit", "mph", "km/h", "wind unit", "change unit"],
    answer: "Temperature, wind speed, and barometric pressure units are all in the Settings tab. Switching them only changes what's displayed, the actual math behind every score always uses the same units regardless."
  },
  {
    topic: "Settings - sound",
    keywords: ["sound", "noise", "mute", "silent", "turn off sound", "shutter sound", "beep"],
    answer: "Sound effects (tap sounds, the shutter-click on manual refresh, haptic buzz) can be turned off in Settings. None of it ever plays automatically in the background, only when you actually tap something like Refresh Data."
  },
  {
    topic: "Auto-refresh",
    keywords: ["auto refresh", "auto-refresh", "background refresh", "refresh automatically", "5 minutes"],
    answer: "The app quietly re-checks weather every 5 minutes in the background with no sound and no popup. You can turn this off in Settings if you'd rather only refresh by pressing the Refresh Data button yourself."
  },
  {
    topic: "Clear cache / stuck data",
    keywords: ["stuck", "cached data", "clear cache", "old data", "not updating", "stale"],
    answer: "If the dashboard looks stuck on old numbers, go to Settings and tap 'Clear Cached Data & Refresh'. It throws away the saved last-known-good reading and pulls a completely fresh one."
  },
  {
    topic: "Setting a location",
    keywords: ["location", "gps", "change location", "set location", "coordinates"],
    answer: "Type a town or city name into the Location box at the top and tap Set, or tap Use GPS to grab your device's current position. You can also type coordinates directly as 'lat, lon'."
  },
  {
    topic: "Offline / data privacy",
    keywords: ["offline", "privacy", "data stored", "internet", "no connection", "my data"],
    answer: "Sun and moon position work with no internet connection at all, since they're pure astronomy math. Weather, terrain, and air quality need a connection to fetch. Everything you enter (your location, Shoot Log, calibration) stays stored locally on your own device, nothing is sent anywhere else."
  },
  {
    topic: "Outlook tab",
    keywords: ["outlook tab", "7 day", "7-day", "week ahead", "forecast days"],
    answer: "The Outlook tab shows the same sunrise/sunset quality score for the next 7 days, so you can plan ahead instead of only seeing today."
  },
  {
    topic: "Raw vs calibrated score",
    keywords: ["raw score", "raw prediction", "before calibration", "difference between predicted", "raw", "calibrated"],
    answer: "Internally the app always computes a 'raw' prediction first, straight from the model with no personal correction. Calibration is applied on top of that raw number to produce what you actually see. Calibration always compares your ratings against the raw prediction, never the already-corrected one, so the correction can't compound on itself over time."
  },
  {
    topic: "Time of day / diel factor",
    keywords: ["time of day factor", "daylight position", "twilight position", "dawn chorus", "midday lull"],
    answer: "'Daylight/twilight position' is the foundation of the bird score, not just one input among others. It's a curve based on published circadian research: a sharp peak right at sunrise and sunset (the dawn chorus and evening feeding push), a daytime baseline with a documented midday slowdown, and a low floor at night. Weather and season can only scale this curve up or down, they can't invent activity at a time of day when the curve says there shouldn't be any."
  },
  {
    topic: "Weather/season modifier numbers",
    keywords: ["weather modifier", "season modifier", "x1", "migration modifier", "what does x mean"],
    answer: "The weather modifier (roughly x0.55 to x1.15) and season modifier (roughly x0.70 to x1.20) are multipliers applied to the time-of-day base score, not separate scores of their own. A weather modifier of x1.15 means current conditions are boosting activity by about 15% above the daytime baseline; x0.70 means conditions are suppressing it."
  },
  {
    topic: "What species does this cover",
    keywords: ["species", "what birds", "owls", "nocturnal", "songbirds", "raptors"],
    answer: "The model is tuned for birds active during the day, songbirds, woodpeckers, raptors, and waterfowl. It is not built for owls or other non-migratory nocturnal behavior, which is why the score never drops all the way to zero after dark outside migration season. The one exception: during spring and fall migration windows, it adds a real night bump timed to when radar-tracked nocturnal migration traffic typically peaks, a few hours after full dark."
  },
  {
    topic: "Minimum shoots for calibration",
    keywords: ["how many shoots", "minimum rated", "3 shoots", "need more", "how many ratings"],
    answer: "You need at least 3 rated shoots (light or bird activity, or both) before calibration starts correcting predictions. The Shoot Log tab shows a running count of how many you've rated and how many more you need."
  },
  {
    topic: "Deleting a single log entry",
    keywords: ["delete entry", "remove entry", "delete one shoot", "remove one log", "delete", "just one", "single entry"],
    answer: "Each row in the Shoot Log table has a small x button on the right, tap it to delete just that one entry. Calibration recalculates immediately from whatever entries are left. 'Clear Log' in the Shoot Log tab is different, that deletes everything at once."
  },
  {
    topic: "Refresh sound behavior",
    keywords: ["refresh sound", "why silent", "no sound on refresh", "auto refresh sound", "manual sound", "no sound", "silent", "sound on refresh", "sound when"],
    answer: "The app only makes sound when you actually tap something. The background auto-refresh (every 5 minutes) and the day-rollover refresh are always silent. Only pressing the Refresh Data button yourself plays the shutter-click sound, and it's a different tone from every other sound in the app so you can tell it apart."
  },
  {
    topic: "Is this 100% accurate",
    keywords: ["100% accurate", "always accurate", "how accurate", "always right", "guaranteed"],
    answer: "No prediction here is guaranteed. This app combines real astronomy math (exact) with weather forecasting and behavioral-ecology research (both probabilistic by nature), so it can be wrong on any given day the same way any weather forecast can. Calibration narrows the gap between what it predicts and what you actually see at your locations, but it's a planning aid, not a certainty."
  },
  {
    topic: "Terrain fan sampling detail",
    keywords: ["fan sampling", "bearing fan", "elevation api", "how terrain works", "azimuth"],
    answer: "The terrain check samples real elevation data across a small fan of compass bearings around your exact sunrise/sunset direction, at five distances out to 55km, and finds the tallest obstruction across that whole fan. A single ray checked at only a few fixed points can miss a real peak sitting slightly off to the side, so the fan is a meaningfully harder target to step around than one line, though it still isn't a continuous scan of the whole skyline."
  },
  {
    topic: "Stuck on the wrong location / default location banner",
    keywords: ["wrong location", "stuck on kansas", "default location", "not my location", "location banner", "gps not working", "gps didn't set", "gps sync", "weather is off", "temperature is wrong", "wrong city"],
    answer: "If every reading looks off, the app is probably still sitting on its generic fallback spot (center of the US) instead of your real location - a banner at the top of the Dashboard says so when that's the case. This happens if GPS was denied, timed out, or you never set a location: the app now automatically retries GPS on every load while it's stuck on the fallback, and shows a clear error message instead of failing silently. Tap 'Use GPS' on that banner or the header, or type your town/city into the Location box and hit Set, and every reading (temperature, humidity, wind, barometer, sunrise/sunset) updates from that point on."
  },
  {
    topic: "Why weather numbers differ from another weather app",
    keywords: ["differs from another app", "different from apple weather", "different from weather app", "why is the temperature different", "disagrees with", "another site says", "which weather app is right", "most accurate weather"],
    answer: "Weather here comes from Open-Meteo, which blends 15+ national weather agency models (NOAA, ECMWF, DWD, and others) and picks the highest-resolution one for your spot - it's a legitimate, free data source, the same class of underlying model most weather apps are built on. Two different weather providers forecasting the same hour will still disagree by a couple of degrees sometimes, especially in places with fewer nearby weather stations - that's normal model variance, not a bug in either one, and no single provider is 'the most accurate' across every location and day."
  }
];
const ASK_STOPWORDS = new Set(["a","an","the","is","are","does","do","did","why","what","whats","how","my","me","to","of","on","for","in","it","this","that","i","you","your","when","can","will","should","about","and","or"]);

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s.\/-]/g, " ").split(/\s+/).filter(w => w && !ASK_STOPWORDS.has(w));
}

function findBestAnswer(question) {
  const qLower = question.toLowerCase();
  const qTokens = tokenize(question);
  let best = null, bestScore = 0;
  for (const entry of ASK_KB) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (kw.includes(" ") || kw.includes("-") || kw.includes("/")) {
        if (qLower.includes(kw)) score += 2; // multi-word phrase match is a strong signal
      } else if (qTokens.includes(kw)) {
        score += 1;
      }
    }
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  if (best && bestScore >= 1) return best.answer;
  return "I don't have a documented answer for that one. Try asking about: bird score, sunrise/sunset quality, calibration, barometer, terrain, units, sound, auto-refresh, or your location. The Notes tab also has the full write-up of every number in the app.";
}

function askAddMessage(text, who) {
  const wrap = document.getElementById("ask-messages");
  const el = document.createElement("div");
  el.className = "ask-msg " + (who === "user" ? "ask-msg-user" : "ask-msg-bot");
  el.textContent = text;
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
}

const ASK_SUGGESTIONS = ["Why is my bird score low?", "How does calibration work?", "What's the barometer trend?", "How do I change units?"];

function renderAskSuggestions() {
  const box = document.getElementById("ask-suggestions");
  if (!box) return;
  box.innerHTML = ASK_SUGGESTIONS.map(s => `<button type="button" class="ask-suggestion">${s}</button>`).join("");
  box.querySelectorAll(".ask-suggestion").forEach(btn => {
    btn.addEventListener("click", () => askSubmitQuestion(btn.textContent));
  });
}

function askSubmitQuestion(text) {
  const q = (text || "").trim();
  if (!q) return;
  askAddMessage(q, "user");
  feedbackTap();
  const answer = findBestAnswer(q);
  setTimeout(() => askAddMessage(answer, "bot"), 220); // tiny delay reads as a real response, not an instant canned lookup
  const input = document.getElementById("ask-input");
  if (input) input.value = "";
}

document.addEventListener("DOMContentLoaded", () => {
  const fab = document.getElementById("ask-fab");
  const panel = document.getElementById("ask-panel");
  const overlay = document.getElementById("ask-overlay");
  if (!fab || !panel || !overlay) return;

  let askOpened = false;
  function openAsk() {
    panel.hidden = false;
    overlay.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    if (!askOpened) {
      askOpened = true;
      askAddMessage("Ask me anything about how this app's numbers work, units, or settings. I only know what's documented in the Notes tab, nothing outside this app.", "bot");
      renderAskSuggestions();
    }
    const input = document.getElementById("ask-input");
    if (input) setTimeout(() => input.focus(), 50);
  }
  function closeAsk() {
    panel.hidden = true;
    overlay.hidden = true;
    fab.setAttribute("aria-expanded", "false");
  }
  fab.addEventListener("click", () => {
    feedbackTap();
    if (panel.hidden) openAsk(); else closeAsk();
  });
  document.getElementById("ask-close").addEventListener("click", closeAsk);
  overlay.addEventListener("click", closeAsk);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) closeAsk();
  });
  document.getElementById("ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    askSubmitQuestion(document.getElementById("ask-input").value);
  });
  // (No separate wireTactileFeedback call needed here - the single
  // delegated wireTactileFeedback("button") call above already covers the
  // Ask panel's buttons, including .ask-suggestion, which is added later.)
});
