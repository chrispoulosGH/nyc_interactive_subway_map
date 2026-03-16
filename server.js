import express from 'express';
import cors from 'cors';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());

const FEEDS = {
  base: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  ace:  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  bdfm: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  g:    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
  jz:   'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
  nqrw: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  l:    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
};

const ALERTS_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts';

const EFFECT_SEVERITY = {
  REDUCED_SERVICE:    1,
  SIGNIFICANT_DELAYS: 2,
  DETOUR:             2,
  SUSPENSION:         3,
  NO_SERVICE:         3,
};

async function fetchFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MTA responded ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buf));
}

// Simple in-memory cache
const cache = { alerts: null, alertsAt: 0, trains: null, trainsAt: 0, vehicles: null, vehiclesAt: 0, ridership: null, ridershipAt: 0, crime: null, crimeAt: 0, shapes: null, shapesAt: 0, stops: null, stopsAt: 0 };
const ALERTS_TTL   = 15_000;
const TRAINS_TTL   = 15_000;
const VEHICLES_TTL = 15_000;
const RIDERSHIP_TTL = 300_000;
const CRIME_TTL    = 86_400_000;
const SHAPES_TTL   = 86_400_000;
const STOPS_TTL    = 86_400_000;

// Shared GTFS static zip cache — avoid re-downloading for shapes + stops
let gtfsZipBuf = null;
let gtfsZipAt  = 0;
async function getGTFSZip() {
  if (gtfsZipBuf && Date.now() - gtfsZipAt < SHAPES_TTL) return gtfsZipBuf;
  console.log('Downloading MTA GTFS zip…');
  const r = await fetch('http://web.mta.info/developers/data/nyct/subway/google_transit.zip');
  if (!r.ok) throw new Error(`GTFS zip ${r.status}`);
  gtfsZipBuf = Buffer.from(await r.arrayBuffer());
  gtfsZipAt  = Date.now();
  return gtfsZipBuf;
}

app.get('/api/alerts', async (_req, res) => {
  try {
    if (cache.alerts && Date.now() - cache.alertsAt < ALERTS_TTL) {
      return res.json(cache.alerts);
    }

    const feed = await fetchFeed(ALERTS_URL);
    const byRoute = {};
    const list = [];

    for (const entity of feed.entity) {
      const alert = entity.alert;
      if (!alert) continue;

      const routes = [...new Set(
        (alert.informedEntity || []).map(ie => ie.routeId).filter(Boolean)
      )];
      const header   = alert.headerText?.translation?.[0]?.text || '';
      const desc     = alert.descriptionText?.translation?.[0]?.text || '';
      const effect   = alert.effect?.toString() || 'UNKNOWN';
      const severity = EFFECT_SEVERITY[effect] || 1;

      list.push({ routes, header, desc, effect, severity });

      for (const r of routes) {
        if (!byRoute[r] || severity > byRoute[r].severity) {
          byRoute[r] = { severity, effect };
        }
      }
    }

    cache.alerts  = { byRoute, list, updatedAt: Date.now() };
    cache.alertsAt = Date.now();
    res.json(cache.alerts);
  } catch (err) {
    console.error('alerts error:', err.message);
    res.status(502).json({ error: err.message, byRoute: {}, list: [] });
  }
});

app.get('/api/trains', async (_req, res) => {
  try {
    if (cache.trains && Date.now() - cache.trainsAt < TRAINS_TTL) {
      return res.json(cache.trains);
    }

    const counts = {};
    const stopArrivals = {};

    await Promise.allSettled(
      Object.values(FEEDS).map(async url => {
        const feed = await fetchFeed(url);
        for (const entity of feed.entity) {
          if (entity.tripUpdate) {
            const routeId = entity.tripUpdate.trip?.routeId;
            if (routeId) {
              counts[routeId] = (counts[routeId] || 0) + 1;
              for (const stu of (entity.tripUpdate.stopTimeUpdate || []).slice(0, 3)) {
                const stopId  = stu.stopId?.replace(/[NS]$/, '');
                const arrival = Number(stu.arrival?.time || stu.departure?.time || 0);
                if (stopId && arrival) {
                  if (!stopArrivals[stopId]) stopArrivals[stopId] = [];
                  stopArrivals[stopId].push({ routeId, arrivalTime: arrival * 1000 });
                }
              }
            }
          }
        }
      })
    );

    const now = Date.now();
    const stopVolume = {};
    for (const [stopId, arrivals] of Object.entries(stopArrivals)) {
      stopVolume[stopId] = arrivals.filter(
        a => a.arrivalTime > now && a.arrivalTime - now < 600_000
      ).length;
    }

    cache.trains  = { counts, stopVolume, updatedAt: Date.now() };
    cache.trainsAt = Date.now();
    res.json(cache.trains);
  } catch (err) {
    console.error('trains error:', err.message);
    res.status(502).json({ error: err.message, counts: {}, stopVolume: {} });
  }
});

function bearingBetween(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Stop coordinate cache — fetched once from MTA open data (station lat/lng keyed by GTFS stop ID)
let stopCoords = null;
let stopCoordsAt = 0;

async function getStopCoords() {
  if (stopCoords && Date.now() - stopCoordsAt < 86_400_000) return stopCoords;
  const r = await fetch('https://data.ny.gov/resource/39hk-dx4f.json?$limit=600');
  if (!r.ok) throw new Error(`stops API ${r.status}`);
  const rows = await r.json();
  stopCoords = {};
  for (const row of rows) {
    if (row.gtfs_stop_id && row.gtfs_latitude && row.gtfs_longitude) {
      stopCoords[row.gtfs_stop_id] = {
        lat:  parseFloat(row.gtfs_latitude),
        lng:  parseFloat(row.gtfs_longitude),
        name: row.stop_name || row.gtfs_stop_id,
      };
    }
  }
  stopCoordsAt = Date.now();
  return stopCoords;
}

const LINE_TO_FEED = {
  '1':'base','2':'base','3':'base','4':'base','5':'base','6':'base','7':'base',
  'A':'ace', 'C':'ace', 'E':'ace',
  'B':'bdfm','D':'bdfm','F':'bdfm','M':'bdfm',
  'G':'g',
  'J':'jz',  'Z':'jz',
  'N':'nqrw','Q':'nqrw','R':'nqrw','W':'nqrw',
  'L':'l',
  'SI':'base',
};

const scheduleCache = {};
const SCHEDULE_TTL  = 30_000;

app.get('/api/schedule/:lineId', async (req, res) => {
  try {
    const lineId  = req.params.lineId.toUpperCase();
    const feedKey = LINE_TO_FEED[lineId];
    if (!feedKey) return res.status(404).json({ error: `Unknown line: ${lineId}`, trips: [] });

    if (scheduleCache[lineId] && Date.now() - scheduleCache[lineId].at < SCHEDULE_TTL) {
      return res.json(scheduleCache[lineId].data);
    }

    const [feed, stops] = await Promise.all([fetchFeed(FEEDS[feedKey]), getStopCoords()]);
    const nowSec = Date.now() / 1000;
    const trips  = [];

    for (const entity of feed.entity) {
      if (!entity.tripUpdate) continue;
      const tu = entity.tripUpdate;
      if (tu.trip?.routeId !== lineId) continue;

      const upcoming = (tu.stopTimeUpdate || [])
        .map(stu => ({
          stopId: stu.stopId?.replace(/[NS]$/, ''),
          time:   Number(stu.arrival?.time || stu.departure?.time || 0),
        }))
        .filter(s => s.stopId && s.time > nowSec)
        .sort((a, b) => a.time - b.time);

      if (upcoming.length === 0) continue;

      const tripId    = tu.trip?.tripId || entity.id;
      const direction = tripId.includes('..N') ? 'N' : 'S';
      const next      = upcoming[0];
      const dest      = upcoming[upcoming.length - 1];

      trips.push({
        tripId,
        direction,
        nextStop:      stops[next.stopId]?.name || next.stopId,
        destination:   stops[dest.stopId]?.name || dest.stopId,
        departureTime: next.time * 1000,
        departureAt:   new Date(next.time * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        stops:         upcoming.length,
      });
    }

    trips.sort((a, b) => a.departureTime - b.departureTime);
    const data = { lineId, trips, updatedAt: Date.now() };
    scheduleCache[lineId] = { data, at: Date.now() };
    res.json(data);
  } catch (err) {
    console.error('schedule error:', err.message);
    res.status(502).json({ error: err.message, lineId: req.params.lineId, trips: [] });
  }
});

// Infer train positions from trip update stop sequences.
// The NYC subway does not publish GTFS-RT vehicle position entities, so we
// interpolate each train's lat/lng between its last-departed stop and next stop.
app.get('/api/vehicles', async (_req, res) => {
  try {
    if (cache.vehicles && Date.now() - cache.vehiclesAt < VEHICLES_TTL) {
      return res.json(cache.vehicles);
    }

    const coords = await getStopCoords();
    const nowSec = Date.now() / 1000;
    const vehicles = [];

    await Promise.allSettled(
      Object.values(FEEDS).map(async url => {
        const feed = await fetchFeed(url);
        for (const entity of feed.entity) {
          if (!entity.tripUpdate) continue;
          const tu = entity.tripUpdate;
          const routeId = tu.trip?.routeId;
          if (!routeId) continue;

          const stus = (tu.stopTimeUpdate || [])
            .map(stu => ({
              stopId: stu.stopId?.replace(/[NS]$/, ''),
              time:   Number(stu.arrival?.time || stu.departure?.time || 0),
            }))
            .filter(s => s.stopId && s.time)
            .sort((a, b) => a.time - b.time);

          if (stus.length === 0) continue;

          let prev = null, next = null;
          for (const s of stus) {
            if (s.time <= nowSec) prev = s;
            else if (!next) next = s;
          }

          // Need at least a next stop with known coordinates
          if (!next || !coords[next.stopId]) continue;

          const nc = coords[next.stopId];
          const pc = prev ? coords[prev.stopId] : null;
          const bearing = pc ? bearingBetween(pc.lat, pc.lng, nc.lat, nc.lng) : 0;

          // Interpolate current position at compute time so the client can dead-reckon forward
          const secsToNext = Math.max(0, next.time - nowSec);
          let lat = nc.lat, lng = nc.lng;
          if (pc && prev && next.time > prev.time) {
            const t = Math.max(0, Math.min(1, (nowSec - prev.time) / (next.time - prev.time)));
            lat = pc.lat + t * (nc.lat - pc.lat);
            lng = pc.lng + t * (nc.lng - pc.lng);
          }

          vehicles.push({
            tripId: tu.trip?.tripId || entity.id,
            routeId, bearing,
            lat, lng,          // position at cache-compute time
            nextLat: nc.lat, nextLng: nc.lng,  // destination stop
            secsToNext,        // seconds remaining to next stop at compute time
          });
        }
      })
    );

    cache.vehicles  = vehicles;
    cache.vehiclesAt = Date.now();
    res.json(vehicles);
  } catch (err) {
    console.error('vehicles error:', err.message);
    res.status(502).json([]);
  }
});

app.get('/api/ridership', async (_req, res) => {
  try {
    if (cache.ridership && Date.now() - cache.ridershipAt < RIDERSHIP_TTL) {
      return res.json(cache.ridership);
    }

    const url = 'https://data.ny.gov/resource/wujg-7c2s.json' +
      '?$order=transit_timestamp+DESC&$limit=1000' +
      '&$select=transit_timestamp,station_complex,ridership,latitude,longitude';
    const r = await fetch(url);
    if (!r.ok) throw new Error(`ridership API ${r.status}`);
    const raw = await r.json();

    // Keep only the most recent timestamp per station
    const latest = raw[0]?.transit_timestamp;
    const byStation = {};
    for (const row of raw.filter(x => x.transit_timestamp === latest)) {
      const key = row.station_complex;
      const val = parseInt(row.ridership) || 0;
      if (!byStation[key] || val > byStation[key].ridership) {
        byStation[key] = {
          stationName: key,
          lat: parseFloat(row.latitude),
          lng: parseFloat(row.longitude),
          ridership: val,
          timestamp: latest,
        };
      }
    }

    const data = Object.values(byStation).filter(s => s.lat && s.lng);
    cache.ridership  = data;
    cache.ridershipAt = Date.now();
    res.json(data);
  } catch (err) {
    console.error('ridership error:', err.message);
    res.status(502).json([]);
  }
});

app.get('/api/crime', async (_req, res) => {
  try {
    if (cache.crime && Date.now() - cache.crimeAt < CRIME_TTL) {
      return res.json(cache.crime);
    }

    // NYPD complaint data YTD, subway only, aggregated by station with avg coords
    const url = 'https://data.cityofnewyork.us/resource/5uac-w243.json' +
      '?$select=station_name,avg(latitude)%20as%20lat,avg(longitude)%20as%20lng,count(*)%20as%20incidents' +
      '&$where=prem_typ_desc=%27TRANSIT%20-%20NYC%20SUBWAY%27%20AND%20station_name%20IS%20NOT%20NULL' +
      '&$group=station_name' +
      '&$limit=600';

    const r = await fetch(url);
    if (!r.ok) throw new Error(`crime API ${r.status}`);
    const raw = await r.json();

    const data = raw
      .map(row => ({
        stationName: row.station_name,
        lat: parseFloat(row.lat),
        lng: parseFloat(row.lng),
        incidents: parseInt(row.incidents) || 0,
      }))
      .filter(d => d.incidents > 0 && d.lat && d.lng);

    cache.crime   = data;
    cache.crimeAt = Date.now();
    res.json(data);
  } catch (err) {
    console.error('crime error:', err.message);
    res.status(502).json([]);
  }
});

async function buildStopsData() {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(await getGTFSZip());

  const lines  = zip.getEntry('stops.txt').getData().toString('utf8').split('\n');
  const header = lines[0].split(',');
  const idIdx   = header.indexOf('stop_id');
  const nameIdx = header.indexOf('stop_name');
  const latIdx  = header.indexOf('stop_lat');
  const lonIdx  = header.indexOf('stop_lon');
  const typeIdx = header.indexOf('location_type');

  const stops = [];
  for (let i = 1; i < lines.length; i++) {
    const cols    = lines[i].split(',');
    const locType = cols[typeIdx]?.trim();
    if (locType !== '1') continue;  // parent stations only
    const id  = cols[idIdx]?.trim();
    const name = cols[nameIdx]?.trim();
    const lat  = parseFloat(cols[latIdx]);
    const lng  = parseFloat(cols[lonIdx]);
    if (id && name && !isNaN(lat) && !isNaN(lng)) stops.push({ id, name, lat, lng });
  }
  return stops;
}

async function buildShapesGeoJSON() {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(await getGTFSZip());

  // Parse trips.txt → route_id → Set<shape_id>
  const tripsLines  = zip.getEntry('trips.txt').getData().toString('utf8').split('\n');
  const tripsHeader = tripsLines[0].split(',');
  const rIdx = tripsHeader.indexOf('route_id');
  const sIdx = tripsHeader.indexOf('shape_id');
  const routeShapes = {};
  for (let i = 1; i < tripsLines.length; i++) {
    const cols = tripsLines[i].split(',');
    const routeId = cols[rIdx]?.trim();
    const shapeId = cols[sIdx]?.trim();
    if (routeId && shapeId) {
      if (!routeShapes[routeId]) routeShapes[routeId] = new Set();
      routeShapes[routeId].add(shapeId);
    }
  }

  // Parse shapes.txt → shape_id → sorted [[lng,lat]]
  const shapesLines  = zip.getEntry('shapes.txt').getData().toString('utf8').split('\n');
  const shapesHeader = shapesLines[0].split(',');
  const idIdx  = shapesHeader.indexOf('shape_id');
  const latIdx = shapesHeader.indexOf('shape_pt_lat');
  const lngIdx = shapesHeader.indexOf('shape_pt_lon');
  const seqIdx = shapesHeader.indexOf('shape_pt_sequence');
  const shapePoints = {};
  for (let i = 1; i < shapesLines.length; i++) {
    const cols = shapesLines[i].split(',');
    const sid  = cols[idIdx]?.trim();
    const lat  = parseFloat(cols[latIdx]);
    const lng  = parseFloat(cols[lngIdx]);
    const seq  = parseInt(cols[seqIdx]);
    if (sid && !isNaN(lat) && !isNaN(lng)) {
      if (!shapePoints[sid]) shapePoints[sid] = [];
      shapePoints[sid].push([seq, lng, lat]);
    }
  }
  for (const pts of Object.values(shapePoints)) pts.sort((a, b) => a[0] - b[0]);

  // Build GeoJSON: one feature per route, MultiLineString of all shape variants
  const features = [];
  for (const [routeId, shapeIds] of Object.entries(routeShapes)) {
    const lines = [];
    for (const sid of shapeIds) {
      const pts = shapePoints[sid];
      if (pts && pts.length > 1) lines.push(pts.map(([, lng, lat]) => [lng, lat]));
    }
    if (lines.length > 0) {
      features.push({
        type: 'Feature',
        properties: { name: routeId },
        geometry: { type: 'MultiLineString', coordinates: lines },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

app.get('/api/stops', async (_req, res) => {
  try {
    if (cache.stops && Date.now() - cache.stopsAt < STOPS_TTL) {
      return res.json(cache.stops);
    }
    console.log('Downloading MTA GTFS stops…');
    const stops      = await buildStopsData();
    cache.stops      = stops;
    cache.stopsAt    = Date.now();
    console.log(`Stops loaded: ${stops.length} parent stations`);
    res.json(stops);
  } catch (err) {
    console.error('stops error:', err.message);
    res.status(502).json([]);
  }
});

app.get('/api/shapes', async (_req, res) => {
  try {
    if (cache.shapes && Date.now() - cache.shapesAt < SHAPES_TTL) {
      return res.json(cache.shapes);
    }
    console.log('Downloading MTA GTFS shapes…');
    const geojson  = await buildShapesGeoJSON();
    cache.shapes   = geojson;
    cache.shapesAt = Date.now();
    console.log(`Shapes loaded: ${geojson.features.length} routes`);
    res.json(geojson);
  } catch (err) {
    console.error('shapes error:', err.message);
    res.status(502).json({ type: 'FeatureCollection', features: [] });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Serve built frontend in production
const distPath = join(__dirname, 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => res.sendFile(join(distPath, 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MTA proxy server → http://localhost:${PORT}`));
