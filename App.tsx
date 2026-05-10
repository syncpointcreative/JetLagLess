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
import {
  BathroomFrequency,
  buildItineraryPlan,
  CaffeineSensitivity,
  Chronotype,
  DEFAULT_PROFILE,
  ItineraryPlan,
  LegInput,
  MealStrategy,
  PersonalProfile,
  PlaneSleepAbility,
} from './src/lib/jetlag';

interface LegForm {
  id: string;
  originQuery: string;
  originIata: string;
  destQuery: string;
  destIata: string;
  departureDate: string;
  departureLocalTime: string;
  flightDurationHours: string;
}

interface FormState {
  legs: LegForm[];
  usualBedtime: string;
  usualWakeTime: string;
  prepDaysAvailable: string;
  profile: PersonalProfile;
}

const newLegId = () => Math.random().toString(36).slice(2, 9);

function emptyLeg(): LegForm {
  return {
    id: newLegId(),
    originQuery: '',
    originIata: '',
    destQuery: '',
    destIata: '',
    departureDate: todayISO(),
    departureLocalTime: '',
    flightDurationHours: '',
  };
}

function sampleLeg(over: Partial<LegForm>): LegForm {
  return { ...emptyLeg(), ...over };
}

const initial: FormState = {
  legs: [
    sampleLeg({
      originQuery: 'JFK — New York',
      originIata: 'JFK',
      destQuery: 'NRT — Tokyo',
      destIata: 'NRT',
      departureLocalTime: '18:30',
      flightDurationHours: '13.5',
    }),
  ],
  usualBedtime: '23:00',
  usualWakeTime: '07:00',
  prepDaysAvailable: '3',
  profile: DEFAULT_PROFILE,
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function App() {
  const [form, setForm] = useState<FormState>(initial);

  const updateLeg = (id: string, patch: Partial<LegForm>) =>
    setForm((f) => ({ ...f, legs: f.legs.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  const addLeg = () => setForm((f) => ({ ...f, legs: [...f.legs, emptyLeg()] }));
  const removeLeg = (id: string) =>
    setForm((f) => ({ ...f, legs: f.legs.length > 1 ? f.legs.filter((l) => l.id !== id) : f.legs }));
  const updateProfile = (patch: Partial<PersonalProfile>) =>
    setForm((f) => ({ ...f, profile: { ...f.profile, ...patch } }));

  const { plan, error } = useMemo<{ plan?: ItineraryPlan; error?: string }>(() => {
    try {
      const legs: LegInput[] = form.legs.map((l, i) => {
        const o = lookupAirport(l.originIata);
        const d = lookupAirport(l.destIata);
        if (!o) throw new Error(`Leg ${i + 1}: pick an origin airport.`);
        if (!d) throw new Error(`Leg ${i + 1}: pick a destination airport.`);
        if (!l.departureDate || !l.departureLocalTime) {
          throw new Error(`Leg ${i + 1}: enter departure date and time.`);
        }
        const dur = parseFloat(l.flightDurationHours);
        if (!isFinite(dur) || dur <= 0) throw new Error(`Leg ${i + 1}: enter flight duration.`);
        const depUtc = localToUtc(l.departureDate, l.departureLocalTime, o.tz);
        if (isNaN(depUtc.getTime())) throw new Error(`Leg ${i + 1}: invalid date or time.`);
        const arrUtc = new Date(depUtc.getTime() + dur * 3_600_000);
        return { originTz: o.tz, destTz: d.tz, departureUtc: depUtc, arrivalUtc: arrUtc };
      });
      for (let i = 1; i < legs.length; i++) {
        if (legs[i].departureUtc.getTime() <= legs[i - 1].arrivalUtc.getTime()) {
          throw new Error(`Leg ${i + 1} departs before leg ${i} arrives.`);
        }
      }
      return {
        plan: buildItineraryPlan({
          legs,
          usualBedtime: form.usualBedtime,
          usualWakeTime: form.usualWakeTime,
          prepDaysAvailable: parseInt(form.prepDaysAvailable, 10) || 0,
          profile: form.profile,
        }),
      };
    } catch (e: any) {
      return { error: e.message };
    }
  }, [form]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>JetLagLess</Text>
        <Text style={styles.subtitle}>
          Add each leg of your trip — we'll plan when to sleep on each flight, what to do on
          layovers, and how to prep your body before you go.
        </Text>

        <FlightLookup
          onResolved={(r, addAsNewLeg) => {
            const leg = sampleLeg({
              originQuery: r.origin.iata
                ? `${r.origin.iata}${r.origin.city ? ` — ${r.origin.city}` : ''}`
                : '',
              originIata: r.origin.iata ?? '',
              destQuery: r.destination.iata
                ? `${r.destination.iata}${r.destination.city ? ` — ${r.destination.city}` : ''}`
                : '',
              destIata: r.destination.iata ?? '',
              departureDate: r.departure.localDate,
              departureLocalTime: r.departure.localTime,
              flightDurationHours: String(r.durationHours),
            });
            setForm((f) => {
              if (addAsNewLeg) {
                const next = [...f.legs, leg];
                return { ...f, legs: sortLegsByDeparture(next) };
              }
              const replaceId = f.legs[0].id;
              return {
                ...f,
                legs: sortLegsByDeparture([{ ...leg, id: replaceId }, ...f.legs.slice(1)]),
              };
            });
          }}
          hasLegs={form.legs.length > 0}
        />

        {form.legs.map((leg, i) => (
          <LegSection
            key={leg.id}
            index={i}
            total={form.legs.length}
            leg={leg}
            onChange={(patch) => updateLeg(leg.id, patch)}
            onRemove={() => removeLeg(leg.id)}
          />
        ))}

        <Pressable
          onPress={addLeg}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryPressed]}
        >
          <Text style={styles.secondaryText}>+ Add another leg</Text>
        </Pressable>

        <Section title="Your usual sleep">
          <Field
            label="Usual bedtime (HH:MM)"
            value={form.usualBedtime}
            onChange={(v) => setForm((f) => ({ ...f, usualBedtime: v }))}
          />
          <Field
            label="Usual wake time (HH:MM)"
            value={form.usualWakeTime}
            onChange={(v) => setForm((f) => ({ ...f, usualWakeTime: v }))}
          />
          <Field
            label="Days available to prep before flight"
            value={form.prepDaysAvailable}
            onChange={(v) => setForm((f) => ({ ...f, prepDaysAvailable: v }))}
            keyboardType="number-pad"
          />
        </Section>

        <Section title="About you">
          <Segmented<Chronotype>
            label="When do you feel most alert?"
            value={form.profile.chronotype}
            options={[
              { value: 'early', label: 'Mornings' },
              { value: 'neutral', label: 'Mixed' },
              { value: 'night', label: 'Evenings' },
            ]}
            onChange={(v) => updateProfile({ chronotype: v })}
          />
          <Segmented<PlaneSleepAbility>
            label="How well do you sleep on planes?"
            value={form.profile.planeSleepAbility}
            options={[
              { value: 'none', label: 'Not at all' },
              { value: 'poor', label: 'Poorly' },
              { value: 'okay', label: 'Okay' },
              { value: 'good', label: 'Easily' },
            ]}
            onChange={(v) => updateProfile({ planeSleepAbility: v })}
          />
          <Segmented<BathroomFrequency>
            label="Bathroom frequency"
            value={form.profile.bathroomFrequency}
            options={[
              { value: 'rare', label: 'Rare' },
              { value: 'average', label: 'Average' },
              { value: 'often', label: 'Often' },
            ]}
            onChange={(v) => updateProfile({ bathroomFrequency: v })}
          />
          <Segmented<MealStrategy>
            label="In-flight meals"
            value={form.profile.mealStrategy}
            options={[
              { value: 'skip', label: 'Skip' },
              { value: 'light', label: 'Light' },
              { value: 'regular', label: 'Regular' },
            ]}
            onChange={(v) => updateProfile({ mealStrategy: v })}
          />
          <Segmented<CaffeineSensitivity>
            label="Caffeine sensitivity"
            value={form.profile.caffeineSensitivity}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'normal', label: 'Normal' },
              { value: 'high', label: 'High' },
            ]}
            onChange={(v) => updateProfile({ caffeineSensitivity: v })}
          />
          <Segmented<boolean>
            label="Do you usually drink alcohol on flights?"
            value={form.profile.alcoholOnFlights}
            options={[
              { value: false, label: 'No' },
              { value: true, label: 'Yes' },
            ]}
            onChange={(v) => updateProfile({ alcoholOnFlights: v })}
          />
        </Section>

        {error && <Text style={styles.error}>{error}</Text>}
        {plan && <Results plan={plan} legs={form.legs} />}

        <View style={{ height: 40 }} />
      </ScrollView>
      <StatusBar style="light" />
    </KeyboardAvoidingView>
  );
}

/**
 * Convert a wall-clock date+time in a given timezone to a UTC instant.
 * Iterative because each candidate UTC may map to a different offset across DST.
 */
function localToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const naive = new Date(`${dateStr}T${timeStr}:00Z`);
  if (isNaN(naive.getTime())) return naive;
  let utc = naive;
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMs(tz, utc);
    utc = new Date(naive.getTime() - offset);
  }
  return utc;
}

function tzOffsetMs(tz: string, at: Date): number {
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tgt = new Date(at.toLocaleString('en-US', { timeZone: tz }));
  return tgt.getTime() - utc.getTime();
}

function legDepartureMs(l: LegForm): number {
  const o = lookupAirport(l.originIata);
  if (!o || !l.departureDate || !l.departureLocalTime) return Number.MAX_SAFE_INTEGER;
  const t = localToUtc(l.departureDate, l.departureLocalTime, o.tz).getTime();
  return isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

function sortLegsByDeparture(legs: LegForm[]): LegForm[] {
  return [...legs].sort((a, b) => legDepartureMs(a) - legDepartureMs(b));
}

function formatDateInTz(d: Date, tz: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const y = get('year');
    const m = get('month');
    const day = get('day');
    if (!y || !m || !day) return undefined;
    return `${y}-${m}-${day}`;
  } catch {
    return undefined;
  }
}

function LegSection({
  index,
  total,
  leg,
  onChange,
  onRemove,
}: {
  index: number;
  total: number;
  leg: LegForm;
  onChange: (patch: Partial<LegForm>) => void;
  onRemove: () => void;
}) {
  const origin = lookupAirport(leg.originIata);
  const dest = lookupAirport(leg.destIata);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Leg {index + 1}</Text>
        {total > 1 && (
          <Pressable onPress={onRemove} hitSlop={10}>
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        )}
      </View>
      <AirportPicker
        label="Origin airport"
        query={leg.originQuery}
        selected={origin}
        onChangeQuery={(v) => onChange({ originQuery: v, originIata: '' })}
        onSelect={(a) => onChange({ originQuery: airportLabel(a), originIata: a.iata })}
        placeholder="JFK, New York…"
      />
      <AirportPicker
        label="Destination airport"
        query={leg.destQuery}
        selected={dest}
        onChangeQuery={(v) => onChange({ destQuery: v, destIata: '' })}
        onSelect={(a) => onChange({ destQuery: airportLabel(a), destIata: a.iata })}
        placeholder="NRT, Tokyo…"
      />
      <View style={styles.row2}>
        <View style={styles.col}>
          <Field
            label="Date (YYYY-MM-DD)"
            value={leg.departureDate}
            onChange={(v) => onChange({ departureDate: v })}
          />
        </View>
        <View style={styles.col}>
          <Field
            label="Time (HH:MM)"
            value={leg.departureLocalTime}
            onChange={(v) => onChange({ departureLocalTime: v })}
          />
        </View>
      </View>
      <Field
        label="Flight duration (hours)"
        value={leg.flightDurationHours}
        onChange={(v) => onChange({ flightDurationHours: v })}
        keyboardType="decimal-pad"
      />
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

function FlightLookup({
  onResolved,
  hasLegs,
}: {
  onResolved: (r: FlightLookupResult, addAsNewLeg: boolean) => void;
  hasLegs: boolean;
}) {
  const [ident, setIdent] = useState('');
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [last, setLast] = useState<string | undefined>();

  const submit = async (addAsNewLeg: boolean) => {
    setLoading(true);
    setError(undefined);
    try {
      const url = `/api/flight?ident=${encodeURIComponent(ident.trim())}&date=${encodeURIComponent(date)}`;
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onResolved(body as FlightLookupResult, addAsNewLeg);
      setLast(`${body.ident}: ${body.origin.iata} → ${body.destination.iata}`);
      setIdent('');
      // Advance the lookup date to this flight's arrival date so the next
      // lookup defaults to "after this leg lands."
      const arrLocalDate = formatDateInTz(
        new Date(body.arrival.utc),
        body.destination.timezone,
      );
      if (arrLocalDate) setDate(arrLocalDate);
    } catch (e: any) {
      setError(e.message ?? 'Lookup failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Look up by flight number</Text>
      <Text style={styles.hint}>Auto-fills airport, date, time, and duration.</Text>
      <View style={styles.row2}>
        <View style={[styles.col, { flex: 1.2 }]}>
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
        <View style={styles.col}>
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
      <View style={styles.row2}>
        <View style={styles.col}>
          <Pressable
            onPress={() => submit(false)}
            disabled={loading || ident.trim().length < 3}
            style={({ pressed }) => [
              styles.button,
              (loading || ident.trim().length < 3) && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.buttonText}>
              {loading ? 'Looking up…' : 'Replace leg 1'}
            </Text>
          </Pressable>
        </View>
        {hasLegs && (
          <View style={styles.col}>
            <Pressable
              onPress={() => submit(true)}
              disabled={loading || ident.trim().length < 3}
              style={({ pressed }) => [
                styles.secondaryButton,
                { marginTop: 0 },
                (loading || ident.trim().length < 3) && styles.buttonDisabled,
                pressed && styles.secondaryPressed,
              ]}
            >
              <Text style={styles.secondaryText}>Add as new leg</Text>
            </Pressable>
          </View>
        )}
      </View>
      {error && <Text style={styles.hintBad}>{error}</Text>}
      {last && !error && <Text style={styles.hintGood}>Filled from {last}</Text>}
    </View>
  );
}

function Segmented<T>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.segmented}>
        {options.map((opt, i) => {
          const active = opt.value === value;
          return (
            <Pressable
              key={i}
              onPress={() => onChange(opt.value)}
              style={({ pressed }) => [
                styles.segment,
                active && styles.segmentActive,
                pressed && !active && styles.segmentPressed,
                i === 0 && styles.segmentFirst,
                i === options.length - 1 && styles.segmentLast,
              ]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
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
  keyboardType,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
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

function Results({ plan, legs }: { plan: ItineraryPlan; legs: LegForm[] }) {
  const dirLabel =
    plan.direction === 'east'
      ? `Eastward, +${plan.shiftHours.toFixed(1)}h (advance)`
      : plan.direction === 'west'
        ? `Westward, ${plan.shiftHours.toFixed(1)}h (delay)`
        : 'No timezone change';

  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];

  return (
    <View style={styles.results}>
      <Text style={styles.resultsTitle}>
        {firstLeg?.originIata || '???'} → {lastLeg?.destIata || '???'}
      </Text>

      <View style={styles.summaryRow}>
        <Summary label="Direction" value={dirLabel} />
        <Summary label="Severity" value={plan.severity} />
        <Summary label="Full adjust" value={`~${plan.daysToFullyAdjust}d`} />
        <Summary label="Total travel" value={`${plan.totalTravelHours.toFixed(1)}h`} />
        <Summary label="Arrives at" value={plan.arrivalLocalTime} />
        <Summary
          label="Onboard sleep"
          value={
            plan.onboardSleepCapHours > 0
              ? `up to ${plan.onboardSleepCapHours.toFixed(1)}h`
              : 'skip'
          }
        />
      </View>

      {plan.legs.map((lp) => {
        const f = legs[lp.index];
        return (
          <Block
            key={lp.index}
            title={`Leg ${lp.index + 1} · ${f?.originIata ?? '?'} → ${f?.destIata ?? '?'} · ${lp.durationHours.toFixed(1)}h`}
          >
            {lp.onboardSleep.shouldSleep ? (
              <>
                <Text style={styles.bigLine}>
                  Sleep at flight hour {lp.onboardSleep.sleepAtFlightHour.toFixed(1)} (
                  <Text style={styles.bold}>{lp.onboardSleep.sleepAtFinalDestLocal}</Text> at final
                  dest)
                </Text>
                <Text style={styles.bigLine}>
                  Wake at flight hour {lp.onboardSleep.wakeAtFlightHour.toFixed(1)} (
                  <Text style={styles.bold}>{lp.onboardSleep.wakeAtFinalDestLocal}</Text> at final
                  dest)
                </Text>
                <Text style={styles.body}>
                  Target ~{lp.onboardSleep.durationHours.toFixed(1)}h of sleep on this leg.
                </Text>
              </>
            ) : (
              <Text style={styles.bigLine}>Stay awake on this leg.</Text>
            )}
            <Text style={styles.body}>{lp.onboardSleep.rationale}</Text>
            {plan.layovers
              .filter((lo) => lo.afterLegIndex === lp.index)
              .map((lo) => (
                <View key={`lo-${lo.afterLegIndex}`} style={styles.layover}>
                  <Text style={styles.layoverTitle}>
                    Layover · {lo.durationHours.toFixed(1)}h ({lo.classification})
                  </Text>
                  <Text style={styles.body}>
                    Land {lo.arrivalLocalTime} local · depart {lo.departureLocalTime} local
                  </Text>
                  {lo.advice.map((a, i) => (
                    <Text key={i} style={styles.body}>
                      • {a}
                    </Text>
                  ))}
                </View>
              ))}
          </Block>
        );
      })}

      {plan.inflightAdvice.length > 0 && (
        <Block title="In-flight habits">
          {plan.inflightAdvice.map((a, i) => (
            <Text key={i} style={styles.body}>
              • {a}
            </Text>
          ))}
        </Block>
      )}

      {(plan.preFlightShifts.length > 0 || plan.preFlightAdvice.length > 0) && (
        <Block title="Before you fly">
          {plan.preFlightShifts.map((s) => (
            <Text key={s.day} style={styles.body}>
              <Text style={styles.bold}>Day -{plan.preFlightShifts.length - s.day + 1}:</Text> bed{' '}
              {s.bedtime} → wake {s.wakeTime}
            </Text>
          ))}
          {plan.preFlightAdvice.map((a, i) => (
            <Text key={`adv-${i}`} style={styles.body}>
              • {a}
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
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#fff' },
  removeText: { fontSize: 13, color: '#ff9b9b' },
  field: { marginBottom: 12 },
  row2: { flexDirection: 'row', gap: 8 },
  col: { flex: 1 },
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
  suggestionIata: { fontSize: 13, fontWeight: '700', color: '#a5b4fc', width: 44 },
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
  secondaryButton: {
    backgroundColor: 'transparent',
    borderColor: '#4f46e5',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 16,
  },
  secondaryPressed: { backgroundColor: '#1a2150' },
  secondaryText: { color: '#a5b4fc', fontSize: 14, fontWeight: '600' },
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
  layover: {
    backgroundColor: '#1a2150',
    borderLeftColor: '#a5b4fc',
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
  },
  layoverTitle: { fontSize: 13, fontWeight: '700', color: '#fff', marginBottom: 4 },
  segmented: {
    flexDirection: 'row',
    borderRadius: 8,
    overflow: 'hidden',
    borderColor: '#2a3160',
    borderWidth: 1,
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: 'center',
    backgroundColor: '#0b1020',
    borderLeftColor: '#2a3160',
    borderLeftWidth: 1,
  },
  segmentFirst: { borderLeftWidth: 0 },
  segmentLast: {},
  segmentActive: { backgroundColor: '#4f46e5' },
  segmentPressed: { backgroundColor: '#1a2150' },
  segmentText: { fontSize: 13, color: '#9aa3c7', fontWeight: '500' },
  segmentTextActive: { color: '#fff', fontWeight: '700' },
});
