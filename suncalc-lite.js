/* suncalc-lite.js
   Self-contained solar position / sun-times module. No network dependency.
   Implements the standard low-precision solar position algorithm
   (Jean Meeus, "Astronomical Algorithms") in the same form used by the
   widely-deployed SunCalc.js library, reimplemented here directly so this
   app has no external script dependency (relevant for field use with
   unreliable signal). Exposes the same shape as SunCalc: getPosition() and
   getTimes().
*/
(function (global) {
  "use strict";

  const PI = Math.PI;
  const rad = PI / 180;
  const dayMs = 1000 * 60 * 60 * 24;
  const J1970 = 2440588;
  const J2000 = 2451545;

  function toJulian(date) { return date.getTime() / dayMs - 0.5 + J1970; }
  function fromJulian(j) { return new Date((j + 0.5 - J1970) * dayMs); }
  function toDays(date) { return toJulian(date) - J2000; }

  const e = rad * 23.4397; // obliquity of the Earth

  function rightAscension(l, b) {
    return Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  }
  function declination(l, b) {
    return Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  }
  function azimuth(H, phi, dec) {
    return Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  }
  function altitude(H, phi, dec) {
    return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  }
  function siderealTime(d, lw) {
    return rad * (280.16 + 360.9856235 * d) - lw;
  }
  function astroRefraction(h) {
    if (h < 0) h = 0;
    return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
  }

  function solarMeanAnomaly(d) {
    return rad * (357.5291 + 0.98560028 * d);
  }
  function eclipticLongitude(M) {
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const P = rad * 102.9372; // perihelion of Earth
    return M + C + P + PI;
  }
  function sunCoords(d) {
    const M = solarMeanAnomaly(d);
    const L = eclipticLongitude(M);
    return { dec: declination(L, 0), ra: rightAscension(L, 0) };
  }

  function getPosition(date, lat, lng) {
    const lw = rad * -lng;
    const phi = rad * lat;
    const d = toDays(date);
    const c = sunCoords(d);
    const H = siderealTime(d, lw) - c.ra;
    return {
      azimuth: azimuth(H, phi, c.dec),
      altitude: altitude(H, phi, c.dec)
    };
  }

  const J0 = 0.0009;
  function julianCycle(d, lw) { return Math.round(d - J0 - lw / (2 * PI)); }
  function approxTransit(Ht, lw, n) { return J0 + (Ht + lw) / (2 * PI) + n; }
  function solarTransitJ(ds, M, L) { return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L); }
  function hourAngle(h, phi, d) {
    return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));
  }
  function observerAngle(height) { return -2.076 * Math.sqrt(height) / 60; }

  function getSetJ(h, lw, phi, dec, n, M, L) {
    const w = hourAngle(h, phi, dec);
    const a = approxTransit(w, lw, n);
    return solarTransitJ(a, M, L);
  }

  const DEFAULT_TIMES = [
    [-0.833, "sunrise", "sunset"],
    [-0.3, "sunriseEnd", "sunsetStart"],
    [-6, "dawn", "dusk"],
    [-12, "nauticalDawn", "nauticalDusk"],
    [-18, "nightEnd", "night"],
    [6, "goldenHourEnd", "goldenHour"]
  ];

  function getTimes(date, lat, lng, height) {
    height = height || 0;
    const lw = rad * -lng;
    const phi = rad * lat;
    const dh = observerAngle(height);
    const d = toDays(date);
    const n = julianCycle(d, lw);
    const ds = approxTransit(0, lw, n);
    const M = solarMeanAnomaly(ds);
    const L = eclipticLongitude(M);
    const dec = declination(L, 0);
    const Jnoon = solarTransitJ(ds, M, L);

    const result = {
      solarNoon: fromJulian(Jnoon),
      nadir: fromJulian(Jnoon - 0.5)
    };

    for (const [angle, riseName, setName] of DEFAULT_TIMES) {
      const h0 = (angle + dh) * rad;
      const Jset = getSetJ(h0, lw, phi, dec, n, M, L);
      const Jrise = Jnoon - (Jset - Jnoon);
      result[riseName] = fromJulian(Jrise);
      result[setName] = fromJulian(Jset);
    }
    return result;
  }

  global.SunCalcLite = { getPosition, getTimes };
})(typeof window !== "undefined" ? window : globalThis);
