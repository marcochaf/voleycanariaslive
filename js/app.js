import { fetchCategories, fetchGroups, fetchRounds, pickDefaultRound, fetchMatchesOfRound, fetchMatch, fetchStandings, todayYMD, addDay } from './api.js';

const $view = document.getElementById('view');
const STORE_KEY = 'vcl.selection.v1';
const LIST_REFRESH_MS = 30_000;
const LIVE_REFRESH_MS = 5_000;

const TBD = 'Horario por definir';

const STATUS_LABEL = {
  scheduled: 'Programado',
  live: 'En directo',
  finished: 'Finalizado',
  pending: 'Pendiente de acta',
  postponed: 'Aplazado',
  canceled: 'Suspendido',
};

// ---------- utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const load = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } };
const save = (s) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {} };

// ---------- equipos favoritos ----------
// Cada equipo pertenece a una sola competición en la API, así que guardamos varios IDs de equipo
const FAVS_KEY = 'vcl.favs.v1';
const favs = new Set((() => { try { return JSON.parse(localStorage.getItem(FAVS_KEY)) || []; } catch { return []; } })().map(String));
const isFav = (id) => id != null && favs.has(String(id));
function toggleFav(id) {
  id = String(id);
  favs.has(id) ? favs.delete(id) : favs.add(id);
  try { localStorage.setItem(FAVS_KEY, JSON.stringify([...favs])); } catch {}
  // Actualizamos lo que ya está pintado sin recargar datos
  const on = favs.has(id);
  document.querySelectorAll(`[data-team="${CSS.escape(id)}"]`).forEach((el) => el.classList.toggle('fav', on));
  document.querySelectorAll(`.fav-btn[data-fav="${CSS.escape(id)}"]`).forEach((b) => {
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '★' : '☆';
  });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.fav-btn');
  if (!b) return;
  e.preventDefault();
  toggleFav(b.dataset.fav);
});
function favBtn(team) {
  const on = isFav(team.id);
  return `<button class="fav-btn" data-fav="${esc(team.id)}" aria-pressed="${on}" aria-label="Equipo favorito: ${esc(team.name)}" title="Marcar como favorito">${on ? '★' : '☆'}</button>`;
}
const teamData = (team) => (team.id != null ? ` data-team="${esc(team.id)}"` : '');
const favCls = (team) => (isFav(team.id) ? 'fav' : '');

function initials(name) {
  return name.replace(/^(C\.?V\.?|C\.?D\.?|CV|CD|U\.?D\.?|A\.?D\.?)\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}
function logo(team, cls = '') {
  return team.logo
    ? `<img class="logo ${cls}" src="${esc(team.logo)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'logo logo-ph ${cls}',textContent:'${esc(initials(team.name))}'}))">`
    : `<span class="logo logo-ph ${cls}">${esc(initials(team.name))}</span>`;
}
function fmtDay(ymd) {
  const t = todayYMD();
  if (ymd === t) return 'Hoy';
  if (ymd === addDay(t, -1)) return 'Ayer';
  if (ymd === addDay(t, 1)) return 'Mañana';
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function fmtDayLong(ymd) {
  const rel = fmtDay(ymd);
  const full = new Date(ymd + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return ['Hoy', 'Ayer', 'Mañana'].includes(rel) ? `${rel} · ${full}` : full;
}

// Temporizador que se pausa con la pestaña oculta
let timer = null, abortCtl = null;
function schedule(fn, ms) {
  clearTimeout(timer);
  timer = setTimeout(() => (document.hidden ? null : fn()), ms);
}
function stopAll() {
  clearTimeout(timer);
  abortCtl?.abort();
  abortCtl = new AbortController();
  releaseWakeLock();
}
let resumeFn = null;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && resumeFn) resumeFn();
});

// ---------- router ----------
function route() {
  stopAll();
  resumeFn = null;
  const h = location.hash.slice(1);
  const m = h.match(/^\/m\/(\d+)/);
  if (m) return renderScoreboard(m[1]);
  return renderHome();
}
window.addEventListener('hashchange', route);

// ---------- portada: selectores + partidos ----------
let categoriesCache = null;
const groupsCache = new Map();
const roundsCache = new Map();

async function renderHome() {
  const sel = load();
  const urlRound = new URLSearchParams(location.hash.split('?')[1]).get('r');

  $view.innerHTML = `
    <section class="filters card">
      <label><span>Categoría</span><select id="f-cat" disabled><option>Cargando…</option></select></label>
      <label><span>Competición</span><select id="f-tour" disabled></select></label>
      <label><span>Grupo</span><select id="f-group" disabled></select></label>
    </section>
    <nav class="tabs" role="tablist" hidden>
      <button role="tab" data-tab="matches">Partidos</button>
      <button role="tab" data-tab="standings">Clasificación</button>
    </nav>
    <nav class="roundnav" hidden>
      <button class="icon-btn" id="r-prev" aria-label="Jornada anterior">‹</button>
      <div class="round-pick">
        <select id="f-round" aria-label="Jornada"></select>
        <small id="r-dates"></small>
      </div>
      <button class="icon-btn" id="r-next" aria-label="Jornada siguiente">›</button>
    </nav>
    <section id="matches" class="matches"></section>`;

  const $cat = document.getElementById('f-cat');
  const $tour = document.getElementById('f-tour');
  const $group = document.getElementById('f-group');
  const $round = document.getElementById('f-round');
  const $roundNav = document.querySelector('.roundnav');
  const $rDates = document.getElementById('r-dates');
  const $prev = document.getElementById('r-prev');
  const $next = document.getElementById('r-next');
  const $list = document.getElementById('matches');
  const $tabs = document.querySelector('.tabs');
  let tab = sel.tab === 'standings' ? 'standings' : 'matches';
  const setTab = (t) => {
    tab = t;
    sel.tab = t;
    save(sel);
    $tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    refresh();
  };
  $tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  // Muestra la pestaña activa: partidos (con selector de jornada) o clasificación
  const refresh = () => {
    $tabs.hidden = !$group.value;
    $roundNav.hidden = tab !== 'matches' || !rounds.length;
    $list.className = tab === 'matches' ? 'matches' : 'standings-wrap';
    return tab === 'matches' ? loadMatches() : loadStandings();
  };

  try {
    categoriesCache ||= await fetchCategories({ signal: abortCtl.signal });
  } catch (e) {
    if (e.name === 'AbortError') return;
    $list.innerHTML = errorBox('No se pudieron cargar las competiciones.');
    return;
  }
  const cats = categoriesCache;
  let rounds = [];

  const fillCats = () => {
    $cat.innerHTML = `<option value="">Elige categoría</option>` + cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $cat.disabled = false;
    if (cats.some((c) => c.id === sel.catId)) $cat.value = sel.catId;
  };
  const fillTours = () => {
    const cat = cats.find((c) => c.id === $cat.value);
    $tour.innerHTML = cat ? `<option value="">Elige competición</option>` + cat.tournaments.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('') : '';
    $tour.disabled = !cat;
    if (cat?.tournaments.some((t) => t.id === sel.tournamentId)) $tour.value = sel.tournamentId;
    else if (cat?.tournaments.length === 1) $tour.value = cat.tournaments[0].id;
  };
  const fillGroups = async () => {
    const tid = $tour.value;
    $group.innerHTML = '';
    $group.disabled = true;
    if (!tid) return;
    $group.innerHTML = '<option>Cargando…</option>';
    try {
      if (!groupsCache.has(tid)) groupsCache.set(tid, await fetchGroups(tid, { signal: abortCtl.signal }));
    } catch (e) {
      if (e.name !== 'AbortError') $group.innerHTML = '<option>Error</option>';
      return;
    }
    const groups = groupsCache.get(tid);
    $group.innerHTML = `<option value="">Elige grupo</option>` + groups.map((g) => `<option value="${g.id}">${esc(g.name)}${g.phase ? ' — ' + esc(g.phase) : ''}</option>`).join('');
    $group.disabled = false;
    $group.value = groups.some((g) => g.id === sel.groupId) ? sel.groupId : groups.length === 1 ? groups[0].id : '';
  };
  const fillRounds = async (preferred) => {
    rounds = [];
    $roundNav.hidden = true;
    const gid = $group.value;
    if (!gid) return;
    $list.innerHTML = `<div class="loading"><span class="spinner"></span>Cargando jornadas…</div>`;
    try {
      if (!roundsCache.has(gid)) roundsCache.set(gid, await fetchRounds(gid, { signal: abortCtl.signal }));
    } catch (e) {
      if (e.name !== 'AbortError') $list.innerHTML = errorBox('No se pudieron cargar las jornadas.');
      return;
    }
    rounds = roundsCache.get(gid);
    if (!rounds.length) return;
    const today = todayYMD();
    $round.innerHTML = rounds.map((r) => {
      const tag = r.from && r.from <= today && today <= r.to ? ' · hoy' : r.total && r.finished === r.total ? ' ✓' : '';
      return `<option value="${r.id}">${esc(r.name)}${tag}</option>`;
    }).join('');
    $round.value = rounds.some((r) => r.id === preferred) ? preferred : pickDefaultRound(rounds)?.id;
  };

  const persist = () => { sel.catId = $cat.value; sel.tournamentId = $tour.value; sel.groupId = $group.value; save(sel); };
  const syncRoundUI = () => {
    const i = rounds.findIndex((r) => r.id === $round.value);
    const r = rounds[i];
    $prev.disabled = i <= 0;
    $next.disabled = i < 0 || i >= rounds.length - 1;
    $rDates.textContent = r?.from ? (r.from === r.to ? fmtDay(r.from) : `${fmtDay(r.from)} – ${fmtDay(r.to)}`) : 'Sin fecha';
    lastHome = r ? `#/?r=${r.id}` : '#/';
    history.replaceState(null, '', lastHome);
  };
  const stepRound = (d) => {
    const i = rounds.findIndex((r) => r.id === $round.value) + d;
    if (i < 0 || i >= rounds.length) return;
    $round.value = rounds[i].id;
    syncRoundUI();
    loadMatches();
  };
  $prev.onclick = () => stepRound(-1);
  $next.onclick = () => stepRound(1);
  $round.onchange = () => { syncRoundUI(); loadMatches(); };

  const afterGroup = async (preferredRound) => { persist(); await fillRounds(preferredRound); syncRoundUI(); setTab(tab); };
  $cat.onchange = async () => { fillTours(); await fillGroups(); afterGroup(); };
  $tour.onchange = async () => { await fillGroups(); afterGroup(); };
  $group.onchange = () => afterGroup();

  fillCats();
  fillTours();
  await fillGroups();
  await afterGroup(urlRound);

  async function loadStandings() {
    clearTimeout(timer);
    resumeFn = null;
    const gid = $group.value;
    if (!gid) { $list.innerHTML = `<div class="empty">Selecciona categoría, competición y grupo.</div>`; return; }
    $list.innerHTML = `<div class="loading"><span class="spinner"></span>Cargando clasificación…</div>`;
    try {
      const rows = await fetchStandings(gid, { signal: abortCtl.signal });
      if (gid !== $group.value || tab !== 'standings') return;
      const g = groupsCache.get($tour.value)?.find((x) => x.id === gid);
      $list.innerHTML = rows.length
        ? `<section class="card standings">${g ? `<h2 class="st-title">${esc(g.name)}${g.phase ? ` <small>${esc(g.phase)}</small>` : ''}</h2>` : ''}${standingsTable(rows)}</section>`
        : `<div class="empty">Este grupo no tiene clasificación (puede ser una fase eliminatoria).</div>`;
    } catch (e) {
      if (e.name !== 'AbortError') $list.innerHTML = errorBox('No se pudo cargar la clasificación.');
    }
  }

  async function loadMatches(silent = false) {
    clearTimeout(timer);
    if (tab !== 'matches') return;
    const rid = $round.value;
    if (!$group.value) {
      $list.innerHTML = `<div class="empty">Selecciona categoría, competición y grupo para ver los partidos.</div>`;
      return;
    }
    if (!rounds.length) {
      if (!$list.querySelector('.error')) $list.innerHTML = `<div class="empty">Este grupo no tiene jornadas.</div>`;
      return;
    }
    if (!silent) $list.innerHTML = `<div class="loading"><span class="spinner"></span>Cargando partidos…</div>`;
    let matches;
    try {
      matches = await fetchMatchesOfRound(rid, { signal: abortCtl.signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (!silent) $list.innerHTML = errorBox('No se pudieron cargar los partidos.');
      resumeFn = () => loadMatches(true);
      schedule(resumeFn, LIST_REFRESH_MS);
      return;
    }
    if (rid !== $round.value || tab !== 'matches') return; // cambió de jornada/pestaña mientras cargaba

    // Agrupamos por día (una jornada puede repartirse en varios)
    let html = '', day = null;
    for (const m of matches) {
      if (m.date !== day) { day = m.date; html += `<h3 class="day-head">${esc(fmtDayLong(day))}</h3>`; }
      html += matchCard(m);
    }
    $list.innerHTML = html || `<div class="empty">No hay partidos en esta jornada.</div>`;

    // En la jornada del día refrescamos para ver los marcadores avanzar
    const today = todayYMD();
    if (matches.some((m) => m.status === 'live' || (m.status === 'scheduled' && m.date === today))) {
      resumeFn = () => loadMatches(true);
      schedule(resumeFn, LIST_REFRESH_MS);
    }
  }
}

function matchCard(m) {
  const showScore = m.status === 'live' || m.status === 'finished' || m.status === 'pending';
  const sets = m.played.map((p) => `${p.home ?? 0}-${p.away ?? 0}`).join('  ');
  const win = m.status === 'finished' ? (m.setsHome > m.setsAway ? 'home' : m.setsAway > m.setsHome ? 'away' : '') : '';
  return `
  <a class="match card status-${m.status}" href="#/m/${m.id}">
    <div class="match-meta">
      <span class="time">${m.time ? esc(m.time) : `<span class="tbd">${TBD}</span>`}</span>
      <span class="badge badge-${m.status}">${m.status === 'live' ? '<i class="dot"></i>' : ''}${STATUS_LABEL[m.status]}</span>
    </div>
    <div class="match-teams">
      ${teamRow(m.home, win === 'home', showScore ? m.setsHome : '')}
      ${teamRow(m.away, win === 'away', showScore ? m.setsAway : '')}
    </div>
    <div class="match-foot">
      <span>${m.facility ? '📍 ' + esc(m.facility.short) : ''}</span>
      ${sets ? `<span class="setline">${esc(sets)}</span>` : ''}
    </div>
  </a>`;
}

function teamRow(team, winner, sets) {
  return `<div class="row ${winner ? 'winner' : ''} ${favCls(team)}"${teamData(team)}>${logo(team, 'sm')}<span class="name">${esc(team.name)}</span><b class="sets">${sets}</b></div>`;
}

// ---------- marcador ----------
let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() { wakeLock?.release?.().catch(() => {}); wakeLock = null; }

async function renderScoreboard(id) {
  $view.innerHTML = `<div id="sb-wrap"><div class="loading"><span class="spinner"></span>Cargando marcador…</div></div><div id="sb-standings"></div>`;
  let prev = null;
  const tick = async () => {
    let m;
    try {
      m = await fetchMatch(id, { signal: abortCtl.signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (!prev) { document.getElementById('sb-wrap').innerHTML = errorBox('No se pudo cargar el partido.') + backLink(); return; }
      document.querySelector('.sb-updated')?.classList.add('stale');
      schedule(tick, LIVE_REFRESH_MS * 2);
      return;
    }
    paintScoreboard(m, prev);
    if (!prev && m.groupId) paintMatchStandings(m);
    prev = m;
    if (m.status === 'live') {
      if (!wakeLock) requestWakeLock();
      schedule(tick, LIVE_REFRESH_MS);
    } else if (m.status === 'scheduled') {
      const wait = Math.min(Math.max(m.start - Date.now(), LIVE_REFRESH_MS), 60_000);
      schedule(tick, wait);
    } else if (m.status === 'pending') {
      schedule(tick, 60_000);
    } else {
      releaseWakeLock();
    }
  };
  resumeFn = () => { requestWakeLock(); tick(); };
  tick();
}

function paintScoreboard(m, prev) {
  const live = m.status === 'live';
  const cur = m.current;
  const finishedWin = m.status === 'finished' ? (m.setsHome > m.setsAway ? 'home' : m.setsAway > m.setsHome ? 'away' : '') : '';

  // Puntos grandes: set en juego si hay directo; si no, sets ganados
  const bigHome = live && cur ? cur.home ?? 0 : m.setsHome;
  const bigAway = live && cur ? cur.away ?? 0 : m.setsAway;
  const bigLabel = live && cur ? esc(cur.name) : m.status === 'finished' ? 'Resultado final' : m.status === 'scheduled' ? (m.time ? `Comienza a las ${esc(m.time)}` : TBD) : STATUS_LABEL[m.status];
  const showBig = m.status !== 'scheduled' && m.status !== 'postponed' && m.status !== 'canceled';

  const setsRows = m.periods.filter((p) => (p.home || 0) + (p.away || 0) > 0 || (cur && p.id === cur.id));
  const now = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  document.getElementById('sb-wrap').innerHTML = `
  <div class="sb-top">
    ${backLink()}
    <div class="sb-actions">
      <button class="icon-btn" id="sb-share" aria-label="Compartir" title="Compartir">⤴</button>
      <button class="icon-btn" id="sb-full" aria-label="Pantalla completa" title="Pantalla completa">⛶</button>
    </div>
  </div>
  <section class="scoreboard card status-${m.status}">
    <header class="sb-head">
      <div class="sb-comp">${esc(m.tournament)}</div>
      <div class="sb-sub">${esc([m.group, m.round].filter(Boolean).join(' · '))}</div>
      <span class="badge badge-${m.status} lg">${live ? '<i class="dot"></i>' : ''}${STATUS_LABEL[m.status]}</span>
    </header>

    <div class="sb-main">
      <div class="sb-team ${finishedWin === 'home' ? 'winner' : ''}">
        ${logo(m.home, 'xl')}
        <div class="sb-name">${esc(m.home.name)}</div>
        ${live ? `<div class="sb-sets" aria-label="Sets ganados">${dots(m.setsHome)}<span>${m.setsHome}</span></div>` : ''}
      </div>

      <div class="sb-center">
        ${showBig ? `
        <div class="sb-score">
          <span class="num" id="big-home">${bigHome}</span>
          <span class="sep">:</span>
          <span class="num" id="big-away">${bigAway}</span>
        </div>` : `<div class="sb-time${m.time ? '' : ' sm'}">${esc(m.time || fmtDay(m.date))}</div>`}
        <div class="sb-label">${bigLabel}</div>
      </div>

      <div class="sb-team ${finishedWin === 'away' ? 'winner' : ''}">
        ${logo(m.away, 'xl')}
        <div class="sb-name">${esc(m.away.name)}</div>
        ${live ? `<div class="sb-sets" aria-label="Sets ganados">${dots(m.setsAway)}<span>${m.setsAway}</span></div>` : ''}
      </div>
    </div>

    ${m.facility ? venueBlock(m.facility) : ''}

    ${setsRows.length ? `
    <table class="sb-table">
      <thead><tr><th></th>${setsRows.map((p) => `<th class="${cur && p.id === cur.id ? 'cur' : ''}">${esc(shortPeriod(p.name))}</th>`).join('')}<th class="tot">Sets</th></tr></thead>
      <tbody>
        <tr><td class="tn">${esc(m.home.name)}</td>${setsRows.map((p) => cell(p, 'home', cur)).join('')}<td class="tot">${m.setsHome}</td></tr>
        <tr><td class="tn">${esc(m.away.name)}</td>${setsRows.map((p) => cell(p, 'away', cur)).join('')}<td class="tot">${m.setsAway}</td></tr>
      </tbody>
    </table>` : ''}

    <footer class="sb-foot">
      <span>📅 ${esc(fmtDayLong(m.date))} · ${m.time ? esc(m.time) : TBD}</span>
      ${m.status === 'finished' && m.report ? `<a href="${esc(m.report)}" target="_blank" rel="noopener">Acta (PDF)</a>` : ''}
      <span class="sb-updated">${live ? '<i class="dot"></i> Actualizado ' + now : 'Actualizado ' + now}</span>
    </footer>
  </section>`;

  // Animación al cambiar el tanteo
  if (prev && live && prev.current?.id === cur?.id) {
    if ((prev.current?.home ?? 0) !== (cur?.home ?? 0)) bump('big-home');
    if ((prev.current?.away ?? 0) !== (cur?.away ?? 0)) bump('big-away');
  }

  document.getElementById('sb-full').onclick = () => {
    const el = document.documentElement;
    document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.().catch(() => {});
  };
  document.getElementById('sb-share').onclick = async () => {
    const data = { title: `${m.home.name} vs ${m.away.name}`, text: 'Marcador en directo', url: location.href };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(location.href); toast('Enlace copiado'); }
    } catch {}
  };
  document.title = live && cur ? `${cur.home ?? 0}-${cur.away ?? 0} · ${m.home.name} vs ${m.away.name}` : `${m.home.name} vs ${m.away.name}`;
}

function venueBlock(f) {
  const lines = [f.address, f.place].filter(Boolean).join(' · ');
  return `
    <a class="sb-venue" href="${esc(f.mapsUrl)}" target="_blank" rel="noopener" title="Abrir en Google Maps">
      <span class="pin" aria-hidden="true">📍</span>
      <span class="v-text"><b>${esc(f.name)}</b>${lines ? `<small>${esc(lines)}</small>` : ''}</span>
      <span class="v-go">Cómo llegar ›</span>
    </a>`;
}

async function paintMatchStandings(m) {
  const box = document.getElementById('sb-standings');
  if (!box) return;
  try {
    const rows = await fetchStandings(m.groupId, { signal: abortCtl.signal });
    if (!rows.length || !document.body.contains(box)) return;
    box.innerHTML = `<section class="card standings"><h2 class="st-title">Clasificación · ${esc(m.group)}</h2>${standingsTable(rows, [m.home.id, m.away.id])}</section>`;
  } catch {}
}

function standingsTable(rows, highlight = []) {
  return `
  <div class="st-scroll">
  <table class="st-table">
    <thead><tr>
      <th class="pos">#</th><th class="team">Equipo</th><th class="pts" title="Puntos">Pts</th>
      <th title="Partidos jugados">PJ</th><th title="Partidos ganados">PG</th><th title="Partidos perdidos">PP</th>
      <th title="Sets a favor">SF</th><th title="Sets en contra">SC</th>
      <th class="xs-hide" title="Puntos a favor">PF</th><th class="xs-hide" title="Puntos en contra">PC</th>
    </tr></thead>
    <tbody>
      ${rows.map((r) => `
      <tr class="${highlight.includes(r.id) ? 'hl' : ''} ${favCls(r)}"${teamData(r)}>
        <td class="pos">${r.position}</td>
        <td class="team"><span>${favBtn(r)}${logo(r, 'xs')}<span class="tname">${esc(r.name)}</span></span></td>
        <td class="pts">${r.points}</td>
        <td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td>
        <td>${r.setsFor}</td><td>${r.setsAgainst}</td>
        <td class="xs-hide">${r.ptsFor}</td><td class="xs-hide">${r.ptsAgainst}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>
  <p class="st-legend">Toca ☆ para destacar tus equipos favoritos · PJ jugados · PG ganados · PP perdidos · SF/SC sets a favor/en contra<span class="xs-hide"> · PF/PC puntos a favor/en contra</span></p>`;
}

function dots(n) { return `<i class="sd"></i>`.repeat(Math.max(0, Math.min(n, 5))); }
function shortPeriod(name) { return name.replace(/^Set\s*/i, 'S').replace(/^Partido\s*/i, 'P'); }
function cell(p, side, cur) {
  const v = p[side] ?? 0, o = p[side === 'home' ? 'away' : 'home'] ?? 0;
  const cls = [cur && p.id === cur.id ? 'cur' : '', p.finished && v > o ? 'won' : ''].join(' ');
  return `<td class="${cls}">${v}</td>`;
}
function bump(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}
let lastHome = '#/';
function backLink() { return `<a class="back" href="${esc(lastHome)}">‹ Partidos</a>`; }
function errorBox(msg) { return `<div class="empty error">${esc(msg)}<br><button class="btn" onclick="location.reload()">Reintentar</button></div>`; }
function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ---------- arranque ----------
abortCtl = new AbortController();
route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
