function toLocalDateFromGraph(start) {
  if (!start || !start.dateTime) return null;
  if (start.timeZone === 'UTC') {
    return new Date(start.dateTime + 'Z');
  }
  return new Date(start.dateTime);
}

// Keyword-based emoji matching for events
const emojiKeywords = [
  { keywords: ['movie', 'film', 'cinema', 'theater'], emoji: '🎬' },
  { keywords: ['party', 'celebration', 'super bowl', 'game day'], emoji: '🎉' },
  { keywords: ['dinner', 'lunch', 'breakfast', 'restaurant', 'eat'], emoji: '🍽️' },
  { keywords: ['birthday'], emoji: '🎂' },
  { keywords: ['concert', 'music', 'show'], emoji: '🎵' },
  { keywords: ['travel', 'trip', 'vacation', 'flight', 'airport'], emoji: '✈️' },
  { keywords: ['meeting', 'work', 'office'], emoji: '💼' },
  { keywords: ['doctor', 'dentist', 'appointment', 'medical'], emoji: '🏥' },
  { keywords: ['school', 'class', 'graduation'], emoji: '🎓' },
  { keywords: ['wedding', 'anniversary'], emoji: '💍' },
  { keywords: ['camping', 'hike', 'outdoor'], emoji: '🏕️' },
  { keywords: ['game', 'play', 'sports'], emoji: '🏈' },
  { keywords: ['nail', 'salon', 'spa'], emoji: '💅' },
  { keywords: ['prom', 'dance'], emoji: '💃' },
];

const fallbackEmojis = ['🌟', '✨', '💫', '⭐', '🎯', '📌'];

function getEventEmoji(subject) {
  const lower = subject.toLowerCase();
  
  // Check for keyword matches
  for (const { keywords, emoji } of emojiKeywords) {
    if (keywords.some(kw => lower.includes(kw))) {
      return emoji;
    }
  }
  
  // Fallback: consistent emoji based on hash
  const hash = subject.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return fallbackEmojis[hash % fallbackEmojis.length];
}

// Animated weather icons by Bas Milius (MIT) — https://github.com/basmilius/weather-icons
// Maps dashboard icon keys to local SVG filenames in weather-icons/
const weatherIconFiles = {
  sunny:                'clear-day',
  clear:                'clear-day',
  'clear-night':        'clear-night',
  'partly-cloudy':      'partly-cloudy-day',
  'partly-cloudy-night':'partly-cloudy-night',
  cloudy:               'overcast',
  overcast:             'overcast',
  'overcast-day':       'overcast-day',
  drizzle:              'drizzle',
  rain:                 'rain',
  snow:                 'snow',
  thunderstorm:         'thunderstorms-rain',
  fog:                  'fog',
  mist:                 'mist',
  'uv-index-1':         'uv-index-1',
  'uv-index-2':         'uv-index-2',
  'uv-index-3':         'uv-index-3',
  'uv-index-4':         'uv-index-4',
  'uv-index-5':         'uv-index-5',
  'uv-index-6':         'uv-index-6',
  'uv-index-7':         'uv-index-7',
  'uv-index-8':         'uv-index-8',
  'uv-index-9':         'uv-index-9',
  'uv-index-10':        'uv-index-10',
  'uv-index-11':        'uv-index-11',
  sunrise:              'sunrise',
  sunset:               'sunset',
  'moon-new':           'moon-new',
  'moon-waxing-crescent':'moon-waxing-crescent',
  'moon-first-quarter': 'moon-first-quarter',
  'moon-waxing-gibbous':'moon-waxing-gibbous',
  'moon-full':          'moon-full',
  'moon-waning-gibbous':'moon-waning-gibbous',
  'moon-last-quarter':  'moon-last-quarter',
  'moon-waning-crescent':'moon-waning-crescent',
  // Additional common weather condition mappings
  haze:                 'mist',
  windy:                'overcast',
  hot:                  'clear-day',
  cold:                 'snow',
  'mostly-cloudy':      'overcast',
  'mostly-cloudy-night':'overcast',
  'partly-sunny':       'partly-cloudy-day',
  'partly-cloudy-day':  'partly-cloudy-day',
  sleet:                'rain',
  ice:                  'snow',
  'freezing-rain':      'rain',
  'light-rain':         'drizzle',
  'heavy-rain':         'rain',
  'light-snow':         'snow',
  'heavy-snow':         'snow',
  'scattered-showers':  'drizzle',
  'isolated-thunderstorms': 'thunderstorms-rain',
  smoke:                'fog',
  dust:                 'fog',
  blizzard:             'snow'
};

// Track last successful weather refresh time
let lastWeatherRefresh = null;

function getWeatherIcon(iconName) {
  const file = weatherIconFiles[iconName] || 'not-available';
  if (!weatherIconFiles[iconName] && iconName) {
    console.warn('Unmapped weather icon:', iconName);
  }
  return `<object class="weather-icon-inner" type="image/svg+xml" data="weather-icons/${file}.svg" aria-label="${iconName || ''}"></object>`;
}

// ---- Event detail popup ----
// Convert URLs in plain text to clickable links
function linkifyUrls(text) {
  return text.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function showEventPopup(ev) {
  const overlay = document.getElementById('event-popup');
  const content = document.getElementById('event-popup-content');
  if (!overlay || !content) return;

  const emoji = getEventEmoji(ev.subject);
  const startDt = toLocalDateFromGraph(ev.start);
  const endDt = toLocalDateFromGraph(ev.end);

  let timeRange = 'All Day';
  if (!ev.isAllDay && startDt) {
    const startStr = startDt.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
    if (endDt) {
      // Same day: show "Sat, Apr 18, 6:00 PM – 9:00 PM"
      // Different day: show full range
      const sameDay = startDt.toDateString() === endDt.toDateString();
      const endStr = sameDay
        ? endDt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : endDt.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      timeRange = startStr + ' – ' + endStr;
    } else {
      timeRange = startStr;
    }
  } else if (startDt) {
    timeRange = startDt.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + ' (All Day)';
  }

  // Sanitize text content to prevent XSS
  function esc(str) {
    const el = document.createElement('div');
    el.textContent = str;
    return el.innerHTML;
  }

  // Strip HTML tags from body content (Outlook can include HTML)
  function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  }

  let bodyHtml = '';

  // Location
  const loc = ev.location && (typeof ev.location === 'string' ? ev.location : ev.location.displayName);
  if (loc) {
    bodyHtml += '<div class="event-popup-field"><span class="event-popup-field-label">Location</span><span class="event-popup-field-value">' + esc(loc) + '</span></div>';
  }

  // Attendees / Invitees
  if (ev.attendees && ev.attendees.length) {
    const names = ev.attendees.map(a => {
      const name = (a.emailAddress && a.emailAddress.name) || (a.emailAddress && a.emailAddress.address) || a.name || a.email || '';
      return esc(name);
    }).filter(Boolean);
    if (names.length) {
      bodyHtml += '<div class="event-popup-field"><span class="event-popup-field-label">Invitees</span><span class="event-popup-field-value">' + names.join(', ') + '</span></div>';
    }
  }

  // Organizer
  if (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.name) {
    bodyHtml += '<div class="event-popup-field"><span class="event-popup-field-label">Organizer</span><span class="event-popup-field-value">' + esc(ev.organizer.emailAddress.name) + '</span></div>';
  }

  // Description / Body
  const bodyText = ev.bodyPreview || (ev.body && (ev.body.contentType === 'text' ? ev.body.content : stripHtml(ev.body.content))) || '';
  if (bodyText.trim()) {
    bodyHtml += '<div class="event-popup-field event-popup-desc"><span class="event-popup-field-label">Description</span><div class="event-popup-field-value event-popup-body-text">' + linkifyUrls(esc(bodyText.trim())) + '</div></div>';
  }

  if (!bodyHtml && !loc) {
    bodyHtml = '<div class="event-popup-field" style="opacity:0.5">No additional details available.</div>';
  }

  content.innerHTML =
    '<div class="event-popup-title">' + emoji + ' ' + esc(ev.subject) + '</div>' +
    '<div class="event-popup-time">' + esc(timeRange) + '</div>' +
    '<div class="event-popup-details">' + bodyHtml + '</div>';

  overlay.style.display = 'flex';
}

function showCountdownPopup(cd) {
  const overlay = document.getElementById('event-popup');
  const content = document.getElementById('event-popup-content');
  if (!overlay || !content) return;

  function esc(str) {
    const el = document.createElement('div');
    el.textContent = str;
    return el.innerHTML;
  }

  // Date range
  let dateStr = '';
  if (cd.start) {
    const startDt = toLocalDateFromGraph(cd.start) || new Date(cd.start.dateTime);
    const endDt = cd.end ? (toLocalDateFromGraph(cd.end) || new Date(cd.end.dateTime)) : null;
    if (startDt) {
      const startStr = startDt.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      if (endDt && endDt.toDateString() !== startDt.toDateString()) {
        const endStr = endDt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        dateStr = startStr + ' \u2013 ' + endStr;
      } else {
        dateStr = startStr;
      }
    }
  }

  // Build detail fields (same as showEventPopup)
  let bodyHtml = '';

  // Countdown badge
  bodyHtml += '<div class="event-popup-countdown-big">' + cd.days + ' <span>days</span></div>';

  // Location
  if (cd.location) {
    bodyHtml += '<div class="event-popup-field"><span class="event-popup-field-label">Location</span><span class="event-popup-field-value">' + esc(cd.location) + '</span></div>';
  }

  // Attendees
  if (cd.attendees && cd.attendees.length) {
    const names = cd.attendees.map(a => esc(a.name || a.email || '')).filter(Boolean);
    if (names.length) {
      bodyHtml += '<div class="event-popup-field"><span class="event-popup-field-label">Invitees</span><span class="event-popup-field-value">' + names.join(', ') + '</span></div>';
    }
  }

  // Organizer
  if (cd.organizer) {
    bodyHtml += '<div class="event-popup-field"><span class="event-popup-field-label">Organizer</span><span class="event-popup-field-value">' + esc(cd.organizer) + '</span></div>';
  }

  // Description
  const bodyText = cd.bodyPreview || '';
  if (bodyText.trim()) {
    bodyHtml += '<div class="event-popup-field event-popup-desc"><span class="event-popup-field-label">Description</span><div class="event-popup-field-value event-popup-body-text">' + linkifyUrls(esc(bodyText.trim())) + '</div></div>';
  }

  content.innerHTML =
    '<div class="event-popup-title">' + esc(cd.label) + '</div>' +
    '<div class="event-popup-time">' + (dateStr ? esc(dateStr) : '') + '</div>' +
    '<div class="event-popup-details">' + bodyHtml + '</div>';

  overlay.style.display = 'flex';
}

function hideEventPopup() {
  const overlay = document.getElementById('event-popup');
  if (overlay) overlay.style.display = 'none';
}

// Close event popup on overlay click, close button, or Escape key
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('event-popup');
  const closeBtn = document.getElementById('event-popup-close');
  if (closeBtn) closeBtn.addEventListener('click', hideEventPopup);
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideEventPopup();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideEventPopup();
  });
});

// ---- Weather detail popup ----
/**
 * Map an icon key to a background mood. Deliberately coarse — five buckets, not one
 * per WMO code — because the tile needs to read at a glance from across the kitchen,
 * and subtle distinctions between "drizzle" and "light rain" do not survive that.
 */
function skyClass(icon, isDay) {
  const k = String(icon || '');
  if (/thunder/.test(k)) return 'storm';
  if (/rain|drizzle/.test(k)) return 'rain';
  if (/snow|sleet|hail/.test(k)) return 'snow';
  if (/fog|mist|haze/.test(k)) return 'fog';
  if (/overcast|cloudy/.test(k) && !/partly/.test(k)) return 'cloud';
  if (/partly/.test(k)) return isDay === false ? 'night' : 'partly';
  if (/clear|sunny/.test(k) || /^uv-index/.test(k)) return isDay === false ? 'night' : 'clear';
  return 'cloud';
}

function showWeatherPopup(weather) {
  const cur = weather.current;
  const air = weather.air;
  const today = weather.days[0];
  if (!cur) return;

  const overlay = document.getElementById('weather-popup');
  const content = document.getElementById('weather-popup-content');
  if (!overlay || !content) return;

  // Station names and attributions come from an external feed and are interpolated
  // into innerHTML below, so they are escaped rather than trusted.
  const esc = (str) => {
    const el = document.createElement('div');
    el.textContent = str == null ? '' : String(str);
    return el.innerHTML;
  };

  // Where the AQI actually came from. A modelled fallback is labelled as one — the
  // whole point of the station feed is that the two are not interchangeable.
  let airSource = '';
  if (air && air.aqi != null) {
    if (air.modelled) {
      airSource = 'modelled estimate — no station';
    } else if (air.station) {
      airSource = esc(air.station) +
        (air.distanceKm != null ? ` · ${air.distanceKm} km` : '');
    }
  }

  // Apply UV index icon override (same logic as main tile)
  let popupIcon = cur.icon;
  if (cur.isDay && cur.uvIndex != null && cur.uvIndex >= 1 &&
      (cur.icon === 'sunny' || cur.icon === 'clear')) {
    const uvLevel = Math.min(Math.round(cur.uvIndex), 11);
    popupIcon = `uv-index-${uvLevel}`;
  }
  const iconHtml = getWeatherIcon(popupIcon);

  content.innerHTML = `
    <div class="weather-popup-body">
      <div class="weather-popup-left">
        <div class="popup-icon">${iconHtml}</div>
        <div class="popup-temp">${cur.temp != null ? cur.temp + '°' : '--°'}</div>
        <div class="popup-desc">${cur.desc || today.desc}</div>
      </div>
      <div class="weather-popup-right">
        <div class="weather-popup-grid">
          <div class="weather-popup-item">
            <div class="popup-item-label">High / Low</div>
            <div class="popup-item-value">${today.high}° / ${today.low}°</div>
          </div>
          <div class="weather-popup-item">
            <div class="popup-item-label">Air quality</div>
            <div class="popup-item-value">${air && air.aqi != null
              ? `<span class="aqi-dot" style="background:${air.color}"></span>${air.aqi} · ${air.label}`
              : '--'}</div>
            ${airSource ? `<div class="popup-item-note">${airSource}</div>` : ''}
          </div>
          <div class="weather-popup-item">
            <div class="popup-item-label">PM2.5 / PM10</div>
            <div class="popup-item-value">${air && air.pm25 != null
              ? `${air.pm25} / ${air.pm10 != null ? air.pm10 : '--'} µg/m³` : '--'}</div>
          </div>
          <div class="weather-popup-item">
            <div class="popup-item-label">Humidity</div>
            <div class="popup-item-value">${cur.humidity != null ? cur.humidity + '%' : '--'}</div>
          </div>
          <div class="weather-popup-item">
            <div class="popup-item-label">UV Index</div>
            <div class="popup-item-value">${cur.uvIndex != null ? cur.uvIndex : '--'}</div>
          </div>
          <div class="weather-popup-item">
            <div class="popup-item-label">Wind</div>
            <div class="popup-item-value">${cur.windMph != null ? cur.windMph + ' mph' : '--'}</div>
          </div>
          <div class="weather-popup-item">
            <div class="popup-item-label">Wind Max</div>
            <div class="popup-item-value">${cur.windMaxMph != null ? cur.windMaxMph + ' mph' : '--'}</div>
          </div>
          <div class="weather-popup-item">
            <div class="popup-item-label">Rain</div>
            <div class="popup-item-value">${cur.precipChance != null ? cur.precipChance + '%' : '--'}</div>
          </div>
        </div>
      </div>
    </div>
    <div class="weather-popup-footer">
      <div class="weather-popup-footer-tile">
        <div class="footer-tile-icon">${getWeatherIcon('sunrise')}</div>
        <div class="footer-tile-label">Sunrise</div>
        <div class="footer-tile-value">${cur.sunrise || '--'}</div>
      </div>
      <div class="weather-popup-footer-tile">
        <div class="footer-tile-icon">${getWeatherIcon('sunset')}</div>
        <div class="footer-tile-label">Sunset</div>
        <div class="footer-tile-value">${cur.sunset || '--'}</div>
      </div>
      ${cur.moon ? `<div class="weather-popup-footer-tile">
        <div class="footer-tile-icon">${getWeatherIcon(cur.moon.icon || 'moon-full')}</div>
        <div class="footer-tile-label">Moon</div>
        <div class="footer-tile-value">${cur.moon.name}</div>
      </div>` : ''}
    </div>
    ${lastWeatherRefresh ? `<div class="weather-popup-timestamp">Last updated: ${lastWeatherRefresh.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>` : ''}
    ${air && air.attributions && air.attributions.length
      ? `<div class="weather-popup-attribution">AQI: ${air.attributions.map(esc).join(' · ')}</div>`
      : ''}
  `;

  overlay.style.display = 'flex';
}

function hideWeatherPopup() {
  const overlay = document.getElementById('weather-popup');
  if (overlay) overlay.style.display = 'none';
}

// Close popup on overlay click, close button, or Escape key
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('weather-popup');
  const closeBtn = document.getElementById('weather-popup-close');
  if (closeBtn) closeBtn.addEventListener('click', hideWeatherPopup);
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideWeatherPopup();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideWeatherPopup();
  });
});

function updateFromState(state) {
  // Weather
  const weatherGrid = document.getElementById('weather-grid');
  if (weatherGrid && state.weather && state.weather.days) {
    weatherGrid.innerHTML = '';
    const cur = state.weather.current;
    for (let i = 0; i < state.weather.days.length; i++) {
      const day = state.weather.days[i];
      const div = document.createElement('div');
      div.className = 'weather-day';

      // Today tile: use current conditions if available
      let icon = day.icon;
      let temp = `${day.high}° / ${day.low}°`;
      let desc = day.desc;
      let label = day.label;
      const air = state.weather.air;

      if (i === 0 && cur && cur.icon) {
        icon = cur.icon;
        desc = cur.desc || desc;
        // For sunny/clear current conditions with UV data, show UV icon. The UV number
        // is deliberately NOT repeated in the text: the icon already carries it, and the
        // description line is better spent on air quality, which nothing else shows.
        if (cur.isDay && cur.uvIndex != null && cur.uvIndex >= 1 &&
            (cur.icon === 'sunny' || cur.icon === 'clear')) {
          const uvLevel = Math.min(Math.round(cur.uvIndex), 11);
          icon = `uv-index-${uvLevel}`;
        }
        // AQI rides on the Now tile's description line so the current reading is always
        // on screen, not only once it crosses the alert threshold. Filled with the EPA
        // band colour, which is what makes "good" readable at a glance without spending
        // the line's remaining width spelling the band name out.
        // No "·" separator: the filled chip already reads as a separate object, and a
        // literal separator strands itself at the end of the line when the description
        // wraps — which it does at normal tile width with anything longer than "Rain".
        if (air && air.aqi != null) {
          desc = `${desc} <span class="aqi-chip">AQI ${air.aqi}</span>`;
        }
        // Show current temp alongside daily range
        if (cur.temp != null) {
          temp = `${cur.temp}° (${day.high}°/${day.low}°)`;
        }
        label = 'Now';
      }

      // Tint the tile to its own conditions. `sky-*` drives a gradient in the
      // stylesheet, so a sunny day stops looking like an overcast one.
      div.classList.add('sky-' + skyClass(icon, cur && i === 0 ? cur.isDay : true));

      // Air quality goes on the Now tile only. The forecast tiles are about what to
      // expect; AQI is about whether to open a window right now, and repeating it
      // across four tiles would just be noise.
      //
      // The reading itself is always on the description line above. This block is the
      // ALERT on top of it: at 50 and over the tile also gets the pulsing band-coloured
      // ring, because at that point it needs to catch an eye that wasn't already looking.
      let aqiHtml = '';
      if (i === 0 && air && air.aqi != null) {
        // The band colour and its paired ink are published to the tile for EVERY
        // reading, not just alerting ones — the description-line chip needs them at
        // AQI 18 just as much as the ring needs them at 118.
        div.style.setProperty('--aqi', air.color);
        div.style.setProperty('--aqi-ink', air.ink);
        div.title = `US AQI ${air.aqi} — ${air.label}`;

        if (air.aqi >= 50) {
          div.classList.add('aqi-alert');
          aqiHtml =
            `<div class="weather-aqi"><span class="aqi-num">AQI ${air.aqi}</span>` +
            `<span class="aqi-label">${air.label}</span></div>`;
        }
      }

      div.innerHTML = `
        <div class="weather-label">${label}</div>
        <div class="weather-icon">${getWeatherIcon(icon)}</div>
        <div class="weather-temp">${temp}</div>
        <div class="weather-desc">${desc}</div>
        ${aqiHtml}
      `;

      // Make the Now tile tappable
      if (i === 0 && cur) {
        div.classList.add('now-tile');
        div.addEventListener('click', () => showWeatherPopup(state.weather));
      }

      weatherGrid.appendChild(div);
    }
  }

  // Today
  const todayList = document.getElementById('today-events');
  if (todayList) {
    todayList.innerHTML = '';
    if (state.todayEvents && state.todayEvents.length) {
      for (const ev of state.todayEvents) {
        const li = document.createElement('li');
        const dt = toLocalDateFromGraph(ev.start);
        const timeStr = ev.isAllDay ? '' : (dt
          ? dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : '');
        const span = document.createElement('span');
        span.className = 'time';
        span.textContent = timeStr;
        li.appendChild(span);
        li.appendChild(document.createTextNode(getEventEmoji(ev.subject) + ' ' + ev.subject));
        li.style.cursor = 'pointer';
        li.addEventListener('click', () => showEventPopup(ev));
        todayList.appendChild(li);
      }
    } else {
      const li = document.createElement('li');
      li.textContent = 'nothing scheduled';
      todayList.appendChild(li);
    }
  }

  // Tomorrow — headed by the actual weekday ("Sunday"), not the word "Tomorrow".
  // Long form here, short in the weather row, so each matches its neighbours.
  const tomorrowTitle = document.getElementById('tomorrow-title');
  if (tomorrowTitle) {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    tomorrowTitle.textContent = t.toLocaleDateString([], { weekday: 'long' });
  }

  const tomorrowList = document.getElementById('tomorrow-events');
  if (tomorrowList) {
    tomorrowList.innerHTML = '';
    if (state.tomorrowEvents && state.tomorrowEvents.length) {
      for (const ev of state.tomorrowEvents) {
        const li = document.createElement('li');
        const dt = toLocalDateFromGraph(ev.start);
        const timeStr = ev.isAllDay ? '' : (dt
          ? dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : '');
        const span = document.createElement('span');
        span.className = 'time';
        span.textContent = timeStr;
        li.appendChild(span);
        li.appendChild(document.createTextNode(getEventEmoji(ev.subject) + ' ' + ev.subject));
        li.style.cursor = 'pointer';
        li.addEventListener('click', () => showEventPopup(ev));
        tomorrowList.appendChild(li);
      }
    } else {
      const li = document.createElement('li');
      li.textContent = 'nothing scheduled';
      tomorrowList.appendChild(li);
    }
  }

  // Upcoming: next 5 days, day-after-tomorrow onward
  const upcomingList = document.getElementById('upcoming-events');
  if (upcomingList) {
    upcomingList.innerHTML = '';
    if (state.upcomingDays && state.upcomingDays.length) {
      for (const day of state.upcomingDays) {
        // Parse at midday LOCAL, not `new Date("2026-09-02")` — a date-only string is
        // parsed as UTC midnight, which renders as 5pm the previous day in Pacific and
        // labelled Wednesday's row "Tuesday". Midday keeps it clear of DST edges too.
        const dt = new Date(day.date + 'T12:00:00');
        const dayStr = dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.className = 'dow';
        span.textContent = dayStr + ':';
        li.appendChild(span);
        if (day.events && day.events.length) {
          for (const ev of day.events) {
            const label = document.createElement('span');
            label.className = 'label';
            label.textContent = getEventEmoji(ev.subject) + ' ' + ev.subject;
            label.style.cursor = 'pointer';
            label.addEventListener('click', () => showEventPopup(ev));
            li.appendChild(label);
          }
        } else {
          const label = document.createElement('span');
          label.className = 'label empty';
          label.textContent = '–';
          li.appendChild(label);
        }
        upcomingList.appendChild(li);
      }
    } else {
      const li = document.createElement('li');
      li.textContent = 'no upcoming events';
      upcomingList.appendChild(li);
    }
  }

  // Countdowns
  if (state.countdowns && state.countdowns.length) {
    const cards = document.getElementById('countdown-cards');
    if (cards) {
      cards.innerHTML = '';
      // No cap: the strip scrolls, so extras are reachable rather than dropped.
      for (const cd of state.countdowns) {
        const card = document.createElement('div');
        card.className = 'card' + (cd.days === 0 ? ' pulse-countdown' : '');
        const label = document.createElement('div');
        label.className = 'card-label';
        label.textContent = cd.label;
        const days = document.createElement('div');
        days.className = 'card-days';
        days.textContent = cd.days;
        const sub = document.createElement('div');
        sub.className = 'card-sub';
        sub.textContent = 'days';
        card.appendChild(label);
        card.appendChild(days);
        card.appendChild(sub);
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => showCountdownPopup(cd));
        cards.appendChild(card);
      }
    }
  }
}

// --- data refresh -----------------------------------------------------------
//
// The legacy screen ran ONE 60-second loop that both re-fetched state.json and
// checked reminders. Against a Function that is 1,440 invocations a day, but the
// interval could not simply be lengthened: the same loop drives the chime, which
// fires when an event is within 15 minutes. A 30-minute check can step straight
// over that window, so the reminder would have failed silently.
//
// The two concerns are therefore split: fetch on the network cadence, re-evaluate
// reminders locally every minute against what is already in memory.

let lastState = null;

// Track which events we've already chimed for
const chimedEvents = new Set();

function checkEventReminders(state) {
  if (!state.todayEvents || !window.playReminderChime) return;

  const now = new Date();
  const fifteenMinutes = 15 * 60 * 1000;

  for (const ev of state.todayEvents) {
    const eventTime = toLocalDateFromGraph(ev.start);
    if (!eventTime) continue;

    const timeUntil = eventTime - now;
    const eventKey = ev.subject + '-' + eventTime.toISOString();

    // Chime if event is 10-15 minutes away and we haven't chimed yet
    if (timeUntil > 0 && timeUntil <= fifteenMinutes && !chimedEvents.has(eventKey)) {
      console.log('Reminder chime for:', ev.subject);
      window.playReminderChime();
      chimedEvents.add(eventKey);
    }
  }
}

async function refreshAll() {
  const state = await window.KitchenData.fetchState();
  // null means the calendar call failed; keep the last good screen rather than
  // blanking a wall display over one bad request.
  if (!state) return;

  lastState = state;
  if (state.updatedAt) lastWeatherRefresh = new Date(state.updatedAt);
  updateFromState(state);
  checkEventReminders(state);
}

// Re-render immediately after a location change so the screen reflects the choice
// without waiting out the poll interval.
window.addEventListener('kitchen-location-changed', refreshAll);

refreshAll();

setInterval(refreshAll, window.KitchenData.STATE_POLL_MS);

setInterval(() => {
  if (lastState) checkEventReminders(lastState);
}, window.KitchenData.TICK_MS);

// Full page reload every 15 minutes to pick up code changes
// Uses Fully Kiosk API to clear WebView cache when available
setTimeout(() => {
  if (typeof fully !== 'undefined' && fully.clearCache) {
    try { fully.clearCache(); } catch (e) {}
  }
  // Strip any existing query params (e.g. leftover _t) and reload clean
  if (window.location.search) {
    window.location.href = window.location.origin + window.location.pathname;
  } else {
    window.location.reload(true);
  }
}, 15 * 60 * 1000);
