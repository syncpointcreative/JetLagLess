// Vercel serverless function: GET /api/flight?ident=AA178&date=2026-05-09
// Looks up a flight via FlightAware AeroAPI and returns the fields the
// JetLagLess form needs to auto-fill. Falls back through every time-field
// variant AeroAPI exposes, and uses our bundled airport DB to resolve a
// timezone when the AeroAPI record omits one.

import airportsData from '../src/data/airports.json';

interface AeroAirport {
  code_iata?: string;
  code_icao?: string;
  code?: string;
  name?: string;
  city?: string;
  airport_info_url?: string;
  timezone?: string;
}

interface AeroFlight {
  ident?: string;
  ident_iata?: string;
  ident_icao?: string;

  // Gate-out / gate-in (push back, arrive at gate)
  scheduled_out?: string;
  estimated_out?: string;
  actual_out?: string;
  scheduled_in?: string;
  estimated_in?: string;
  actual_in?: string;

  // Wheels-off / wheels-on (takeoff / touchdown)
  scheduled_off?: string;
  estimated_off?: string;
  actual_off?: string;
  scheduled_on?: string;
  estimated_on?: string;
  actual_on?: string;

  // Filed (flight plan)
  filed_off?: string;
  filed_on?: string;
  filed_departure_time?: string;
  filed_arrival_time?: string;

  origin?: AeroAirport;
  destination?: AeroAirport;
}

interface AeroResponse {
  flights?: AeroFlight[];
}

interface AirportRecord {
  name: string;
  city: string;
  country: string;
  tz: string;
}
const airportDb = airportsData as Record<string, AirportRecord>;

function resolveTimezone(a?: AeroAirport): string | undefined {
  if (!a) return undefined;
  if (a.timezone) return a.timezone;
  const iata = a.code_iata ?? a.code;
  if (iata && airportDb[iata.toUpperCase()]) return airportDb[iata.toUpperCase()].tz;
  return undefined;
}

function pickDeparture(f: AeroFlight): string | undefined {
  return (
    f.scheduled_out ??
    f.estimated_out ??
    f.actual_out ??
    f.scheduled_off ??
    f.estimated_off ??
    f.actual_off ??
    f.filed_off ??
    f.filed_departure_time
  );
}

function pickArrival(f: AeroFlight): string | undefined {
  return (
    f.scheduled_in ??
    f.estimated_in ??
    f.actual_in ??
    f.scheduled_on ??
    f.estimated_on ??
    f.actual_on ??
    f.filed_on ??
    f.filed_arrival_time
  );
}

export default async function handler(req: any, res: any) {
  const ident = String(req.query.ident ?? '').trim();
  const date = String(req.query.date ?? '').trim();

  if (!ident) {
    res.status(400).json({ error: 'Missing ?ident=<flight number>' });
    return;
  }

  const key = process.env.FLIGHTAWARE_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'Server misconfigured: FLIGHTAWARE_API_KEY not set.' });
    return;
  }

  const url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}`;
  const aeroRes = await fetch(url, { headers: { 'x-apikey': key, Accept: 'application/json' } });

  if (!aeroRes.ok) {
    const body = await aeroRes.text();
    res.status(aeroRes.status).json({
      error: `FlightAware returned ${aeroRes.status}`,
      detail: body.slice(0, 500),
    });
    return;
  }

  const data = (await aeroRes.json()) as AeroResponse;
  const flights = data.flights ?? [];
  if (flights.length === 0) {
    res.status(404).json({ error: `No flights found for ${ident}.` });
    return;
  }

  const picked = pickFlight(flights, date);
  if (!picked) {
    res.status(404).json({ error: `No flight matches ${ident} on ${date}.` });
    return;
  }

  const out = pickDeparture(picked);
  const inn = pickArrival(picked);
  const originTz = resolveTimezone(picked.origin);
  const destTz = resolveTimezone(picked.destination);

  if (!out || !inn) {
    res.status(502).json({
      error: `Found ${ident} but FlightAware didn't return scheduled times for this date. Try a different date or enter the flight manually.`,
      detail: { departure: out ?? null, arrival: inn ?? null },
    });
    return;
  }
  if (!originTz || !destTz) {
    res.status(502).json({
      error: `Found ${ident} but couldn't resolve a timezone for ${!originTz ? 'origin' : 'destination'}. Try entering the flight manually.`,
    });
    return;
  }

  const depUtc = new Date(out);
  const arrUtc = new Date(inn);
  const durationHours = (arrUtc.getTime() - depUtc.getTime()) / 3_600_000;
  const depLocal = formatLocalParts(depUtc, originTz);

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.status(200).json({
    ident: picked.ident_iata ?? picked.ident ?? ident,
    origin: {
      iata: picked.origin?.code_iata ?? picked.origin?.code ?? null,
      icao: picked.origin?.code_icao ?? null,
      name: picked.origin?.name ?? null,
      city: picked.origin?.city ?? null,
      timezone: originTz,
    },
    destination: {
      iata: picked.destination?.code_iata ?? picked.destination?.code ?? null,
      icao: picked.destination?.code_icao ?? null,
      name: picked.destination?.name ?? null,
      city: picked.destination?.city ?? null,
      timezone: destTz,
    },
    departure: { utc: out, localDate: depLocal.date, localTime: depLocal.time },
    arrival: { utc: inn },
    durationHours: Math.round(durationHours * 10) / 10,
  });
}

function pickFlight(flights: AeroFlight[], date: string): AeroFlight | undefined {
  if (!date) return flights[0];
  const target = new Date(`${date}T12:00:00Z`).getTime();
  let best: AeroFlight | undefined;
  let bestDelta = Infinity;
  for (const f of flights) {
    const t = pickDeparture(f);
    if (!t) continue;
    const delta = Math.abs(new Date(t).getTime() - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = f;
    }
  }
  return best ?? flights[0];
}

function formatLocalParts(d: Date, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
  };
}
