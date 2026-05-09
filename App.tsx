import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Airport, lookupAirport, searchAirports } from './src/lib/airports';
import { buildPlan, JetlagPlan, tzOffsetHours } from './src/lib/jetlag';

interface FormState {
  originQuery: string;
  originIata: string;
  destQuery: string;
  destIata: string;
  departureDate: string; // YYYY-MM-DD
  departureLocalTime: string; // HH:MM
  flightDurationHours: string;
  usualBedtime: string;
  usualWakeTime: string;
  prepDaysAvailable: string;
}

const initial: FormState = {
  originQuery: 'JFK',
  originIata: 'JFK',
  destQuery: 'NRT',
  destIata: 'NRT',
  departureDate: todayISO(),
  departureLocalTime: '18:30',
  flightDurationHours: '13.5',
  usualBedtime: '23:00',
  usualWakeTime: '07:00',
  prepDaysAvailable: '3',
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function App() {
  const [form, setForm] = useState<FormState>(initial);
  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const origin = lookupAirport(form.originIata);
  const dest = lookupAirport(form.destIata);

  const { plan, error } = useMemo<{ plan?: JetlagPlan; error?: string }>(() => {
    if (!origin) return { error: `Unknown origin airport "${form.originIata}". Try a 3-letter IATA code like JFK, LAX, LHR.` };
    if (!dest) return { error: `Unknown destination airport "${form.destIata}". Try a 3-letter IATA code.` };
    try {
      const depDate = new Date(`${form.departureDate}T${form.departureLocalTime}:00`);
      if (isNaN(depDate.getTime())) throw new Error('Invalid departure date or time.');
      const homeOffsetHours = tzOffsetHours(origin.tz, depDate);
      // Estimate destination offset at arrival instant for DST accuracy.
      const flightHours = parseFloat(form.flightDurationHours);
      if (!isFinite(flightHours) || flightHours <= 0) throw new Error('Enter a valid flight duration.');
      const arrInstant = new Date(depDate.getTime() + flightHours * 3_600_000);
      const destOffsetHours = tzOffsetHours(dest.tz, arrInstant);
      return {
        plan: buildPlan({
          homeOffsetHours,
          destOffsetHours,
          departureLocalTime: form.departureLocalTime,
          flightDurationHours: flightHours,
          usualBedtime: form.usualBedtime,
          usualWakeTime: form.usualWakeTime,
          prepDaysAvailable: parseInt(form.prepDaysAvailable, 10) || 0,
        }),
      };
    } catch (e: any) {
      return { error: e.message };
    }
  }, [form, origin, dest]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>JetLagLess</Text>
        <Text style={styles.subtitle}>
          Enter your flight and your usual sleep — we'll plan when to nap, when to wake, and how to
          prep your body.
        </Text>

        <FlightLookup
          onResolved={(r) => {
            const originAirport = lookupAirport(r.origin.iata ?? '');
            const destAirport = lookupAirport(r.destination.iata ?? '');
            setForm((f) => ({
              ...f,
              originQuery: originAirport ? airportLabel(originAirport) : (r.origin.iata ?? ''),
              originIata: r.origin.iata ?? '',
              destQuery: destAirport ? airportLabel(destAirport) : (r.destination.iata ?? ''),
              destIata: r.destination.iata ?? '',
              departureDate: r.departure.localDate,
              departureLocalTime: r.departure.localTime,
              flightDurationHours: String(r.durationHours),
            }));
          }}
        />

        <Section title="Flight">
          <AirportPicker
            label="Origin airport"
            query={form.originQuery}
            selected={origin}
            onChangeQuery={(v) => setForm((f) => ({ ...f, originQuery: v, originIata: '' }))}
            onSelect={(a) =>
              setForm((f) => ({ ...f, originQuery: airportLabel(a), originIata: a.iata }))
            }
            placeholder="JFK, New York, Tokyo…"
          />
          <AirportPicker
            label="Destination airport"
            query={form.destQuery}
            selected={dest}
            onChangeQuery={(v) => setForm((f) => ({ ...f, destQuery: v, destIata: '' }))}
            onSelect={(a) =>
              setForm((f) => ({ ...f, destQuery: airportLabel(a), destIata: a.iata }))
            }
            placeholder="NRT, Tokyo, London…"
          />
          <Field
            label="Departure date (YYYY-MM-DD)"
            value={form.departureDate}
            onChange={(v) => set('departureDate', v)}
          />
          <Field
            label="Departure local time (HH:MM)"
            value={form.departureLocalTime}
            onChange={(v) => set('departureLocalTime', v)}
          />
          <Field
            label="Total flight duration (hours, layovers included)"
            value={form.flightDurationHours}
            onChange={(v) => set('flightDurationHours', v)}
            keyboardType="decimal-pad"
          />
        </Section>

        <Section title="Your usual sleep">
          <Field
            label="Usual bedtime (HH:MM)"
            value={form.usualBedtime}
            onChange={(v) => set('usualBedtime', v)}
          />
          <Field
            label="Usual wake time (HH:MM)"
            value={form.usualWakeTime}
            onChange={(v) => set('usualWakeTime', v)}
          />
          <Field
            label="Days available to prep before flight"
            value={form.prepDaysAvailable}
            onChange={(v) => set('prepDaysAvailable', v)}
            keyboardType="number-pad"
          />
        </Section>

        {error && <Text style={styles.error}>{error}</Text>}
        {plan && origin && dest && <Results plan={plan} origin={origin} dest={dest} />}

        <View style={{ height: 40 }} />
      </ScrollView>
      <StatusBar style="light" />
    </KeyboardAvoidingView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  keyboardType,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  keyboardType?: 'decimal-pad' | 'number-pad' | 'numbers-and-punctuation' | 'default';
  placeholder?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor="#4a527a"
      />
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

function airportLabel(a: Airport): string {
  return `${a.iata} — ${a.city}`;
}

interface FlightLookupResult {
  ident: string;
  origin: { iata: string | null; name: string | null; city: string | null; timezone: string };
  destination: { iata: string | null; name: string | null; city: string | null; timezone: string };
  departure: { utc: string; localDate: string; localTime: string };
  arrival: { utc: string };
  durationHours: number;
}

function FlightLookup({ onResolved }: { onResolved: (r: FlightLookupResult) => void }) {
  const [ident, setIdent] = useState('');
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [last, setLast] = useState<string | undefined>();

  const submit = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const url = `/api/flight?ident=${encodeURIComponent(ident.trim())}&date=${encodeURIComponent(date)}`;
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onResolved(body as FlightLookupResult);
      setLast(`${body.ident}: ${body.origin.iata} → ${body.destination.iata}`);
    } catch (e: any) {
      setError(e.message ?? 'Lookup failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Look up by flight number</Text>
      <Text style={styles.hint}>Auto-fills the airports, date, time, and duration below.</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <View style={{ flex: 1.2 }}>
          <Text style={styles.label}>Flight (e.g. AA178)</Text>
          <TextInput
            style={styles.input}
            value={ident}
            onChangeText={(v) => setIdent(v.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="AA178"
            placeholderTextColor="#4a527a"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Date</Text>
          <TextInput
            style={styles.input}
            value={date}
            onChangeText={setDate}
            autoCorrect={false}
            placeholder="YYYY-MM-DD"
            placeholderTextColor="#4a527a"
          />
        </View>
      </View>
      <Pressable
        onPress={submit}
        disabled={loading || ident.trim().length < 3}
        style={({ pressed }) => [
          styles.button,
          (loading || ident.trim().length < 3) && styles.buttonDisabled,
          pressed && styles.buttonPressed,
        ]}
      >
        <Text style={styles.buttonText}>{loading ? 'Looking up…' : 'Look up flight'}</Text>
      </Pressable>
      {error && <Text style={styles.hintBad}>{error}</Text>}
      {last && !error && <Text style={styles.hintGood}>Filled from {last}</Text>}
    </View>
  );
}

function AirportPicker({
  label,
  query,
  selected,
  onChangeQuery,
  onSelect,
  placeholder,
}: {
  label: string;
  query: string;
  selected?: Airport;
  onChangeQuery: (v: string) => void;
  onSelect: (a: Airport) => void;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const showList = focused && !selected && query.trim().length > 0;
  const suggestions = useMemo(() => (showList ? searchAirports(query, 8) : []), [showList, query]);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={onChangeQuery}
        autoCorrect={false}
        autoCapitalize="characters"
        placeholder={placeholder}
        placeholderTextColor="#4a527a"
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
      />
      {selected ? (
        <Text style={styles.hintGood}>
          {selected.name} — {selected.city}, {selected.country} · {selected.tz}
        </Text>
      ) : query.length > 0 && suggestions.length === 0 && focused ? (
        <Text style={styles.hintBad}>No matches — try an IATA code or city name</Text>
      ) : !focused && query.length > 0 ? (
        <Text style={styles.hintBad}>Pick an airport from the list</Text>
      ) : (
        <Text style={styles.hint}>Type an airport code, city, or name</Text>
      )}
      {showList && suggestions.length > 0 && (
        <View style={styles.suggestions}>
          {suggestions.map((a) => (
            <Pressable
              key={a.iata}
              style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
              onPress={() => onSelect(a)}
            >
              <Text style={styles.suggestionIata}>{a.iata}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.suggestionCity}>
                  {a.city}, {a.country}
                </Text>
                <Text style={styles.suggestionName}>{a.name}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function Results({ plan, origin, dest }: { plan: JetlagPlan; origin: Airport; dest: Airport }) {
  const dirLabel =
    plan.direction === 'east'
      ? `Eastward, +${plan.shiftHours.toFixed(1)}h (advance)`
      : plan.direction === 'west'
        ? `Westward, ${plan.shiftHours.toFixed(1)}h (delay)`
        : 'No timezone change';

  return (
    <View style={styles.results}>
      <Text style={styles.resultsTitle}>
        {origin.city} → {dest.city}
      </Text>

      <View style={styles.summaryRow}>
        <Summary label="Direction" value={dirLabel} />
        <Summary label="Severity" value={plan.severity} />
        <Summary label="Full adjust" value={`~${plan.daysToFullyAdjust}d`} />
        <Summary label="Arrives at" value={plan.arrivalLocalTime} />
      </View>

      <Block title="On the plane">
        {plan.onboardSleep.shouldSleep ? (
          <>
            <Text style={styles.bigLine}>
              Sleep at <Text style={styles.bold}>{plan.onboardSleep.sleepAtDestLocal}</Text> dest. /
              flight hour {plan.onboardSleep.sleepAtFlightHour.toFixed(1)}
            </Text>
            <Text style={styles.bigLine}>
              Wake at <Text style={styles.bold}>{plan.onboardSleep.wakeAtDestLocal}</Text> dest. /
              flight hour {plan.onboardSleep.wakeAtFlightHour.toFixed(1)}
            </Text>
            <Text style={styles.body}>
              Target ~{plan.onboardSleep.durationHours.toFixed(1)}h of sleep.
            </Text>
          </>
        ) : (
          <Text style={styles.bigLine}>Don't sleep — stay awake on this flight.</Text>
        )}
        <Text style={styles.body}>{plan.onboardSleep.rationale}</Text>
      </Block>

      {plan.preFlightShifts.length > 0 && (
        <Block title="Pre-flight shift schedule">
          {plan.preFlightShifts.map((s) => (
            <Text key={s.day} style={styles.body}>
              <Text style={styles.bold}>Day -{plan.preFlightShifts.length - s.day + 1}:</Text>{' '}
              bed {s.bedtime} → wake {s.wakeTime}
            </Text>
          ))}
        </Block>
      )}

      <Block title="After you land">
        {plan.arrivalAdvice.map((a, i) => (
          <Text key={i} style={styles.body}>
            • {a}
          </Text>
        ))}
      </Block>
    </View>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summary}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#0b1020' },
  container: { padding: 20, paddingTop: 60 },
  title: { fontSize: 32, fontWeight: '700', color: '#fff', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#9aa3c7', marginBottom: 24, lineHeight: 20 },
  section: {
    backgroundColor: '#151a35',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#fff', marginBottom: 12 },
  field: { marginBottom: 12 },
  label: { fontSize: 13, color: '#c5cae9', marginBottom: 6 },
  input: {
    backgroundColor: '#0b1020',
    borderColor: '#2a3160',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 15,
  },
  hint: { fontSize: 11, color: '#6b73a0', marginTop: 4 },
  hintGood: { fontSize: 11, color: '#7ee0a1', marginTop: 4 },
  hintBad: { fontSize: 11, color: '#ff9b9b', marginTop: 4 },
  suggestions: {
    marginTop: 6,
    backgroundColor: '#0b1020',
    borderColor: '#2a3160',
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomColor: '#1a2150',
    borderBottomWidth: 1,
    gap: 12,
  },
  suggestionPressed: { backgroundColor: '#1a2150' },
  suggestionIata: {
    fontSize: 13,
    fontWeight: '700',
    color: '#a5b4fc',
    width: 44,
  },
  suggestionCity: { fontSize: 14, color: '#fff' },
  suggestionName: { fontSize: 11, color: '#9aa3c7', marginTop: 1 },
  button: {
    backgroundColor: '#4f46e5',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonPressed: { backgroundColor: '#4338ca' },
  buttonDisabled: { backgroundColor: '#2a3160' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  error: { color: '#ff7676', marginVertical: 8 },
  results: {
    backgroundColor: '#1a2150',
    borderRadius: 14,
    padding: 16,
    marginTop: 4,
  },
  resultsTitle: { fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 12 },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  summary: { width: '50%', marginBottom: 12 },
  summaryLabel: { fontSize: 11, color: '#9aa3c7', textTransform: 'uppercase' },
  summaryValue: { fontSize: 15, color: '#fff', fontWeight: '600', marginTop: 2 },
  block: {
    backgroundColor: '#0f1538',
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
  },
  blockTitle: { fontSize: 14, fontWeight: '700', color: '#a5b4fc', marginBottom: 8 },
  bigLine: { fontSize: 15, color: '#fff', marginBottom: 4 },
  body: { fontSize: 13, color: '#c5cae9', lineHeight: 19, marginBottom: 4 },
  bold: { fontWeight: '700', color: '#fff' },
});
