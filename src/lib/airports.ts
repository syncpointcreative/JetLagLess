import data from '../data/airports.json';

export interface Airport {
  name: string;
  city: string;
  country: string;
  tz: string;
}

const db = data as Record<string, Airport>;

export function lookupAirport(iata: string): Airport | undefined {
  if (!iata) return undefined;
  return db[iata.toUpperCase().trim()];
}
