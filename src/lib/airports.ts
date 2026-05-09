import data from '../data/airports.json';

export interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  tz: string;
}

const raw = data as Record<string, Omit<Airport, 'iata'>>;

const all: Airport[] = Object.entries(raw).map(([iata, a]) => ({ iata, ...a }));
const byIata: Map<string, Airport> = new Map(all.map((a) => [a.iata, a]));

export function lookupAirport(iata: string): Airport | undefined {
  if (!iata) return undefined;
  return byIata.get(iata.toUpperCase().trim());
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/**
 * Rank: exact IATA (0) < IATA prefix (1) < city prefix (2) < city contains (3) <
 * name prefix (4) < name contains (5) < country prefix (6).
 */
export function searchAirports(query: string, limit = 8): Airport[] {
  const q = norm(query.trim());
  if (!q) return [];

  const scored: { a: Airport; rank: number }[] = [];
  for (const a of all) {
    const iata = a.iata.toLowerCase();
    const city = norm(a.city);
    const name = norm(a.name);
    const country = norm(a.country);

    let rank = -1;
    if (iata === q) rank = 0;
    else if (iata.startsWith(q)) rank = 1;
    else if (city.startsWith(q)) rank = 2;
    else if (city.includes(q)) rank = 3;
    else if (name.startsWith(q)) rank = 4;
    else if (name.includes(q)) rank = 5;
    else if (country.startsWith(q)) rank = 6;
    else continue;

    scored.push({ a, rank });
    if (rank === 0 && scored.length >= limit) break;
  }

  scored.sort((x, y) => x.rank - y.rank || x.a.iata.localeCompare(y.a.iata));
  return scored.slice(0, limit).map((s) => s.a);
}
