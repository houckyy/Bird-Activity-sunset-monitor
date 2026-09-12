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
    `&current=temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,surface_pressure,precipitation` +
    `&hourly=surface_pressure,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility` +
    `&past_days=1&forecast_days=7&timezone=auto`;
  const res = await fetch(url);
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

function computeSunQuality(low, mid, high, humidity) {
  const base = triangularScore(high, 40, 60) * 0.55 + triangularScore(mid, 35, 60) * 0.45;
  const lowMult = Math.max(0, 1 - low / 65);
  const humMult = Math.max(0.35, 1 - Math.max(0, humidity - 55) / 60);
  const score = Math.round(Math.max(0, Math.min(100, base * lowMult * humMult)));
  let label;
  if (score >= 75) label = "Great";
  else if (score >= 55) label = "Good";
  else if (score >= 32) label = "Fair";
  else label = "Poor";
  return { score, label };
}

function qualityAt(hourly, date) {
  const idx = nearestHourIndex(hourly, date);
  if (idx === -1) return { score: 0, label: "n/a" };
  return computeSunQuality(
    hourly.cloud_cover_low[idx],
    hourly.cloud_cover_mid[idx],
    hourly.cloud_cover_high[idx],
    hourly.relative_humidity_2m[idx]
  );
}

// Kept in sync with the .tier-* colors in style.css so ring sweeps, outlook
// scores, and the verdict text all read as one consistent color language.
function qualityColor(label) {
  switch (label) {
    case "Great": return "#ffda8c"; // Golden Pollen
    case "Good": return "#5fc2cc";  // Teal
    case "Fair": return "#d1b06a";  // muted gold
    default: return "#e2665f";      // Scarlet Rush
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

function weatherFactor(current, trendHpa) {
  let score = 100;
  const wind = current.wind_speed_10m; // km/h from Open-Meteo default
  const precip = current.precipitation; // mm
  const temp = current.temperature_2m; // C

  // Wind: activity drops sharply above ~20 km/h, birds shelter in high wind.
  if (wind > 35) score -= 45;
  else if (wind > 20) score -= 25;
  else if (wind > 10) score -= 8;

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
  const weather = weatherFactor(weatherData.current, trend);
  const season = seasonalFactor(now);

  // Weather and season are MODIFIERS on the diel gate (roughly +-45% and
  // +-30% swings), not independent additive scores - that's what stops
  // "great weather + migration season" from producing a nonzero score at
  // 2 AM when there is no diurnal activity potential to modulate.
  const weatherMult = 0.55 + (weather / 100) * 0.6;   // 0.55 - 1.15
  const seasonMult = 0.7 + (season / 100) * 0.5;      // 0.70 - 1.20

  const total = Math.round(Math.max(0, Math.min(100, diel * weatherMult * seasonMult)));

  let verdict, tier;
  if (total >= 75) { verdict = "High activity likely"; tier = "great"; }
  else if (total >= 50) { verdict = "Moderate activity likely"; tier = "good"; }
  else if (total >= 25) { verdict = "Low activity likely"; tier = "fair"; }
  else { verdict = "Quiet period likely"; tier = "poor"; }

  return {
    total, verdict, tier,
    factors: {
      "Daylight/twilight position": diel,
      "Weather modifier": `x${weatherMult.toFixed(2)}`,
      "Season/migration modifier": `x${seasonMult.toFixed(2)}`,
      "Pressure trend (3h)": `${trend.toFixed(2)} hPa`
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

function renderSun(loc, now, sunToday, sunTomorrow, utcOffsetSeconds) {
  const phase = classifyPhase(now, sunToday.times);
  document.getElementById("sun-phase").textContent = phase;
  document.getElementById("sun-elevation").textContent = `Elevation: ${sunToday.elevationDeg.toFixed(1)}°`;
  applyPhaseTheme(phase);

  const t = sunToday.times;
  const ft = (d) => fmtTime(d, utcOffsetSeconds);
  const blueIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v3M4.2 6.2l2 2M2 13h3M19 13h3M17.8 8.2l2-2"/><path d="M6 19a6 6 0 0 1 12 0"/></svg>';
  const goldIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="13" r="3.4"/><path d="M12 6.5V4M5.6 9.6 4 8M18.4 9.6 20 8M3 17h18"/></svg>';
  const noonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
  const rows = [
    [blueIcon, "Blue hour (dawn)", `${ft(t.nauticalDawn)} - ${ft(t.dawn)}`],
    [goldIcon, "Golden hour (sunrise)", `${ft(t.sunrise)} - ${ft(t.goldenHourEnd)}`],
    [noonIcon, "Solar noon", ft(t.solarNoon)],
    [goldIcon, "Golden hour (sunset)", `${ft(t.goldenHour)} - ${ft(t.sunset)}`],
    [blueIcon, "Blue hour (dusk)", `${ft(t.dusk)} - ${ft(t.nauticalDusk)}`]
  ];
  const tbody = document.querySelector("#sun-times tbody");
  tbody.innerHTML = rows.map(([icon, k, v]) => `<tr><td><span class="row-icon">${icon}</span>${k}</td><td>${v}</td></tr>`).join("");
  if (utcOffsetSeconds == null) {
    tbody.innerHTML += `<tr><td colspan="2" style="color:var(--muted);font-size:0.78rem;">Times shown in your device's timezone until weather data confirms the location's actual timezone.</td></tr>`;
  }
  return phase;
}

function renderTodayQuality(times, weatherData) {
  const qSunrise = qualityAt(weatherData.hourly, times.sunrise);
  const qSunset = qualityAt(weatherData.hourly, times.sunset);
  animateNumber(document.getElementById("q-sunrise"), qSunrise.score, { suffix: "%" });
  document.getElementById("q-sunrise-label").textContent = qSunrise.label;
  animateNumber(document.getElementById("q-sunset"), qSunset.score, { suffix: "%" });
  document.getElementById("q-sunset-label").textContent = qSunset.label;
  paintRing(document.getElementById("ring-sunrise"), qSunrise.score, qSunrise.label);
  paintRing(document.getElementById("ring-sunset"), qSunset.score, qSunset.label);
}

function renderOutlook(loc, weatherData) {
  const grid = document.getElementById("outlook-grid");
  grid.innerHTML = "";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let d = 0; d < 7; d++) {
    const day = new Date();
    day.setDate(day.getDate() + d);
    const { times } = computeSun(loc, day);
    const qSunrise = qualityAt(weatherData.hourly, times.sunrise);
    const qSunset = qualityAt(weatherData.hourly, times.sunset);
    const el = document.createElement("div");
    el.className = "outlook-day" + (d === 0 ? " is-today" : "");
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
    ["temp", "Temperature", `${c.temperature_2m}°C`],
    ["humid", "Humidity", `${c.relative_humidity_2m}%`],
    ["pressure", "Pressure trend (3h)", `${trend >= 0 ? "+" : ""}${trend.toFixed(2)} hPa`]
  ];
  const tbody = document.querySelector("#weather-table tbody");
  tbody.innerHTML = rows.map(([icon, k, v]) =>
    `<tr><td><span class="row-icon">${rowIcons[icon]}</span>${k}</td><td>${v}</td></tr>`
  ).join("");
}

function renderBird(score) {
  animateNumber(document.getElementById("bird-score"), score.total);
  const verdictEl = document.getElementById("bird-verdict");
  verdictEl.textContent = score.verdict;
  verdictEl.className = "big-stat small tier-" + score.tier;
  document.getElementById("bird-fill").style.width = score.total + "%";
  const grid = document.getElementById("bird-factors");
  grid.innerHTML = Object.entries(score.factors).map(([k, v]) =>
    `<div class="factor"><div class="fname">${k}</div><div class="fval">${v}</div></div>`
  ).join("");
}

function renderAbout() {
  document.getElementById("about-content").innerHTML = `
    <h3>Sun &amp; light</h3>
    <p>Sun position and twilight/golden/blue hour boundaries are computed on-device from the standard low-precision solar position algorithm (Jean Meeus, <em>Astronomical Algorithms</em>) using your coordinates and the current time - pure astronomical geometry, no network call and no external script required. Blue hour is approximated as the window between nautical twilight and civil twilight (sun roughly -6&deg; to -8&deg; below the horizon), matching common photographic convention.</p>
    <h3>Sunrise/sunset quality (%)</h3>
    <p>Built from Open-Meteo's altitude-banded cloud cover (low/mid/high) and humidity at the exact sunrise/sunset hour, for today and the next 7 days. The logic: high and mid clouds are what catch and scatter low-angle sunlight into color, so a moderate amount of them (roughly 30-50%, not zero, not solid overcast) scores highest; low clouds sitting on the horizon block the sun's light path before it can light anything up, so more low cloud cover drags the score toward zero regardless of the high/mid layers; high humidity scatters and mutes saturation, so it further discounts the score. This is the same category of model commercial sunset-prediction apps use, built here from the raw altitude-banded data rather than a proprietary formula - it is a genuine physical estimate, not a guess, but it is not calibrated against photographed outcomes the way a paid app with a large feedback dataset might be.</p>
    <h3>Weather &amp; exposure</h3>
    <p>Cloud cover, wind, temperature, humidity, and pressure come from <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (no API key, hourly-resolution model/observation blend). The ISO suggestion assumes bird-in-flight shutter speeds (~1/1600-1/2500s) are fixed, so ISO is the variable absorbing light loss - it is a heuristic based on sun elevation and cloud cover, not a light-meter reading.</p>
    <h3>Bird activity meter - read this before trusting it</h3>
    <p><strong>This is a heuristic model, not a live feed of actual bird counts.</strong> There is no public API that returns real-time species activity intensity for a coordinate. The score is a weighted composite of three real, measured inputs:</p>
    <p><strong>Daylight/twilight position</strong> is the gate, not just one input among several: a daytime baseline (with the documented midday activity lull), a sharp bonus right at sunrise/sunset for the dawn-chorus and pre-roost feeding peaks, and a low floor at full night. Weather and season only modulate this gate - they cannot manufacture a "moderate activity" reading at 2 AM just because the barometric trend looks good, which an earlier additive version of this model actually did.</p>
    <p><strong>Weather modifier (~0.55x-1.15x)</strong> - penalizes wind above ~20 km/h and active precipitation (both suppress flight/foraging activity), and gives a bonus for falling barometric pressure (pre-frontal foraging increase) with a penalty for sharply rising pressure.</p>
    <p><strong>Season/migration modifier (~0.70x-1.20x)</strong> - a fixed calendar bump for Northern Hemisphere spring (Apr-May) and fall (Sep-Oct) migration windows, moderate for breeding season (Jun-Jul), lower baseline for winter.</p>
    <p>This is tuned for diurnal and crepuscular species - passerines, woodpeckers, raptors, waterfowl. It is not built for owls or nocturnal migrants, and the night floor is a deliberate low baseline, not a claim that nothing moves after dark.</p>
    <p>Treat the number as a planning heuristic to decide when to go out, not a species-count prediction. If you want it grounded in actual observation frequency for your exact location, the next upgrade would be pulling recent eBird checklist frequency by hour for nearby hotspots (requires an eBird API key and more processing than this client-side tool does).</p>
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
async function refreshAll() {
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

    // re-render with the location's real UTC offset now that we have it
    renderSun(loc, now, sunToday, sunTomorrow, weatherData.utc_offset_seconds);
    renderTodayQuality(sunToday.times, weatherData);
    renderOutlook(loc, weatherData);
    renderWeather(sunToday, weatherData);
    const score = computeBirdScore(now, sunToday.times, weatherData, sunToday.elevationDeg);
    state.birdScore = score;
    renderBird(score);

    statusEl.textContent = "Updated " + now.toLocaleTimeString();
    liveTick(); // refresh the live-clock line immediately - otherwise it can
                // still show "(weather offline)" from the pre-fetch tick
                // until the next 15s interval fires
  } catch (err) {
    statusEl.textContent = "Sun/light times updated. Weather unavailable (" + err.message + ") - exposure, quality rings, outlook, and bird score need a connection.";
    console.error(err);
    showWeatherUnavailable();
  } finally {
    refreshBtn.classList.remove("is-loading");
    refreshBtn.disabled = false;
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
  const phase = renderSun(loc, now, sunToday, null, utcOffset);
  state.lastPhase = phase;

  if (state.weather) {
    const score = computeBirdScore(now, sunToday.times, state.weather, sunToday.elevationDeg);
    state.birdScore = score;
    renderBird(score);
  }

  document.getElementById("live-clock-text").textContent =
    "Live - " + now.toLocaleTimeString() + (state.weather ? "" : " (weather offline)");
}

function showWeatherUnavailable() {
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

// ---------- Wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  state.loc = loadLocation();
  setLocationLabel();
  renderAbout();
  renderLog();
  refreshAll();
  liveTick();

  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
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
