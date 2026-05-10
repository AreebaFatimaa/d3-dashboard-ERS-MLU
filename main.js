/*
 * main.js — D3 dashboard for ERS Major Land Uses, 1945–2017.
 * Carousel of 48 contiguous-state slides; each slide stacks two US maps:
 *   top    = acres_defense_industrial (fixed)
 *   bottom = acres_forest_use_land | acres_cropland_used_for_crops | acres_grassland_pasture_range
 * Three viz types share a single state object: spike | cartogram | choropleth.
 * Debug panel (dat.gui-style) drives all knobs; per-card SVG/PNG export is client-side.
 * Data source: USDA ERS Major Land Uses (release 2024-09-13), 16 ERS years × 48 states.
 * Stocks per year — concurrent change is shown, NOT direct conversion.
 * Topology: us-atlas v3 states-10m (pre-projected Albers USA pixel coords; 975×610).
 * Public surface: window.APP = { state, data, render }. No build step; D3 v7 + topojson via CDN.
 */

(function () {
  'use strict';

  // === DATA ===
  const YEARS = [1945, 1949, 1954, 1959, 1964, 1969, 1974, 1978, 1982, 1987,
                 1992, 1997, 2002, 2007, 2012, 2017];
  const TOP_METRIC = 'acres_defense_industrial';
  const BOTTOM_METRICS = {
    acres_forest_use_land:        { label: 'Forest-use land',        defaultPalette: 'Greens' },
    acres_cropland_used_for_crops:{ label: 'Cropland used for crops',defaultPalette: 'BuGn'   },
    acres_grassland_pasture_range:{ label: 'Grassland pasture & range', defaultPalette: 'YlGn' }
  };
  const PALETTES_TOP = ['Reds', 'Oranges', 'YlOrRd'];
  const PALETTES_BOTTOM = ['Greens', 'BuGn', 'YlGn'];
  const INTERP = {
    Reds: d3.interpolateReds, Oranges: d3.interpolateOranges, YlOrRd: d3.interpolateYlOrRd,
    Greens: d3.interpolateGreens, BuGn: d3.interpolateBuGn, YlGn: d3.interpolateYlGn
  };

  const DATA = {
    rows: [],
    byKey: new Map(),     // `${abbr}|${year}` -> row
    states: [],           // [{abbr, name}] alpha by name
    statesGeo: null,      // featureCollection
    centroidByName: new Map(),
    centroidByFips: new Map(),
    fipsByAbbr: STATE_FIPS_TABLE(),
    domains: {}           // metric -> { perYear: {year:[min,max]}, global: [min,max] }
  };

  // FIPS table (abbr -> "01"…) for fallback join. Only lower 48.
  function STATE_FIPS_TABLE() {
    return {
      AL:'01',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',FL:'12',GA:'13',ID:'16',
      IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',ME:'23',MD:'24',MA:'25',MI:'26',
      MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',NJ:'34',NM:'35',NY:'36',
      NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',SC:'45',SD:'46',TN:'47',
      TX:'48',UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',WI:'55',WY:'56'
    };
  }
  const ABBR_BY_FIPS = (() => {
    const out = {};
    Object.entries(DATA.fipsByAbbr).forEach(([a, f]) => out[f] = a);
    return out;
  })();

  // === STATE ===
  const STATE = {
    vizType: 'spike',
    year: 1945,
    yearRange: [1945, 2017],
    bottomMetric: 'acres_forest_use_land',
    playing: false,
    speed: 1,
    topPalette: 'Reds',
    topCustom: '',
    bottomPalette: 'Greens',
    bottomCustom: '',
    topOpacity: 0.85,
    bottomOpacity: 0.85,
    highlight: '#FFD700',
    spikeWidth: 4,
    spikeShape: 'line',
    spikeMaxHeight: 120,
    pattern: 'none',
    scale: 'linear',
    domainMode: 'per-year',
    slideIndex: 0
  };

  // us-atlas v3 states-10m.json is raw lat/lon; we project with Albers USA fit to viewBox.
  // ViewBox reserves a TITLE_H strip at the top so a baked-in metric title travels with exports.
  const VIEWBOX_W = 975, VIEWBOX_H = 660, TITLE_H = 50;
  const PROJECTION = d3.geoAlbersUsa();
  const PATH = d3.geoPath(PROJECTION);

  let playTimer = null;

  // === LOAD ===
  Promise.all([
    d3.csv('./data/ers_mlu_state_year_48_states_wide.csv', d3.autoType),
    d3.json('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json')
  ]).then(([rows, topo]) => {
    DATA.rows = rows;
    rows.forEach(r => DATA.byKey.set(`${r.state_abbr}|${r.year}`, r));

    const seen = new Map();
    rows.forEach(r => { if (!seen.has(r.state_abbr)) seen.set(r.state_abbr, r.state_name); });
    DATA.states = [...seen.entries()]
      .map(([abbr, name]) => ({ abbr, name }))
      .sort((a, b) => d3.ascending(a.name, b.name));

    const nameToAbbr = new Map(DATA.states.map(s => [s.name, s.abbr]));
    const fc = topojson.feature(topo, topo.objects.states);
    // primary join: state_name → feature.properties.name. Fallback: FIPS via feature.id.
    fc.features = fc.features.filter(f => nameToAbbr.has(f.properties.name) || ABBR_BY_FIPS[f.id]);
    DATA.statesGeo = fc;

    // fit Albers USA below the title strip
    PROJECTION.fitExtent([[0, TITLE_H], [VIEWBOX_W, VIEWBOX_H]], fc);

    fc.features.forEach(f => {
      const c = PATH.centroid(f);
      DATA.centroidByName.set(f.properties.name, c);
      DATA.centroidByFips.set(f.id, c);
      f._abbr = nameToAbbr.get(f.properties.name) || ABBR_BY_FIPS[f.id];
    });

    precomputeDomains();
    initDefs();
    initDebugPanel();
    initCarousel();
    bindKeys();
    render();

    window.APP = { state: STATE, data: DATA, render };
  }).catch(err => {
    console.error('Load failed:', err);
    document.getElementById('stateTitle').textContent = 'Failed to load data — see console.';
  });

  // === SCALES ===
  function precomputeDomains() {
    const metrics = [TOP_METRIC, ...Object.keys(BOTTOM_METRICS)];
    metrics.forEach(m => {
      const perYear = {};
      let gMin = Infinity, gMax = -Infinity;
      YEARS.forEach(y => {
        const vals = DATA.rows.filter(r => r.year === y).map(r => +r[m] || 0);
        const mn = d3.min(vals), mx = d3.max(vals);
        perYear[y] = [mn, mx];
        if (mn < gMin) gMin = mn;
        if (mx > gMax) gMax = mx;
      });
      DATA.domains[m] = { perYear, global: [gMin, gMax] };
    });
  }

  function getDomain(metric) {
    const dom = DATA.domains[metric];
    if (STATE.domainMode === 'global') return dom.global.slice();
    return dom.perYear[STATE.year].slice();
  }

  function colorScaleFor(metric, palette, customHex) {
    const [mn, mx] = getDomain(metric);
    const lo = STATE.scale === 'log' ? Math.max(1, mn || 1) : 0;
    const hi = Math.max(mx, lo + 1);
    let interpolator;
    if (customHex && /^#?[0-9a-f]{6}$/i.test(customHex.replace('#',''))) {
      const c = customHex.startsWith('#') ? customHex : '#' + customHex;
      interpolator = d3.interpolateRgb('#f7f7f4', c);
    } else {
      interpolator = INTERP[palette] || d3.interpolateGreys;
    }
    let s;
    if (STATE.scale === 'sqrt')      s = d3.scaleSqrt().domain([lo, hi]);
    else if (STATE.scale === 'log')  s = d3.scaleLog().domain([lo, hi]).clamp(true);
    else                             s = d3.scaleLinear().domain([lo, hi]);
    return v => interpolator(s(Math.max(lo, v || 0)));
  }

  function sizeScaleFor(metric, range) {
    const [, mx] = getDomain(metric);
    const lo = STATE.scale === 'log' ? 1 : 0;
    let s;
    if (STATE.scale === 'sqrt')      s = d3.scaleSqrt();
    else if (STATE.scale === 'log')  s = d3.scaleLog().clamp(true);
    else                             s = d3.scaleLinear();
    return s.domain([lo, Math.max(mx, lo + 1)]).range(range);
  }

  // === MAPS ===
  function initDefs() {
    [document.getElementById('mapTop'), document.getElementById('mapBottom')].forEach(svg => {
      const sel = d3.select(svg);
      const defs = sel.append('defs');

      // patterns
      defs.append('pattern')
        .attr('id', svg.id + '-pat-stripes').attr('patternUnits', 'userSpaceOnUse')
        .attr('width', 6).attr('height', 6)
        .html(`<rect width="6" height="6" fill="white"/><path d="M0,6 L6,0" stroke="black" stroke-width="1"/>`);
      defs.append('pattern')
        .attr('id', svg.id + '-pat-dots').attr('patternUnits', 'userSpaceOnUse')
        .attr('width', 6).attr('height', 6)
        .html(`<rect width="6" height="6" fill="white"/><circle cx="3" cy="3" r="1.1" fill="black"/>`);
      defs.append('pattern')
        .attr('id', svg.id + '-pat-hatch').attr('patternUnits', 'userSpaceOnUse')
        .attr('width', 8).attr('height', 8)
        .html(`<rect width="8" height="8" fill="white"/><path d="M0,0 L8,8 M-2,6 L2,10 M6,-2 L10,2" stroke="black" stroke-width="1"/>`);

      // viz layers
      sel.append('g').attr('class', 'layer layer-base');         // base outlines (always)
      sel.append('g').attr('class', 'layer layer-choropleth');
      sel.append('g').attr('class', 'layer layer-cartogram');
      sel.append('g').attr('class', 'layer layer-spike');

      // baked-in title and subtitle (live in SVG so they travel with single-card exports)
      sel.append('text').attr('class', 'map-title')
        .attr('x', VIEWBOX_W / 2).attr('y', 26).attr('text-anchor', 'middle');
      sel.append('text').attr('class', 'map-title-sub')
        .attr('x', VIEWBOX_W / 2).attr('y', 44).attr('text-anchor', 'middle');
    });
  }

  function spikePath(cx, cy, h, w, shape) {
    const half = w / 2;
    if (shape === 'triangle') {
      return `M${cx - half},${cy} L${cx},${cy - h} L${cx + half},${cy} Z`;
    }
    if (shape === 'lollipop') {
      // line + circle handled together: return only the stem path; circle drawn separately via class
      return `M${cx},${cy} L${cx},${cy - h}`;
    }
    // line
    return `M${cx - half},${cy} L${cx},${cy - h} L${cx + half},${cy}`;
  }

  function patternFillFor(svgId) {
    if (STATE.pattern === 'none') return null;
    return `url(#${svgId}-pat-${STATE.pattern})`;
  }

  function metricLabel(m) {
    if (m === TOP_METRIC) return 'Defense & industrial';
    return BOTTOM_METRICS[m]?.label || m;
  }

  function renderMap(svgEl, metric, palette, customColor, opacity) {
    const T = d3.transition().duration(250);
    const sel = d3.select(svgEl);
    const id = svgEl.id;
    const features = DATA.statesGeo.features;
    const highlightAbbr = DATA.states[STATE.slideIndex]?.abbr;

    const valueFor = f => {
      const r = DATA.byKey.get(`${f._abbr}|${STATE.year}`);
      return r ? +r[metric] || 0 : 0;
    };
    // dim non-active and glow active across every data-bearing element
    const dimGlowClass = (f, base) =>
      `${base} ${f._abbr === highlightAbbr ? 'state-active' : 'state-other'}`;

    const color = colorScaleFor(metric, palette, customColor);
    const fillPattern = patternFillFor(id);

    // baked-in title (top of viewBox)
    const stName = DATA.states[STATE.slideIndex]?.name || '';
    sel.select('text.map-title').text(`${metricLabel(metric)} — ${stName}`);
    sel.select('text.map-title-sub').text(`${STATE.year} · ${STATE.vizType} · ${STATE.scale} scale`);

    // base outlines (always present, faint)
    sel.select('g.layer-base')
      .attr('opacity', STATE.vizType === 'choropleth' ? 0 : 0.9)
      .selectAll('path.state-outline')
      .data(features, f => f.id)
      .join(
        e => e.append('path').attr('class', 'state state-outline').attr('d', PATH),
        u => u,
        x => x.remove()
      );

    // CHOROPLETH
    sel.select('g.layer-choropleth')
      .attr('opacity', STATE.vizType === 'choropleth' ? opacity : 0)
      .style('pointer-events', STATE.vizType === 'choropleth' ? 'auto' : 'none')
      .selectAll('path.state-fill')
      .data(features, f => f.id)
      .join(
        enter => enter.append('path')
          .attr('class', f => dimGlowClass(f, 'state state-fill'))
          .attr('d', PATH)
          .attr('fill', f => color(valueFor(f)))
          .attr('stroke', f => f._abbr === highlightAbbr ? STATE.highlight : '#888')
          .attr('stroke-width', f => f._abbr === highlightAbbr ? 2.5 : 0.5)
          .on('pointermove', tipMove)
          .on('pointerleave', tipHide),
        update => update
          .attr('class', f => dimGlowClass(f, 'state state-fill'))
          .call(s => s.transition(T)
            .attr('fill', f => color(valueFor(f)))
            .attr('stroke', f => f._abbr === highlightAbbr ? STATE.highlight : '#888')
            .attr('stroke-width', f => f._abbr === highlightAbbr ? 2.5 : 0.5)),
        exit => exit.remove()
      );

    // pattern overlay for choropleth (drawn on top, semi-transparent)
    sel.select('g.layer-choropleth')
      .selectAll('path.pattern-overlay')
      .data(fillPattern && STATE.vizType === 'choropleth' ? features : [], f => f.id)
      .join(
        enter => enter.append('path')
          .attr('class', 'pattern-overlay')
          .attr('d', PATH)
          .attr('fill', fillPattern)
          .attr('opacity', 0.35)
          .attr('pointer-events', 'none'),
        update => update.attr('fill', fillPattern).attr('opacity', 0.35),
        exit => exit.remove()
      );

    // CARTOGRAM (bubbles at centroids)
    const bubbleR = sizeScaleFor(metric, [0, 28]);
    const cartoG = sel.select('g.layer-cartogram')
      .attr('opacity', STATE.vizType === 'cartogram' ? opacity : 0)
      .style('pointer-events', STATE.vizType === 'cartogram' ? 'auto' : 'none');

    cartoG.selectAll('circle.bubble')
      .data(features, f => f.id)
      .join(
        enter => enter.append('circle')
          .attr('class', f => dimGlowClass(f, 'bubble'))
          .attr('cx', f => PATH.centroid(f)[0])
          .attr('cy', f => PATH.centroid(f)[1])
          .attr('r', f => bubbleR(valueFor(f)))
          .attr('fill', f => fillPattern || color(valueFor(f)))
          .attr('stroke', f => f._abbr === highlightAbbr ? STATE.highlight : '#222')
          .attr('stroke-width', f => f._abbr === highlightAbbr ? 2.5 : 0.5)
          .on('pointermove', tipMove)
          .on('pointerleave', tipHide),
        update => update
          .attr('class', f => dimGlowClass(f, 'bubble'))
          .call(s => s.transition(T)
            .attr('cx', f => PATH.centroid(f)[0])
            .attr('cy', f => PATH.centroid(f)[1])
            .attr('r', f => bubbleR(valueFor(f)))
            .attr('fill', f => fillPattern || color(valueFor(f)))
            .attr('stroke', f => f._abbr === highlightAbbr ? STATE.highlight : '#222')
            .attr('stroke-width', f => f._abbr === highlightAbbr ? 2.5 : 0.5)),
        exit => exit.remove()
      );

    // SPIKE
    const spikeH = sizeScaleFor(metric, [0, STATE.spikeMaxHeight]);
    const spikeG = sel.select('g.layer-spike')
      .attr('opacity', STATE.vizType === 'spike' ? opacity : 0)
      .style('pointer-events', STATE.vizType === 'spike' ? 'auto' : 'none');

    spikeG.selectAll('path.spike')
      .data(features, f => f.id)
      .join(
        enter => enter.append('path')
          .attr('class', f => dimGlowClass(f, 'spike'))
          .attr('d', f => {
            const [cx, cy] = PATH.centroid(f);
            return spikePath(cx, cy, spikeH(valueFor(f)), STATE.spikeWidth, STATE.spikeShape);
          })
          .attr('fill', f => STATE.spikeShape === 'lollipop' ? 'none' : color(valueFor(f)))
          .attr('stroke', f => STATE.spikeShape === 'lollipop'
            ? color(valueFor(f))
            : (f._abbr === highlightAbbr ? STATE.highlight : '#00000055'))
          .attr('stroke-width', f => STATE.spikeShape === 'lollipop' ? STATE.spikeWidth * 0.6 : 0.5)
          .on('pointermove', tipMove)
          .on('pointerleave', tipHide),
        update => update
          .attr('class', f => dimGlowClass(f, 'spike'))
          .call(s => s.transition(T)
            .attr('d', f => {
              const [cx, cy] = PATH.centroid(f);
              return spikePath(cx, cy, spikeH(valueFor(f)), STATE.spikeWidth, STATE.spikeShape);
            })
            .attr('fill', f => STATE.spikeShape === 'lollipop' ? 'none' : color(valueFor(f)))
            .attr('stroke', f => STATE.spikeShape === 'lollipop'
              ? color(valueFor(f))
              : (f._abbr === highlightAbbr ? STATE.highlight : '#00000055'))
            .attr('stroke-width', f => STATE.spikeShape === 'lollipop' ? STATE.spikeWidth * 0.6 : 0.5)),
        exit => exit.remove()
      );

    // lollipop heads
    spikeG.selectAll('circle.lollipop-head')
      .data(STATE.spikeShape === 'lollipop' ? features : [], f => f.id)
      .join(
        enter => enter.append('circle')
          .attr('class', f => dimGlowClass(f, 'lollipop-head'))
          .attr('cx', f => PATH.centroid(f)[0])
          .attr('cy', f => PATH.centroid(f)[1] - spikeH(valueFor(f)))
          .attr('r', STATE.spikeWidth * 0.9)
          .attr('fill', f => color(valueFor(f)))
          .attr('stroke', f => f._abbr === highlightAbbr ? STATE.highlight : '#222')
          .attr('stroke-width', f => f._abbr === highlightAbbr ? 1.8 : 0.4),
        update => update
          .attr('class', f => dimGlowClass(f, 'lollipop-head'))
          .call(s => s.transition(T)
            .attr('cx', f => PATH.centroid(f)[0])
            .attr('cy', f => PATH.centroid(f)[1] - spikeH(valueFor(f)))
            .attr('r', STATE.spikeWidth * 0.9)
            .attr('fill', f => color(valueFor(f)))
            .attr('stroke', f => f._abbr === highlightAbbr ? STATE.highlight : '#222')
            .attr('stroke-width', f => f._abbr === highlightAbbr ? 1.8 : 0.4)),
        exit => exit.remove()
      );

    // base outlines: highlight the active state always
    sel.select('g.layer-base').selectAll('path.state-outline')
      .attr('class', f => 'state state-outline' + (f._abbr === highlightAbbr ? ' is-highlight' : ''))
      .attr('stroke-width', f => f._abbr === highlightAbbr ? 2 : 0.5)
      .attr('stroke', f => f._abbr === highlightAbbr ? STATE.highlight : '#b8b1a1');

    // a11y description
    svgEl.setAttribute('aria-label',
      `${metricLabel(metric)} in ${STATE.year} across 48 states, ${stName} highlighted.`);

    // legend
    const legendId = svgEl.id === 'mapTop' ? 'legendTop' : 'legendBottom';
    const legend = document.getElementById(legendId);
    const [mn, mx] = getDomain(metric);
    legend.innerHTML = '';
    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.background = `linear-gradient(to right, ${color(mn)}, ${color(mx)})`;
    legend.appendChild(swatch);
    const text = document.createElement('span');
    text.textContent = `${metricLabel(metric)} · ${formatAcres(mn)} → ${formatAcres(mx)} · ${STATE.scale} · ${STATE.domainMode}`;
    legend.appendChild(text);
  }

  // === CAROUSEL ===
  function initCarousel() {
    const dots = document.getElementById('dots');
    DATA.states.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'dot';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', s.name);
      b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      b.addEventListener('click', () => goToSlide(i));
      dots.appendChild(b);
    });
    document.getElementById('navPrev').addEventListener('click', () => goToSlide(STATE.slideIndex - 1));
    document.getElementById('navNext').addEventListener('click', () => goToSlide(STATE.slideIndex + 1));

    document.querySelectorAll('.export-toolbar').forEach(tb => {
      const target = tb.getAttribute('data-target');
      tb.querySelectorAll('.export-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const kind = btn.getAttribute('data-kind');
          exportSingle(target, kind);
        });
      });
    });
    document.getElementById('exportCombinedSvg').addEventListener('click', () => exportCombined('svg'));
    document.getElementById('exportCombinedPng').addEventListener('click', () => exportCombined('png'));
  }

  function goToSlide(i) {
    const n = DATA.states.length;
    STATE.slideIndex = ((i % n) + n) % n;
    document.querySelectorAll('#dots .dot').forEach((d, idx) =>
      d.setAttribute('aria-selected', idx === STATE.slideIndex ? 'true' : 'false'));
    render();
  }

  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); goToSlide(STATE.slideIndex - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goToSlide(STATE.slideIndex + 1); }
    });
  }

  // === DEBUG_PANEL ===
  function el(tag, attrs = {}, kids = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    (Array.isArray(kids) ? kids : [kids]).forEach(k => k != null && node.append(k.nodeType ? k : String(k)));
    return node;
  }

  function radioField(label, options, current, onChange) {
    const wrap = el('div', { class: 'dp-field' });
    wrap.append(el('label', {}, label));
    const group = el('div', { class: 'dp-radio' });
    options.forEach(o => {
      const value = typeof o === 'string' ? o : o.value;
      const text  = typeof o === 'string' ? o : o.label;
      const lbl = el('label', {});
      const input = el('input', { type: 'radio', name: label, value });
      if (value === current) input.checked = true;
      input.addEventListener('change', () => onChange(value));
      lbl.append(input, el('span', {}, text));
      group.append(lbl);
    });
    wrap.append(group);
    return wrap;
  }

  function rangeField(label, attrs, current, onInput, fmt = (v) => v) {
    const wrap = el('div', { class: 'dp-field' });
    wrap.append(el('label', {}, label));
    const input = el('input', Object.assign({ type: 'range', value: current, 'aria-label': label }, attrs));
    const valueOut = el('span', { class: 'value' }, fmt(current));
    input.addEventListener('input', () => {
      valueOut.textContent = fmt(+input.value);
      onInput(+input.value);
    });
    wrap.append(input, valueOut);
    return wrap;
  }

  function colorField(label, current, onChange) {
    const wrap = el('div', { class: 'dp-field' });
    wrap.append(el('label', {}, label));
    const input = el('input', { type: 'color', value: current, 'aria-label': label });
    input.addEventListener('input', () => onChange(input.value));
    const out = el('span', { class: 'value' }, current);
    input.addEventListener('input', () => { out.textContent = input.value; });
    wrap.append(input, out);
    return wrap;
  }

  function actionRow(label, buttons) {
    const wrap = el('div', { class: 'dp-field' });
    wrap.append(el('label', {}, label));
    const acts = el('div', { class: 'dp-actions' });
    buttons.forEach(b => {
      const btn = el('button', { type: 'button' }, b.label);
      btn.addEventListener('click', b.onClick);
      acts.append(btn);
    });
    wrap.append(acts);
    return wrap;
  }

  function initDebugPanel() {
    // VIZ TYPE
    const grpViz = document.getElementById('grpViz');
    grpViz.append(radioField('Type', ['spike', 'cartogram', 'choropleth'], STATE.vizType, v => {
      STATE.vizType = v; render();
    }));

    // TIME
    const grpTime = document.getElementById('grpTime');
    const yearWrap = el('div', { class: 'dp-field' });
    yearWrap.append(el('label', {}, 'Year'));
    const yearInput = el('input', { type: 'range', min: 0, max: YEARS.length - 1, step: 1, value: 0, 'aria-label': 'Year' });
    const yearOut = el('span', { class: 'value' }, String(STATE.year));
    yearInput.addEventListener('input', () => {
      let y = YEARS[+yearInput.value];
      if (y < STATE.yearRange[0]) y = STATE.yearRange[0];
      if (y > STATE.yearRange[1]) y = STATE.yearRange[1];
      STATE.year = y;
      yearInput.value = YEARS.indexOf(y);
      yearOut.textContent = String(y);
      render();
    });
    yearWrap.append(yearInput, yearOut);
    grpTime.append(yearWrap);
    grpTime._yearInput = yearInput;
    grpTime._yearOut = yearOut;

    grpTime.append(actionRow('Playback', [
      { label: '▶ Play',  onClick: () => setPlaying(true) },
      { label: '⏸ Pause', onClick: () => setPlaying(false) },
      { label: '⏮ First', onClick: () => { STATE.year = STATE.yearRange[0]; syncYearInput(); render(); } }
    ]));

    grpTime.append(radioField('Speed', [
      { value: '0.5', label: '0.5×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }
    ], String(STATE.speed), v => { STATE.speed = +v; if (STATE.playing) setPlaying(true); }));

    // year range two-handle clamp
    const rangeWrap = el('div', { class: 'dp-field' });
    rangeWrap.append(el('label', {}, 'Range'));
    const pair = el('div', { class: 'dp-range-pair' });
    const minIn = el('input', { type: 'range', min: 0, max: YEARS.length - 1, step: 1, value: 0, 'aria-label': 'Range start' });
    const maxIn = el('input', { type: 'range', min: 0, max: YEARS.length - 1, step: 1, value: YEARS.length - 1, 'aria-label': 'Range end' });
    pair.append(minIn, maxIn);
    rangeWrap.append(pair);
    const rangeOut = el('span', { class: 'value' }, `${STATE.yearRange[0]}–${STATE.yearRange[1]}`);
    rangeWrap.append(rangeOut);
    function syncRange() {
      let lo = +minIn.value, hi = +maxIn.value;
      if (lo > hi) { [lo, hi] = [hi, lo]; minIn.value = lo; maxIn.value = hi; }
      STATE.yearRange = [YEARS[lo], YEARS[hi]];
      rangeOut.textContent = `${YEARS[lo]}–${YEARS[hi]}`;
      if (STATE.year < YEARS[lo]) STATE.year = YEARS[lo];
      if (STATE.year > YEARS[hi]) STATE.year = YEARS[hi];
      syncYearInput();
      render();
    }
    minIn.addEventListener('input', syncRange);
    maxIn.addEventListener('input', syncRange);
    grpTime.append(rangeWrap);

    function syncYearInput() {
      const idx = YEARS.indexOf(STATE.year);
      grpTime._yearInput.value = idx;
      grpTime._yearOut.textContent = String(STATE.year);
    }
    grpTime._sync = syncYearInput;

    // BOTTOM CATEGORY
    const grpCat = document.getElementById('grpCategory');
    grpCat.append(radioField('Metric',
      Object.entries(BOTTOM_METRICS).map(([k, v]) => ({ value: k, label: v.label })),
      STATE.bottomMetric,
      v => {
        STATE.bottomMetric = v;
        STATE.bottomPalette = BOTTOM_METRICS[v].defaultPalette;
        STATE.bottomCustom = '';
        document.getElementById('bottomLabel').textContent = BOTTOM_METRICS[v].label;
        document.getElementById('mapBottom').setAttribute('aria-label',
          `${BOTTOM_METRICS[v].label} land map`);
        render();
        // refresh palette UI without rebuilding entire panel
        if (grpColor._refresh) grpColor._refresh();
      }));

    // COLOR & OPACITY
    const grpColor = document.getElementById('grpColor');
    function rebuildColor() {
      grpColor.innerHTML = '';
      grpColor.append(radioField('Top palette', PALETTES_TOP, STATE.topPalette, v => {
        STATE.topPalette = v; STATE.topCustom = ''; render();
      }));
      grpColor.append(colorField('Top custom', STATE.topCustom || '#aa3333', v => {
        STATE.topCustom = v; render();
      }));
      grpColor.append(rangeField('Top opacity', { min: 0.1, max: 1, step: 0.05 }, STATE.topOpacity, v => {
        STATE.topOpacity = v; render();
      }, v => v.toFixed(2)));
      grpColor.append(radioField('Bottom palette', PALETTES_BOTTOM, STATE.bottomPalette, v => {
        STATE.bottomPalette = v; STATE.bottomCustom = ''; render();
      }));
      grpColor.append(colorField('Bottom custom', STATE.bottomCustom || '#2c8c4f', v => {
        STATE.bottomCustom = v; render();
      }));
      grpColor.append(rangeField('Bottom opacity', { min: 0.1, max: 1, step: 0.05 }, STATE.bottomOpacity, v => {
        STATE.bottomOpacity = v; render();
      }, v => v.toFixed(2)));
      grpColor.append(colorField('Highlight', STATE.highlight, v => { STATE.highlight = v; render(); }));
    }
    grpColor._refresh = rebuildColor;
    rebuildColor();

    // SPIKE & PATTERN
    const grpStyle = document.getElementById('grpStyle');
    grpStyle.append(rangeField('Spike width', { min: 1, max: 12, step: 1 }, STATE.spikeWidth, v => {
      STATE.spikeWidth = v; render();
    }));
    grpStyle.append(radioField('Spike shape', ['line', 'triangle', 'lollipop'], STATE.spikeShape, v => {
      STATE.spikeShape = v; render();
    }));
    grpStyle.append(rangeField('Max height', { min: 10, max: 300, step: 5 }, STATE.spikeMaxHeight, v => {
      STATE.spikeMaxHeight = v; render();
    }));
    grpStyle.append(radioField('Pattern', ['none', 'stripes', 'dots', 'hatch'], STATE.pattern, v => {
      STATE.pattern = v; render();
    }));

    // SCALE & AXIS
    const grpScale = document.getElementById('grpScale');
    grpScale.append(radioField('Scale', ['linear', 'sqrt', 'log'], STATE.scale, v => {
      STATE.scale = v; render();
    }));
    grpScale.append(radioField('Domain', [
      { value: 'per-year', label: 'per-year' },
      { value: 'global',   label: 'global' }
    ], STATE.domainMode, v => { STATE.domainMode = v; render(); }));
  }

  function setPlaying(on) {
    STATE.playing = on;
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (!on) return;
    const intervalMs = 1100 / STATE.speed;
    playTimer = setInterval(() => {
      const [lo, hi] = STATE.yearRange;
      const inRange = YEARS.filter(y => y >= lo && y <= hi);
      const i = inRange.indexOf(STATE.year);
      STATE.year = inRange[(i + 1) % inRange.length];
      const grpTime = document.getElementById('grpTime');
      if (grpTime._sync) grpTime._sync();
      render();
    }, intervalMs);
  }

  // === EXPORT ===
  function inlineStyles(srcRoot, dstRoot) {
    const srcAll = [srcRoot, ...srcRoot.querySelectorAll('*')];
    const dstAll = [dstRoot, ...dstRoot.querySelectorAll('*')];
    const props = ['fill','stroke','stroke-width','stroke-opacity','stroke-dasharray',
                   'fill-opacity','opacity','filter','font-family','font-size',
                   'font-weight','text-anchor','dominant-baseline','letter-spacing',
                   'text-transform','pointer-events'];
    for (let i = 0; i < srcAll.length; i++) {
      if (!srcAll[i] || !(srcAll[i] instanceof Element)) continue;
      const cs = window.getComputedStyle(srcAll[i]);
      const parts = [];
      for (const p of props) {
        const v = cs.getPropertyValue(p);
        if (v) parts.push(`${p}:${v}`);
      }
      if (parts.length) {
        const existing = dstAll[i].getAttribute('style') || '';
        dstAll[i].setAttribute('style', parts.join(';') + ';' + existing);
      }
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function buildExportSvg(svgEl, { title, desc }) {
    const clone = svgEl.cloneNode(true);
    inlineStyles(svgEl, clone);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    const bbox = svgEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(bbox.width));
    const h = Math.max(1, Math.round(bbox.height));
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    // background for PNG legibility
    const NS = 'http://www.w3.org/2000/svg';
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', '#ffffff');
    clone.insertBefore(bg, clone.firstChild);
    // title + desc
    const t = document.createElementNS(NS, 'title');  t.textContent = title;
    const d = document.createElementNS(NS, 'desc');   d.textContent = desc;
    clone.insertBefore(t, clone.firstChild);
    clone.insertBefore(d, t.nextSibling);
    return { clone, w, h };
  }

  function svgToBlob(svgNode) {
    const xml = new XMLSerializer().serializeToString(svgNode);
    return new Blob(['<?xml version="1.0" standalone="no"?>\n', xml],
                    { type: 'image/svg+xml;charset=utf-8' });
  }

  function rasterize(svgNode, w, h, scale, cb) {
    const blob = svgToBlob(svgNode);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(cb, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }

  function fileBase(target) {
    const st = DATA.states[STATE.slideIndex];
    const metric = target === 'top' ? TOP_METRIC : STATE.bottomMetric;
    const short = metric.replace(/^acres_/, '');
    return `${st.abbr}_${short}_${STATE.year}_${STATE.vizType}`;
  }

  function exportSingle(target, kind) {
    const svgEl = document.getElementById(target === 'top' ? 'mapTop' : 'mapBottom');
    const st = DATA.states[STATE.slideIndex];
    const metric = target === 'top' ? TOP_METRIC : STATE.bottomMetric;
    const meta = {
      title: `${metricLabel(metric)} — ${st.name} (${STATE.year})`,
      desc:  `Concurrent change, not direct conversion. Source: USDA ERS Major Land Uses, 2024-09-13.`
    };
    const { clone, w, h } = buildExportSvg(svgEl, meta);
    const filename = fileBase(target) + (kind === 'svg' ? '.svg' : '.png');
    if (kind === 'svg') {
      triggerDownload(svgToBlob(clone), filename);
    } else {
      rasterize(clone, w, h, 2, (blob) => blob && triggerDownload(blob, filename));
    }
  }

  function exportCombined(kind) {
    const topEl  = document.getElementById('mapTop');
    const botEl  = document.getElementById('mapBottom');
    const tsTop  = document.getElementById('multTop');
    const tsBot  = document.getElementById('multBottom');
    const st = DATA.states[STATE.slideIndex];
    const NS = 'http://www.w3.org/2000/svg';

    const desc = `Concurrent change, not direct conversion. Source: USDA ERS Major Land Uses, 2024-09-13.`;
    const topMap = buildExportSvg(topEl, { title: `${metricLabel(TOP_METRIC)} — ${st.name} (${STATE.year})`, desc });
    const botMap = buildExportSvg(botEl, { title: `${metricLabel(STATE.bottomMetric)} — ${st.name} (${STATE.year})`, desc });
    const topTs  = buildExportSvg(tsTop, { title: `${metricLabel(TOP_METRIC)} time series — ${st.name}`, desc });
    const botTs  = buildExportSvg(tsBot, { title: `${metricLabel(STATE.bottomMetric)} time series — ${st.name}`, desc });

    const headerH = 64;
    const captionH = 30;
    const W  = Math.max(topMap.w, botMap.w);
    // proportional time-series strip height
    const tsH = Math.round((W / topTs.w) * topTs.h);
    const H = headerH + topMap.h + tsH + botMap.h + tsH + captionH;

    const combo = document.createElementNS(NS, 'svg');
    combo.setAttribute('xmlns', NS);
    combo.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    combo.setAttribute('viewBox', `0 0 ${W} ${H}`);
    combo.setAttribute('width', W);
    combo.setAttribute('height', H);

    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#fff');
    combo.append(bg);

    const titleText = document.createElementNS(NS, 'text');
    titleText.textContent = `${st.name} — ${STATE.year}`;
    titleText.setAttribute('x', W / 2);
    titleText.setAttribute('y', 38);
    titleText.setAttribute('text-anchor', 'middle');
    titleText.setAttribute('font-size', 28);
    titleText.setAttribute('font-weight', 700);
    titleText.setAttribute('font-family', 'sans-serif');
    titleText.setAttribute('fill', '#1c1c1c');
    combo.append(titleText);

    function place(svg, x, y, w, h) {
      svg.removeAttribute('xmlns');
      svg.setAttribute('x', x); svg.setAttribute('y', y);
      svg.setAttribute('width', w); svg.setAttribute('height', h);
      combo.append(svg);
    }
    let cy = headerH;
    place(topMap.clone, 0, cy, W, topMap.h); cy += topMap.h;
    place(topTs.clone,  0, cy, W, tsH);      cy += tsH;
    place(botMap.clone, 0, cy, W, botMap.h); cy += botMap.h;
    place(botTs.clone,  0, cy, W, tsH);      cy += tsH;

    const cap = document.createElementNS(NS, 'text');
    cap.textContent = 'Concurrent change, not direct conversion. Source: USDA ERS Major Land Uses (2024-09-13).';
    cap.setAttribute('x', W / 2);
    cap.setAttribute('y', H - 10);
    cap.setAttribute('text-anchor', 'middle');
    cap.setAttribute('font-size', 12);
    cap.setAttribute('font-family', 'sans-serif');
    cap.setAttribute('fill', '#6e6e6e');
    combo.append(cap);

    const filename = `${st.abbr}_combined_${STATE.year}_${STATE.vizType}.${kind === 'svg' ? 'svg' : 'png'}`;
    if (kind === 'svg') {
      triggerDownload(svgToBlob(combo), filename);
    } else {
      rasterize(combo, W, H, 2, (blob) => blob && triggerDownload(blob, filename));
    }
  }

  // === TIME SERIES (small multiples) ===
  function renderTimeSeries(svgEl, metric, palette, customColor) {
    const T = d3.transition().duration(250);
    const sel = d3.select(svgEl);
    const abbr = DATA.states[STATE.slideIndex]?.abbr;
    if (!abbr) return;
    const series = YEARS.map(y => {
      const r = DATA.byKey.get(`${abbr}|${y}`);
      return { year: y, value: r ? +r[metric] || 0 : 0 };
    });

    const W = 480, H = 110;
    const M = { top: 26, right: 14, bottom: 18, left: 14 };
    const xs = d3.scalePoint().domain(YEARS).range([M.left, W - M.right]).padding(0.05);
    const maxV = d3.max(series, d => d.value) || 1;
    const ys = d3.scaleLinear().domain([0, maxV]).nice().range([H - M.bottom, M.top]);

    const color = colorScaleFor(metric, palette, customColor);
    const lineColor = color(maxV);
    const areaGen = d3.area().x(d => xs(d.year)).y0(ys(0)).y1(d => ys(d.value));
    const lineGen = d3.line().x(d => xs(d.year)).y(d => ys(d.value));

    function ensure(tag, cls) {
      let s = sel.select(`${tag}.${cls}`);
      if (s.empty()) s = sel.append(tag).attr('class', cls);
      return s;
    }

    ensure('text', 'ts-title')
      .attr('x', M.left).attr('y', 14)
      .text(metricLabel(metric).toUpperCase());

    const cur = series.find(d => d.year === STATE.year) || series[0];
    ensure('text', 'ts-value')
      .attr('x', W - M.right).attr('y', 14)
      .attr('text-anchor', 'end')
      .text(formatAcres(cur.value));

    ensure('line', 'ts-guide')
      .transition(T)
      .attr('x1', xs(STATE.year)).attr('x2', xs(STATE.year))
      .attr('y1', M.top).attr('y2', H - M.bottom);

    ensure('path', 'ts-area')
      .attr('fill', lineColor)
      .transition(T)
      .attr('d', areaGen(series));

    ensure('path', 'ts-line')
      .attr('stroke', lineColor)
      .transition(T)
      .attr('d', lineGen(series));

    sel.selectAll('circle.ts-dot')
      .data(series, d => d.year)
      .join(
        enter => enter.append('circle')
          .attr('class', d => d.year === STATE.year ? 'ts-dot ts-dot-active' : 'ts-dot')
          .attr('cx', d => xs(d.year))
          .attr('cy', d => ys(d.value))
          .attr('r', d => d.year === STATE.year ? 4 : 2)
          .attr('fill', d => d.year === STATE.year ? STATE.highlight : lineColor),
        update => update
          .attr('class', d => d.year === STATE.year ? 'ts-dot ts-dot-active' : 'ts-dot')
          .call(s => s.transition(T)
            .attr('cx', d => xs(d.year))
            .attr('cy', d => ys(d.value))
            .attr('r', d => d.year === STATE.year ? 4 : 2)
            .attr('fill', d => d.year === STATE.year ? STATE.highlight : lineColor)),
        exit => exit.remove()
      );

    const labelData = (STATE.year === 1945 || STATE.year === 2017)
      ? [1945, 2017]
      : [1945, STATE.year, 2017];
    sel.selectAll('text.ts-label')
      .data(labelData, d => d)
      .join(
        enter => enter.append('text')
          .attr('class', 'ts-label')
          .attr('x', d => xs(d))
          .attr('y', H - 4)
          .attr('text-anchor', 'middle')
          .attr('fill', d => d === STATE.year ? STATE.highlight : '#6e6e6e')
          .text(d => d),
        update => update
          .attr('x', d => xs(d))
          .attr('fill', d => d === STATE.year ? STATE.highlight : '#6e6e6e')
          .text(d => d),
        exit => exit.remove()
      );

    svgEl.setAttribute('aria-label',
      `${metricLabel(metric)} time series for ${DATA.states[STATE.slideIndex].name}, ` +
      `${STATE.year} value ${formatAcres(cur.value)}.`);
  }

  // === RENDER ===
  function formatAcres(v) {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1e6) return d3.format(',.1f')(v / 1e6) + 'M ac';
    if (v >= 1e3) return d3.format(',.0f')(v / 1e3) + 'K ac';
    return d3.format(',')(Math.round(v)) + ' ac';
  }

  // tooltip
  const tipEl = document.getElementById('tooltip');
  function tipMove(event, f) {
    const abbr = f._abbr;
    const r    = DATA.byKey.get(`${abbr}|${STATE.year}`);
    const r45  = DATA.byKey.get(`${abbr}|1945`);
    if (!r) { tipHide(); return; }
    const top = +r[TOP_METRIC] || 0;
    const bot = +r[STATE.bottomMetric] || 0;
    const dTop = top - (r45 ? +r45[TOP_METRIC] || 0 : 0);
    const dBot = bot - (r45 ? +r45[STATE.bottomMetric] || 0 : 0);
    const cls = v => v > 0 ? 'delta-up' : (v < 0 ? 'delta-dn' : '');
    const sgn = v => (v > 0 ? '+' : v < 0 ? '' : '±');
    tipEl.innerHTML =
      `<b>${r.state_name}</b> · ${STATE.year}<br>` +
      `Defense & industrial: <b>${formatAcres(top)}</b> ` +
      `<span class="${cls(dTop)}">(${sgn(dTop)}${formatAcres(Math.abs(dTop))} since 1945)</span><br>` +
      `${BOTTOM_METRICS[STATE.bottomMetric].label}: <b>${formatAcres(bot)}</b> ` +
      `<span class="${cls(dBot)}">(${sgn(dBot)}${formatAcres(Math.abs(dBot))} since 1945)</span>`;
    tipEl.style.left = event.clientX + 'px';
    tipEl.style.top  = (event.clientY - 8) + 'px';
    tipEl.classList.add('show');
  }
  function tipHide() { tipEl.classList.remove('show'); }

  function render() {
    const st = DATA.states[STATE.slideIndex];
    if (!st) return;

    // keep CSS var in sync so the glow filter tracks the user's highlight color
    document.documentElement.style.setProperty('--highlight', STATE.highlight);

    document.getElementById('stateTitle').textContent = st.name;

    document.getElementById('topLabel').textContent = 'Defense & industrial';
    document.getElementById('bottomLabel').textContent =
      BOTTOM_METRICS[STATE.bottomMetric].label;

    const topSvg = document.getElementById('mapTop');
    const botSvg = document.getElementById('mapBottom');
    renderMap(topSvg, TOP_METRIC, STATE.topPalette, STATE.topCustom, STATE.topOpacity);
    renderMap(botSvg, STATE.bottomMetric, STATE.bottomPalette, STATE.bottomCustom, STATE.bottomOpacity);

    renderTimeSeries(document.getElementById('multTop'),
      TOP_METRIC, STATE.topPalette, STATE.topCustom);
    renderTimeSeries(document.getElementById('multBottom'),
      STATE.bottomMetric, STATE.bottomPalette, STATE.bottomCustom);
  }
})();
