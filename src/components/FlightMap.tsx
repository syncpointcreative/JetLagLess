import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
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

// Editorial palette — must match the rest of the app.
const C = {
  bg: '#fbf7ee',
  land: '#e8dec6',
  landStroke: '#c9bd9d',
  graticule: '#e8dec6',
  arc: '#15233f',
  sleep: '#b97a4a',
  airport: '#15233f',
  airportRing: '#fbf7ee',
  label: '#15233f',
};

// Use a route-centered equirectangular projection: we pivot the map's
// central meridian to the great-circle midpoint of the route so transpacific
// flights don't wrap around the edges of the map.
const PADDING_DEG = 12;

/**
 * Normalize a longitude into the interval [centralLon - 180, centralLon + 180].
 * After normalization, the route sits contiguously around centralLon.
 */
function normalizeLon(lon: number, centralLon: number): number {
  let diff = lon - centralLon;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return centralLon + diff;
}

/** Spherical centroid of a set of (lon,lat) points; used as the map center. */
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

/** Spherical interpolation along the great circle from p1 to p2 at fraction t. */
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

/** Split projected coords at antimeridian crossings so the path doesn't wrap. */
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

export function FlightMap({ legs }: FlightMapProps) {
  if (legs.length === 0) return null;

  // Build all great-circle arcs.
  const arcs = legs.map((leg) => {
    const pts = greatCirclePoints(
      [leg.origin.lon, leg.origin.lat],
      [leg.destination.lon, leg.destination.lat],
    );
    return { leg, pts };
  });

  // Pivot the projection's central meridian to the great-circle midpoint of
  // the route. This keeps transpacific or transarctic flights centered
  // instead of wrapping around the edges of a Greenwich-centered map.
  const arcMidpoints: LngLat[] = arcs.map((a) => a.pts[Math.floor(a.pts.length / 2)]);
  const [centralLon] = sphericalCentroid(arcMidpoints);

  // Re-express every point relative to the chosen central meridian.
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

  const W = 680;
  const H = 380;
  const project = projection(bounds, W, H);

  // Build land paths: shift each ring to the centered coord system, split
  // at the new antimeridian for any ring that wraps, and project.
  const landPaths: string[] = [];
  for (const poly of world) {
    for (const ring of poly) {
      const shifted = ring.map(([lon, lat]) => shift([lon, lat]));
      // Quick reject if entirely outside bounds.
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

  // Project each arc (already in shifted coords).
  const projectedArcs = shiftedArcs.map((a) => ({
    leg: a.leg,
    pts: a.pts,
    segs: splitAtAntimeridian(a.pts).map((seg) =>
      seg.map(([lon, lat]) => project(lon, lat)),
    ),
  }));

  // Sleep segments per leg (slice the arc in fractional space before splitting).
  const sleepSegments = shiftedArcs.flatMap((a) => {
    const win = a.leg.sleepWindow;
    if (!win) return [];
    const [t0, t1] = win;
    if (t1 <= t0) return [];
    const total = a.pts.length - 1;
    const i0 = Math.max(0, Math.floor(t0 * total));
    const i1 = Math.min(total, Math.ceil(t1 * total));
    const seg = a.pts.slice(i0, i1 + 1);
    return splitAtAntimeridian(seg).map((s) =>
      s.map(([lon, lat]) => project(lon, lat)),
    );
  });

  // Airport markers (deduplicated).
  const airportSet = new Map<string, Airport>();
  for (const leg of legs) {
    airportSet.set(leg.origin.iata, leg.origin);
    airportSet.set(leg.destination.iata, leg.destination);
  }

  return (
    <View style={styles.wrapper}>
      <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet">
        {/* Background */}
        <Path d={`M0,0 H${W} V${H} H0 Z`} fill={C.bg} />

        {/* Land */}
        <G>
          {landPaths.map((d, i) => (
            <Path key={i} d={d} fill={C.land} stroke={C.landStroke} strokeWidth={0.5} />
          ))}
        </G>

        {/* Flight arcs (base color) */}
        <G>
          {projectedArcs.map((arc, i) =>
            arc.segs.map((seg, j) => (
              <Path
                key={`arc-${i}-${j}`}
                d={pathFromPoints(seg)}
                fill="none"
                stroke={C.arc}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeDasharray="2 3"
                opacity={0.7}
              />
            )),
          )}
        </G>

        {/* Sleep segments (highlighted) */}
        <G>
          {sleepSegments.map((seg, i) => (
            <Path
              key={`sleep-${i}`}
              d={pathFromPoints(seg)}
              fill="none"
              stroke={C.sleep}
              strokeWidth={3.5}
              strokeLinecap="round"
              opacity={0.95}
            />
          ))}
        </G>

        {/* Airport markers */}
        <G>
          {Array.from(airportSet.values()).map((a) => {
            const [shiftedLon, shiftedLat] = shift([a.lon, a.lat]);
            const [x, y] = project(shiftedLon, shiftedLat);
            return (
              <G key={a.iata}>
                <Circle cx={x} cy={y} r={5} fill={C.airportRing} />
                <Circle cx={x} cy={y} r={3} fill={C.airport} />
                <SvgText
                  x={x + 8}
                  y={y + 4}
                  fontSize="11"
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
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDash, { borderColor: C.arc, opacity: 0.7 }]} />
          <Text style={styles.legendLabel}>Flight path</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendBar, { backgroundColor: C.sleep }]} />
          <Text style={styles.legendLabel}>Suggested sleep window</Text>
        </View>
      </View>
    </View>
  );
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
});
