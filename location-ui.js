// Location picker for the kitchen dashboard.
//
// The screen on the wall never moves, so this is not a control anyone should have to
// find. It sits behind a small button showing the current place, and exists mainly so
// a copy opened while travelling shows the right weather without a redeploy.
//
// Choosing a place stores its coordinates AND its IANA timezone (both come from
// Open-Meteo's geocoding response), so the timezone is never typed or guessed. The
// dashboard re-fetches immediately rather than waiting out the 30-minute poll.

(function (global) {
  'use strict';

  var doc = global.document;
  var searchTimer = null;

  function el(id) { return doc.getElementById(id); }

  function renderCurrent() {
    var btn = el('location-button');
    if (btn) btn.textContent = '📍 ' + global.KitchenLocation.describe();
  }

  function renderResults(places) {
    var list = el('location-results');
    if (!list) return;

    if (!places.length) {
      list.innerHTML = '<div class="location-empty">No matches</div>';
      return;
    }

    list.innerHTML = '';
    places.forEach(function (p) {
      var row = doc.createElement('button');
      row.className = 'location-result';
      // Region and country are shown deliberately: "Springfield" matches Illinois,
      // Missouri and Massachusetts. Bare city names would let someone
      // pick the wrong one without noticing.
      row.innerHTML =
        '<span class="location-name">' + p.name + '</span>' +
        '<span class="location-meta">' + [p.region, p.country].filter(Boolean).join(', ') +
        ' · ' + p.timezone + '</span>';
      row.addEventListener('click', function () { choose(p); });
      list.appendChild(row);
    });
  }

  function choose(place) {
    var stored = global.KitchenLocation.set(place);
    if (!stored) {
      // Storage can refuse (private mode, kiosk with site data disabled). Say so
      // rather than appearing to accept a choice that will not survive a reload.
      var list = el('location-results');
      if (list) list.innerHTML = '<div class="location-empty">Could not save on this device</div>';
      return;
    }
    renderCurrent();
    close();
    global.dispatchEvent(new Event('kitchen-location-changed'));
  }

  function search(query) {
    global.KitchenLocation.search(query)
      .then(renderResults)
      .catch(function () {
        var list = el('location-results');
        if (list) list.innerHTML = '<div class="location-empty">Search unavailable</div>';
      });
  }

  function open() {
    var overlay = el('location-popup');
    if (!overlay) return;
    overlay.style.display = '';
    var input = el('location-search');
    if (input) { input.value = ''; input.focus(); }
    var list = el('location-results');
    if (list) list.innerHTML = '';
  }

  function close() {
    var overlay = el('location-popup');
    if (overlay) overlay.style.display = 'none';
  }

  function init() {
    renderCurrent();

    var btn = el('location-button');
    if (btn) btn.addEventListener('click', open);

    var closeBtn = el('location-popup-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    var overlay = el('location-popup');
    if (overlay) {
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    }

    var input = el('location-search');
    if (input) {
      input.addEventListener('input', function () {
        // Debounced: a geocoding request per keystroke is rude to a free service
        // and makes results flicker on a slow kitchen connection.
        clearTimeout(searchTimer);
        var q = input.value;
        searchTimer = setTimeout(function () { search(q); }, 350);
      });
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.KitchenLocationUI = { open: open, close: close, refresh: renderCurrent };
})(window);
