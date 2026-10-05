// Weather for the kitchen dashboard, fetched client-side.
//
// Open-Meteo needs no credential, so this never passes through the Function — which
// keeps /api/state to a single job and means the forecast still renders when Graph
// is briefly unavailable.
//
// The returned shape is deliberately identical to what the legacy server-side
// fetchWeather() produced ({ current, days }), so the existing renderer in app.js is
// untouched. The WMO code mappings below are ported verbatim for the same reason:
// changing them would silently change which icons appear.

(function (global) {
  'use strict';

  function iconFor(code) {
    if (code === 0) return 'sunny';
    if (code === 1 || code === 2) return 'partly-cloudy';
    if (code === 3) return 'cloudy';
    if (code >= 45 && code <= 48) return 'fog';
    if (code >= 51 && code <= 67) return 'rain';
    if (code >= 71 && code <= 77) return 'snow';
    if (code >= 80 && code <= 82) return 'rain';
    if (code >= 85 && code <= 86) return 'snow';
    if (code >= 95 && code <= 99) return 'thunderstorm';
    return 'cloudy';
  }

  function describeCode(code) {
    if (code === 0) return 'Clear sky';
    if (code === 1) return 'Mainly clear';
    if (code === 2) return 'Partly cloudy';
    if (code === 3) return 'Overcast';
    if (code >= 45 && code <= 48) return 'Fog';
    if (code >= 51 && code <= 55) return 'Drizzle';
    if (code >= 56 && code <= 57) return 'Freezing drizzle';
    if (code >= 61 && code <= 65) return 'Rain';
    if (code === 66 || code === 67) return 'Freezing rain';
    if (code >= 71 && code <= 75) return 'Snow';
    if (code === 77) return 'Snow grains';
    if (code >= 80 && code <= 82) return 'Rain showers';
    if (code >= 85 && code <= 86) return 'Snow showers';
    if (code === 95) return 'Thunderstorm';
    if (code >= 96 && code <= 99) return 'Thunderstorm';
    return 'Unknown';
  }

  /**
   * Times come back already expressed in the requested location's zone (timezone=auto
   * on the request), so they are formatted as wall-clock without re-interpreting them
   * against the device's own zone — which would shift sunrise when the chosen location
   * differs from where the tablet sits.
   */
  function formatLocalTime(value) {
    if (!value) return null;
    var t = String(value).split('T')[1];
    if (!t) return null;
    var parts = t.split(':');
    var h = parseInt(parts[0], 10);
    var m = parts[1] || '00';
    var suffix = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + m + ' ' + suffix;
  }

  /**
   * US AQI bands, per the EPA scale the numbers are reported on. Colours are the
   * EPA's own, not invented — people recognise "orange day" from forecasts and news,
   * so matching them makes the tile readable at a glance from across the kitchen.
   */
  function aqiBand(aqi) {
    if (aqi == null || isNaN(aqi)) return null;
    if (aqi <= 50)  return { label: 'Good',            color: '#00E400', ink: '#0b2b0b' };
    if (aqi <= 100) return { label: 'Moderate',        color: '#FFFF00', ink: '#2b2b00' };
    if (aqi <= 150) return { label: 'Sensitive groups', color: '#FF7E00', ink: '#2b1400' };
    if (aqi <= 200) return { label: 'Unhealthy',       color: '#FF0000', ink: '#ffffff' };
    if (aqi <= 300) return { label: 'Very unhealthy',  color: '#8F3F97', ink: '#ffffff' };
    return              { label: 'Hazardous',          color: '#7E0023', ink: '#ffffff' };
  }

  function buildAirUrl(location) {
    var p = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: 'pm2_5,pm10,us_aqi',
      timezone: 'auto',
      forecast_days: '1',
    });
    return 'https://air-quality-api.open-meteo.com/v1/air-quality?' + p.toString();
  }

  /**
   * The AQI number itself comes from /api/air — a real reporting ground station, via
   * WAQI. Open-Meteo's own us_aqi is a 45km model grid cell with no US stations in it
   * and reads a full band high (see api/src/lib/air.js), so it is now only the
   * fallback for when the station call fails.
   *
   * Resolved against the document, not the site root, for the same reason /api/state
   * is: this may be mounted under a prefix by Tailscale Serve.
   */
  async function fetchStationAir() {
    var loc = global.KitchenLocation.get();
    var url = new URL(
      'api/air?lat=' + encodeURIComponent(loc.latitude) + '&lon=' + encodeURIComponent(loc.longitude),
      global.document.baseURI
    ).toString();

    var res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('air HTTP ' + res.status);
    var data = await res.json();
    return data && data.aqi != null ? data : null;
  }

  /**
   * Open-Meteo's PM2.5 / PM10, which are CONCENTRATIONS in µg/m³. WAQI reports its
   * per-pollutant figures as AQI sub-indices instead, so they cannot be swapped in
   * here — same field names, different units, and the popup states µg/m³ explicitly.
   */
  async function fetchConcentrations(location) {
    var res = await fetch(buildAirUrl(location), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('AQI HTTP ' + res.status);
    var data = await res.json();
    return data.current || {};
  }

  /**
   * Air quality gets its own request and its own failure. Returns null rather than
   * throwing: smoke data going missing must never cost us the forecast, which is the
   * tile's primary job.
   *
   * Station and concentrations are independent — settled, not all() — so losing either
   * still leaves the other on screen.
   */
  async function fetchAir(location) {
    var results = await Promise.allSettled([
      fetchStationAir(),
      fetchConcentrations(location),
    ]);

    var station = results[0].status === 'fulfilled' ? results[0].value : null;
    var conc = results[1].status === 'fulfilled' ? results[1].value : {};

    if (results[0].status === 'rejected') {
      console.error('Station AQI failed:', results[0].reason && results[0].reason.message);
    }
    if (results[1].status === 'rejected') {
      console.error('Concentrations failed:', results[1].reason && results[1].reason.message);
    }

    // Station first; Open-Meteo's modelled value only if the station is unreachable,
    // so the tile degrades to "roughly right" rather than to nothing.
    var aqi = null;
    var modelled = false;
    if (station && station.aqi != null) {
      aqi = Math.round(station.aqi);
    } else if (conc.us_aqi != null) {
      aqi = Math.round(conc.us_aqi);
      modelled = true;
    }
    if (aqi == null) return null;

    var band = aqiBand(aqi);
    return {
      aqi: aqi,
      label: band ? band.label : '',
      color: band ? band.color : null,
      ink: band ? band.ink : null,
      pm25: conc.pm2_5 == null ? null : Math.round(conc.pm2_5 * 10) / 10,
      pm10: conc.pm10 == null ? null : Math.round(conc.pm10 * 10) / 10,
      // Provenance, so the popup can say which station and how far — and so a
      // fallback reading is never passed off as a measured one.
      station: station ? station.station : null,
      distanceKm: station ? station.distanceKm : null,
      observedAt: station ? station.observedAt : null,
      attributions: station && station.attributions ? station.attributions : [],
      modelled: modelled,
    };
  }

  function buildUrl(location) {
    var p = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,' +
             'precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      // Derived from the coordinates, so the forecast's clock always matches the
      // place being shown rather than wherever the tablet happens to be.
      timezone: 'auto',
      forecast_days: '4',
    });
    return 'https://api.open-meteo.com/v1/forecast?' + p.toString();
  }

  function shape(data) {
    var daily = data.daily;
    if (!daily || !daily.time) return null;

    // Only the first tile gets a relative name — it is rendered as "Now" with live
    // conditions. Every other tile is a weekday, so "Tomorrow" sitting between "Now"
    // and "Mon" mixed two labelling schemes in one row and made the row harder to scan.
    var labels = ['Today'];
    var days = [];

    for (var i = 0; i < 4 && i < daily.time.length; i++) {
      var code = daily.weather_code[i];
      var label = labels[i];
      if (!label) {
        // Midday avoids the date rolling backwards in zones behind the parser.
        label = new Date(daily.time[i] + 'T12:00:00')
          .toLocaleDateString('en-US', { weekday: 'short' });
      }
      days.push({
        label: label,
        high: Math.round(daily.temperature_2m_max[i]),
        low: Math.round(daily.temperature_2m_min[i]),
        icon: iconFor(code),
        desc: describeCode(code),
      });
    }

    var cur = data.current;
    var current = cur ? {
      temp: Math.round(cur.temperature_2m),
      humidity: Math.round(cur.relative_humidity_2m),
      icon: iconFor(cur.weather_code),
      desc: describeCode(cur.weather_code),
      isDay: cur.is_day === 1,
      windMph: Math.round(cur.wind_speed_10m),
      windMaxMph: daily.wind_speed_10m_max ? Math.round(daily.wind_speed_10m_max[0]) : null,
      uvIndex: daily.uv_index_max ? Math.round(daily.uv_index_max[0] * 10) / 10 : null,
      precipChance: daily.precipitation_probability_max ? daily.precipitation_probability_max[0] : null,
      sunrise: daily.sunrise ? formatLocalTime(daily.sunrise[0]) : null,
      sunset: daily.sunset ? formatLocalTime(daily.sunset[0]) : null,
    } : null;

    return { days: days, current: current, timezone: data.timezone || null };
  }

  /** Fetch and shape the forecast. Returns null rather than throwing: a missing
   *  forecast should never take the calendar down with it. */
  async function fetchWeather(location, retries) {
    var attempts = (retries === undefined ? 2 : retries) + 1;

    for (var attempt = 0; attempt < attempts; attempt++) {
      try {
        // Forecast and air quality are separate endpoints; request them together so
        // AQI costs no extra wall-clock time on a kitchen tablet's connection.
        var both = await Promise.all([
          fetch(buildUrl(location), { signal: AbortSignal.timeout(10000) }),
          fetchAir(location),
        ]);
        var res = both[0];
        if (!res.ok) throw new Error('Weather HTTP ' + res.status);
        var shaped = shape(await res.json());
        if (shaped) shaped.air = both[1];
        return shaped;
      } catch (err) {
        if (attempt === attempts - 1) {
          console.error('Weather failed:', err.message);
          return null;
        }
        await new Promise(function (r) { setTimeout(r, 2000); });
      }
    }
    return null;
  }

  global.KitchenWeather = {
    fetch: fetchWeather,
    // exported for tests
    iconFor: iconFor,
    aqiBand: aqiBand,
    describeCode: describeCode,
    formatLocalTime: formatLocalTime,
    shape: shape,
  };
})(window);
