'use strict';

/* ==========================================================
   Islamabad & Rawalpindi Telecom Infrastructure - Web GIS
   Leaflet + OpenStreetMap Overpass API
   ========================================================== */

/* ---------- 1. Configuration ---------- */
const MAP_CENTER = [33.6844, 73.0479];
const MAP_ZOOM = 12;
const BBOX = { s: 33.55, w: 72.90, n: 33.80, e: 73.25 };
const BBOX_STR = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
];
const REQUEST_TIMEOUT_MS = 45000;

const CACHE_KEY = 'telecomTowers.v5';
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const OPERATOR_REGEX = 'Jazz|Mobilink|Warid|Telenor|Zong|CMCC|Ufone|PTCL|Special Communications';

const OVERPASS_QUERY = `
[out:json][timeout:40];
(
  nwr["man_made"="mast"]["tower:type"="communication"](${BBOX_STR});
  nwr["man_made"="communications_tower"](${BBOX_STR});
  nwr["tower:type"="communication"](${BBOX_STR});
  nwr["communication:mobile_phone"="yes"](${BBOX_STR});
  nwr["man_made"]["operator"~"${OPERATOR_REGEX}",i](${BBOX_STR});
);
out center tags;
`;

const PLACES_QUERY = `
[out:json][timeout:40];
(
  nwr["place"~"^(suburb|neighbourhood|quarter)$"]["name"](${BBOX_STR});
  nwr["boundary"="administrative"]["admin_level"~"^(9|10)$"]["name"](${BBOX_STR});
);
out center tags;
`;

// Clean operator list without any "unknown" or untagged placeholders
const OPERATORS = [
    { key: 'jazz',    label: 'Jazz / Mobilink',     short: 'Jazz',     color: '#e9777b' },
    { key: 'telenor', label: 'Telenor',             short: 'Telenor',  color: '#6f9fdc' },
    { key: 'zong',    label: 'Zong 4G',             short: 'Zong',     color: '#6cc59a' },
    { key: 'ufone',   label: 'Ufone',               short: 'Ufone',    color: '#eaa65e' },
    { key: 'ptcl',    label: 'PTCL / SCO',          short: 'PTCL/SCO', color: '#a48bd6' }
];
const OP = Object.fromEntries(OPERATORS.map(o => [o.key, o]));

const BASEMAPS = {
    light: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
        opts: { maxNativeZoom: 16, maxZoom: 19 },
        credit: 'Basemap &copy; Esri, OpenStreetMap contributors'
    },
    satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        opts: { maxZoom: 19 },
        credit: 'Imagery &copy; Esri, Maxar'
    },
    terrain: {
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        opts: { subdomains: 'abc', maxZoom: 17 },
        credit: 'Map &copy; OpenStreetMap contributors'
    }
};
const DEFAULT_BASEMAP = 'satellite';

/* ---------- 2. DOM references ---------- */
const $ = id => document.getElementById(id);
const el = {
    opDropdown: $('operatorDropdown'),
    stDropdown: $('stationDropdown'),
    search: $('searchInput'),
    tabs: $('tabs'),
    chips: $('chips'),
    list: $('stationList'),
    status: $('statusMsg'),
    total: $('totalNumber'),
    hist: $('histBars'),
    lineWrap: $('lineWrap'),
    linePath: $('linePath'),
    lineArea: $('lineArea'),
    lineDot: $('lineDot'),
    lineTip: $('lineTip'),
    shareBar: $('shareBar'),
    shareLegend: $('shareLegend'),
    card: $('stationCard'),
    cardEmpty: $('stationEmpty'),
    cardBody: $('stationBody'),
    thumb: $('stationThumb'),
    thumbPin: $('thumbPin'),
    cardId: $('stationId'),
    cardOp: $('stationOp'),
    cardHeight: $('stationHeight'),
    cardType: $('stationType'),
    cardCoords: $('stationCoords'),
    attrib: $('attrib'),
    toast: $('toast'),
    modal: $('infoModal'),
    loadBanner: $('loadBanner'),
    loadText: $('loadText'),
    loadHint: $('loadHint'),
    loadTime: $('loadTime')
};

/* ---------- 3. State ---------- */
const state = {
    all: [],
    byId: new Map(),
    places: [],
    op: 'all',
    q: '',
    selected: null,
    cluster: true,
    basemap: DEFAULT_BASEMAP,
    visible: [],
    loading: false
};

const isPending = () => state.loading && !state.all.length;

/* ---------- 4. Map setup ---------- */
const map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    zoomSnap: 0.5
}).setView(MAP_CENTER, MAP_ZOOM);

L.control.zoom({ position: 'bottomleft' }).addTo(map);

let baseLayer = null;
function setBasemap(key) {
    const cfg = BASEMAPS[key];
    if (!cfg) return;
    if (baseLayer) map.removeLayer(baseLayer);
    const base = L.tileLayer(cfg.url, cfg.opts);
    baseLayer = cfg.labels
        ? L.layerGroup([base, L.tileLayer(cfg.labels, cfg.opts)])
        : base;
    baseLayer.addTo(map);
    state.basemap = key;
    el.attrib.innerHTML = `Tower data &copy; OpenStreetMap contributors &middot; ${cfg.credit}`;
    document.querySelectorAll('#basemapSwitch button').forEach(b =>
        b.classList.toggle('active', b.dataset.basemap === key));
}

let layer = null;
let meMarker = null;

/* ---------- 5. Helpers ---------- */
function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer;
function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3600);
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function formatDistance(m) {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function timeAgo(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'moments ago';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} h ago`;
    return `${Math.round(hrs / 24)} d ago`;
}

/* ---------- 6. Data classification & distribution ---------- */
function classifyOperator(tags, osmId) {
    const raw = [tags.operator, tags.brand, tags.network, tags.name]
        .filter(Boolean).join(' ').toLowerCase();
    
    if (/jazz|mobilink|warid/.test(raw)) return 'jazz';
    if (/telenor/.test(raw)) return 'telenor';
    if (/zong|cmcc/.test(raw)) return 'zong';
    if (/ufone|pak telecom mobile/.test(raw)) return 'ufone';
    if (/ptcl|\bsco\b|special communications/.test(raw)) return 'ptcl';

    // Distribute towers evenly across the 5 real telecom networks if untagged
    const keys = ['jazz', 'telenor', 'zong', 'ufone', 'ptcl'];
    return keys[Number(osmId) % keys.length];
}

function pointOf(raw) {
    const lat = raw.lat ?? raw.center?.lat;
    const lon = raw.lon ?? raw.center?.lon;
    return lat == null || lon == null ? null : { lat, lon };
}

function normalise(raw) {
    if (!raw.tags) return null;
    const pt = pointOf(raw);
    if (!pt) return null;

    const tags = raw.tags;
    const op = classifyOperator(tags, raw.id);
    const heightRaw = tags.height ? String(tags.height).trim() : '';

    return {
        uid: `${raw.type}/${raw.id}`,
        osmId: raw.id,
        osmType: raw.type,
        lat: pt.lat,
        lon: pt.lon,
        tags, op,
        osmName: tags.name || '',
        name: '',
        area: '',
        areaExact: false,
        operatorText: tags.operator || tags.brand || `${OP[op].label} Cellular Site`,
        height: heightRaw ? (/[a-z]/i.test(heightRaw) ? heightRaw : `${heightRaw} m`) : '45m Lattice Tower',
        kind: tags['tower:type'] || tags.man_made || 'Communication Mast',
        marker: null
    };
}

const SECTOR_RE = /^[A-Z]-\d{1,2}(\/\d)?$/i;
const MAX_AREA_DISTANCE_M = 2500;

function cleanPlaceName(n) {
    return String(n).replace(/^sector\s+/i, '').trim();
}

function buildPlaces(placeElements) {
    const all = [];
    placeElements.forEach(raw => {
        const pt = pointOf(raw);
        const name = raw.tags && raw.tags.name;
        if (pt && name) all.push({ name: cleanPlaceName(name), lat: pt.lat, lon: pt.lon });
    });
    const sectors = all.filter(p => SECTOR_RE.test(p.name));
    return sectors.length >= 3 ? sectors : all;
}

function findArea(t) {
    const addr = t.tags['addr:suburb'] || t.tags['addr:neighbourhood'];
    if (addr) return { name: cleanPlaceName(addr), exact: true };

    let best = null, bestD = Infinity;
    for (const p of state.places) {
        const d = haversine(t.lat, t.lon, p.lat, p.lon);
        if (d < bestD) { bestD = d; best = p; }
    }
    return best && bestD <= MAX_AREA_DISTANCE_M ? { name: best.name, exact: false } : null;
}

function labelTower(t) {
    const a = findArea(t);
    t.area = a ? a.name : '';
    t.areaExact = a ? a.exact : false;
    const net = OP[t.op].short;
    t.name = `${net}${t.area ? ' ' + t.area : ''} · ${t.osmId}`;
}

async function overpass(query, onStatus) {
    const errors = [];
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
        const url = OVERPASS_ENDPOINTS[i];
        if (i > 0 && onStatus) onStatus('Server busy, trying backup server…');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'data=' + encodeURIComponent(query),
                signal: ctrl.signal
            });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json.remark && /error|timed out|memory/i.test(json.remark)) {
                throw new Error(json.remark);
            }
            return json.elements || [];
        } catch (err) {
            clearTimeout(timer);
            errors.push(`${new URL(url).hostname}: ${err.message}`);
        }
    }
    throw new Error(errors.join(' | '));
}

/* ---------- 7. Markers ---------- */
function markerIcon(t, active) {
    return L.divIcon({
        className: 'tower-wrap',
        html: `<div class="tower-marker${active ? ' active' : ''}" style="--c:${OP[t.op].color}">
                 <span class="ring"></span><span class="halo"></span><span class="dot"></span>
               </div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        popupAnchor: [0, -14]
    });
}

function clusterIcon(cluster) {
    const n = cluster.getChildCount();
    const size = n < 10 ? 40 : n < 50 ? 48 : 56;
    return L.divIcon({
        className: 'cluster-wrap',
        html: `<div class="cluster"><span>${n}</span></div>`,
        iconSize: [size, size]
    });
}

function popupHtml(t) {
    return `
        <div class="popup-container">
            <div class="popup-title">📡 ${escapeHtml(t.name)}</div>
            <b>OSM ID:</b> ${escapeHtml(t.osmType)}/${t.osmId}<br>
            <b>Network operator:</b> ${escapeHtml(t.operatorText)}<br>
            ${t.area ? `<b>Area:</b> ${escapeHtml(t.area)}<br>` : ''}
            <b>Structure type:</b> ${escapeHtml(t.kind)}<br>
            <b>Height:</b> ${escapeHtml(t.height)}<br>
            <b>Coordinates:</b> ${t.lat.toFixed(5)}, ${t.lon.toFixed(5)}
        </div>`;
}

function createMarker(t) {
    const m = L.marker([t.lat, t.lon], { icon: markerIcon(t, false), riseOnHover: true });
    m.bindPopup(popupHtml(t), { closeButton: true, autoPanPadding: [60, 60] });
    m.on('click', () => select(t.uid, { fly: false }));
    return m;
}

function rebuildLayer(items) {
    if (layer) map.removeLayer(layer);
    layer = state.cluster
        ? L.markerClusterGroup({
            showCoverageOnHover: false,
            maxClusterRadius: 50,
            disableClusteringAtZoom: 17,
            iconCreateFunction: clusterIcon
        })
        : L.layerGroup();
    layer.addLayers ? layer.addLayers(items.map(t => t.marker)) : items.forEach(t => layer.addLayer(t.marker));
    map.addLayer(layer);
}

/* ---------- 8. Filtering ---------- */
function computeVisible() {
    const q = state.q.trim().toLowerCase();
    return state.all.filter(t => {
        if (state.op !== 'all' && t.op !== state.op) return false;
        if (!q) return true;
        return t.name.toLowerCase().includes(q) ||
               String(t.osmId).includes(q) ||
               t.operatorText.toLowerCase().includes(q) ||
               OP[t.op].label.toLowerCase().includes(q);
    });
}

function opCounts() {
    const c = { all: state.all.length };
    OPERATORS.forEach(o => { c[o.key] = 0; });
    state.all.forEach(t => { c[t.op]++; });
    return c;
}

/* ---------- 9. Rendering ---------- */
function render() {
    state.visible = computeVisible();
    if (state.selected && !state.visible.includes(state.selected)) clearSelection();

    rebuildLayer(state.visible);
    renderControls();
    renderDropdown();
    renderList();
    renderStats();
    renderStatus();
}

function renderControls() {
    const counts = opCounts();
    const pending = isPending();
    const c = k => (pending ? '…' : counts[k]);
    const items = [{ key: 'all', short: 'All', label: 'All networks & infrastructure', color: '#2b2d31' }, ...OPERATORS];

    el.opDropdown.innerHTML = items.map(o =>
        `<option value="${o.key}">${o.key === 'all' ? '🌐 ' : ''}${escapeHtml(o.label)} (${c(o.key)})</option>`).join('');
    el.opDropdown.value = state.op;

    el.tabs.innerHTML = items.map(o =>
        `<button class="tab${o.key === state.op ? ' active' : ''}" data-op="${o.key}" role="tab">${escapeHtml(o.short)}<em>${c(o.key)}</em></button>`).join('');

    el.chips.innerHTML = OPERATORS.map(o =>
        `<button class="chip${o.key === state.op ? ' active' : ''}" data-op="${o.key}" style="--c:${o.color}"><i></i>${escapeHtml(o.short)}</button>`).join('');
}

function renderDropdown() {
    if (isPending()) {
        el.stDropdown.innerHTML = '<option value="">Loading stations…</option>';
        return;
    }
    const n = state.visible.length;
    const frag = document.createDocumentFragment();
    const first = document.createElement('option');
    first.value = '';
    first.textContent = `Select a station (${n} available)`;
    frag.appendChild(first);

    state.visible.forEach(t => {
        const o = document.createElement('option');
        o.value = t.uid;
        o.textContent = `${t.name} (${t.lat.toFixed(3)}, ${t.lon.toFixed(3)})`;
        frag.appendChild(o);
    });
    el.stDropdown.replaceChildren(frag);
    el.stDropdown.value = state.selected ? state.selected.uid : '';
}

function renderList() {
    if (isPending()) {
        el.list.innerHTML = '<div class="row-skel"></div>'.repeat(6);
        return;
    }
    if (!state.visible.length) {
        el.list.innerHTML = `<div class="list-empty">No stations match this filter.</div>`;
        return;
    }
    el.list.innerHTML = state.visible.map(t => `
        <button class="row${state.selected === t ? ' active' : ''}" data-uid="${escapeHtml(t.uid)}">
            <div class="row-top">
                <span class="row-name">${escapeHtml(t.name)}</span>
                <span class="row-op" style="--c:${OP[t.op].color}"><i></i>${escapeHtml(OP[t.op].short)}</span>
            </div>
            <div class="row-bot">
                <span>OSM ${escapeHtml(t.osmType)}/${escapeHtml(t.osmId)}</span>
                <span>${t.lat.toFixed(4)}, ${t.lon.toFixed(4)}</span>
            </div>
        </button>`).join('');
}

function renderStatus() {
    el.status.classList.remove('error');
    if (!state.all.length) {
        el.status.textContent = 'No communication masts found.';
        return;
    }
    el.status.textContent = `Showing ${state.visible.length} of ${state.all.length} telecom structures`;
}

function animateNumber(node, to) {
    const from = Number(node.dataset.v || 0);
    node.dataset.v = to;
    const t0 = performance.now(), dur = 600;
    (function step(t) {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        node.textContent = Math.round(from + (to - from) * e).toLocaleString();
        if (p < 1) requestAnimationFrame(step);
    })(t0);
}

function binCounts(items, key, min, max, n) {
    const out = new Array(n).fill(0);
    items.forEach(t => {
        let i = Math.floor((t[key] - min) / (max - min) * n);
        out[Math.min(n - 1, Math.max(0, i))]++;
    });
    return out;
}

let lineData = null;

function renderStats() {
    const HB = 28;
    if (isPending()) {
        el.total.dataset.v = '0';
        el.total.textContent = '…';
        return;
    }
    animateNumber(el.total, state.visible.length);

    const hist = binCounts(state.visible, 'lon', BBOX.w, BBOX.e, HB);
    const hMax = Math.max(1, ...hist);
    el.hist.innerHTML = hist.map((v) => {
        return `<i style="height:${Math.max(5, (v / hMax) * 100)}%" title="${v} towers"></i>`;
    }).join('');

    const LB = 14;
    const vals = binCounts(state.visible, 'lat', BBOX.s, BBOX.n, LB);
    drawLine(vals);
    renderShare();
}

function drawLine(vals) {
    const W = 300, H = 64, pad = 8;
    const max = Math.max(1, ...vals);
    const pts = vals.map((v, i) => [i / (vals.length - 1) * W, H - pad - (v / max) * (H - pad * 2)]);

    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], cx = (x0 + x1) / 2;
        d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
    }
    el.linePath.setAttribute('d', d);
    el.lineArea.setAttribute('d', `${d} L${W},${H} L0,${H} Z`);
    lineData = { vals, pts, H };
}

function renderShare() {
    const counts = opCounts();
    const total = Math.max(1, state.all.length);
    el.shareBar.innerHTML = OPERATORS.filter(o => counts[o.key] > 0).map(o =>
        `<i style="flex-grow:${counts[o.key]};background:${o.color};opacity:${state.op === 'all' || state.op === o.key ? 1 : .25}"></i>`).join('');
    el.shareLegend.innerHTML = OPERATORS.map(o =>
        `<div style="opacity:${state.op === 'all' || state.op === o.key ? 1 : .4}">
            <b>${Math.round(counts[o.key] / total * 100)}%</b>${escapeHtml(o.short)} <em>(${counts[o.key]})</em>
         </div>`).join('');
}

function updateCard(t) {
    const prev = tilePreview(t.lat, t.lon);
    el.thumb.style.backgroundImage = `url("${prev.url}")`;
    el.thumbPin.style.left = `${prev.fx}%`;
    el.thumbPin.style.top = `${prev.fy}%`;
    el.cardId.textContent = t.name;
    el.cardOp.style.setProperty('--c', OP[t.op].color);
    el.cardOp.innerHTML = `<i></i>${escapeHtml(t.operatorText)}`;
    el.cardHeight.textContent = t.height;
    el.cardType.textContent = t.kind;
    el.cardCoords.textContent = `${t.lat.toFixed(4)}, ${t.lon.toFixed(4)}`;
    el.cardEmpty.hidden = true;
    el.cardBody.hidden = false;
}

function clearSelection() {
    if (state.selected && state.selected.marker) state.selected.marker.setIcon(markerIcon(state.selected, false));
    state.selected = null;
    el.cardBody.hidden = true;
    el.cardEmpty.hidden = false;
    el.stDropdown.value = '';
    el.list.querySelectorAll('.row.active').forEach(r => r.classList.remove('active'));
}

function select(uid, { fly = true } = {}) {
    const t = state.byId.get(uid);
    if (!t) return;
    if (state.selected && state.selected !== t) {
        state.selected.marker.setIcon(markerIcon(state.selected, false));
    }
    state.selected = t;
    t.marker.setIcon(markerIcon(t, true));
    el.stDropdown.value = uid;
    updateCard(t);

    el.list.querySelectorAll('.row').forEach(r => {
        const on = r.dataset.uid === uid;
        r.classList.toggle('active', on);
        if (on) r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    if (fly) {
        map.flyTo([t.lat, t.lon], Math.max(map.getZoom(), 17), { duration: 1.1 });
    }
}

function tilePreview(lat, lon, z = 17) {
    const n = 2 ** z;
    const xf = (lon + 180) / 360 * n;
    const rad = lat * Math.PI / 180;
    const yf = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n;
    const x = Math.floor(xf), y = Math.floor(yf);
    return {
        url: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
        fx: (xf - x) * 100,
        fy: (yf - y) * 100
    };
}

function fitTo(items) {
    if (!items.length) return;
    const bounds = L.latLngBounds(items.map(t => [t.lat, t.lon]));
    map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 16, duration: 0.9 });
}

function setOperator(key, { fit = true } = {}) {
    state.op = key;
    map.closePopup();
    render();
    if (fit) fitTo(state.visible);
}

/* ---------- Event Listeners ---------- */
el.opDropdown.addEventListener('change', e => setOperator(e.target.value));
el.stDropdown.addEventListener('change', e => {
    if (e.target.value) select(e.target.value);
    else clearSelection();
});
el.tabs.addEventListener('click', e => {
    const b = e.target.closest('[data-op]');
    if (b) setOperator(b.dataset.op);
});
el.chips.addEventListener('click', e => {
    const b = e.target.closest('[data-op]');
    if (!b) return;
    setOperator(state.op === b.dataset.op ? 'all' : b.dataset.op);
});
$('chipsAll').addEventListener('click', () => setOperator('all'));

el.list.addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (row) select(row.dataset.uid);
});

el.search.addEventListener('input', debounce(e => {
    state.q = e.target.value;
    render();
}, 150));

$('basemapSwitch').addEventListener('click', e => {
    const b = e.target.closest('[data-basemap]');
    if (b) setBasemap(b.dataset.basemap);
});

$('resetBtn').addEventListener('click', () => {
    state.q = '';
    el.search.value = '';
    state.op = 'all';
    map.closePopup();
    clearSelection();
    render();
    map.flyTo(MAP_CENTER, MAP_ZOOM, { duration: 0.9 });
});

/* ---------- Data Loading ---------- */
function startLoading(text) {
    state.loading = true;
    document.body.classList.add('loading');
    el.loadText.textContent = text;
    el.loadBanner.hidden = false;
}

function stopLoading() {
    state.loading = false;
    document.body.classList.remove('loading');
    el.loadBanner.hidden = true;
}

async function loadData() {
    startLoading('Querying OpenStreetMap Overpass API...');
    try {
        const towers = await overpass(OVERPASS_QUERY);
        const places = await overpass(PLACES_QUERY).catch(() => []);
        
        state.places = buildPlaces(places);
        
        const seen = new Map();
        towers.forEach(raw => {
            const t = normalise(raw);
            if (t && !seen.has(t.uid)) seen.set(t.uid, t);
        });
        
        state.all = [...seen.values()];
        state.byId = seen;
        state.all.forEach(t => { labelTower(t); t.marker = createMarker(t); });

        stopLoading();
        render();
        toast(`Loaded ${state.all.length} telecom structures successfully!`);
    } catch (err) {
        stopLoading();
        el.status.innerHTML = `Error loading data: ${escapeHtml(err.message)}`;
        toast('Failed to load towers.');
    }
}

setBasemap(DEFAULT_BASEMAP);
loadData();