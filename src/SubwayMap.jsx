import { useState, useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { STATIONS, LINES, generateEdges } from './subwayData';
import { useRealtime } from './useRealtime';

const SEVERITY_COLOR = { 1: '#f59e0b', 2: '#ef4444', 3: '#7f1d1d' };


const BOUNDS = [
  [Math.min(...STATIONS.map(s => s.lat)), Math.min(...STATIONS.map(s => s.lng))],
  [Math.max(...STATIONS.map(s => s.lat)), Math.max(...STATIONS.map(s => s.lng))],
];

function FitBounds() {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(BOUNDS, { padding: [24, 24] });
    setTimeout(() => map.zoomIn(3.4), 100);
  }, [map]);
  return null;
}

function CreatePane({ name, zIndex }) {
  const map = useMap();
  useEffect(() => {
    if (!map.getPane(name)) {
      const pane = map.createPane(name);
      pane.style.zIndex = zIndex;
    }
  }, [map, name, zIndex]);
  return null;
}

function ZoomControls() {
  const map = useMap();
  const btnStyle = {
    width: 49, height: 49, fontSize: 28, fontWeight: 'bold',
    background: 'rgba(15,20,40,0.92)', color: '#eee',
    border: '1px solid #0f3460', cursor: 'pointer', borderRadius: 4,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    lineHeight: 1,
  };
  return (
    <div style={{
      position: 'absolute', bottom: 40, right: 16, zIndex: 1000,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <button style={btnStyle} onClick={() => map.zoomIn()}>+</button>
      <button style={btnStyle} onClick={() => map.zoomOut()}>−</button>
      <button
        style={{ ...btnStyle, fontSize: 10, height: 25 }}
        onClick={() => { map.fitBounds(BOUNDS, { padding: [24, 24] }); setTimeout(() => map.zoomIn(3.4), 100); }}
      >Reset</button>
    </div>
  );
}

const EDGES = generateEdges();
const STATION_MAP = Object.fromEntries(STATIONS.map(s => [s.id, s]));

// Normalize station name for fuzzy matching against GTFS stop names
function normName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pre-group edges by route for fast lookup
const EDGES_BY_ROUTE = {};
for (const e of EDGES) {
  if (!EDGES_BY_ROUTE[e.line]) EDGES_BY_ROUTE[e.line] = [];
  EDGES_BY_ROUTE[e.line].push(e);
}

function projectOnSegment(plat, plng, alat, alng, blat, blng) {
  const dlat = blat - alat, dlng = blng - alng;
  const lenSq = dlat * dlat + dlng * dlng;
  if (lenSq < 1e-14) return { lat: alat, lng: alng, distSq: (plat-alat)**2 + (plng-alng)**2 };
  const t = Math.max(0, Math.min(1, ((plat - alat) * dlat + (plng - alng) * dlng) / lenSq));
  const lat = alat + t * dlat, lng = alng + t * dlng;
  return { lat, lng, distSq: (plat - lat) ** 2 + (plng - lng) ** 2 };
}


const NYC_CENTER = [40.728, -73.948];
const INITIAL_ZOOM = 12;

function makeTrainIcon(color, bearing, scale = 1) {
  const rw = Math.round(21 * scale);
  const rh = Math.max(2, Math.round(5 * scale));
  const rx = Math.max(1, Math.round(2 * scale));
  const sw = Math.max(1, Math.round(2 * scale));
  // Square SVG large enough to contain the rect at any rotation angle
  const size = Math.ceil(Math.sqrt(rw * rw + rh * rh)) + sw * 2 + 4;
  const c    = size / 2;
  const html = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect x="${c - rw / 2}" y="${c - rh / 2}" width="${rw}" height="${rh}" rx="${rx}"
      fill="white" stroke="${color}" stroke-width="${sw}"
      transform="rotate(${bearing}, ${c}, ${c})"
      style="filter:drop-shadow(0 0 3px rgba(0,0,0,0.8))"/>
  </svg>`;
  return L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [c, c] });
}

function MapLayers({ visibleEdges, visibleStations, selected, setSelected, activeLines, alertsByRoute = {}, trainCounts = {}, stopVolume = {}, stationRidership = {}, maxRidership = 1, showRidership = false, showLabels = true, stationCrime = {}, maxCrime = 1, showCrime = false, shapes = null }) {
  const [zoom, setZoom] = useState(12);
  useMapEvents({ zoomend: (e) => setZoom(e.target.getZoom()) });

  const showLines    = zoom >= 13;
  const labelSize    = Math.max(7, Math.round((zoom - 11) * 1.2 + 8));
  const circleRadius = Math.max(3, Math.round((zoom - 11) * 1.5 + 4));

  return (
    <>
      {/* Alert overlays — rendered first so track lines appear on top */}
      {shapes
        ? shapes.features.flatMap((feature, i) => {
            const routeNames = (feature.properties?.name || '').trim().split(/\s+/).filter(Boolean);
            const alertedRoute = routeNames.find(r => activeLines.has(r) && alertsByRoute[r]);
            if (!alertedRoute) return [];
            const alert = alertsByRoute[alertedRoute];
            const color = SEVERITY_COLOR[alert.severity] || '#f59e0b';
            const rings = feature.geometry.type === 'MultiLineString'
              ? feature.geometry.coordinates
              : [feature.geometry.coordinates];
            return rings.map((coords, j) => (
              <Polyline
                key={`alert-shape-${i}-${j}`}
                positions={coords.map(([lng, lat]) => [lat, lng])}
                pathOptions={{ color, weight: 4, opacity: 0.6, dashArray: '8 8' }}
              />
            ));
          })
        : visibleEdges.map((edge, i) => {
            const from  = STATION_MAP[edge.from];
            const to    = STATION_MAP[edge.to];
            const alert = alertsByRoute[edge.line];
            if (!from || !to || !alert) return null;
            return (
              <Polyline
                key={`alert-${i}`}
                positions={[[from.lat, from.lng], [to.lat, to.lng]]}
                pathOptions={{ color: SEVERITY_COLOR[alert.severity] || '#f59e0b', weight: 6, opacity: 0.5, dashArray: '8 8' }}
              />
            );
          })
      }

      {/* Edges — GeoJSON track geometry when available, straight-line fallback */}
      {shapes
        ? shapes.features.flatMap((feature, i) => {
            const routeNames = (feature.properties?.name || '').trim().split(/\s+/).filter(Boolean);
            const activeRoute = routeNames.find(r => activeLines.has(r));
            if (!activeRoute) return [];
            const color  = LINES[activeRoute]?.color || '#fff';
            const trips  = routeNames.reduce((sum, r) => sum + (trainCounts[r] || 0), 0);
            const weight = Math.min(4, 1 + trips * 0.05);
            const rings  = feature.geometry.type === 'MultiLineString'
              ? feature.geometry.coordinates
              : [feature.geometry.coordinates];
            return rings.map((coords, j) => (
              <Polyline
                key={`shape-${i}-${j}`}
                positions={coords.map(([lng, lat]) => [lat, lng])}
                pathOptions={{ color, weight, opacity: 0.85 }}
              />
            ));
          })
        : visibleEdges.map((edge, i) => {
            const from  = STATION_MAP[edge.from];
            const to    = STATION_MAP[edge.to];
            if (!from || !to) return null;
            const trips  = trainCounts[edge.line] || 0;
            const weight = Math.min(4, 1 + trips * 0.05);
            return (
              <Polyline
                key={i}
                positions={[[from.lat, from.lng], [to.lat, to.lng]]}
                pathOptions={{ color: LINES[edge.line]?.color || '#fff', weight, opacity: 0.85 }}
              />
            );
          })
      }

      {/* Ridership halos — rendered beneath station dots */}
      {showRidership && visibleStations.map(station => {
        const riders = stationRidership[station.id] || 0;
        if (!riders) return null;
        const ratio = riders / maxRidership;
        const haloRadius = circleRadius * (1.8 + 2.5 * ratio);
        return (
          <CircleMarker
            key={`ridership-${station.id}`}
            center={[station.lat, station.lng]}
            radius={haloRadius}
            pathOptions={{
              color: 'transparent', weight: 0,
              fillColor: '#00aaff',
              fillOpacity: 0.15 + 0.45 * ratio,
            }}
            eventHandlers={{ click: () => setSelected(selected === station.id ? null : station.id) }}
          />
        );
      })}

      {/* Crime halos — rendered beneath station dots */}
      {showCrime && visibleStations.map(station => {
        const crimes = stationCrime[station.id] || 0;
        if (!crimes) return null;
        const ratio = crimes / maxCrime;
        const haloRadius = circleRadius * (1.8 + 2.5 * ratio);
        const g = Math.round(68 * (1 - ratio));
        return (
          <CircleMarker
            key={`crime-${station.id}`}
            center={[station.lat, station.lng]}
            radius={haloRadius}
            pathOptions={{
              color: 'transparent', weight: 0,
              fillColor: `rgb(239,${g},0)`,
              fillOpacity: 0.18 + 0.45 * ratio,
            }}
            eventHandlers={{ click: () => setSelected(selected === station.id ? null : station.id) }}
          />
        );
      })}

      {/* Stations */}
      {visibleStations.map(station => {
        const isSelected   = selected === station.id;
        const primaryLine  = station.lines.find(l => activeLines.has(l));
        const lineColor    = primaryLine ? LINES[primaryLine]?.color : '#888';
        const vol          = stopVolume[station.id] || 0;
        const stationAlert = station.lines.map(l => alertsByRoute[l]).filter(Boolean).sort((a, b) => b.severity - a.severity)[0];
        const riders       = stationRidership[station.id] || 0;
        const fillColor    = isSelected ? '#fff' : lineColor;
        const radius       = isSelected ? circleRadius + 4 : circleRadius;

        return (
          <CircleMarker
            key={station.id}
            center={[station.lat, station.lng]}
            radius={radius}
            pane="stations"
            pathOptions={{
              color:       isSelected ? '#fff' : stationAlert ? SEVERITY_COLOR[stationAlert.severity] : '#111',
              fillColor,
              fillOpacity: 1,
              weight:      isSelected ? 1.5 : stationAlert ? 1.5 : 0.5,
            }}
            eventHandlers={{ click: () => setSelected(isSelected ? null : station.id) }}
          >
            {showLabels && (
              <Tooltip direction="top" offset={[0, -10]} opacity={1} permanent={true} className="station-label">
                <span style={{ fontSize: labelSize, fontWeight: 300 }}>{station.name}</span>
                {showLines && <><br /><span style={{ fontSize: labelSize - 1, fontWeight: 300, opacity: 0.75 }}>{station.lines.join(' · ')}</span></>}
                {showRidership && riders > 0 && <><br /><span style={{ fontSize: labelSize - 1, fontWeight: 300, color: '#93c5fd' }}>👥 {riders.toLocaleString()} riders/hr</span></>}
                {vol > 0 && <><br /><span style={{ fontSize: labelSize - 1, fontWeight: 300, color: '#6ee7b7' }}>🚇 {vol} train{vol !== 1 ? 's' : ''} arriving</span></>}
                {showCrime && stationCrime[station.id] > 0 && <><br /><span style={{ fontSize: labelSize - 1, fontWeight: 300, color: '#fca5a5' }}>🚨 {stationCrime[station.id]} incidents YTD</span></>}
                {stationAlert && <><br /><span style={{ fontSize: labelSize - 1, fontWeight: 300, color: SEVERITY_COLOR[stationAlert.severity] }}>⚠ {stationAlert.effect}</span></>}
              </Tooltip>
            )}
          </CircleMarker>
        );
      })}

    </>
  );
}

// Dead-reckoning vehicle layer — bypasses React rendering for per-frame updates
function snapPointToRoute(lat, lng, routeId) {
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return null;
  const routeEdges = EDGES_BY_ROUTE[routeId];
  if (!routeEdges) return null;
  let best = null;
  for (const e of routeEdges) {
    const from = STATION_MAP[e.from], to = STATION_MAP[e.to];
    if (!from || !to) continue;
    const p = projectOnSegment(lat, lng, from.lat, from.lng, to.lat, to.lng);
    if (!best || p.distSq < best.distSq) best = p;
  }
  return best ? { lat: best.lat, lng: best.lng } : null;
}

function trainScale(zoom) {
  return Math.max(0.3, ((zoom - 11) * 3 + 8) / 11);
}

function VehicleLayer({ vehicles, showVehicles, activeLines }) {
  const map        = useMap();
  const markersRef = useRef(new Map()); // tripId → Leaflet marker
  const animRef    = useRef(new Map()); // tripId → { snapCur, snapNext, secsToNext, startSec, routeId, bearing }
  const rafRef     = useRef(null);
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: e => setZoom(e.target.getZoom()) });

  // Refresh all marker icons when zoom changes
  useEffect(() => {
    const scale = trainScale(zoom);
    const color = id => LINES[id]?.color || '#aaa';
    for (const [tripId, marker] of markersRef.current) {
      const data = animRef.current.get(tripId);
      if (data) marker.setIcon(makeTrainIcon(color(data.routeId), data.bearing, scale));
    }
  }, [zoom]);

  // Update animation targets whenever vehicle data or visibility changes
  useEffect(() => {
    if (!showVehicles) {
      markersRef.current.forEach(m => m.remove());
      markersRef.current.clear();
      animRef.current.clear();
      return;
    }

    const color    = id => LINES[id]?.color || '#aaa';
    const nowSec   = Date.now() / 1000;
    const scale    = trainScale(zoom);
    const incoming = new Set();

    for (const v of vehicles) {
      if (!activeLines.has(v.routeId)) continue;
      const snapCur  = snapPointToRoute(v.lat,     v.lng,     v.routeId);
      const snapNext = snapPointToRoute(v.nextLat, v.nextLng, v.routeId);
      if (!snapCur || !snapNext) continue;

      incoming.add(v.tripId);

      // Create marker if new
      if (!markersRef.current.has(v.tripId)) {
        const icon   = makeTrainIcon(color(v.routeId), v.bearing ?? 0, scale);
        const marker = L.marker([snapCur.lat, snapCur.lng], { icon, zIndexOffset: 500 });
        marker.bindTooltip(
          `<span style="font-size:13px;font-weight:bold;color:${color(v.routeId)}">${v.routeId}</span>` +
          `<br><span style="font-size:11px;color:#ccc">En route</span>`,
          { className: 'station-label', direction: 'top', offset: [0, -14] }
        );
        marker.addTo(map);
        markersRef.current.set(v.tripId, marker);
      } else {
        markersRef.current.get(v.tripId).setIcon(makeTrainIcon(color(v.routeId), v.bearing ?? 0, scale));
      }

      // Store animation segment + metadata for zoom-driven icon refresh
      animRef.current.set(v.tripId, {
        snapCur, snapNext,
        secsToNext: Math.max(1, v.secsToNext),
        startSec:   nowSec,
        routeId:    v.routeId,
        bearing:    v.bearing ?? 0,
      });
    }

    // Remove stale markers
    for (const [id, marker] of markersRef.current) {
      if (!incoming.has(id)) { marker.remove(); markersRef.current.delete(id); animRef.current.delete(id); }
    }
  }, [vehicles, showVehicles, activeLines, map, zoom]);

  // rAF dead-reckoning loop — runs continuously while showVehicles is true
  useEffect(() => {
    if (!showVehicles) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    function tick() {
      const nowSec = Date.now() / 1000;
      for (const [tripId, data] of animRef.current) {
        const marker = markersRef.current.get(tripId);
        if (!marker) continue;
        const t   = Math.min((nowSec - data.startSec) / data.secsToNext, 1);
        const lat = data.snapCur.lat + t * (data.snapNext.lat - data.snapCur.lat);
        const lng = data.snapCur.lng + t * (data.snapNext.lng - data.snapCur.lng);
        marker.setLatLng([lat, lng]);
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [showVehicles]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    markersRef.current.forEach(m => m.remove());
  }, []);

  return null;
}

function ScheduleDialog({ schedule, onClose, onMove, onResize, isMobile }) {
  const { lineId, trips, pos, size, loading } = schedule;
  const lineColor = LINES[lineId]?.color || '#888';
  const textColor = lineColor === '#FCCC0A' ? '#000' : '#fff';
  const now       = Date.now();

  // Keep stable refs to callbacks so effects don't re-run on every render
  const onMoveRef   = useRef(onMove);
  const onResizeRef = useRef(onResize);
  useEffect(() => { onMoveRef.current   = onMove;   }, [onMove]);
  useEffect(() => { onResizeRef.current = onResize; }, [onResize]);

  // --- Drag ---
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const handleDragDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;
    const move = (e) => onMoveRef.current({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
    const up   = () => setIsDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [isDragging]);

  // --- Resize ---
  const [isResizing, setIsResizing] = useState(false);
  const resizeStart = useRef(null);

  const handleResizeDown = (e, edge) => {
    e.preventDefault(); e.stopPropagation();
    resizeStart.current = { edge, mx: e.clientX, my: e.clientY, w: size.w, h: size.h, px: pos.x, py: pos.y };
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;
    const move = (e) => {
      const { edge, mx, my, w, h, px, py } = resizeStart.current;
      const dx = e.clientX - mx, dy = e.clientY - my;
      let nw = w, nh = h, nx = px, ny = py;
      if (edge.includes('e')) nw = Math.max(400, w + dx);
      if (edge.includes('w')) { nw = Math.max(400, w - dx); nx = px + (w - nw); }
      if (edge.includes('s')) nh = Math.max(300, h + dy);
      if (edge.includes('n')) { nh = Math.max(300, h - dy); ny = py + (h - nh); }
      onResizeRef.current({ pos: { x: nx, y: ny }, size: { w: nw, h: nh } });
    };
    const up = () => setIsResizing(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [isResizing]);

  const north = (trips || []).filter(t => t.direction === 'N').slice(0, 20);
  const south = (trips || []).filter(t => t.direction === 'S').slice(0, 20);

  const TripRow = ({ trip }) => {
    const mins     = Math.round((trip.departureTime - now) / 60000);
    const minColor = mins <= 2 ? '#ef4444' : mins <= 5 ? '#f59e0b' : '#6ee7b7';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px', marginBottom: 5, borderRadius: 7, background: 'rgba(255,255,255,0.04)', border: '1px solid #1e3a5f' }}>
        <div style={{ minWidth: 43, fontWeight: 'bold', fontSize: 19, color: minColor, textAlign: 'center', flexShrink: 0 }}>
          {mins <= 0 ? 'Now' : `${mins}m`}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, color: '#eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>→ {trip.destination}</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{trip.departureAt} · via {trip.nextStop}</div>
        </div>
        <div style={{ fontSize: 13, color: '#4b5563', flexShrink: 0 }}>{trip.stops} stops</div>
      </div>
    );
  };

  // Edge strips (8px thick, inset 0) for dragging any edge
  const edgeStyle = (edge) => {
    const base = { position: 'absolute', zIndex: 10 };
    if (edge === 'n') return { ...base, top: 0, left: 16, right: 16, height: 6, cursor: 'n-resize' };
    if (edge === 's') return { ...base, bottom: 0, left: 16, right: 16, height: 6, cursor: 's-resize' };
    if (edge === 'w') return { ...base, left: 0, top: 16, bottom: 16, width: 6, cursor: 'w-resize' };
    if (edge === 'e') return { ...base, right: 0, top: 16, bottom: 16, width: 6, cursor: 'e-resize' };
  };
  // Corner handles (16×16) at each corner
  const cornerStyle = (corner) => ({
    position: 'absolute', width: 16, height: 16, zIndex: 11,
    ...(corner.includes('n') ? { top: 0 } : { bottom: 0 }),
    ...(corner.includes('w') ? { left: 0 } : { right: 0 }),
    cursor: `${corner}-resize`,
    background: lineColor, opacity: 0.85, borderRadius: corner === 'nw' ? '14px 0 4px 0' : corner === 'ne' ? '0 14px 0 4px' : corner === 'sw' ? '0 4px 0 14px' : '4px 0 14px 0',
  });

  return (
    <div style={isMobile ? {
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 56, zIndex: 9000,
      background: 'rgba(13,18,38,0.97)', border: `2px solid ${lineColor}`,
      display: 'flex', flexDirection: 'column',
    } : {
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 9000,
      width: size.w, height: size.h,
      background: 'rgba(13,18,38,0.97)', border: `2px solid ${lineColor}`,
      borderRadius: 16, boxShadow: `0 12px 48px rgba(0,0,0,0.9), 0 0 24px ${lineColor}44`,
      userSelect: 'none', display: 'flex', flexDirection: 'column',
    }}>
      {/* Edge resize strips — desktop only */}
      {!isMobile && ['n','s','e','w'].map(e => (
        <div key={e} style={edgeStyle(e)} onMouseDown={ev => handleResizeDown(ev, e)} />
      ))}
      {/* Corner resize handles — desktop only */}
      {!isMobile && ['nw','ne','sw','se'].map(c => (
        <div key={c} style={cornerStyle(c)} onMouseDown={e => handleResizeDown(e, c)} />
      ))}

      {/* Title bar */}
      <div onMouseDown={isMobile ? undefined : handleDragDown} style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px', flexShrink: 0,
        cursor: isMobile ? 'default' : isDragging ? 'grabbing' : 'grab',
        background: `${lineColor}22`, borderBottom: `1px solid ${lineColor}55`,
        borderRadius: '14px 14px 0 0',
      }}>
        <div style={{
          width: 39, height: 39, borderRadius: '50%', background: lineColor, color: textColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 'bold', fontSize: 19, flexShrink: 0,
        }}>{lineId}</div>
        <span style={{ flex: 1, fontSize: 19, fontWeight: 'bold', color: '#eee' }}>
          {LINES[lineId]?.name} — Schedule
        </span>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', cursor: 'pointer', fontSize: 17,
          color: '#666', padding: '3px 4px',
        }}>✕</button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 25, color: '#555', fontSize: 17 }}>Loading schedule…</div>
        ) : (
          [{ label: 'Uptown / Bronx', dir: 'N', rows: north }, { label: 'Downtown / Brooklyn', dir: 'S', rows: south }].map(({ label, dir, rows }) => (
            <div key={dir} style={{ marginBottom: 15 }}>
              <div style={{ fontSize: 15, fontWeight: 'bold', color: lineColor, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 7, paddingBottom: 5, borderBottom: `1px solid ${lineColor}44` }}>
                {label}
              </div>
              {rows.length === 0
                ? <div style={{ fontSize: 15, color: '#4b5563', padding: '7px 0' }}>No upcoming departures</div>
                : rows.map(t => <TripRow key={t.tripId} trip={t} />)
              }
            </div>
          ))
        )}
        {!loading && <div style={{ fontSize: 12, color: '#374151', textAlign: 'right', marginTop: 4 }}>Updated {new Date().toLocaleTimeString()}</div>}
      </div>
    </div>
  );
}

export default function SubwayMap() {
  const [selected, setSelected]       = useState(null);
  const [activeLines, setActiveLines] = useState(new Set(Object.keys(LINES)));
  const [isMobile, setIsMobile]       = useState(() => window.innerWidth < 768);
  const [mobilePanel, setMobilePanel] = useState(null); // 'lines' | 'controls' | 'alerts' | null
  const longPressRef                  = useRef(null);
  const longPressFiredRef             = useRef(false);
  const [showVehicles,  setShowVehicles]  = useState(false);
  const [showRidership, setShowRidership] = useState(false);
  const [showLabels,    setShowLabels]    = useState(true);
  const [showCrime,     setShowCrime]     = useState(false);
  const [contextMenu,   setContextMenu]   = useState(null); // { lineId, x, y }
  const [schedules,     setSchedules]     = useState([]);   // [{ lineId, trips, pos, loading }]
  const [shapes,        setShapes]        = useState(null);
  const [gtfsStops,     setGtfsStops]     = useState(null);
  const { alerts, trains, vehicles, ridership, crime, status, lastUpdate } = useRealtime();

  useEffect(() => {
    fetch('/api/shapes').then(r => r.json()).then(setShapes).catch(() => {});
    fetch('/api/stops').then(r => r.json()).then(setGtfsStops).catch(() => {});
  }, []);

  // Override STATIONS coordinates with precise GTFS positions matched by name, then proximity
  const resolvedStations = useMemo(() => {
    if (!gtfsStops || gtfsStops.length === 0) return STATIONS;
    const byName = new Map(gtfsStops.map(s => [normName(s.name), s]));
    return STATIONS.map(s => {
      // 1. Exact name match
      const nameMatch = byName.get(normName(s.name));
      if (nameMatch) return { ...s, lat: nameMatch.lat, lng: nameMatch.lng };
      // 2. Proximity fallback — nearest GTFS stop within 150m
      let best = null, bestDist = Infinity;
      for (const gs of gtfsStops) {
        const d = Math.hypot(s.lat - gs.lat, s.lng - gs.lng);
        if (d < bestDist) { bestDist = d; best = gs; }
      }
      // ~0.0014 degrees ≈ 150m
      return best && bestDist < 0.0014 ? { ...s, lat: best.lat, lng: best.lng } : s;
    });
  }, [gtfsStops]);

  // Resize listener for mobile detection
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Close bottom panel when a station is selected on mobile
  useEffect(() => {
    if (isMobile && selected) setMobilePanel(null);
  }, [selected, isMobile]);

  // Dismiss context menu on any outside click
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener('click', dismiss);
    return () => window.removeEventListener('click', dismiss);
  }, [contextMenu]);

  const openSchedule = (lineId) => {
    // If already open, just refresh
    setSchedules(prev => {
      if (prev.find(s => s.lineId === lineId)) return prev;
      return [...prev, { lineId, trips: [], pos: { x: 320 + prev.length * 30, y: 120 + prev.length * 30 }, size: { w: 375, h: 332 }, loading: true }];
    });
    fetch(`/api/schedule/${lineId}`)
      .then(r => r.json())
      .then(data => setSchedules(prev => prev.map(s => s.lineId === lineId ? { ...s, trips: data.trips || [], loading: false } : s)))
      .catch(() => setSchedules(prev => prev.map(s => s.lineId === lineId ? { ...s, loading: false } : s)));
  };

  // Match ridership rows (lat/lng from data.ny.gov) to our station IDs by proximity
  const stationRidership = useMemo(() => {
    const result = {};
    for (const row of ridership) {
      let best = null, bestDist = Infinity;
      for (const s of resolvedStations) {
        const d = Math.hypot(s.lat - row.lat, s.lng - row.lng);
        if (d < bestDist) { bestDist = d; best = s; }
      }
      if (best && bestDist < 0.008) {
        if (!result[best.id] || row.ridership > result[best.id]) {
          result[best.id] = row.ridership;
        }
      }
    }
    return result;
  }, [ridership, resolvedStations]);

  const maxRidership = useMemo(() =>
    Math.max(...Object.values(stationRidership), 1),
  [stationRidership]);

  // Match crime rows to station IDs by proximity
  const stationCrime = useMemo(() => {
    const result = {};
    for (const row of crime) {
      let best = null, bestDist = Infinity;
      for (const s of resolvedStations) {
        const d = Math.hypot(s.lat - row.lat, s.lng - row.lng);
        if (d < bestDist) { bestDist = d; best = s; }
      }
      if (best && bestDist < 0.012) {
        result[best.id] = (result[best.id] || 0) + row.incidents;
      }
    }
    return result;
  }, [crime, resolvedStations]);

  const maxCrime = useMemo(() =>
    Math.max(...Object.values(stationCrime), 1),
  [stationCrime]);


  const toggleLine = (id) => setActiveLines(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAll = () => {
    const allKeys = Object.keys(LINES);
    const allOn   = allKeys.every(id => activeLines.has(id));
    setActiveLines(allOn ? new Set() : new Set(allKeys));
  };

  const allOn = Object.keys(LINES).every(id => activeLines.has(id));

  const [severityFilter, setSeverityFilter] = useState(new Set());

  const toggleSeverity = (sev) => setSeverityFilter(prev => {
    const next = new Set(prev);
    next.has(sev) ? next.delete(sev) : next.add(sev);
    return next;
  });

  const visibleEdges = EDGES.filter(e => {
    if (!activeLines.has(e.line)) return false;
    if (severityFilter.size > 0) {
      const alert = alerts.byRoute[e.line];
      return alert && severityFilter.has(alert.severity);
    }
    return true;
  });
  const visibleStations = resolvedStations.filter(s => {
    if (!s.lines.some(l => activeLines.has(l))) return false;
    if (severityFilter.size > 0) {
      return s.lines.some(l => {
        const alert = alerts.byRoute[l];
        return alert && severityFilter.has(alert.severity);
      });
    }
    return true;
  });
  const selectedStation = selected ? STATION_MAP[selected] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' }}>

      {/* Header */}
      <div style={{ padding: '10px 20px', background: '#16213e', borderBottom: '1px solid #0f3460', display: 'flex', alignItems: 'center', color: '#eee' }}>
        <h1 style={{ margin: 0, fontSize: 22, color: '#ffffff', flexShrink: 0 }}>NYC Subway Interactive Map</h1>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
          <span style={{
            width: 11, height: 11, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
            background: status === 'live' ? '#22c55e' : status === 'error' ? '#ef4444' : '#f59e0b',
            boxShadow: status === 'live' ? '0 0 14px #22c55e' : 'none',
          }} />
          <span style={{ color: '#aaa' }}>
            {status === 'live'  ? `Live · updated ${lastUpdate?.toLocaleTimeString()}` :
             status === 'error' ? 'MTA API unavailable' : 'Connecting to MTA…'}
          </span>
          {status === 'live' && (() => {
            const total = Object.values(trains.counts).reduce((a, b) => a + b, 0);
            return total > 0 ? (
              <span style={{ color: '#6ee7b7' }}>🚇 {total} trains active</span>
            ) : null;
          })()}
          {alerts.list.length > 0 && (
            <span style={{ color: '#FFD700' }}>
              ⚠ {alerts.list.length} active alert{alerts.list.length !== 1 ? 's' : ''}
            </span>
          )}
          {severityFilter.size > 0 && (
            <button onClick={() => setSeverityFilter(new Set())} style={{
              padding: '2px 7px', borderRadius: 3, cursor: 'pointer',
              fontSize: 13, fontWeight: 'bold', border: 'none',
              background: '#374151', color: '#f59e0b', transition: 'all 0.2s',
            }}>✕ Clear Filter</button>
          )}
        </div>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Map */}
        <div style={{ flex: 1, position: 'relative' }}>
          <MapContainer
            center={NYC_CENTER}
            zoom={INITIAL_ZOOM}
            style={{ width: '100%', height: '100%' }}
            zoomControl={false}
            zoomSnap={0.5}
          >
            <FitBounds />
            <ZoomControls />
            <CreatePane name="stations" zIndex={450} />
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://carto.com/">CARTO</a>'
              maxZoom={20}
            />

            <MapLayers
              visibleEdges={visibleEdges}
              visibleStations={visibleStations}
              selected={selected}
              setSelected={setSelected}
              activeLines={activeLines}
              alertsByRoute={alerts.byRoute}
              trainCounts={trains.counts}
              stopVolume={trains.stopVolume}
              stationRidership={stationRidership}
              maxRidership={maxRidership}
              showRidership={showRidership}
              showLabels={showLabels}
              stationCrime={stationCrime}
              maxCrime={maxCrime}
              showCrime={showCrime}
              shapes={shapes}
            />
            <VehicleLayer
              vehicles={vehicles}
              showVehicles={showVehicles}
              activeLines={activeLines}
            />
          </MapContainer>

          {/* Alert legend */}
          <div style={isMobile ? {
            position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 2000,
            display: mobilePanel === 'alerts' ? 'block' : 'none',
            background: 'rgba(13,18,40,0.98)', borderTop: '2px solid #374151',
            padding: '11px 13px', maxHeight: '60vh', overflowY: 'auto',
          } : {
            position: 'absolute', top: 16, right: 16, zIndex: 1000,
            background: 'rgba(15, 20, 40, 0.93)', borderRadius: 8,
            border: '1px solid #374151', padding: '11px 13px',
            backdropFilter: 'blur(6px)', minWidth: 216,
            maxHeight: 'calc(100vh - 100px)', overflowY: 'auto',
          }}>
            <div style={{ fontSize: 12, fontWeight: 'bold', color: '#e5e7eb', marginBottom: 8, letterSpacing: 1 }}>
              ALERTS
            </div>

            {[
              { sev: 1, color: SEVERITY_COLOR[1], label: 'Minor Delay',       desc: 'Reduced service or minor delays',  effect: 'REDUCED_SERVICE' },
              { sev: 2, color: SEVERITY_COLOR[2], label: 'Significant Delay', desc: 'Major delays, detours in effect',  effect: 'SIGNIFICANT_DELAYS / DETOUR' },
              { sev: 3, color: SEVERITY_COLOR[3], label: 'Suspension',        desc: 'No service or full suspension',    effect: 'NO_SERVICE / SUSPENSION' },
            ].map(({ sev, color, label, desc, effect }) => (
              <div
                key={sev}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', marginBottom: 6,
                  padding: '7px 8px', borderRadius: 6,
                  background: 'rgba(255,255,255,0.03)',
                  border: `1px solid ${color}55`,
                }}
              >
                <svg width={30} height={8} style={{ flexShrink: 0 }}>
                  <line x1={0} y1={4} x2={30} y2={4}
                    stroke={color} strokeWidth={2} strokeDasharray="5 4" />
                </svg>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 'bold', color, marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 8, color: '#9ca3af', marginBottom: 1 }}>{desc}</div>
                  <div style={{ fontSize: 7, color: '#4b5563' }}>{effect}</div>
                </div>
              </div>
            ))}

            <div style={{ borderTop: '1px solid #374151', marginTop: 5, paddingTop: 8 }}>
              <div style={{ fontSize: 8, fontWeight: 'bold', color: '#e5e7eb', marginBottom: 6 }}>MAP INDICATORS</div>
              {[
                { icon: '━━', color: '#6b7280',        label: 'Line weight',  desc: 'Thicker = more active trains' },
                { icon: '◉',  color: SEVERITY_COLOR[1], label: 'Station ring', desc: 'Colored ring = alert on that line' },
                { icon: '🚇', color: '#6ee7b7',        label: 'Arrivals',     desc: 'Trains arriving within 10 min (hover)' },
              ].map(({ icon, color, label, desc }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, padding: '4px 0' }}>
                  <span style={{ fontSize: 12, color, width: 20, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
                  <div>
                    <div style={{ fontSize: 8, color: '#d1d5db', fontWeight: 'bold', marginBottom: 1 }}>{label}</div>
                    <div style={{ fontSize: 7, color: '#9ca3af' }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Legend overlay + control panel */}
          <div style={isMobile ? {
            position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 2000,
            display: (mobilePanel === 'lines' || mobilePanel === 'controls') ? 'flex' : 'none',
            flexDirection: 'column', background: 'rgba(13,18,40,0.98)',
            borderTop: '2px solid #0f3460', maxHeight: '60vh', overflowY: 'auto',
          } : { position: 'absolute', top: 16, left: 16, zIndex: 1000, display: 'flex', gap: 12, alignItems: 'flex-start' }}>

          {/* Lines legend */}
          <div style={{
            background: 'rgba(15, 20, 40, 0.93)', borderRadius: isMobile ? 0 : 6,
            border: isMobile ? 'none' : '1px solid #0f3460', padding: '8px 9px',
            backdropFilter: 'blur(6px)',
            maxHeight: isMobile ? 'none' : 'calc(100vh - 100px)', overflowY: 'auto',
            display: isMobile && mobilePanel !== 'lines' ? 'none' : 'block',
            flex: isMobile ? 1 : 'unset',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3, gap: 5 }}>
              <div style={{ fontSize: 12, color: '#aaa', letterSpacing: 1, textTransform: 'uppercase', fontWeight: 'bold' }}>Lines</div>
              <button onClick={toggleAll} style={{
                padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
                fontSize: 7, fontWeight: 'bold', border: 'none',
                background: allOn ? '#4a5568' : '#22aa55', color: '#fff',
              }}>
                {allOn ? 'All Off' : 'All On'}
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#8899bb', marginBottom: 6, fontStyle: 'italic' }}>
              {isMobile ? 'Long-press line for schedule' : 'Right-click line for schedule'}
            </div>

            {Object.entries(LINES).map(([id, line]) => {
              const active = activeLines.has(id);
              return (
                <button key={id}
                  onClick={() => { if (!longPressFiredRef.current) toggleLine(id); }}
                  onContextMenu={e => { e.preventDefault(); setContextMenu({ lineId: id, x: e.clientX, y: e.clientY }); }}
                  onTouchStart={() => {
                    longPressFiredRef.current = false;
                    longPressRef.current = setTimeout(() => {
                      longPressFiredRef.current = true;
                      setContextMenu({ lineId: id, x: window.innerWidth / 2 - 54, y: window.innerHeight / 2 - 40 });
                      setMobilePanel(null);
                    }, 600);
                  }}
                  onTouchEnd={() => clearTimeout(longPressRef.current)}
                  onTouchMove={() => clearTimeout(longPressRef.current)}
                  title="Right-click for schedule"
                  style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  width: '100%', marginBottom: 5, padding: '5px 7px',
                  borderRadius: 5, cursor: 'pointer',
                  background: active ? 'rgba(255,255,255,0.07)' : 'transparent',
                  border: `1px solid ${active ? line.color : '#333'}`,
                  opacity: active ? 1 : 0.4, transition: 'all 0.15s',
                }}>
                  <span style={{
                    width: 29, height: 29, borderRadius: '50%', flexShrink: 0,
                    background: active ? line.color : '#333',
                    color: line.color === '#FCCC0A' ? '#000' : '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 'bold', fontSize: 13,
                  }}>{id}</span>
                  <span style={{ fontSize: 11, color: active ? '#ddd' : '#555', textAlign: 'left' }}>{line.name}</span>
                </button>
              );
            })}
          </div>

          {/* Control panel */}
          <div style={{
            background: 'rgba(15, 20, 40, 0.93)', borderRadius: isMobile ? 0 : 6,
            border: isMobile ? 'none' : '1px solid #0f3460', padding: '8px 9px',
            backdropFilter: 'blur(6px)',
            display: isMobile && mobilePanel !== 'controls' ? 'none' : 'flex',
            flexDirection: 'column', gap: 5,
            maxHeight: isMobile ? 'none' : 'calc(100vh - 100px)', overflowY: 'auto',
            flex: isMobile ? 1 : 'unset',
          }}>
            <div style={{ fontSize: 12, color: '#aaa', letterSpacing: 1, textTransform: 'uppercase', fontWeight: 'bold', marginBottom: 2 }}>Controls</div>

            {/* Overlay toggles */}
            {[
              { label: 'Live Trains',    icon: '🚇', active: showVehicles,  toggle: () => setShowVehicles(v => !v),  color: '#22c55e' },
              { label: 'Rider Volumes',  icon: '👥', active: showRidership, toggle: () => setShowRidership(v => !v), color: '#00aaff' },
              { label: 'Crime Heatmap',  icon: '🚨', active: showCrime,     toggle: () => setShowCrime(v => !v),     color: '#ef4444' },
              { label: 'Station Labels', icon: '🏷', active: showLabels,    toggle: () => setShowLabels(v => !v),    color: '#a78bfa' },
            ].map(({ label, icon, active, toggle, color }) => (
              <button key={label} onClick={toggle} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '6px 8px', borderRadius: 5,
                cursor: 'pointer', border: `1px solid ${active ? color : '#6b7280'}`,
                background: active ? `${color}22` : 'rgba(255,255,255,0.06)',
                transition: 'all 0.15s',
              }}>
                <span style={{ fontSize: 13, flexShrink: 0 }}>{icon}</span>
                <span style={{ fontSize: 11, color: active ? '#ddd' : '#9ca3af', textAlign: 'left', flex: 1 }}>{label}</span>
                <span style={{
                  width: 15, height: 9, borderRadius: 4, flexShrink: 0,
                  background: active ? color : '#4b5563',
                  display: 'flex', alignItems: 'center', padding: '0 1px',
                  transition: 'background 0.2s',
                }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%', background: '#fff',
                    transform: active ? 'translateX(7px)' : 'translateX(0)',
                    transition: 'transform 0.2s', display: 'block',
                  }} />
                </span>
              </button>
            ))}

            {/* Alert type toggles */}
            <div style={{ fontSize: 9, color: '#aaa', letterSpacing: 1, textTransform: 'uppercase', fontWeight: 'bold', marginTop: 3, marginBottom: 0 }}>Alert Filter</div>
            {[
              { sev: 1, color: SEVERITY_COLOR[1], label: 'Minor Delay',       icon: '⚠' },
              { sev: 2, color: SEVERITY_COLOR[2], label: 'Major Delay',        icon: '🔴' },
              { sev: 3, color: SEVERITY_COLOR[3], label: 'Suspension',         icon: '🛑' },
            ].map(({ sev, color, label, icon }) => {
              const active = severityFilter.has(sev);
              return (
                <button key={sev} onClick={() => toggleSeverity(sev)} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', padding: '6px 8px', borderRadius: 5,
                  cursor: 'pointer', border: `1px solid ${active ? color : '#6b7280'}`,
                  background: active ? `${color}22` : 'rgba(255,255,255,0.06)',
                  transition: 'all 0.15s',
                  boxShadow: active ? `0 0 3px ${color}44` : 'none',
                }}>
                  <span style={{ fontSize: 13, flexShrink: 0 }}>{icon}</span>
                  <span style={{ fontSize: 11, color: active ? color : '#9ca3af', textAlign: 'left', flex: 1 }}>{label}</span>
                  <span style={{
                    width: 15, height: 9, borderRadius: 4, flexShrink: 0,
                    background: active ? color : '#4b5563',
                    display: 'flex', alignItems: 'center', padding: '0 1px',
                    transition: 'background 0.2s',
                  }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%', background: '#fff',
                      transform: active ? 'translateX(7px)' : 'translateX(0)',
                      transition: 'transform 0.2s', display: 'block',
                    }} />
                  </span>
                </button>
              );
            })}
          </div>

          </div>{/* end flex row wrapper */}
        </div>

        {/* Station info panel */}
        {selectedStation && (
          <div style={isMobile ? {
            position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 1800,
            background: '#16213e', borderTop: '2px solid #0f3460',
            padding: 13, overflowY: 'auto', color: '#eee', maxHeight: '55vh',
          } : {
            width: 187, background: '#16213e', borderLeft: '1px solid #0f3460',
            padding: 13, overflowY: 'auto', color: '#eee',
          }}>
            <div style={{ fontSize: 10, fontWeight: 'bold', color: '#aaa', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Station Info</div>
            <button onClick={() => setSelected(null)} style={{
              marginBottom: 8, padding: '2px 8px', borderRadius: 3,
              background: '#0f3460', color: '#eee', border: '1px solid #e94560',
              cursor: 'pointer', fontSize: 10,
            }}>✕ Close</button>
            <h3 style={{ margin: '0 0 6px', color: '#e94560', fontSize: 13 }}>{selectedStation.name}</h3>
            <div style={{ fontSize: 8, color: '#aaa', marginBottom: 6 }}>Lines:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
              {selectedStation.lines.map(lineId => (
                <div key={lineId} style={{
                  width: 24, height: 24, borderRadius: '50%',
                  background: LINES[lineId]?.color || '#888',
                  color: LINES[lineId]?.color === '#FCCC0A' ? '#000' : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 'bold', fontSize: 11,
                }}>{lineId}</div>
              ))}
            </div>

            {/* Supplemental stats */}
            {(() => {
              const riders   = stationRidership[selectedStation.id] || 0;
              const crimes   = stationCrime[selectedStation.id] || 0;
              const arrivals = trains.stopVolume?.[selectedStation.id] || 0;
              const stationAlerts = selectedStation.lines
                .map(l => alerts.byRoute[l] ? { line: l, ...alerts.byRoute[l] } : null)
                .filter(Boolean)
                .sort((a, b) => b.severity - a.severity);

              const statRow = (icon, label, value, color, sub) => (
                <div key={label} style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '6px 7px', marginBottom: 5, borderRadius: 5,
                  background: 'rgba(255,255,255,0.04)', border: '1px solid #1e3a5f',
                }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
                  <div>
                    <div style={{ fontSize: 8, color: '#9ca3af', marginBottom: 1 }}>{label}</div>
                    <div style={{ fontSize: 11, fontWeight: 'bold', color }}>{value}</div>
                    {sub && <div style={{ fontSize: 7, color: '#6b7280', marginTop: 1 }}>{sub}</div>}
                  </div>
                </div>
              );

              return (
                <div style={{ marginBottom: 11 }}>
                  <div style={{ fontSize: 8, color: '#aaa', marginBottom: 6, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 'bold' }}>Live Data</div>

                  {statRow('🚇', 'Trains Arriving', arrivals > 0 ? `${arrivals} in next 10 min` : 'None scheduled', arrivals > 0 ? '#6ee7b7' : '#4b5563')}
                  {statRow('👥', 'Rider Volume', riders > 0 ? `${riders.toLocaleString()} / hr` : 'No data', '#93c5fd', riders > 0 ? `${Math.round(riders / maxRidership * 100)}% of peak station` : null)}
                  {statRow('🚨', 'Crime (YTD)', crimes > 0 ? `${crimes} incidents` : 'No data', crimes > 200 ? '#f87171' : crimes > 50 ? '#fb923c' : '#86efac', crimes > 0 ? `${Math.round(crimes / maxCrime * 100)}% of highest station` : null)}

                  {stationAlerts.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      {stationAlerts.map(({ line, severity, effect }) => (
                        <div key={line} style={{
                          display: 'flex', alignItems: 'center', gap: 7,
                          padding: '6px 7px', marginBottom: 5, borderRadius: 5,
                          background: `${SEVERITY_COLOR[severity]}18`,
                          border: `1px solid ${SEVERITY_COLOR[severity]}88`,
                        }}>
                          <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                          <div>
                            <div style={{ fontSize: 8, color: '#9ca3af', marginBottom: 1 }}>
                              Alert — Line {line}
                            </div>
                            <div style={{ fontSize: 11, fontWeight: 'bold', color: SEVERITY_COLOR[severity] }}>
                              {effect.replace(/_/g, ' ')}
                            </div>
                            <div style={{ fontSize: 7, color: '#6b7280', marginTop: 1 }}>
                              {severity === 1 ? 'Minor' : severity === 2 ? 'Significant' : 'Severe'}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {stationAlerts.length === 0 && statRow('✅', 'Service Status', 'No alerts', '#4ade80')}
                </div>
              );
            })()}

            <div style={{ fontSize: 8, color: '#ccc', marginBottom: 5 }}>Connected stations:</div>
            {EDGES
              .filter(e => (e.from === selected || e.to === selected) && activeLines.has(e.line))
              .map((e, i) => {
                const otherId = e.from === selected ? e.to : e.from;
                const other   = STATION_MAP[otherId];
                return other ? (
                  <div key={i} onClick={() => setSelected(otherId)} style={{
                    padding: '4px 6px', marginBottom: 2, borderRadius: 4,
                    background: '#0f3460', cursor: 'pointer', fontSize: 8,
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                    <span style={{
                      width: 13, height: 13, borderRadius: '50%', flexShrink: 0,
                      background: LINES[e.line]?.color, display: 'inline-flex',
                      alignItems: 'center', justifyContent: 'center',
                      fontSize: 7, fontWeight: 'bold',
                      color: LINES[e.line]?.color === '#FCCC0A' ? '#000' : '#fff',
                    }}>{e.line}</span>
                    {other.name}
                  </div>
                ) : null;
              })}
          </div>
        )}
      </div>

      {!isMobile && (
        <div style={{ padding: '4px 16px', background: '#16213e', fontSize: 11, borderTop: '1px solid #0f3460', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#8899bb', fontStyle: 'italic' }}>Scroll to zoom · Click + drag to pan</span>
          <span style={{ color: '#8899bb', fontStyle: 'italic' }}>Click station for Station Info</span>
        </div>
      )}

      {/* Mobile bottom tab bar */}
      {isMobile && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 3000,
          display: 'flex', background: '#0d1226', borderTop: '2px solid #0f3460', height: 56,
        }}>
          {[
            { id: 'lines',    icon: '🚇', label: 'Lines'    },
            { id: 'controls', icon: '⚙️',  label: 'Controls' },
            { id: 'alerts',   icon: '⚠️',  label: 'Alerts'   },
          ].map(({ id, icon, label }) => {
            const active = mobilePanel === id;
            return (
              <button key={id}
                onClick={() => { setMobilePanel(prev => prev === id ? null : id); setSelected(null); }}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', gap: 2, background: 'none', border: 'none',
                  cursor: 'pointer', color: active ? '#93c5fd' : '#6b7280',
                  borderTop: active ? '2px solid #93c5fd' : '2px solid transparent',
                  fontSize: 11, fontWeight: active ? 'bold' : 'normal', transition: 'all 0.15s',
                }}>
                <span style={{ fontSize: 20 }}>{icon}</span>
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div style={{
          position: 'fixed',
          left: isMobile ? '50%' : contextMenu.x,
          top: isMobile ? '50%' : contextMenu.y,
          transform: isMobile ? 'translate(-50%, -50%)' : 'none',
          zIndex: 9500,
          background: 'rgba(13,18,38,0.97)', border: '1px solid #0f3460',
          borderRadius: 5, padding: '3px 0', minWidth: 107,
          boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
        }} onClick={e => e.stopPropagation()}>
          <div style={{ padding: '5px 11px', fontSize: 12, color: '#4b5563', letterSpacing: 1, textTransform: 'uppercase' }}>
            Line {contextMenu.lineId}
          </div>
          <div onClick={() => { openSchedule(contextMenu.lineId); setContextMenu(null); }} style={{
            padding: '9px 15px', cursor: 'pointer', fontSize: 17, color: '#eee',
            display: 'flex', alignItems: 'center', gap: 9,
            borderTop: '1px solid #1e3a5f',
          }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            📅 Schedule
          </div>
        </div>
      )}

      {/* Schedule dialogs */}
      {schedules.map(schedule => (
        <ScheduleDialog
          key={schedule.lineId}
          schedule={schedule}
          isMobile={isMobile}
          onClose={() => setSchedules(prev => prev.filter(s => s.lineId !== schedule.lineId))}
          onMove={pos => setSchedules(prev => prev.map(s => s.lineId === schedule.lineId ? { ...s, pos } : s))}
          onResize={({ pos, size }) => setSchedules(prev => prev.map(s => s.lineId === schedule.lineId ? { ...s, pos, size } : s))}
        />
      ))}
    </div>
  );
}
