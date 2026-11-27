// Cliente mínimo de la API pública de Clupik/Leverade (JSON:API, CORS abierto, sin autenticación).
// Nota: el detalle /matches/{id} exige login, pero el listado /matches?filter=id:{id} es público.

export const API = 'https://api.leverade.com';
export const MANAGER_ID = '288589'; // Federación Canaria de Voleibol
export const TZ = 'Atlantic/Canary';

async function get(path, { signal } = {}) {
  const res = await fetch(API + path, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/** Indexa `included` por "tipo:id" y resuelve relaciones. */
function indexDoc(doc) {
  const idx = new Map();
  for (const r of doc.included || []) idx.set(`${r.type}:${r.id}`, r);
  const rel = (res, name) => {
    const d = res?.relationships?.[name]?.data;
    if (!d) return Array.isArray(d) ? [] : null;
    return Array.isArray(d) ? d.map((x) => idx.get(`${x.type}:${x.id}`)).filter(Boolean) : idx.get(`${d.type}:${d.id}`) || null;
  };
  return { idx, rel };
}

async function getAll(path, opts) {
  // Recorre la paginación (page[size] máx. 100)
  const sep = path.includes('?') ? '&' : '?';
  let page = 1, data = [], included = [];
  for (;;) {
    const doc = await get(`${path}${sep}page[size]=100&page[number]=${page}`, opts);
    data = data.concat(doc.data || []);
    included = included.concat(doc.included || []);
    if (!doc.links?.next || (doc.data || []).length < 100) break;
    page++;
  }
  return { data, included };
}

/** Torneos en curso de la temporada actual, agrupados por categoría. */
export async function fetchCategories(opts) {
  const live = await get(`/tournaments?filter=manager.id:${MANAGER_ID},status:in_progress&page[size]=100`, opts);
  // Cada disciplina (pista, playa…) tiene su propia temporada: nos quedamos con la más reciente de cada una
  const latest = new Map();
  for (const t of live.data || []) {
    const disc = t.relationships.discipline?.data?.id || '0';
    const season = +t.relationships.season.data.id;
    if (!latest.has(disc) || season > latest.get(disc)) latest.set(disc, season);
  }
  if (!latest.size) return [];
  const docs = await Promise.all([...new Set(latest.values())].map((s) =>
    getAll(`/tournaments?filter=manager.id:${MANAGER_ID},season.id:${s}&include=category&sort=order`, opts)));
  const doc = { data: docs.flatMap((d) => d.data), included: docs.flatMap((d) => d.included) };
  const { rel } = indexDoc(doc);
  const cats = new Map();
  for (const t of doc.data) {
    // Fuera las competiciones ya finalizadas o canceladas
    if (t.attributes.status !== 'in_progress') continue;
    const c = rel(t, 'category');
    const key = c?.id || '0';
    if (!cats.has(key)) cats.set(key, { id: key, name: c?.attributes.name?.replace(/ Voleibol$/, '') || 'Otras', order: c?.attributes.order ?? 99, tournaments: [] });
    cats.get(key).tournaments.push({ id: t.id, name: t.attributes.name, gender: t.attributes.gender, order: t.attributes.order });
  }
  return [...cats.values()].sort((a, b) => a.order - b.order);
}

export async function fetchGroups(tournamentId, opts) {
  const doc = await getAll(`/groups?filter=tournament.id:${tournamentId}&sort=order`, opts);
  return doc.data.map((g) => ({ id: g.id, name: g.attributes.name, phase: g.attributes.group }));
}

const MATCH_INCLUDE = 'teams,results,periods.results,facility,round.group.tournament';

function addDay(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Jornadas de un grupo con el rango de fechas de sus partidos
 * (las jornadas no traen fecha propia en la API, así que la deducimos de los partidos).
 */
export async function fetchRounds(groupId, opts) {
  const [rounds, matches] = await Promise.all([
    getAll(`/rounds?filter=group.id:${groupId}&sort=order`, opts),
    getAll(`/matches?filter=round.group.id:${groupId}&include=teams`, opts),
  ]);
  rememberTeams(groupId, matches.included);
  const dates = new Map();
  for (const m of matches.data) {
    if (m.attributes.rest) continue;
    const rid = m.relationships.round.data.id;
    const d = (m.attributes.datetime || m.attributes.date || '').slice(0, 10);
    if (!d) continue;
    const r = dates.get(rid) || { from: d, to: d, total: 0, finished: 0 };
    if (d < r.from) r.from = d;
    if (d > r.to) r.to = d;
    r.total++;
    if (m.attributes.finished) r.finished++;
    dates.set(rid, r);
  }
  return rounds.data
    .map((r) => ({ id: r.id, name: r.attributes.name, order: r.attributes.order, ...(dates.get(r.id) || { from: null, to: null, total: 0, finished: 0 }) }))
    .sort((a, b) => a.order - b.order);
}

// Escudos de los equipos de cada grupo (la clasificación solo trae id y nombre)
const teamsByGroup = new Map();
function rememberTeams(groupId, included = []) {
  const map = teamsByGroup.get(groupId) || new Map();
  for (const t of included) if (t.type === 'team') map.set(String(t.id), { name: t.attributes.name, logo: t.meta?.avatar?.large || null });
  teamsByGroup.set(groupId, map);
  return map;
}

/** Clasificación de un grupo. Devuelve [] si el grupo no tiene clasificación (p. ej. eliminatorias). */
export async function fetchStandings(groupId, opts) {
  const [doc, teams] = await Promise.all([
    get(`/groups/${groupId}/standings`, opts),
    teamsByGroup.has(groupId)
      ? teamsByGroup.get(groupId)
      : getAll(`/matches?filter=round.group.id:${groupId}&include=teams`, opts).then((d) => rememberTeams(groupId, d.included)),
  ]);
  return (doc.meta?.standingsrows || [])
    .map((r) => {
      const s = Object.fromEntries((r.standingsstats || []).map((x) => [x.type, x.value]));
      const id = String(r.id);
      return {
        id,
        position: r.position,
        name: r.name,
        logo: teams.get(id)?.logo || null,
        points: s.score ?? 0,
        played: s.played_matches ?? 0,
        won: s.won_matches ?? 0,
        lost: s.lost_matches ?? 0,
        setsFor: s.value ?? 0,
        setsAgainst: s.value_against ?? 0,
        ptsFor: s.periods_value ?? 0,
        ptsAgainst: s.periods_value_against ?? 0,
      };
    })
    .sort((a, b) => a.position - b.position);
}

/** Jornada por defecto: la de hoy; si no, la próxima; si no, la última disputada. */
export function pickDefaultRound(rounds, today = todayYMD()) {
  const dated = rounds.filter((r) => r.from);
  return (
    dated.find((r) => r.from <= today && today <= r.to) ||
    dated.find((r) => r.from > today) ||
    dated[dated.length - 1] ||
    rounds[0] ||
    null
  );
}

export async function fetchMatchesOfRound(roundId, opts) {
  const doc = await getAll(`/matches?filter=round.id:${roundId}&sort=date&include=${MATCH_INCLUDE}`, opts);
  const { rel } = indexDoc(doc);
  return doc.data.map((m) => normalizeMatch(m, rel)).filter((m) => !m.rest).sort((a, b) => a.start - b.start);
}

/** Partidos de un día. scope = { groupId } | { tournamentId } */
export async function fetchMatchesOfDay(scope, ymd, opts) {
  const f = scope.groupId ? `round.group.id:${scope.groupId}` : `round.group.tournament.id:${scope.tournamentId}`;
  const doc = await getAll(`/matches?filter=${f},date>${ymd},date<${addDay(ymd, 1)}&sort=date&include=${MATCH_INCLUDE}`, opts);
  const { rel } = indexDoc(doc);
  return doc.data.map((m) => normalizeMatch(m, rel)).filter((m) => !m.rest);
}

export async function fetchMatch(id, opts) {
  const doc = await get(`/matches?filter=id:${id}&include=${MATCH_INCLUDE}`, opts);
  if (!doc.data?.length) throw new Error('Partido no encontrado');
  const { rel } = indexDoc(doc);
  return normalizeMatch(doc.data[0], rel);
}

/** Convierte "YYYY-MM-DD HH:mm:ss" en hora de Canarias a epoch ms. */
export function zonedToEpoch(str, tz = TZ) {
  const [d, t = '00:00:00'] = str.split(' ');
  const asUTC = Date.parse(`${d}T${t}Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(asUTC))
    .reduce((o, p) => ((o[p.type] = p.value), o), {});
  const shown = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUTC - (shown - asUTC);
}

export function todayYMD(tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
export { addDay };

const LIVE_WINDOW_MS = 4 * 3600 * 1000;

function normalizeMatch(m, rel) {
  const a = m.attributes;
  const teams = rel(m, 'teams');
  const team = (id) => {
    const t = teams.find((x) => x.id === id);
    return t ? { id: t.id, name: t.attributes.name, logo: t.meta?.avatar?.large || null } : { id, name: 'Por determinar', logo: null };
  };
  const homeId = m.meta?.home_team, awayId = m.meta?.away_team;
  const home = team(homeId), away = team(awayId);

  const valOf = (results, teamId) => {
    const r = results.find((x) => x.relationships?.team?.data?.id === teamId);
    return r?.attributes.value ?? null;
  };

  const periods = rel(m, 'periods')
    .sort((x, y) => x.attributes.order - y.attributes.order)
    .map((p) => {
      const res = rel(p, 'results');
      return { id: p.id, name: p.attributes.name, order: p.attributes.order, finished: !!p.attributes.finished, home: valOf(res, homeId), away: valOf(res, awayId) };
    });
  const played = periods.filter((p) => (p.home || 0) + (p.away || 0) > 0);

  const matchRes = rel(m, 'results').filter((r) => !r.relationships?.period?.data);
  let setsHome = valOf(matchRes, homeId), setsAway = valOf(matchRes, awayId);
  // Durante el directo el total puede ir por detrás: lo recalculamos con los sets cerrados
  const cHome = played.filter((p) => p.finished && p.home > p.away).length;
  const cAway = played.filter((p) => p.finished && p.away > p.home).length;
  if (!a.finished || setsHome == null) { setsHome = Math.max(setsHome || 0, cHome); setsAway = Math.max(setsAway || 0, cAway); }

  const start = zonedToEpoch(a.datetime || a.date);
  // Los partidos sin hora asignada vienen a las 00:00
  const timeUnknown = (a.datetime || a.date).slice(11, 16) === '00:00';
  const now = Date.now();
  let status;
  if (a.canceled) status = 'canceled';
  else if (a.postponed) status = 'postponed';
  else if (a.finished) status = 'finished';
  else if (played.length) status = 'live';
  else if (timeUnknown) status = (a.datetime || a.date).slice(0, 10) >= todayYMD() ? 'scheduled' : 'pending';
  else if (now < start) status = 'scheduled';
  else if (now - start < LIVE_WINDOW_MS) status = 'live';
  else status = 'pending';

  const current = status === 'live' ? periods.find((p) => !p.finished && ((p.home || 0) + (p.away || 0) > 0)) || periods.find((p) => !p.finished) || null : null;

  const round = rel(m, 'round');
  const group = round && rel(round, 'group');
  const tournament = group && rel(group, 'tournament');
  const facility = rel(m, 'facility');

  return {
    id: m.id,
    start,
    time: timeUnknown ? '' : (a.datetime || a.date).slice(11, 16),
    date: (a.datetime || a.date).slice(0, 10),
    rest: !!a.rest,
    status,
    home, away,
    setsHome: setsHome ?? 0,
    setsAway: setsAway ?? 0,
    periods,
    played,
    current,
    round: round?.attributes.name || '',
    group: group?.attributes.name || '',
    tournament: tournament?.attributes.name || '',
    groupId: group?.id || null,
    facility: normalizeFacility(facility),
    report: a.report || null,
    updatedAt: a.updated_at,
  };
}

function normalizeFacility(f) {
  const a = f?.attributes;
  const name = a?.name?.trim();
  if (!name) return null;
  const address = [a.address, a.postal_code].filter(Boolean).join(', ');
  const place = [a.city, a.province && a.province !== a.city ? a.province : null].filter(Boolean).join(', ');
  const hasGeo = a.latitude && a.longitude;
  const q = hasGeo ? `${a.latitude},${a.longitude}` : [name, a.address, a.city, a.province || 'Canarias'].filter(Boolean).join(', ');
  return {
    name,
    address,
    place,
    short: [name, a.city].filter(Boolean).join(' · '),
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
  };
}
