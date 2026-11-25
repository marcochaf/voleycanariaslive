# Voley Canarias Live

PWA that shows **live scoreboards** for Federación Canaria de Voleibol matches (data from Clupik/Leverade).

## How it works
- Uses the public **Leverade/Clupik** JSON:API (`https://api.leverade.com`, no authentication, CORS open). No scraping: fcanvb.es has an anti-bot check, and the API already exposes everything needed.
- Flow: **Category → Competition → Group → Matchday** → **scoreboard**.
  - The default matchday is today's; otherwise the next one; otherwise the last one played. ‹ › or the dropdown to switch.
  - Rounds have no date in the API: their date range is worked out from their matches. Matches without an assigned time come back as `00:00` and are shown as "Horario por definir".
- **Clasificación** tab for the group (points, matches won and lost, sets and points for and against). The scoreboard also shows the standings with both teams highlighted.
- **Venue** of the match (name, address and city, when they exist) with a "Cómo llegar" link to Google Maps.
- Scoreboard: refreshes every 8 s while the match is live (pauses with the tab in the background), current set in large digits, set-by-set table, sets won, animation on each point, full screen (TV mode), keeps the screen on (Wake Lock) and lets you share the link (`#/m/<matchId>`).
- The selection is remembered in `localStorage`.

## Endpoints used
| Data | Endpoint |
|---|---|
| Competitions (season in progress) | `/tournaments?filter=manager.id:288589,season.id:<id>&include=category` |
| Groups | `/groups?filter=tournament.id:<id>` |
| Rounds | `/rounds?filter=group.id:<id>` (+ `/matches?filter=round.group.id:<id>` for the dates) |
| Group standings | `/groups/<id>/standings` (in `meta.standingsrows`) |
| Matches of a round | `/matches?filter=round.id:<id>&include=teams,results,periods.results,…` |
| One match | `/matches?filter=id:<id>&include=…` (`/matches/<id>` requires login) |

Points per set are in `periods[].results[].value`; sets won are in the match `results` (without `period`).

## Running locally
```bash
python3 -m http.server 8080   # then open http://localhost:8080
```
Static site with no build step: upload the folder to any HTTPS hosting (Netlify, GitHub Pages, Apache/Nginx…). The service worker only works over HTTPS or localhost.

## Structure
```
index.html  manifest.webmanifest  sw.js
css/styles.css
js/api.js   ← API client + data normalization
js/app.js   ← router, views, polling
icons/
```
