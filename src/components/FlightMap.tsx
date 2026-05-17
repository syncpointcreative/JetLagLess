import React, { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';
import worldData from '../data/world.json';
import { Airport } from '../lib/airports';

type LngLat = [number, number];
type Ring = LngLat[];
type Polygon = Ring[];

const world = worldData as Polygon[];

export interface MapLeg {
  origin: Airport;
  destination: Airport;
  /** Fractional [start, end] of this leg that's sleep (e.g. [0.3, 0.7]) */
  sleepWindow?: [number, number] | null;
}

export interface FlightMapProps {
  legs: MapLeg[];
}

const C = {
  bg: '#fbf7ee',
  land: '#e8dec6',
  landStroke: '#c9bd9d',
  arc: '#15233f',
  sleep: '#b97a4a',
  airport: '#15233f',
  airportRing: '#fbf7ee',
  label: '#15233f',
};

const PADDING_DEG = 12;

function normalizeLon(lon: number, centralLon: number): number {
  let diff = lon - centralLon;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return centralLon + diff;
}

function sphericalCentroid(points: LngLat[]): [number, number] {
  let x = 0, y = 0, z = 0;
  for (const [lon, lat] of points) {
    const phi = (lat * Math.PI) / 180;
    const lam = (lon * Math.PI) / 180;
    x += Math.cos(phi) * Math.cos(lam);
    y += Math.cos(phi) * Math.sin(lam);
    z += Math.sin(phi);
  }
  const lonRad = Math.atan2(y, x);
  const latRad = Math.atan2(z, Math.sqrt(x * x + y * y));
  return [(lonRad * 180) / Math.PI, (latRad * 180) / Math.PI];
}

function projection(
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number },
  w: number,
  h: number,
) {
  const lonSpan = bounds.maxLon - bounds.minLon;
  const latSpan = bounds.maxLat - bounds.minLat;
  const midLat = (bounds.maxLat + bounds.minLat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180) || 1;
  const kx = w / lonSpan;
  const ky = h / (latSpan / cosLat);
  const k = Math.min(kx, ky);
  const projectedLonSpan = lonSpan * k;
  const projectedLatSpan = (latSpan / cosLat) * k;
  const offsetX = (w - projectedLonSpan) / 2;
  const offsetY = (h - projectedLatSpan) / 2;
  return (lon: number, lat: number): [number, number] => [
    offsetX + (lon - bounds.minLon) * k,
    offsetY + ((bounds.maxLat - lat) / cosLat) * k,
  ];
}

function slerp(p1: LngLat, p2: LngLat, t: number): LngLat {
  const lon1 = (p1[0] * Math.PI) / 180;
  const lat1 = (p1[1] * Math.PI) / 180;
  const lon2 = (p2[0] * Math.PI) / 180;
  const lat2 = (p2[1] * Math.PI) / 180;
  const x1 = Math.cos(lat1) * Math.cos(lon1);
  const y1 = Math.cos(lat1) * Math.sin(lon1);
  const z1 = Math.sin(lat1);
  const x2 = Math.cos(lat2) * Math.cos(lon2);
  const y2 = Math.cos(lat2) * Math.sin(lon2);
  const z2 = Math.sin(lat2);
  const dot = Math.min(1, Math.max(-1, x1 * x2 + y1 * y2 + z1 * z2));
  const omega = Math.acos(dot);
  if (omega < 1e-9) return p1;
  const a = Math.sin((1 - t) * omega) / Math.sin(omega);
  const b = Math.sin(t * omega) / Math.sin(omega);
  const x = a * x1 + b * x2;
  const y = a * y1 + b * y2;
  const z = a * z1 + b * z2;
  const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
  const lon = Math.atan2(y, x);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

function greatCirclePoints(p1: LngLat, p2: LngLat, steps = 80): LngLat[] {
  const points: LngLat[] = [];
  for (let i = 0; i <= steps; i++) points.push(slerp(p1, p2, i / steps));
  return points;
}

function splitAtAntimeridian(points: LngLat[]): LngLat[][] {
  const segs: LngLat[][] = [[]];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    if (i === 0) {
      segs[segs.length - 1].push(cur);
      continue;
    }
    const prev = points[i - 1];
    if (Math.abs(cur[0] - prev[0]) > 180) {
      segs.push([cur]);
    } else {
      segs[segs.length - 1].push(cur);
    }
  }
  return segs;
}

function pathFromPoints(points: [number, number][]): string {
  if (points.length === 0) return '';
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L${points[i][0].toFixed(1)},${points[i][1].toFixed(1)}`;
  }
  return d;
}

const W = 680;
const H = 380;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 10;

interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

const fitView: ViewState = { x: 0, y: 0, zoom: 1 };

function clampZoom(z: number) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

function zoomAt(s: ViewState, px: number, py: number, factor: number): ViewState {
  const newZoom = clampZoom(s.zoom * factor);
  const worldX = s.x + px / s.zoom;
  const worldY = s.y + py / s.zoom;
  return {
    x: worldX - px / newZoom,
    y: worldY - py / newZoom,
    zoom: newZoom,
  };
}

export function FlightMap({ legs }: FlightMapProps) {
  const [view, setView] = useState<ViewState>(fitView);
  const [selected, setSelected] = useState<Airport | null>(null);
  const containerRef = useRef<View | null>(null);

  // ----- geometry (memoized) -----
  const geom = useMemo(() => buildGeometry(legs), [legs]);

  if (legs.length === 0 || !geom) return null;

  const viewBox = `${view.x} ${view.y} ${W / view.zoom} ${H / view.zoom}`;

  const resetView = () => {
    setView(fitView);
    setSelected(null);
  };

  // Web pointer handlers — built via raw DOM events on a wrapper div.
  const webHandlers = Platform.OS === 'web' ? buildWebHandlers({ view, setView }) : {};

  // Project a screen-space point to popup coords.
  const popupPos = (() => {
    if (!selected) return null;
    const [sx, sy] = geom.project(geom.shift([selected.lon, selected.lat]));
    // viewBox space → percent of container
    const left = ((sx - view.x) / (W / view.zoom)) * 100;
    const top = ((sy - view.y) / (H / view.zoom)) * 100;
    return { left, top };
  })();

  return (
    <View style={styles.wrapper}>
      {React.createElement(
        Platform.OS === 'web' ? 'div' : View as any,
        {
          ref: containerRef as any,
          style:
            Platform.OS === 'web'
              ? ({
                  position: 'relative',
                  touchAction: 'none',
                  cursor: 'grab',
                  userSelect: 'none',
                } as any)
              : { position: 'relative' },
          ...webHandlers,
        },
        <>
          <Svg
            viewBox={viewBox}
            width="100%"
            height={H}
            preserveAspectRatio="xMidYMid meet"
          >
            <Path d={`M0,0 H${W} V${H} H0 Z`} fill={C.bg} />

            <G>
              {geom.landPaths.map((d, i) => (
                <Path key={i} d={d} fill={C.land} stroke={C.landStroke} strokeWidth={0.5} />
              ))}
            </G>

            <G>
              {geom.projectedArcs.map((arc, i) =>
                arc.segs.map((seg, j) => (
                  <Path
                    key={`arc-${i}-${j}`}
                    d={pathFromPoints(seg)}
                    fill="none"
                    stroke={C.arc}
                    strokeWidth={1.5 / Math.sqrt(view.zoom)}
                    strokeLinecap="round"
                    strokeDasharray="2 3"
                    opacity={0.7}
                  />
                )),
              )}
            </G>

            <G>
              {geom.sleepSegments.map((seg, i) => (
                <Path
                  key={`sleep-${i}`}
                  d={pathFromPoints(seg)}
                  fill="none"
                  stroke={C.sleep}
                  strokeWidth={3.5 / Math.sqrt(view.zoom)}
                  strokeLinecap="round"
                  opacity={0.95}
                />
              ))}
            </G>

            <G>
              {Array.from(geom.airports.values()).map((a) => {
                const [x, y] = geom.project(geom.shift([a.lon, a.lat]));
                const r = 5 / Math.sqrt(view.zoom);
                const isSelected = selected?.iata === a.iata;
                return (
                  <G
                    key={a.iata}
                    onPress={() => setSelected(isSelected ? null : a)}
                    {...(Platform.OS === 'web'
                      ? {
                          onClick: (e: any) => {
                            e.stopPropagation();
                            setSelected(isSelected ? null : a);
                          },
                        }
                      : {})}
                  >
                    <Circle
                      cx={x}
                      cy={y}
                      r={r + 6 / view.zoom}
                      fill="transparent"
                    />
                    <Circle cx={x} cy={y} r={r} fill={C.airportRing} />
                    <Circle
                      cx={x}
                      cy={y}
                      r={r * 0.6}
                      fill={isSelected ? C.sleep : C.airport}
                    />
                    <SvgText
                      x={x + 8 / Math.sqrt(view.zoom)}
                      y={y + 4 / Math.sqrt(view.zoom)}
                      fontSize={11 / Math.sqrt(view.zoom)}
                      fontWeight="700"
                      fill={C.label}
                      fontFamily="Inter, sans-serif"
                    >
                      {a.iata}
                    </SvgText>
                  </G>
                );
              })}
            </G>
          </Svg>

          {selected && popupPos && (
            <View
              style={[
                styles.popup,
                {
                  left: `${popupPos.left}%` as any,
                  top: `${popupPos.top}%` as any,
                },
              ]}
              pointerEvents="box-none"
            >
              <View style={styles.popupArrow} />
              <View style={styles.popupBody}>
                <Text style={styles.popupTitle}>
                  <Text style={styles.popupIata}>{selected.iata}</Text>  {selected.city}
                </Text>
                <Text style={styles.popupSub}>{selected.name}</Text>
                <Text style={styles.popupMeta}>{selected.country} · {selected.tz}</Text>
              </View>
            </View>
          )}

          <View style={styles.controls} pointerEvents="box-none">
            <Pressable
              onPress={() => setView((v) => zoomAt(v, W / 2, H / 2, 1.3))}
              style={({ pressed }) => [styles.ctrl, pressed && styles.ctrlPressed]}
            >
              <Text style={styles.ctrlText}>+</Text>
            </Pressable>
            <Pressable
              onPress={() => setView((v) => zoomAt(v, W / 2, H / 2, 1 / 1.3))}
              style={({ pressed }) => [styles.ctrl, pressed && styles.ctrlPressed]}
            >
              <Text style={styles.ctrlText}>−</Text>
            </Pressable>
            <Pressable
              onPress={resetView}
              style={({ pressed }) => [styles.ctrl, styles.ctrlWide, pressed && styles.ctrlPressed]}
            >
              <Text style={styles.ctrlTextSmall}>Reset</Text>
            </Pressable>
          </View>
        </>,
      )}

      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDash, { borderColor: C.arc, opacity: 0.7 }]} />
          <Text style={styles.legendLabel}>Flight path</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendBar, { backgroundColor: C.sleep }]} />
          <Text style={styles.legendLabel}>Suggested sleep window</Text>
        </View>
        <View style={styles.legendItem}>
          <Text style={styles.legendHint}>Drag · scroll/pinch to zoom · tap an airport</Text>
        </View>
      </View>
    </View>
  );
}

// --- geometry helpers ---

function buildGeometry(legs: MapLeg[]) {
  if (legs.length === 0) return null;
  const arcs = legs.map((leg) => ({
    leg,
    pts: greatCirclePoints(
      [leg.origin.lon, leg.origin.lat],
      [leg.destination.lon, leg.destination.lat],
    ),
  }));

  const arcMidpoints: LngLat[] = arcs.map((a) => a.pts[Math.floor(a.pts.length / 2)]);
  const [centralLon] = sphericalCentroid(arcMidpoints);
  const shift = (p: LngLat): LngLat => [normalizeLon(p[0], centralLon), p[1]];

  const shiftedArcs = arcs.map((a) => ({
    leg: a.leg,
    pts: a.pts.map(shift),
  }));

  const allLngLat: LngLat[] = [
    ...shiftedArcs.flatMap((a) => a.pts),
    ...legs.flatMap((l) => [
      shift([l.origin.lon, l.origin.lat]),
      shift([l.destination.lon, l.destination.lat]),
    ]),
  ];
  const lons = allLngLat.map((p) => p[0]);
  const lats = allLngLat.map((p) => p[1]);
  const bounds = {
    minLon: Math.min(...lons) - PADDING_DEG,
    maxLon: Math.max(...lons) + PADDING_DEG,
    minLat: Math.max(-85, Math.min(...lats) - PADDING_DEG),
    maxLat: Math.min(85, Math.max(...lats) + PADDING_DEG),
  };
  const project = projection(bounds, W, H);

  const landPaths: string[] = [];
  for (const poly of world) {
    for (const ring of poly) {
      const shifted = ring.map(([lon, lat]) => shift([lon, lat]));
      let any = false;
      for (const [lon, lat] of shifted) {
        if (lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat) {
          any = true;
          break;
        }
      }
      if (!any) continue;
      const segs = splitAtAntimeridian(shifted);
      for (const seg of segs) {
        if (seg.length < 2) continue;
        const projected = seg.map(([lon, lat]) => project(lon, lat));
        landPaths.push(pathFromPoints(projected) + ' Z');
      }
    }
  }

  const projectedArcs = shiftedArcs.map((a) => ({
    leg: a.leg,
    pts: a.pts,
    segs: splitAtAntimeridian(a.pts).map((seg) => seg.map(([lon, lat]) => project(lon, lat))),
  }));

  const sleepSegments = shiftedArcs.flatMap((a) => {
    const win = a.leg.sleepWindow;
    if (!win) return [];
    const [t0, t1] = win;
    if (t1 <= t0) return [];
    const total = a.pts.length - 1;
    const i0 = Math.max(0, Math.floor(t0 * total));
    const i1 = Math.min(total, Math.ceil(t1 * total));
    const seg = a.pts.slice(i0, i1 + 1);
    return splitAtAntimeridian(seg).map((s) => s.map(([lon, lat]) => project(lon, lat)));
  });

  const airports = new Map<string, Airport>();
  for (const leg of legs) {
    airports.set(leg.origin.iata, leg.origin);
    airports.set(leg.destination.iata, leg.destination);
  }

  return { project, shift, landPaths, projectedArcs, sleepSegments, airports };
}

// --- web pointer / wheel / touch handlers ---

function buildWebHandlers({
  view,
  setView,
}: {
  view: ViewState;
  setView: React.Dispatch<React.SetStateAction<ViewState>>;
}) {
  // We must use refs for in-flight gesture state, but since this function is
  // re-invoked on every render with fresh state, store on the closure.
  const drag = { active: false, lastX: 0, lastY: 0 };
  const pinch: { active: boolean; startDist: number; startZoom: number; midX: number; midY: number } = {
    active: false,
    startDist: 0,
    startZoom: 1,
    midX: 0,
    midY: 0,
  };

  const screenToViewBox = (e: any) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX ?? 0) - rect.left) * (W / rect.width);
    const py = ((e.clientY ?? 0) - rect.top) * (H / rect.height);
    return { rect, px, py };
  };

  return {
    onWheel: (e: any) => {
      e.preventDefault();
      const { px, py } = screenToViewBox(e);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setView((v) => zoomAt(v, px, py, factor));
    },
    onMouseDown: (e: any) => {
      drag.active = true;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      e.currentTarget.style.cursor = 'grabbing';
    },
    onMouseMove: (e: any) => {
      if (!drag.active) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const dx = (e.clientX - drag.lastX) * (W / rect.width);
      const dy = (e.clientY - drag.lastY) * (H / rect.height);
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      setView((v) => ({ ...v, x: v.x - dx / v.zoom, y: v.y - dy / v.zoom }));
    },
    onMouseUp: (e: any) => {
      drag.active = false;
      e.currentTarget.style.cursor = 'grab';
    },
    onMouseLeave: (e: any) => {
      drag.active = false;
      e.currentTarget.style.cursor = 'grab';
    },
    onTouchStart: (e: any) => {
      if (e.touches.length === 1) {
        drag.active = true;
        drag.lastX = e.touches[0].clientX;
        drag.lastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        drag.active = false;
        pinch.active = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinch.startDist = Math.hypot(dx, dy);
        pinch.startZoom = view.zoom;
        const rect = e.currentTarget.getBoundingClientRect();
        pinch.midX =
          ((e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left) *
          (W / rect.width);
        pinch.midY =
          ((e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top) *
          (H / rect.height);
      }
    },
    onTouchMove: (e: any) => {
      e.preventDefault();
      if (pinch.active && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const factor = dist / pinch.startDist;
        setView((v) => zoomAt({ ...v, zoom: pinch.startZoom }, pinch.midX, pinch.midY, factor));
      } else if (drag.active && e.touches.length === 1) {
        const rect = e.currentTarget.getBoundingClientRect();
        const dxp = (e.touches[0].clientX - drag.lastX) * (W / rect.width);
        const dyp = (e.touches[0].clientY - drag.lastY) * (H / rect.height);
        drag.lastX = e.touches[0].clientX;
        drag.lastY = e.touches[0].clientY;
        setView((v) => ({ ...v, x: v.x - dxp / v.zoom, y: v.y - dyp / v.zoom }));
      }
    },
    onTouchEnd: () => {
      drag.active = false;
      pinch.active = false;
    },
  };
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: C.bg,
    borderRadius: 10,
    overflow: 'hidden',
    borderColor: '#d8cfb9',
    borderWidth: 1,
    marginBottom: 14,
  },
  controls: {
    position: 'absolute',
    right: 10,
    top: 10,
    flexDirection: 'column',
    gap: 6,
  },
  ctrl: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#fbf7ee',
    borderColor: '#c9bd9d',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlWide: { width: 'auto', paddingHorizontal: 10, borderRadius: 16 },
  ctrlPressed: { backgroundColor: '#ede4cf' },
  ctrlText: { fontSize: 18, color: '#15233f', fontWeight: '700', lineHeight: 20 },
  ctrlTextSmall: { fontSize: 11, color: '#15233f', fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  popup: {
    position: 'absolute',
    transform: [{ translateX: -130 }, { translateY: -120 }],
    width: 260,
    alignItems: 'center',
  },
  popupArrow: {
    position: 'absolute',
    bottom: -6,
    left: '50%',
    marginLeft: -6,
    width: 12,
    height: 12,
    backgroundColor: '#fbf7ee',
    transform: [{ rotate: '45deg' }],
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#c9bd9d',
  },
  popupBody: {
    backgroundColor: '#fbf7ee',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderColor: '#c9bd9d',
    borderWidth: 1,
    minWidth: 200,
  },
  popupTitle: { fontFamily: 'Fraunces, Georgia, serif', fontSize: 16, fontWeight: '600', color: '#15233f' },
  popupIata: { color: '#b97a4a', fontWeight: '700' },
  popupSub: { fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#3e4a66', marginTop: 4 },
  popupMeta: { fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#7d8499', marginTop: 4, letterSpacing: 0.3 },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopColor: '#e6dec9',
    borderTopWidth: 1,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDash: {
    width: 22,
    height: 0,
    borderTopWidth: 1.5,
    borderStyle: 'dashed',
  },
  legendBar: { width: 22, height: 3.5, borderRadius: 2 },
  legendLabel: {
    fontFamily: 'Inter, sans-serif',
    fontSize: 11,
    color: '#3e4a66',
    letterSpacing: 0.3,
  },
  legendHint: {
    fontFamily: 'Inter, sans-serif',
    fontSize: 11,
    color: '#7d8499',
    fontStyle: 'italic',
    marginLeft: 'auto',
  },
});
