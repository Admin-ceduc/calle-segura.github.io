(() => {
const API = (window.CALLE_SEGURA_API_URL || (location.protocol === 'file:' ? 'http://localhost:5000' : '')).replace(/\/+$/, '');
const API_UNCONFIGURED = location.hostname.endsWith('.github.io') && !API;
const BASE_PATH = window.CALLE_SEGURA_BASE_PATH || '/';
const loadUser = () => {
  try { return JSON.parse(localStorage.getItem('cs_user') || 'null'); }
  catch { localStorage.removeItem('cs_user'); return null; }
};
const CATS = {
  em: {
    Carabineros: ['Robo o asalto', 'Accidente', 'Persona en riesgo', 'Violencia intrafamiliar', 'Otro'],
    Bomberos: ['Incendio', 'Rescate', 'Fuga de gas', 'Accidente', 'Otro'],
    Ambulancia: ['Accidente', 'Emergencia médica', 'Persona en riesgo', 'Otro'],
    'Seguridad municipal': ['Robo o asalto', 'Persona en riesgo', 'Ruido molesto', 'Vandalismo', 'Otro'],
    Otro: ['Emergencia general', 'Otro']
  },
  pr: ['Luminaria apagada', 'Basura acumulada', 'Bache o vereda dañada', 'Grafiti', 'Otro']
};
const SERVICES = ['Carabineros', 'Bomberos', 'Ambulancia', 'Seguridad municipal', 'Otro'];
const STATUSES = ['Nuevo', 'Visto', 'En curso', 'Resuelto'];
const LEBU_CENTER = [-37.6163, -73.6511];
const B = { minLat: -37.66, maxLat: -37.57, minLon: -73.70, maxLon: -73.60 };
const LEBU_BOUNDS = [[B.minLat, B.minLon], [B.maxLat, B.maxLon]];
const S = {
  user: loadUser(), reports: [], users: [], notifications: [],
  filter: 'all', muniSearch: '', muniStatus: 'all', muniType: 'all',
  muniPriority: 'all', muniAssignee: 'all',
  sel: null, type: 'em', pick: null, photo: null, form: {}, tracking: null
};
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isStaff = () => S.user && ['staff', 'admin'].includes(S.user.role);

async function api(path, opts) {
  if (API_UNCONFIGURED) throw new Error('El backend de Calle Segura todavía no está conectado.');
  const headers = {};
  if (S.user?.token) headers.Authorization = `Bearer ${S.user.token}`;
  const fetchOptions = opts ? { ...opts, headers } : { headers };
  if (opts?.body instanceof FormData) {
    fetchOptions.body = opts.body;
  } else if (opts?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(opts.body);
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  let r, d;
  try {
    fetchOptions.signal = controller.signal;
    r = await fetch(API + path, fetchOptions);
    d = await r.json().catch(error => {
      if (error.name === 'AbortError') throw error;
      return {};
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('El servidor tardó demasiado en responder. Intenta nuevamente.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  if (!r.ok) {
    const error = new Error(d.error || 'Error de servidor');
    error.status = r.status;
    throw error;
  }
  return d;
}
async function showReportPhoto(button) {
  const reportId = button.dataset.viewPhoto;
  button.disabled = true;
  try {
    const headers = S.user?.token ? { Authorization: `Bearer ${S.user.token}` } : {};
    const response = await fetch(`${API}/api/reports/${reportId}/photo`, { headers });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'No se pudo cargar la foto');
    }
    const url = URL.createObjectURL(await response.blob());
    const dialog = document.createElement('dialog');
    dialog.className = 'photo-dialog';
    dialog.innerHTML = '<button type="button" class="btn ghost sm photo-dialog-close">Cerrar</button><img alt="Foto adjunta al reporte">';
    dialog.querySelector('img').src = url;
    dialog.querySelector('.photo-dialog-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => { URL.revokeObjectURL(url); dialog.remove(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.append(t); setTimeout(() => t.remove(), 2800);
}
function ago(s) {
  const m = Math.max(0, Math.round((Date.now() - new Date(s.replace(' ', 'T') + 'Z')) / 60000));
  if (m < 1) return 'ahora'; if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60); return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}
const tag = r => `<span class="tag t-${r.type}">${r.type === 'em' ? 'Emergencia' : 'Problema'}</span> <span class="tag s-${r.status.replace(' ', '-')}">${esc(r.status)}</span>`;

/* ---------- mapa de Lebu ---------- */
function mapHTML(kind = 'all') {
  const pick = kind === 'picker';
  return `<div class="leaflet-map ${pick ? 'pick' : ''}" id="${pick ? 'pickmap' : `map-${kind}`}" data-leaflet-map="${kind}" role="application" aria-label="Mapa de reportes de Lebu"></div>`;
}
function markerIcon(type) {
  return L.divIcon({
    className: 'report-marker-icon',
    html: `<span class="report-marker ${type}" aria-hidden="true"><span>✓</span></span>`,
    iconSize: [34, 44],
    iconAnchor: [17, 44],
    popupAnchor: [0, -40]
  });
}
let pickMap = null, pickLayer = null, pickPanelPlaceholder = null;
function drawPick(recenter) {
  if (!pickMap || !pickLayer || !S.pick || !document.body.contains(pickMap.getContainer())) return;
  const p = [S.pick.lat, S.pick.lon];
  pickLayer.clearLayers();
  L.circleMarker(p, { radius: 10, color: '#fff', weight: 4, fillColor: '#2D7DE0', fillOpacity: 1 }).addTo(pickLayer);
  L.circle(p, { radius: 35, color: '#2D7DE0', weight: 2, fill: false, opacity: .55 }).addTo(pickLayer);
  if (recenter) pickMap.setView(p, Math.max(pickMap.getZoom(), 16));
}
function setPick(lat, lon, recenter) {
  S.pick = { lat, lon };
  saveReportForm();
  drawPick(recenter);
  const hint = $('#pickhint');
  if (hint) hint.textContent = 'Punto marcado ✓. Arrastra para explorar y toca otro lugar para cambiarlo.';
}
function setPickerExpanded(expanded) {
  const panel = $('#picker-panel');
  if (!panel) return;
  if (expanded && !pickPanelPlaceholder) {
    pickPanelPlaceholder = document.createComment('picker-panel');
    panel.parentNode.insertBefore(pickPanelPlaceholder, panel);
    document.body.append(panel);
  } else if (!expanded && pickPanelPlaceholder?.parentNode) {
    pickPanelPlaceholder.parentNode.insertBefore(panel, pickPanelPlaceholder);
    pickPanelPlaceholder.remove();
    pickPanelPlaceholder = null;
  }
  panel.classList.toggle('expanded', expanded);
  document.body.classList.toggle('map-expanded', expanded);
  const openButton = $('#open-picker');
  if (openButton) openButton.hidden = expanded;
  const closeButton = $('#close-picker');
  if (closeButton) closeButton.hidden = !expanded;
  if (expanded) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    closeButton?.focus();
  } else {
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    $('#pickmap')?.focus();
  }
  window.setTimeout(() => pickMap?.invalidateSize(), 0);
}
function initMaps() {
  if (!window.L) return;
  document.querySelectorAll('[data-leaflet-map]').forEach(el => {
    if (el._leaflet_id) return;
    const kind = el.dataset.leafletMap;
    const pick = kind === 'picker';
    const list = kind === 'filtered' ? S.reports.filter(r => S.filter === 'all' || r.type === S.filter) : S.reports;
    const point = pick ? S.pick : null;
    const center = point ? [point.lat, point.lon] : LEBU_CENTER;
    const map = L.map(el, { zoomControl: true, maxBounds: LEBU_BOUNDS, maxBoundsViscosity: 1 }).setView(center, point ? 16 : 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    const markerBounds = [];
    list.forEach(r => {
      const position = [r.latitude, r.longitude];
      markerBounds.push(position);
      const marker = L.marker(position, { icon: markerIcon(r.type), title: r.category }).addTo(map);
      const service = r.type === 'em' && r.emergency_service ? `<br><small>Servicio: ${esc(r.emergency_service)}</small>` : '';
      marker.bindPopup(`<strong>${esc(r.category)}</strong>${service}<br>${esc(r.description || 'Sin descripción')}<br><small>${esc(r.address || 'Sin dirección')}</small>`);
      if (!pick) marker.on('click', () => { S.sel = r.id; render(); });
      if (!pick && S.sel === r.id) marker.openPopup();
    });
    if (pick) {
      pickMap = map;
      pickLayer = L.layerGroup().addTo(map);
      drawPick(false);
      map.on('click', e => {
        setPick(e.latlng.lat, e.latlng.lng, false);
        setPickerExpanded(true);
      });
    } else if (markerBounds.length > 1) {
      map.fitBounds(markerBounds, { padding: [28, 28], maxZoom: 14 });
    }
    window.setTimeout(() => map.invalidateSize(), 0);
  });
}

/* ---------- cascarón ---------- */
const icons = {
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'
};
const ico = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[k]}</svg>`;

function shell(route, body) {
  const on = r => route === r ? 'on' : '';
  const who = S.user ? `<a class="ava" href="#/perfil" title="Ver perfil de ${esc(S.user.email)}" aria-label="Ver mi perfil">${esc(S.user.email[0].toUpperCase())}</a>` : '<a class="btn pr sm" href="#/ingresar">Ingresar</a>';
  return `<header><div class="bar"><a class="logo" href="#/"><img src="logo-mark.svg?v=2" alt=""><span>Calle Segura</span></a>
    <nav aria-label="Principal"><a class="${on('')}" href="#/">Inicio</a><a class="${on('mapa')}" href="#/mapa">Mapa</a><a class="${on('reportar')}" href="#/reportar">Reportar</a></nav>${who}</div></header>
    <main class="view">${body}</main>`;
}
function muniShell(route, body) {
  const on = r => route === r ? 'on' : '';
  const nuevos = S.reports.filter(r => r.status === 'Nuevo').length;
  return `<div class="muni"><nav class="rail" aria-label="Navegación municipal">
    <a class="lg" href="#/muni"><img src="logo-calle-segura.png" alt=""><span>Calle Segura</span></a>
    <a class="${on('muni')}" href="#/muni" title="Resumen">${ico('grid')}<span>Resumen</span></a>
    <a class="${on('muni/reportes')}" href="#/muni/reportes" title="Reportes">${ico('list')}<span>Reportes</span>${nuevos ? `<span class="badge">${nuevos}</span>` : ''}</a>
    <a class="${on('muni/usuarios')}" href="#/muni/usuarios" title="Usuarios">${ico('users')}<span>Usuarios</span></a>
    <a class="out" href="#/salir" title="Salir" aria-label="Cerrar sesión">${ico('out')}<span>Cerrar sesión</span></a></nav>
    <div class="mmain view">${body}</div></div>`;
}

/* ---------- vistas ciudadano ---------- */
function stats(list) {
  const n = f => list.filter(f).length;
  return `<div class="stats"><div class="dk"><b>${list.length}</b><span>Reportes</span></div><div><b>${n(r => r.type === 'em')}</b><span>Emergencias</span></div><div><b>${n(r => r.type === 'pr')}</b><span>Problemas</span></div><div><b>${n(r => r.status === 'Resuelto')}</b><span>Resueltos</span></div></div>`;
}
function vInicio() {
  const passkeyAction = S.user ? '<button class="btn ghost" type="button" id="register-passkey">🔐 Activar huella</button>' : '';
  const welcomePanel = S.user
    ? `<div class="herocard">${mapHTML('all')}</div>`
    : `<div class="hero-access box"><div class="access-icon">⌖</div><h3>Ingresa para continuar</h3><p>Para ver el mapa y reportar una situación necesitas iniciar sesión.</p><a class="btn pr full" href="#/ingresar">Ingresar ahora</a><small>Acceso con correo y contraseña</small></div>`;
  return `<section class="hero"><div><h1>Tu calle, <em>más segura</em> entre todos.</h1>
    <p class="lead">Reporta emergencias y problemas de tu barrio en segundos y sigue cómo la municipalidad responde.</p>
    <div class="row"><a class="btn em" href="#/reportar">Reportar ahora</a><a class="btn ghost" href="#/mapa">Ver el mapa</a>${passkeyAction}</div>
    <div class="sos"><b>¿Emergencia en curso?</b> Llama primero al 133 (Carabineros), 132 (Bomberos) o 131 (Ambulancia).</div></div>
    ${welcomePanel}</section>
    ${stats(S.reports)}
    <h2>Así funciona</h2><div class="steps">
    <div class="box"><div class="n">1</div><h3>Marca el lugar</h3><p>Toca el mapa donde ocurre lo que quieres reportar.</p></div>
    <div class="box"><div class="n">2</div><h3>Cuéntanos qué pasa</h3><p>Elige si es emergencia o problema y describe brevemente.</p></div>
    <div class="box"><div class="n">3</div><h3>Sigue el estado</h3><p>Nuevo, visto, en curso o resuelto: lo ves en el mapa.</p></div></div>`;
}
function reportCard(r) {
  const service = r.type === 'em' && r.emergency_service ? `<small>Servicio: ${esc(r.emergency_service)}</small>` : '';
  const photo = r.has_photo && r.can_view_photo ? `<button type="button" class="btn ghost sm photo-view" data-view-photo="${r.id}">📷 Ver foto</button>` : '';
  return `<div class="card" data-card="${r.id}"><div class="top"><div>${tag(r)}</div><small>${ago(r.created_at)}</small></div><h3>${esc(r.category)}</h3>${service}<p>${esc(r.description || 'Sin descripción')}</p><small>${esc(r.address || 'Sin dirección')}</small>${photo}</div>`;
}
function vMapa() {
  if (!S.user) return `<div class="auth box"><h2>Ingresa para reportar</h2><p class="hint">Inicia sesión para ver el mapa y gestionar tus reportes.</p><a class="btn full" style="margin-top:14px" href="#/ingresar">Ingresar</a></div>`;
  const list = S.reports.filter(r => S.filter === 'all' || r.type === S.filter);
  const seg = [['all', 'Todos'], ['em', 'Emergencias'], ['pr', 'Problemas']].map(([k, l]) => `<button class="${S.filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('');
  const shown = S.sel ? list.filter(r => r.id === S.sel) : list;
  const reportAction = S.user
    ? '<a class="btn pr" href="#/reportar">Crear reporte</a>'
    : '<div class="map-login"><p class="hint">Para reportar necesitas ingresar.</p><a class="btn pr" href="#/ingresar">Ingresa para reportar</a></div>';
  return `<h2>Mapa de <em>reportes</em></h2><div class="seg" role="group" aria-label="Filtro">${seg}</div>
    <div class="two"><div class="box">${mapHTML('filtered')}<p class="hint">Toca un pin para ver el detalle${S.sel ? ' · <a href="#/mapa" data-clear>quitar selección</a>' : ''}.</p>${reportAction}</div>
    <div>${shown.map(reportCard).join('') || '<p class="hint">No hay reportes.</p>'}${S.tracking ? `<div class="box" style="margin-top:16px"><b>Seguimiento de emergencia activo</b><p class="hint">Tu ubicación se comparte mientras esta página permanezca abierta.</p><button class="btn ghost" type="button" data-stop-tracking>Detener seguimiento</button></div>` : ''}</div></div>`;
}
function vReportar() {
  if (!S.user) return `<div class="auth box"><h2>Ingresa para reportar</h2><p class="hint">Necesitas una cuenta para que podamos hacer seguimiento.</p><a class="btn full" style="margin-top:14px" href="#/ingresar">Ingresar</a></div>`;
  const f = S.form;
  const categories = S.type === 'em' ? (CATS.em[f.service || 'Carabineros'] || CATS.em.Carabineros) : CATS.pr;
  return `<h2 id="report-title">Nuevo <em>reporte</em></h2>
    <aside class="report-emergency" aria-label="Teléfonos de emergencia"><b>¿Emergencia inmediata?</b><span>Llama primero:</span><a href="tel:133">133 Carabineros</a><a href="tel:132">132 Bomberos</a><a href="tel:131">131 Ambulancia</a></aside>
    <div class="report-progress" id="report-progress" aria-live="polite"><div class="report-progress-copy"><span id="report-step-current">1 de 3</span><b id="report-step-label">Tipo y categoría</b></div><div class="report-progress-track"><span id="report-progress-fill"></span></div></div>
    <div class="two report-layout" id="report-layout" data-report-step="1"><form class="box report-form" id="rform" novalidate>
    <section class="report-step" data-step="1" aria-label="Tipo y categoría">
    <label>Tipo</label><div class="types"><button type="button" class="em ${S.type === 'em' ? 'on' : ''}" data-type="em">🚨 Emergencia</button><button type="button" class="pr ${S.type === 'pr' ? 'on' : ''}" data-type="pr">🛠 Problema</button></div>
    <label for="cat">Categoría</label><select id="cat">${categories.map(c => `<option ${c === f.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
    <input id="customcat" value="${esc(f.customCat || '')}" placeholder="Escribe la categoría" maxlength="80" hidden>
    <label id="service-label" for="service">Compañía o servicio de emergencia</label><select id="service">${SERVICES.map(service => `<option ${service === (f.service || 'Carabineros') ? 'selected' : ''}>${service}</option>`).join('')}</select>
    <div class="report-step-nav"><button class="btn ghost" type="button" data-report-back="1" hidden>Volver</button><button class="btn" type="button" data-report-next="2">Continuar</button></div>
    </section>
    <section class="report-step" data-step="2" aria-label="Detalles del reporte">
    <label for="desc">Descripción (opcional)</label><textarea id="desc" placeholder="Agrega detalles si los tienes">${esc(f.desc || '')}</textarea>
    <label for="addr">Dirección o referencia</label><input id="addr" value="${esc(f.addr || '')}" placeholder="Ej: Calle Prat con Calle Lira">
    <label class="hint report-track-label"><input id="track-location" type="checkbox" ${f.track ? 'checked' : ''}> Si es un robo o asalto, compartir mi ubicación en vivo mientras la página esté abierta.</label>
    <div class="photo-upload" id="photo-field" hidden><label for="report-photo">Foto del lugar (opcional)</label><p class="hint">Disponible para Bomberos o reportes de Problema. Puedes tomarla ahora o elegirla desde tu galería. Máximo 5 MB; JPG, PNG o WebP.</p><input id="report-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"><div class="photo-preview" id="photo-preview-wrap" hidden><img id="photo-preview" alt="Vista previa de la foto del reporte"><button class="btn ghost sm" type="button" data-remove-photo>Quitar foto</button></div></div>
    <div class="report-step-nav"><button class="btn ghost" type="button" data-report-back="1">Volver</button><button class="btn" type="button" data-report-next="3">Elegir ubicación</button></div>
    </section>
    <button class="btn full report-submit report-submit-desktop ${S.type}" style="margin-top:18px" type="submit">Enviar reporte</button></form>
    <div class="box picker-panel" id="picker-panel"><div class="picker-head"><h3>Marca la ubicación</h3><div class="picker-head-actions"><button type="button" class="btn ghost sm" id="open-picker">Ampliar mapa</button><button type="button" class="btn ghost sm" id="close-picker" hidden>Cerrar mapa</button></div></div><button type="button" class="btn gps" id="usegps">⌖ Usar mi ubicación</button>${mapHTML('picker')}<p class="hint" id="pickhint">${S.pick ? 'Punto marcado ✓. Arrastra para explorar y toca otro lugar para cambiarlo.' : 'Toca el mapa para ampliarlo y marcar ese punto. También puedes usar «Ampliar mapa» y elegirlo después.'}</p>
    <div class="report-mobile-actions"><button class="btn ghost" type="button" data-report-back="2">Volver a detalles</button><button class="btn full report-submit ${S.type}" type="submit" form="rform">Enviar reporte</button></div></div></div>`;
}
function setCustomCategory() {
  const select = $('#cat'), input = $('#customcat');
  if (!select || !input) return;
  const custom = select.value === 'Otro';
  input.hidden = !custom;
  input.required = custom;
  if (!custom) input.value = '';
}
function clearReportPhoto() {
  S.photo = null;
  if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  photoPreviewUrl = null;
  const input = $('#report-photo');
  if (input) input.value = '';
  const preview = $('#photo-preview');
  if (preview) { preview.removeAttribute('src'); preview.hidden = true; }
  const previewWrap = $('#photo-preview-wrap');
  if (previewWrap) previewWrap.hidden = true;
}
function setReportPhotoVisibility() {
  const field = $('#photo-field');
  if (!field) return;
  const allowed = S.type === 'pr' || $('#service')?.value === 'Bomberos';
  field.hidden = !allowed;
  if (!allowed) clearReportPhoto();
}
let photoPreviewUrl = null;
function setEmergencyService() {
  const label = $('#service-label'), select = $('#service');
  if (!label || !select) return;
  const visible = S.type === 'em';
  label.hidden = !visible;
  select.hidden = !visible;
  select.required = visible;
}
function setCategoryOptions(selected = '') {
  const select = $('#cat');
  if (!select) return;
  const service = $('#service')?.value || 'Carabineros';
  const categories = S.type === 'em' ? (CATS.em[service] || CATS.em.Carabineros) : CATS.pr;
  const chosen = categories.includes(selected) ? selected : categories[0];
  select.innerHTML = categories.map(category => `<option ${category === chosen ? 'selected' : ''}>${category}</option>`).join('');
}
function saveReportForm() {
  S.form = { desc: $('#desc')?.value || '', addr: $('#addr')?.value || '', customCat: $('#customcat')?.value || '', service: $('#service')?.value || '', category: $('#cat')?.value || '', track: $('#track-location')?.checked || false };
}
function setReportStep(step) {
  const layout = $('#report-layout');
  if (!layout) return;
  saveReportForm();
  layout.dataset.reportStep = String(step);
  const labels = { 1: 'Tipo y categoría', 2: 'Detalles', 3: 'Ubicación' };
  const current = $('#report-step-current');
  const label = $('#report-step-label');
  const progress = $('#report-progress-fill');
  if (current) current.textContent = `${step} de 3`;
  if (label) label.textContent = labels[step];
  if (progress) progress.style.width = `${step / 3 * 100}%`;
  if (window.matchMedia('(max-width: 860px)').matches) {
    window.scrollTo({ top: $('#report-title').offsetTop, behavior: 'smooth' });
  }
  window.setTimeout(() => pickMap?.invalidateSize(), 0);
}
function useGps() {
  if (!navigator.geolocation) { toast('Este navegador no permite usar GPS'); return; }
  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    if (location.hostname === 'calle-segura') {
      toast('Abriendo una dirección compatible con ubicación…');
      window.setTimeout(() => { window.location.href = `http://localhost${location.pathname}${location.search}${location.hash}`; }, 500);
      return;
    }
    toast('La ubicación requiere abrir este sitio mediante HTTPS');
    return;
  }
  const button = $('#usegps');
  if (button) { button.disabled = true; button.textContent = 'Buscando ubicación…'; }
  navigator.geolocation.getCurrentPosition(position => {
    setPick(position.coords.latitude, position.coords.longitude, true);
    if (button) { button.disabled = false; button.textContent = '⌖ Usar mi ubicación'; }
    toast('Ubicación encontrada');
  }, error => {
    if (button) { button.disabled = false; button.textContent = '⌖ Usar mi ubicación'; }
    const message = error.code === 1 ? 'Permite el acceso a la ubicación' : error.code === 2 ? 'No se pudo encontrar tu ubicación' : 'El GPS tardó demasiado';
    toast(message);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
function stopLiveTracking(showMessage = true) {
  if (S.tracking?.watchId != null) navigator.geolocation.clearWatch(S.tracking.watchId);
  S.tracking = null;
  if (showMessage) toast('Seguimiento de ubicación detenido');
}
function startLiveTracking(reportId) {
  if (!navigator.geolocation) { toast('Este navegador no permite seguimiento GPS'); return; }
  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    toast('El seguimiento requiere abrir el sitio mediante HTTPS');
    return;
  }
  stopLiveTracking(false);
  S.tracking = { reportId, watchId: null, lastSentAt: 0, announced: false };
  const sendPosition = async position => {
    const tracking = S.tracking;
    if (!tracking || tracking.reportId !== reportId) return;
    const now = Date.now();
    if (now - tracking.lastSentAt < 15000) return;
    tracking.lastSentAt = now;
    try {
      await api(`/api/reports/${reportId}/location`, { method: 'POST', body: { latitude: position.coords.latitude, longitude: position.coords.longitude } });
      if (!tracking.announced) { tracking.announced = true; toast('Seguimiento activo: compartiendo ubicación cada 15 segundos'); }
    } catch (error) {
      stopLiveTracking(false);
      toast(error.message);
    }
  };
  S.tracking.watchId = navigator.geolocation.watchPosition(sendPosition, () => {
    stopLiveTracking(false);
    toast('No se pudo continuar el seguimiento de ubicación');
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}
function vLogin() {
  return `<form class="auth box" id="lform"><div class="auth-brand"><img src="logo-calle-segura.png" alt="Calle Segura"><span>Acceso seguro a tu comunidad</span></div><h2>Ingresar a <em>Calle Segura</em></h2><p class="hint">Accede con tu correo y contraseña.</p>
    <label for="em">Correo</label><input id="em" type="email" autocomplete="email" placeholder="vecina@correo.cl" required>
    <label for="pw">Contraseña</label><input id="pw" type="password" autocomplete="current-password" minlength="8" required>
    <button class="btn full" style="margin-top:18px" type="submit">Entrar</button>
    <button class="btn full biometric" type="button" id="passkey-login">🔐 Entrar con huella</button>
    <p class="hint" style="margin-top:12px">¿No tienes cuenta? <a href="#/registrar">Crear una cuenta</a></p>
    <p class="hint">Personal municipal: ingresa con las credenciales asignadas.</p></form>`;
}
function vPerfil() {
  if (!S.user) return `<div class="auth box"><h2>Ingresa para ver tu perfil</h2><a class="btn full" style="margin-top:14px" href="#/ingresar">Ingresar</a></div>`;
  const role = S.user.role === 'admin' ? 'Administrador/a' : S.user.role === 'staff' ? 'Funcionario/a municipal' : 'Vecino/a';
  const name = S.user.full_name || S.user.email.split('@')[0];
  const notices = S.notifications.map(notification => `<article class="notice ${notification.is_read ? '' : 'unread'}">
    <p>${esc(notification.message)}</p><small>${ago(notification.created_at)} · Reporte #${notification.report_id}</small>
    ${notification.is_read ? '' : `<button class="btn ghost sm" type="button" data-read-notification="${notification.id}">Marcar como leída</button>`}
  </article>`).join('');
  return `<section class="profile box"><div class="profile-avatar" aria-hidden="true">${esc(name[0].toUpperCase())}</div><div><p class="hint">Mi perfil</p><h2>${esc(name)}</h2><dl><div><dt>Correo</dt><dd>${esc(S.user.email)}</dd></div><div><dt>Tipo de cuenta</dt><dd>${role}</dd></div></dl><a class="btn full logout" href="#/salir">Cerrar sesion</a></div></section>
    <section class="box notification-list"><h3>Avisos de tus reportes</h3>${notices || '<p class="hint">Todavía no tienes avisos.</p>'}</section>`;
}
function vRegister() {
  return `<form class="auth box" id="regform"><div class="auth-brand"><img src="logo-calle-segura.png" alt="Calle Segura"><span>Únete a tu comunidad</span></div><h2>Crear <em>cuenta</em></h2><p class="hint">Regístrate para reportar y seguir situaciones de tu barrio.</p>
    <label for="reg-name">Nombre</label><input id="reg-name" type="text" autocomplete="name" maxlength="120" placeholder="Tu nombre" required>
    <label for="reg-em">Correo</label><input id="reg-em" type="email" autocomplete="email" placeholder="vecina@correo.cl" required>
    <label for="reg-pw">Contraseña</label><input id="reg-pw" type="password" autocomplete="new-password" minlength="8" required>
    <button class="btn full" style="margin-top:18px" type="submit">Crear cuenta</button>
    <p class="hint" style="margin-top:12px">¿Ya tienes cuenta? <a href="#/ingresar">Ingresar</a></p></form>`;
}

/* ---------- portal municipal ---------- */
function mResumen() {
  const c = s => S.reports.filter(r => r.status === s).length, max = Math.max(1, ...STATUSES.map(c));
  const abiertos = S.reports.filter(r => r.status !== 'Resuelto');
  const urgentes = abiertos.filter(r => r.priority === 'Urgente').length;
  const sinAsignar = abiertos.filter(r => !r.assigned_to).length;
  const nuevos = prioritySort(abiertos).slice(0, 4);
  return `<div class="banner"><div><h1>Panel <em>municipal</em></h1><p>${S.reports.filter(r => r.status === 'Nuevo').length} reportes nuevos esperan revisión.</p><p class="banner-alert">${urgentes} urgentes · ${sinAsignar} sin responsable</p></div><a class="btn pr" href="#/muni/reportes">Gestionar reportes</a></div>
    ${stats(S.reports)}
    <div class="grid2"><div class="box"><h3>Reportes por estado</h3><div class="bars">${STATUSES.map(s => `<div><b>${c(s)}</b><i style="height:${c(s) / max * 100}%"></i>${s}</div>`).join('')}</div></div>
    <div class="box"><h3>Requieren atención</h3>${nuevos.map(reportCard).join('') || '<p class="hint">Todo al día</p>'}</div></div>
    <div class="box" style="margin-top:16px"><h3>Mapa</h3>${mapHTML('all')}</div>`;
}
function prioritySort(reports) {
  const priorityOrder = { Urgente: 0, Alta: 1, Normal: 2 };
  return [...reports].sort((a, b) =>
    (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2)
    || (a.type === 'em' ? 0 : 1) - (b.type === 'em' ? 0 : 1)
    || String(b.created_at).localeCompare(String(a.created_at))
  );
}
function muniFilteredReports() {
  const query = S.muniSearch.trim().toLocaleLowerCase();
  return prioritySort(S.reports.filter(report => {
    const searchable = [report.category, report.description, report.address, report.assigned_name, report.assigned_email]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    return (!query || searchable.includes(query))
      && (S.muniStatus === 'all' || report.status === S.muniStatus)
      && (S.muniType === 'all' || report.type === S.muniType)
      && (S.muniPriority === 'all' || (report.priority || 'Normal') === S.muniPriority)
      && (S.muniAssignee === 'all' || (S.muniAssignee === 'none' ? !report.assigned_to : String(report.assigned_to) === S.muniAssignee));
  }));
}
function muniReportRows() {
  const staff = S.users.filter(user => ['staff', 'admin'].includes(user.role) && !user.is_blocked);
  return muniFilteredReports().map(report => {
    const needsDetails = !report.description?.trim() || !report.address?.trim();
    const assignee = report.assigned_to ? String(report.assigned_to) : '';
    return `<tr class="${report.priority === 'Urgente' || report.type === 'em' ? 'priority-row' : ''}">
      <td><span class="tag ${report.type === 'em' ? 't-em' : 't-pr'}">${report.type === 'em' ? 'Emergencia' : 'Problema'}</span><br><span class="tag priority-tag p-${esc((report.priority || 'Normal').toLowerCase())}">${esc(report.priority || 'Normal')}</span></td>
      <td>${esc(report.category)}${report.type === 'em' && report.emergency_service ? `<br><small class="hint">${esc(report.emergency_service)}</small>` : ''}</td>
      <td>${esc(report.description || 'Sin descripción')}${needsDetails ? '<br><small class="missing-detail">Faltan datos</small>' : ''}</td>
      <td>${esc(report.address || 'Sin dirección')}<br><a class="hint" href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(report.latitude)}&mlon=${encodeURIComponent(report.longitude)}#map=18/${encodeURIComponent(report.latitude)}/${encodeURIComponent(report.longitude)}" target="_blank" rel="noopener">Ver en mapa</a></td>
      <td>${ago(report.created_at)}</td>
      <td>${report.has_photo && report.can_view_photo ? `<button type="button" class="btn ghost sm photo-view" data-view-photo="${report.id}">Ver foto</button>` : '—'}</td>
      <td><select data-status="${report.id}" aria-label="Estado del reporte ${report.id}">${STATUSES.map(status => `<option ${status === report.status ? 'selected' : ''}>${status}</option>`).join('')}</select></td>
      <td><select data-assignment="${report.id}" aria-label="Responsable del reporte ${report.id}"><option value="">Sin asignar</option>${staff.map(user => `<option value="${user.id}" ${String(user.id) === assignee ? 'selected' : ''}>${esc(user.full_name || user.email)}</option>`).join('')}</select></td>
      <td><select data-priority="${report.id}" aria-label="Prioridad del reporte ${report.id}">${['Urgente', 'Alta', 'Normal'].map(priority => `<option ${priority === (report.priority || 'Normal') ? 'selected' : ''}>${priority}</option>`).join('')}</select></td>
      <td><button class="btn ghost sm" type="button" data-history="${report.id}">Historial</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="hint">No hay reportes que coincidan con estos filtros.</td></tr>';
}
function mReportes() {
  const staff = S.users.filter(user => ['staff', 'admin'].includes(user.role) && !user.is_blocked);
  return `<h2>Reportes</h2><p class="hint">Ordenados por prioridad. Emergencias quedan destacadas; la antigüedad es informativa, sin plazo oficial configurado.</p>
    <div class="muni-filters">
      <label>Buscar<input id="muni-search" type="search" value="${esc(S.muniSearch)}" placeholder="Categoría, dirección o descripción"></label>
      <label>Estado<select id="muni-status-filter"><option value="all">Todos</option>${STATUSES.map(status => `<option value="${status}" ${S.muniStatus === status ? 'selected' : ''}>${status}</option>`).join('')}</select></label>
      <label>Tipo<select id="muni-type-filter"><option value="all">Todos</option><option value="em" ${S.muniType === 'em' ? 'selected' : ''}>Emergencia</option><option value="pr" ${S.muniType === 'pr' ? 'selected' : ''}>Problema</option></select></label>
      <label>Prioridad<select id="muni-priority-filter"><option value="all">Todas</option>${['Urgente', 'Alta', 'Normal'].map(priority => `<option value="${priority}" ${S.muniPriority === priority ? 'selected' : ''}>${priority}</option>`).join('')}</select></label>
      <label>Responsable<select id="muni-assignee-filter"><option value="all">Todos</option><option value="none" ${S.muniAssignee === 'none' ? 'selected' : ''}>Sin asignar</option>${staff.map(user => `<option value="${user.id}" ${S.muniAssignee === String(user.id) ? 'selected' : ''}>${esc(user.full_name || user.email)}</option>`).join('')}</select></label>
    </div>
    <p id="muni-result-count" class="hint">${muniFilteredReports().length} de ${S.reports.length} reportes</p>
    <div class="scroll"><table class="muni-table"><thead><tr><th>Tipo / prioridad</th><th>Categoría</th><th>Descripción</th><th>Ubicación</th><th>Hace</th><th>Foto</th><th>Estado</th><th>Responsable</th><th>Prioridad</th><th></th></tr></thead><tbody>${muniReportRows()}</tbody></table></div>`;
}
function updateMuniReportRows() {
  const body = document.querySelector('.muni-table tbody');
  if (!body) return;
  body.innerHTML = muniReportRows();
  const count = $('#muni-result-count');
  if (count) count.textContent = `${muniFilteredReports().length} de ${S.reports.length} reportes`;
}
async function showReportHistory(reportId) {
  try {
    const history = await api(`/api/reports/${reportId}/history`);
    const labels = { status: 'Estado', assignment: 'Responsable', priority: 'Prioridad' };
    const entries = history.map(event => {
      const description = event.action === 'status'
        ? `Estado: ${esc(event.new_value)}`
        : `${esc(event.old_value || 'Sin asignar')} → ${esc(event.new_value || 'Sin asignar')}`;
      return `<article class="history-entry"><div><b>${labels[event.action] || 'Actividad'}</b><small>${ago(event.created_at)} · ${esc(event.actor)}</small></div><p>${description}</p>${event.note ? `<p class="hint">${esc(event.note)}</p>` : ''}</article>`;
    }).join('') || '<p class="hint">Este reporte aún no tiene actividad.</p>';
    const dialog = document.createElement('dialog');
    dialog.className = 'history-dialog';
    dialog.innerHTML = `<div class="history-head"><h2>Historial del reporte #${esc(reportId)}</h2><button class="btn ghost sm" type="button" data-close-history>Cerrar</button></div><div class="history-entries">${entries}</div>`;
    dialog.addEventListener('click', event => {
      if (event.target === dialog || event.target.closest('[data-close-history]')) dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  } catch (error) {
    toast(error.message);
  }
}
function mUsuarios() {
  return `<h2>Usuarios</h2><div class="scroll" style="margin-top:12px"><table><thead><tr><th>Correo</th><th>Rol</th><th>Reportes</th><th></th></tr></thead><tbody>
    ${S.users.map(u => `<tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.reports}</td><td>${u.role === 'citizen' ? `<button class="blk ${u.is_blocked ? 'un' : ''}" data-block="${u.id}" data-to="${u.is_blocked ? 0 : 1}">${u.is_blocked ? 'Desbloquear' : 'Bloquear'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

/* ---------- router ---------- */
function routeFromLocation() {
  if (location.hash.startsWith('#/')) return location.hash.slice(2).replace(/^\/+|\/+$/g, '');
  const path = location.pathname.startsWith(BASE_PATH) ? location.pathname.slice(BASE_PATH.length) : location.pathname;
  return path.replace(/^\/+|\/+$/g, '');
}
function go(path, replace = false) {
  const route = path.replace(/^\/+|\/+$/g, '');
  history[replace ? 'replaceState' : 'pushState']({}, '', `#/${route}`);
  return render();
}
let lastRoute = null, renderGeneration = 0;
async function render(skipData = false) {
  const generation = ++renderGeneration;
  const route = routeFromLocation();
  if (route !== 'reportar') {
    if ($('#picker-panel')?.classList.contains('expanded')) setPickerExpanded(false);
    clearReportPhoto();
  }
  if (route === 'salir') {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    S.user = null; S.reports = []; S.users = []; S.notifications = []; localStorage.removeItem('cs_user'); history.replaceState({}, '', '#/'); return render();
  }
  if (!S.user) S.reports = [];
  const app = $('#app');
  if (route.startsWith('muni')) {
    if (!isStaff()) { return go('/ingresar', true); }
    app.innerHTML = muniShell(route, route === 'muni/reportes' ? mReportes() : route === 'muni/usuarios' ? mUsuarios() : mResumen());
  } else {
    const v = { '': vInicio, mapa: vMapa, reportar: vReportar, perfil: vPerfil, ingresar: vLogin, registrar: vRegister }[route] || vInicio;
    app.innerHTML = shell(route, v());
    if (route === 'reportar') { setEmergencyService(); setCategoryOptions(S.form.category); setCustomCategory(); setReportPhotoVisibility(); }
  }
  initMaps();
  document.querySelectorAll('#passkey-login, #register-passkey').forEach(button => button.remove());
  if (route !== lastRoute) window.scrollTo(0, 0);
  lastRoute = route;
  if (S.user && !skipData) {
    let shouldRefreshView = route === '' || route === 'mapa' || route === 'perfil' || route.startsWith('muni');
    const requests = [api('/api/reports').then(reports => {
      if (generation === renderGeneration && routeFromLocation() === route) S.reports = reports;
    }).catch(error => {
      if (generation !== renderGeneration || routeFromLocation() !== route) return;
      if (error.status === 401 || error.status === 403) {
        shouldRefreshView = true;
        S.user = null;
        S.reports = [];
        S.users = [];
        S.notifications = [];
        localStorage.removeItem('cs_user');
      } else {
        toast(error.message);
      }
    })];
    if (route === 'muni/usuarios' || route === 'muni/reportes') {
      requests.push(api('/api/users?email=' + encodeURIComponent(S.user.email)).then(users => {
        if (generation === renderGeneration && routeFromLocation() === route) S.users = users;
      }).catch(error => {
        if (generation === renderGeneration && routeFromLocation() === route && error.status !== 401 && error.status !== 403) toast(error.message);
      }));
    }
    if (route === 'perfil') {
      requests.push(api('/api/notifications').then(notifications => {
        if (generation === renderGeneration && routeFromLocation() === route) S.notifications = notifications;
      }).catch(error => {
        if (generation === renderGeneration && routeFromLocation() === route && error.status !== 401 && error.status !== 403) toast(error.message);
      }));
    }
    Promise.all(requests).then(() => {
      if (shouldRefreshView && generation === renderGeneration && routeFromLocation() === route) render(true);
    });
  }
}

/* ---------- eventos ---------- */
document.addEventListener('click', async e => {
  const t = e.target;
  const link = t.closest('a[href]');
  if (link && link.origin === location.origin && link.getAttribute('href').startsWith('#/')) {
    e.preventDefault();
    if (link.matches('[data-clear]')) S.sel = null;
    go(link.getAttribute('href').slice(1));
    return;
  }
  const pin = t.closest('[data-pin]');
  if (pin) { S.sel = +pin.dataset.pin; render(); return; }
  if (t.closest('[data-clear]')) { S.sel = null; }
  const nextStep = t.closest('[data-report-next]');
  if (nextStep) {
    if (nextStep.dataset.reportNext === '2' && $('#cat')?.value === 'Otro' && !$('#customcat')?.value.trim()) {
      toast('Escribe la categoría');
      $('#customcat').focus();
      return;
    }
    setReportStep(+nextStep.dataset.reportNext);
    return;
  }
  const backStep = t.closest('[data-report-back]');
  if (backStep) { setReportStep(+backStep.dataset.reportBack); return; }
  const photoButton = t.closest('[data-view-photo]');
  if (photoButton) { await showReportPhoto(photoButton); return; }
  const historyButton = t.closest('[data-history]');
  if (historyButton) { await showReportHistory(historyButton.dataset.history); return; }
  const readButton = t.closest('[data-read-notification]');
  if (readButton) {
    try {
      await api(`/api/notifications/${readButton.dataset.readNotification}/read`, { method: 'POST', body: {} });
      S.notifications = S.notifications.map(notification => notification.id === Number(readButton.dataset.readNotification)
        ? { ...notification, is_read: 1 }
        : notification);
      render(true);
    } catch (error) { toast(error.message); }
    return;
  }
  const fl = t.closest('[data-filter]');
  if (fl) { S.filter = fl.dataset.filter; S.sel = null; render(); return; }
  const ty = t.closest('[data-type]');
  if (ty) {
    saveReportForm();
    S.type = ty.dataset.type;
    document.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('on', b === ty));
    document.querySelectorAll('.report-submit').forEach(button => {
      button.classList.remove('em', 'pr');
      button.classList.add(S.type);
    });
    setEmergencyService();
    setCategoryOptions();
    setCustomCategory();
    setReportPhotoVisibility();
    return;
  }
  if (t.closest('#open-picker')) { setPickerExpanded(true); return; }
  if (t.closest('#close-picker')) { setPickerExpanded(false); return; }
  if (t.closest('[data-remove-photo]')) { clearReportPhoto(); return; }
  if (t.closest('[data-stop-tracking]')) { stopLiveTracking(); render(); return; }
  if (t.closest('#usegps')) { useGps(); return; }
  const bl = t.closest('[data-block]');
  if (bl) {
    try { await api(`/api/users/${bl.dataset.block}/block`, { method: 'POST', body: { email: S.user.email, blocked: +bl.dataset.to } }); toast('Usuario actualizado'); render(); } catch (err) { toast(err.message); }
  }
});
document.addEventListener('change', async e => {
  if (e.target.id === 'report-photo') {
    const file = e.target.files?.[0];
    if (!file) { clearReportPhoto(); return; }
    if (file.size > 5 * 1024 * 1024) { clearReportPhoto(); toast('La foto no debe superar 5 MB'); return; }
    if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      clearReportPhoto();
      toast('Usa una foto JPG, PNG o WebP');
      return;
    }
    S.photo = file;
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = URL.createObjectURL(file);
    $('#photo-preview').src = photoPreviewUrl;
    $('#photo-preview-wrap').hidden = false;
    return;
  }
  if (e.target.id === 'service') { saveReportForm(); setCategoryOptions(); setCustomCategory(); setReportPhotoVisibility(); return; }
  if (e.target.id === 'cat') { saveReportForm(); setCustomCategory(); return; }
  if (e.target.id === 'muni-status-filter') { S.muniStatus = e.target.value; updateMuniReportRows(); return; }
  if (e.target.id === 'muni-type-filter') { S.muniType = e.target.value; updateMuniReportRows(); return; }
  if (e.target.id === 'muni-priority-filter') { S.muniPriority = e.target.value; updateMuniReportRows(); return; }
  if (e.target.id === 'muni-assignee-filter') { S.muniAssignee = e.target.value; updateMuniReportRows(); return; }
  const assignment = e.target.closest('[data-assignment]');
  if (assignment) {
    try {
      await api(`/api/reports/${assignment.dataset.assignment}/assignment`, {
        method: 'POST',
        body: { user_id: assignment.value ? Number(assignment.value) : null }
      });
      toast('Responsable actualizado');
      render();
    } catch (error) { toast(error.message); }
    return;
  }
  const priority = e.target.closest('[data-priority]');
  if (priority) {
    try {
      await api(`/api/reports/${priority.dataset.priority}/priority`, { method: 'POST', body: { priority: priority.value } });
      toast('Prioridad actualizada');
      render();
    } catch (error) { toast(error.message); }
    return;
  }
  const sel = e.target.closest('[data-status]');
  if (!sel) return;
  try { await api(`/api/reports/${sel.dataset.status}/status`, { method: 'POST', body: { email: S.user.email, status: sel.value } }); toast('Estado actualizado'); render(); } catch (err) { toast(err.message); }
});
document.addEventListener('input', e => {
  if (e.target.id !== 'muni-search') return;
  S.muniSearch = e.target.value;
  updateMuniReportRows();
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'lform') {
    try {
      S.user = await api('/api/login', { method: 'POST', body: { email: $('#em').value, password: $('#pw').value } });
      localStorage.setItem('cs_user', JSON.stringify(S.user));
      toast('Bienvenida/o, ' + (S.user.full_name || S.user.email));
      go(isStaff() ? '/muni' : '/', true);
    } catch (err) { toast(err.message); }
  }
  if (e.target.id === 'regform') {
    try {
      S.user = await api('/api/register', { method: 'POST', body: { full_name: $('#reg-name').value, email: $('#reg-em').value, password: $('#reg-pw').value } });
      localStorage.setItem('cs_user', JSON.stringify(S.user));
      toast('Cuenta creada correctamente');
      go('/', true);
    } catch (err) { toast(err.message); }
  }
  if (e.target.id === 'rform') {
    if (!S.pick) { toast('Marca la ubicación en el mapa'); return; }
    const category = $('#cat').value === 'Otro' ? $('#customcat').value.trim() : $('#cat').value;
    if (!category) { toast('Escribe la categoría'); return; }
    try {
      const service = S.type === 'em' ? $('#service').value : '';
      const report = { email: S.user.email, type: S.type, category, emergency_service: service, description: $('#desc').value, address: $('#addr').value, latitude: S.pick.lat, longitude: S.pick.lon };
      let body = report;
      if (S.photo) {
        body = new FormData();
        Object.entries(report).forEach(([key, value]) => body.append(key, String(value)));
        body.append('photo', S.photo, S.photo.name);
      }
      const created = await api('/api/reports', { method: 'POST', body });
      if (S.type === 'em' && category === 'Robo o asalto' && $('#track-location').checked) startLiveTracking(created.id);
      S.pick = null; S.form = {}; clearReportPhoto(); toast('Reporte enviado. ¡Gracias!'); go('/mapa');
    } catch (err) { toast(err.message); }
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#picker-panel')?.classList.contains('expanded')) { setPickerExpanded(false); return; }
  if (e.key === 'Enter' && e.target.closest?.('[data-pin]')) e.target.closest('[data-pin]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
window.addEventListener('hashchange', render);
render().finally(() => setTimeout(() => $('#splash').classList.add('off'), 900));
})();
