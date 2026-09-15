// Raylight Home Screen Widget
// A companion iOS home screen widget for the Photography & Bird Activity
// Monitor, built for the free "Scriptable" app (search "Scriptable" on the
// App Store - made by Simon B. Stovring, no relation to this app).
//
// WHY THIS EXISTS INSTEAD OF A NATIVE APP-STORE WIDGET:
// A true iOS home screen widget (Apple's WidgetKit) has to be written in
// Swift, built and code-signed in Xcode on a Mac, under a paid Apple
// Developer account, and shipped as part of a native app bundle. None of
// that is possible from a browser-only web app. Scriptable is a real,
// well-established (10+ years) way to get an actual live, native-looking
// home screen widget that runs real JavaScript, without any of that
// infrastructure. The tradeoff: it only works for people who install the
// free Scriptable app and add this script themselves, it can't be
// distributed through the App Store on its own.
//
// WHAT IT SHOWS: today's nearer sunrise/sunset quality score and the bird
// activity score, computed with the exact same real astronomy + weather
// logic as the main web app (Open-Meteo weather, the Meeus solar position
// algorithm, and the same documented bird-behavior model, source citations
// in app.js if you want to check the math matches).
//
// WHAT IT CANNOT DO: read the calibration your web app has learned from
// your own logged shoots. Calibration lives in that page's browser storage,
// which a widget script has no access to (different sandboxes, by design,
// on both Apple's and the browser's side) - so this always shows the raw,
// uncalibrated model, clearly, rather than faking a number it can't
// actually know.
//
// ---------------- SETUP (one time, about 2 minutes) ----------------
// 1. Install "Scriptable" from the App Store (free).
// 2. Open Scriptable, tap the + in the top right, paste this entire file in,
//    and rename the script (top of screen) to "Raylight".
// 3. Tap the play button once to run it manually. The first run asks for
//    location permission - allow "While Using the App" or "Always", either
//    works. This caches your coordinates so the widget doesn't need to ask
//    again every time iOS refreshes it in the background.
//    - To pin a specific location instead of "wherever my phone is right
//      now" (recommended if you shoot the same spot regularly), see
//      WIDGET_PARAMETER_HELP below.
// 4. Long-press your home screen -> tap the + in the corner -> search
//    "Scriptable" -> choose a widget size (Small or Medium both look good)
//    -> add it to your home screen.
// 5. Long-press the new widget -> Edit Widget -> set "Script" to "Raylight".
//    Optionally set "Parameter" to "lat,lon" (e.g. "40.5853,-105.0844") to
//    lock the widget to one specific location instead of your live GPS
//    position - useful if your phone travels but you want the widget to
//    always show conditions at your usual shooting spot.
// 6. Optionally set RAYLIGHT_APP_URL below to your published app's web
//    address, so tapping the widget opens the full dashboard.
// ---------------------------------------------------------------------

// Fill this in with your GitHub Pages (or custom domain) URL so tapping the
// widget opens the full app. Leave blank to disable tap-through.
const RAYLIGHT_APP_URL = "";

// ---------- Raylight brand palette (matches style.css :root exactly) ----------
const COLOR = {
  navy: new Color("#1c2d4f"),
  terracotta: new Color("#c17a52"),
  terracottaSoft: new Color("#d9a37c"),
  bg: new Color("#f3e8d2"),
  bg2: new Color("#ead9b2"),
  panel: new Color("#fbf6ea"),
  panel2: new Color("#f2e7cc"),
  panelBorder: new Color("#cdb98c"),
  text: new Color("#1c2d4f"),
  muted: new Color("#5c6a86"),
  moss: new Color("#1f6b5c"),   // "good/great" tier
  rust: new Color("#a8371f"),   // "poor" tier
  blue: new Color("#3d6e78")    // blue hour
};

function tierColor(tier) {
  if (tier === "great" || tier === "good") return COLOR.moss;
  if (tier === "fair") return COLOR.terracotta;
  return COLOR.rust;
}

// ---------- Cache (last-known-good, mirrors the web app's stale-data behavior) ----------
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "raylight-widget-cache.json");
function loadCache() {
  try {
    if (!fm.fileExists(cachePath)) return null;
    return JSON.parse(fm.readString(cachePath));
  } catch (e) { return null; }
}
function saveCache(obj) {
  try { fm.writeString(cachePath, JSON.stringify(obj)); } catch (e) { /* non-fatal */ }
}

// ---------- Location: parameter overrides cached GPS overrides live GPS ----------
const locCachePath = fm.joinPath(fm.documentsDirectory(), "raylight-widget-loc.json");
async function resolveLocation() {
  const param = (args.widgetParameter || "").trim();
  if (param) {
    const parts = param.split(",").map(s => parseFloat(s.trim()));
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const loc = { lat: parts[0], lon: parts[1] };
      fm.writeString(locCachePath, JSON.stringify(loc));
      return loc;
    }
  }
  try {
    Location.setAccuracyToHundredMeters();
    const pos = await Location.current();
    const loc = { lat: pos.latitude, lon: pos.longitude };
    fm.writeString(locCachePath, JSON.stringify(loc));
    return loc;
  } catch (e) {
    // Widgets refreshed in the background often can't prompt for location -
    // fall back to whatever was last resolved (from a manual run, or an
    // earlier successful background refresh).
    try {
      if (fm.fileExists(locCachePath)) return JSON.parse(fm.readString(locCachePath));
    } catch (e2) { /* fall through */ }
    return null;
  }
}

// ---------- Solar position (Meeus low-precision algorithm) ----------
// Ported directly from this app's own suncalc-lite.js - identical math, so
// times/angles here always match the main dashboard for the same
// coordinates and moment, to within floating point rounding.
const RAD = Math.PI / 180;
const DAY_MS = 864e5;
const J1970 = 2440588, J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;
function toJulian(d) { return d.getTime() / DAY_MS - 0.5 + J1970; }
function fromJulian(j) { return new Date((j + 0.5 - J1970) * DAY_MS); }
function toDays(d) { return toJulian(d) - J2000; }
function declination(l) { return Math.asin(Math.sin(0) * Math.cos(OBLIQUITY) + Math.cos(0) * Math.sin(OBLIQUITY) * Math.sin(l)); }
function siderealTime(d, lw) { return RAD * (280.16 + 360.9856235 * d) - lw; }
function rightAscension(l) { return Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY), Math.cos(l)); }
function altitude(H, phi, dec) { return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)); }
function solarMeanAnomaly(d) { return RAD * (357.5291 + 0.98560028 * d); }
function eclipticLongitude(M) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + RAD * 102.9372 + Math.PI;
}
function getSunPosition(date, lat, lon) {
  const lw = RAD * -lon, phi = RAD * lat, d = toDays(date);
  const M = solarMeanAnomaly(d), L = eclipticLongitude(M), dec = declination(L);
  const H = siderealTime(d, lw) - rightAscension(L);
  return { altitude: altitude(H, phi, dec) };
}
const J0 = 0.0009;
function julianCycle(d, lw) { return Math.round(d - J0 - lw / (2 * Math.PI)); }
function approxTransit(Ht, lw, n) { return J0 + (Ht + lw) / (2 * Math.PI) + n; }
function solarTransitJ(ds, M, L) { return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L); }
function hourAngle(h, phi, d) { return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d))); }
function getSunTimes(date, lat, lon) {
  const lw = RAD * -lon, phi = RAD * lat, d = toDays(date);
  const n = julianCycle(d, lw), ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds), L = eclipticLongitude(M), dec = declination(L);
  const Jnoon = solarTransitJ(ds, M, L);
  const h0 = -0.833 * RAD;
  const w = hourAngle(h0, phi, dec);
  const a = approxTransit(w, lw, n);
  const Jset = solarTransitJ(a, M, L);
  const Jrise = Jnoon - (Jset - Jnoon);
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset), solarNoon: fromJulian(Jnoon) };
}

// ---------- Sunrise/sunset color quality (identical formula to app.js) ----------
function triangularScore(pct, peak, width) {
  return Math.max(0, 100 - Math.abs(pct - peak) * (100 / width));
}
function lightLabel(score) {
  if (score >= 75) return "Great";
  if (score >= 55) return "Good";
  if (score >= 32) return "Fair";
  return "Poor";
}
function computeSunQuality(low, mid, high, humidity) {
  const base = triangularScore(high, 40, 60) * 0.55 + triangularScore(mid, 35, 60) * 0.45;
  const lowMult = Math.max(0, 1 - low / 65);
  const humMult = Math.max(0.35, 1 - Math.max(0, humidity - 55) / 60);
  const score = Math.round(Math.max(0, Math.min(100, base * lowMult * humMult)));
  return { score, label: lightLabel(score) };
}

// ---------- Bird activity model (identical logic to app.js, minus calibration) ----------
function dielFactor(elevationDeg, now, times) {
  const sigma = 1.5;
  const gauss = (h) => Math.exp(-(h * h) / (2 * sigma * sigma));
  const hrSunrise = (now - times.sunrise) / 3600000;
  const hrSunset = (now - times.sunset) / 3600000;
  const twilightBonus = Math.max(gauss(hrSunrise), gauss(hrSunset)) * 55;
  let base;
  if (elevationDeg > 0) base = 45;
  else if (elevationDeg > -12) base = 10 + ((elevationDeg + 12) / 12) * 35;
  else base = 3 + Math.min(1, Math.max(0, (elevationDeg + 18) / 6)) * 7;
  return Math.round(Math.min(100, base + twilightBonus));
}
function expectedTailwindBearing(date) {
  const doyFrac = (date.getMonth() + 1) + date.getDate() / 31;
  if (doyFrac >= 3.0 && doyFrac <= 6.3) return 180;
  if (doyFrac >= 8.3 && doyFrac <= 11.3) return 0;
  return null;
}
function angularDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function seasonalFactor(date) {
  const doyFrac = (date.getMonth() + 1) + date.getDate() / 31;
  if ((doyFrac >= 4.0 && doyFrac <= 5.8) || (doyFrac >= 9.0 && doyFrac <= 10.8)) return 100;
  if (date.getMonth() + 1 === 6 || date.getMonth() + 1 === 7) return 70;
  if ([12, 1, 2].includes(date.getMonth() + 1)) return 45;
  return 60;
}
function weatherFactor(current, hourly, trendHpa, now, elevationDeg, idxNow) {
  let score = 100;
  const wind = current.wind_speed_10m, precip = current.precipitation, temp = current.temperature_2m;
  if (wind > 35) score -= 45; else if (wind > 20) score -= 25; else if (wind > 10) score -= 8;
  const bearing = expectedTailwindBearing(now);
  if (bearing !== null && typeof current.wind_direction_10m === "number" && wind >= 5) {
    const diff = angularDiff(current.wind_direction_10m, (bearing + 180) % 360);
    if (diff <= 45) score += 15; else if (diff <= 80) score += 6; else if (diff >= 135) score -= 12;
  }
  if (precip > 2) score -= 40; else if (precip > 0.2) score -= 15;
  if (trendHpa <= -1.5) score += 12; else if (trendHpa >= 2) score -= 8;
  if (temp < -10 || temp > 35) score -= 20; else if (temp < 0 || temp > 30) score -= 8;
  // Post-rain foraging pulse, fog suppression, overcast-midday bonus - same
  // three real, cited signals as the main app (see weatherFactor in app.js).
  if (hourly && hourly.precipitation && idxNow >= 2) {
    const cur = hourly.precipitation[idxNow] || 0;
    const recent = Math.max(hourly.precipitation[idxNow - 1] || 0, hourly.precipitation[idxNow - 2] || 0);
    if (cur <= 0.2 && recent >= 1.0) score += 14;
  }
  if (hourly && hourly.visibility && idxNow >= 0) {
    const vis = hourly.visibility[idxNow];
    if (typeof vis === "number") { if (vis < 1000) score -= 18; else if (vis < 3000) score -= 6; }
  }
  if (elevationDeg >= 25 && temp >= 22 && current.cloud_cover >= 60) score += 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}
function pressureTrend(hourly, currentTime) {
  try {
    const idxNow = hourly.time.indexOf(currentTime);
    if (idxNow === -1 || idxNow < 3) return 0;
    return hourly.surface_pressure[idxNow] - hourly.surface_pressure[idxNow - 3];
  } catch (e) { return 0; }
}
function nearestHourIndex(hourly, date) {
  const target = date.getTime();
  let best = -1, bestDiff = Infinity;
  for (let i = 0; i < hourly.time.length; i++) {
    const diff = Math.abs(new Date(hourly.time[i]).getTime() - target);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}
function computeBirdScore(now, times, weatherData, elevationDeg) {
  const diel = dielFactor(elevationDeg, now, times);
  const idxNow = nearestHourIndex(weatherData.hourly, now);
  const trend = pressureTrend(weatherData.hourly, weatherData.current.time);
  const weather = weatherFactor(weatherData.current, weatherData.hourly, trend, now, elevationDeg, idxNow);
  const season = seasonalFactor(now);
  const weatherMult = 0.55 + (weather / 100) * 0.6;
  const seasonMult = 0.7 + (season / 100) * 0.5;
  const total0to100 = Math.max(0, Math.min(100, diel * weatherMult * seasonMult));
  const total = Math.round(total0to100 * 10);
  let verdict, tier;
  if (total >= 750) { verdict = "High activity likely"; tier = "great"; }
  else if (total >= 500) { verdict = "Moderate activity likely"; tier = "good"; }
  else if (total >= 250) { verdict = "Low activity likely"; tier = "fair"; }
  else { verdict = "Quiet period likely"; tier = "poor"; }
  return { total, verdict, tier };
}

// ---------- Weather fetch (same Open-Meteo fields the main app uses) ----------
async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_direction_10m,surface_pressure,precipitation,uv_index` +
    `&hourly=surface_pressure,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility,precipitation` +
    `&forecast_days=1&timezone=auto`;
  const req = new Request(url);
  req.timeoutInterval = 8;
  return await req.loadJSON();
}

// ---------- Build the widget ----------
async function buildWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = COLOR.bg;
  if (RAYLIGHT_APP_URL) widget.url = RAYLIGHT_APP_URL;
  widget.setPadding(14, 14, 14, 14);

  const loc = await resolveLocation();
  if (!loc) {
    widget.addText("Location needed").font = Font.boldSystemFont(14);
    const p = widget.addText("Open the Raylight script once in Scriptable to grant location access, or set a lat,lon widget parameter.");
    p.font = Font.systemFont(11);
    p.textColor = COLOR.muted;
    widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
    return widget;
  }

  const now = new Date();
  let weatherData, usedCache = false;
  try {
    weatherData = await fetchWeather(loc.lat, loc.lon);
    saveCache({ ts: now.getTime(), weatherData });
  } catch (e) {
    const cached = loadCache();
    if (cached) { weatherData = cached.weatherData; usedCache = true; }
  }

  const pos = getSunPosition(now, loc.lat, loc.lon);
  const elevationDeg = pos.altitude * (180 / Math.PI);
  const times = getSunTimes(now, loc.lat, loc.lon);
  const nearNow = Math.abs(now - times.sunrise) <= Math.abs(now - times.sunset) ? "sunrise" : "sunset";
  const eventTime = times[nearNow];

  // Header row: brand mark + name
  const header = widget.addStack();
  header.centerAlignContent();
  const mark = header.addText("☀");
  mark.font = Font.systemFont(13);
  mark.textColor = COLOR.terracotta;
  header.addSpacer(5);
  const title = header.addText("RAYLIGHT");
  title.font = Font.boldSystemFont(11);
  title.textColor = COLOR.navy;
  header.addSpacer();
  const timeFmt = new DateFormatter();
  timeFmt.dateFormat = "h:mm a";
  const eventLabel = header.addText(`${nearNow === "sunrise" ? "Sunrise" : "Sunset"} ${timeFmt.string(eventTime)}`);
  eventLabel.font = Font.systemFont(10);
  eventLabel.textColor = COLOR.muted;

  widget.addSpacer(10);

  if (!weatherData) {
    const err = widget.addText("No data - check connection");
    err.font = Font.systemFont(12);
    err.textColor = COLOR.rust;
    widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
    return widget;
  }

  const idx = nearestHourIndex(weatherData.hourly, eventTime);
  const quality = idx !== -1 ? computeSunQuality(
    weatherData.hourly.cloud_cover_low[idx],
    weatherData.hourly.cloud_cover_mid[idx],
    weatherData.hourly.cloud_cover_high[idx],
    weatherData.hourly.relative_humidity_2m[idx]
  ) : { score: 0, label: "n/a" };
  const bird = computeBirdScore(now, times, weatherData, elevationDeg);

  // Main row: two stat blocks side by side
  const row = widget.addStack();
  row.layoutHorizontally();

  const lightBlock = row.addStack();
  lightBlock.layoutVertically();
  const lightPct = lightBlock.addText(`${quality.score}%`);
  lightPct.font = Font.boldSystemFont(26);
  lightPct.textColor = tierColor(quality.label.toLowerCase());
  const lightSub = lightBlock.addText(`Light - ${quality.label}`);
  lightSub.font = Font.systemFont(10);
  lightSub.textColor = COLOR.muted;

  row.addSpacer();

  const birdBlock = row.addStack();
  birdBlock.layoutVertically();
  const birdNum = birdBlock.addText(`${bird.total}`);
  birdNum.font = Font.boldSystemFont(26);
  birdNum.textColor = tierColor(bird.tier);
  const birdSub = birdBlock.addText("Bird activity");
  birdSub.font = Font.systemFont(10);
  birdSub.textColor = COLOR.muted;

  widget.addSpacer(8);
  const footer = widget.addText(usedCache ? `Cached - as of ${timeFmt.string(new Date(loadCache().ts))}` : `Updated ${timeFmt.string(now)}`);
  footer.font = Font.systemFont(9);
  footer.textColor = usedCache ? COLOR.rust : COLOR.muted;

  widget.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  return widget;
}

// ---------- Entry point ----------
const widget = await buildWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // Manual run from inside Scriptable (e.g. first-time setup to grant
  // location access) - show a preview instead of just exiting silently.
  widget.presentSmall();
}
Script.complete();
