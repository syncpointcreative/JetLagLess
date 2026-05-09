// Vercel serverless function: GET /api/flight?ident=AA178&date=2026-05-09
// Looks up a flight via FlightAware AeroAPI and returns the fields the
// JetLagLess form needs to auto-fill.

interface AeroAirport {
  code_iata?: string;
  code_icao?: string;
  name?: string;
  city?: string;
  timezone?: string;
}

interface AeroFlight {
  ident?: string;
  ident_iata?: string;
  scheduled_out?: string;
  scheduled_in?: string;
  estimated_out?: string;
  estimated_in?: string;
  actual_out?: string;
  actual_in?: string;
  origin?: AeroAirport;
  destination?: AeroAirport;
}

interface AeroResponse {
  flights?: AeroFlight[];
}

export default async function handler(req: any, res: any) {
  const ident = String(req.query.ident ?? '').trim();
  const date = String(req.query.date ?? '').trim(); // YYYY-MM-DD, optional

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

  const out = picked.scheduled_out ?? picked.estimated_out ?? picked.actual_out;
  const inn = picked.scheduled_in ?? picked.estimated_in ?? picked.actual_in;
  if (!out || !inn || !picked.origin?.timezone || !picked.destination?.timezone) {
    res.status(502).json({ error: 'Flight record missing schedule or timezone data.' });
    return;
  }

  const depUtc = new Date(out);
  const arrUtc = new Date(inn);
  const durationHours = (arrUtc.getTime() - depUtc.getTime()) / 3_600_000;
  const depLocal = formatLocalParts(depUtc, picked.origin.timezone);

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.status(200).json({
    ident: picked.ident_iata ?? picked.ident ?? ident,
    origin: {
      iata: picked.origin.code_iata ?? null,
      icao: picked.origin.code_icao ?? null,
      name: picked.origin.name ?? null,
      city: picked.origin.city ?? null,
      timezone: picked.origin.timezone,
    },
    destination: {
      iata: picked.destination.code_iata ?? null,
      icao: picked.destination.code_icao ?? null,
      name: picked.destination.name ?? null,
      city: picked.destination.city ?? null,
      timezone: picked.destination.timezone,
    },
    departure: {
      utc: out,
      localDate: depLocal.date,
      localTime: depLocal.time,
    },
    arrival: { utc: inn },
    durationHours: Math.round(durationHours * 10) / 10,
  });
}

function pickFlight(flights: AeroFlight[], date: string): AeroFlight | undefined {
  if (!date) {
    return flights[0];
  }
  const target = new Date(`${date}T12:00:00Z`).getTime();
  let best: AeroFlight | undefined;
  let bestDelta = Infinity;
  for (const f of flights) {
    const t = f.scheduled_out ?? f.estimated_out ?? f.actual_out;
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
