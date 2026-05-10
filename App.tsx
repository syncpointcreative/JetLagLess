import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useState } from 'react';
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
import { readJson, storage, writeJson } from './src/lib/storage';
import {
  BathroomFrequency,
  buildItineraryPlan,
  CaffeineSensitivity,
  Chronotype,
  DayPlan,
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
  legs: [emptyLeg()],
  usualBedtime: '23:00',
  usualWakeTime: '07:00',
  prepDaysAvailable: '3',
  profile: DEFAULT_PROFILE,
};

const DRAFT_KEY = 'jetlagless:draft:v1';
const TRIPS_KEY = 'jetlagless:trips:v1';

interface SavedTrip {
  name: string;
  savedAt: number;
  legs: LegForm[];
  usualBedtime: string;
  usualWakeTime: string;
  prepDaysAvailable: string;
}

function hydrateDraft(): FormState {
  const saved = readJson<Partial<FormState>>(DRAFT_KEY);
  if (!saved || !Array.isArray(saved.legs) || saved.legs.length === 0) return initial;
  return {
    legs: saved.legs.map((l) => ({ ...emptyLeg(), ...l })),
    usualBedtime: saved.usualBedtime ?? initial.usualBedtime,
    usualWakeTime: saved.usualWakeTime ?? initial.usualWakeTime,
    prepDaysAvailable: saved.prepDaysAvailable ?? initial.prepDaysAvailable,
    profile: { ...DEFAULT_PROFILE, ...(saved.profile ?? {}) },
  };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function App() {
  const [form, setForm] = useState<FormState>(() => hydrateDraft());
  const [savedTrips, setSavedTrips] = useState<Record<string, SavedTrip>>(
    () => readJson<Record<string, SavedTrip>>(TRIPS_KEY) ?? {},
  );

  // Auto-save draft on every change, debounced.
  useEffect(() => {
    const handle = setTimeout(() => writeJson(DRAFT_KEY, form), 400);
    return () => clearTimeout(handle);
  }, [form]);

  const persistTrips = (next: Record<string, SavedTrip>) => {
    setSavedTrips(next);
    writeJson(TRIPS_KEY, next);
  };

  const saveCurrentAs = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const trip: SavedTrip = {
      name: trimmed,
      savedAt: Date.now(),
      legs: form.legs,
      usualBedtime: form.usualBedtime,
      usualWakeTime: form.usualWakeTime,
      prepDaysAvailable: form.prepDaysAvailable,
    };
    persistTrips({ ...savedTrips, [trimmed]: trip });
  };

  const loadTrip = (name: string) => {
    const t = savedTrips[name];
    if (!t) return;
    setForm((f) => ({
      ...f,
      legs: t.legs.map((l) => ({ ...emptyLeg(), ...l, id: newLegId() })),
      usualBedtime: t.usualBedtime,
      usualWakeTime: t.usualWakeTime,
      prepDaysAvailable: t.prepDaysAvailable,
    }));
  };

  const deleteTrip = (name: string) => {
    const next = { ...savedTrips };
    delete next[name];
    persistTrips(next);
  };

  const clearAll = () => {
    setForm(initial);
    storage.remove(DRAFT_KEY);
  };

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

  const [showPlan, setShowPlan] = useState(false);
  // If form changes while plan is shown, leave it shown — user can re-toggle.
  // But hide it on first paint until they've intentionally generated.
  useEffect(() => {
    if (showPlan && error) setShowPlan(true);
  }, [error, showPlan]);

  const canGenerate = hasMeaningfulLeg(form.legs) && !error;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Travel sleep planner</Text>
          <Text style={styles.title}>JetLagLess</Text>
          <Text style={styles.subtitle}>
            A circadian playbook tailored to your flight, your sleep habits, and how your body
            handles travel. Fill out the sections below, then generate your plan.
          </Text>
        </View>

        <Section
          step="1"
          title="About you"
          subtitle="Tell us a bit about how you sleep, eat, and handle flights. Saved across trips."
        >
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

        <Section
          step="2"
          title="Your usual sleep"
          subtitle="What does a normal night at home look like? We'll shift this gradually toward your destination."
        >
          <View style={styles.row2}>
            <View style={styles.col}>
              <PickerField
                label="Usual bedtime"
                type="time"
                value={form.usualBedtime}
                onChange={(v) => setForm((f) => ({ ...f, usualBedtime: v }))}
              />
            </View>
            <View style={styles.col}>
              <PickerField
                label="Usual wake time"
                type="time"
                value={form.usualWakeTime}
                onChange={(v) => setForm((f) => ({ ...f, usualWakeTime: v }))}
              />
            </View>
          </View>
          <Field
            label="Days available to prep before flight"
            value={form.prepDaysAvailable}
            onChange={(v) => setForm((f) => ({ ...f, prepDaysAvailable: v }))}
            keyboardType="number-pad"
          />
        </Section>

        <Section
          step="3"
          title="Your trip"
          subtitle="Look up a flight by number, or enter legs manually. Add more legs for layovers."
        >
          <FlightLookup
            buttonLabel={hasMeaningfulLeg(form.legs) ? 'Add flight to itinerary' : 'Use this flight'}
            onResolved={(r) => {
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
                if (f.legs.length === 1 && !isMeaningfulLeg(f.legs[0])) {
                  return { ...f, legs: [{ ...leg, id: f.legs[0].id }] };
                }
                return { ...f, legs: sortLegsByDeparture([...f.legs, leg]) };
              });
            }}
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
            style={({ pressed }) => [styles.dashedButton, pressed && styles.secondaryPressed]}
          >
            <Text style={styles.secondaryText}>+ Add another leg</Text>
          </Pressable>
        </Section>

        <SavedTrips
          trips={savedTrips}
          onSave={saveCurrentAs}
          onLoad={loadTrip}
          onDelete={deleteTrip}
          onClear={clearAll}
          canSave={hasMeaningfulLeg(form.legs)}
        />

        <Pressable
          onPress={() => setShowPlan(true)}
          disabled={!canGenerate}
          style={({ pressed }) => [
            styles.bigButton,
            !canGenerate && styles.bigButtonDisabled,
            pressed && canGenerate && styles.bigButtonPressed,
          ]}
        >
          <Text style={styles.bigButtonText}>Generate my plan</Text>
        </Pressable>
        {!canGenerate && (
          <Text style={styles.errorMuted}>
            {error ?? 'Add at least one flight leg to generate a plan.'}
          </Text>
        )}

        {showPlan && error && <Text style={styles.error}>{error}</Text>}
        {showPlan && plan && <Results plan={plan} legs={form.legs} />}

        <View style={{ height: 60 }} />
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

function isMeaningfulLeg(l: LegForm): boolean {
  return Boolean(l.originIata || l.destIata || l.flightDurationHours || l.departureLocalTime);
}

function hasMeaningfulLeg(legs: LegForm[]): boolean {
  return legs.some(isMeaningfulLeg);
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
          <PickerField
            label="Departure date"
            type="date"
            value={leg.departureDate}
            onChange={(v) => onChange({ departureDate: v })}
          />
        </View>
        <View style={styles.col}>
          <PickerField
            label="Departure time"
            type="time"
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
  buttonLabel,
}: {
  onResolved: (r: FlightLookupResult) => void;
  buttonLabel: string;
}) {
  const [ident, setIdent] = useState('');
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [last, setLast] = useState<string | undefined>();

  const disabled = loading || ident.trim().length < 3;

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
      setIdent('');
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
      <Text style={styles.hint}>Auto-fills airport, date, time, and duration below.</Text>
      <View style={[styles.row2, { marginTop: 10 }]}>
        <View style={[styles.col, { flex: 1.3 }]}>
          <Text style={styles.label}>Flight (e.g. AA178)</Text>
          <TextInput
            style={styles.input}
            value={ident}
            onChangeText={(v) => setIdent(v.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="AA178"
            placeholderTextColor="#4a527a"
            onSubmitEditing={() => !disabled && submit()}
          />
        </View>
        <View style={styles.col}>
          <PickerField label="Date" type="date" value={date} onChange={setDate} />
        </View>
      </View>
      <Pressable
        onPress={submit}
        disabled={disabled}
        style={({ pressed }) => [
          styles.button,
          disabled && styles.buttonDisabled,
          pressed && !disabled && styles.buttonPressed,
        ]}
      >
        <Text style={styles.buttonText}>{loading ? 'Looking up…' : buttonLabel}</Text>
      </Pressable>
      {error && <Text style={styles.hintBad}>{error}</Text>}
      {last && !error && <Text style={styles.hintGood}>Added {last}</Text>}
    </View>
  );
}

function SavedTrips({
  trips,
  onSave,
  onLoad,
  onDelete,
  onClear,
  canSave,
}: {
  trips: Record<string, SavedTrip>;
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
  onClear: () => void;
  canSave: boolean;
}) {
  const [name, setName] = useState('');
  const list = Object.values(trips).sort((a, b) => b.savedAt - a.savedAt);
  const trimmed = name.trim();
  const exists = trimmed.length > 0 && trips[trimmed] !== undefined;
  const disabled = !canSave || trimmed.length === 0;

  const submit = () => {
    if (disabled) return;
    onSave(trimmed);
    setName('');
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Saved trips</Text>
      <Text style={styles.hint}>
        Your current trip auto-saves locally. Save it under a name to switch between trips.
      </Text>
      <View style={[styles.row2, { marginTop: 10 }]}>
        <View style={[styles.col, { flex: 1.5 }]}>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Trip name (e.g. Tokyo May 2026)"
            placeholderTextColor="#4a527a"
            autoCorrect={false}
            onSubmitEditing={submit}
          />
        </View>
        <View style={styles.col}>
          <Pressable
            onPress={submit}
            disabled={disabled}
            style={({ pressed }) => [
              styles.button,
              { marginTop: 0 },
              disabled && styles.buttonDisabled,
              pressed && !disabled && styles.buttonPressed,
            ]}
          >
            <Text style={styles.buttonText}>{exists ? 'Overwrite' : 'Save trip'}</Text>
          </Pressable>
        </View>
      </View>
      {!canSave && (
        <Text style={styles.hint}>Add at least one flight leg before saving.</Text>
      )}
      {list.length > 0 && (
        <View style={{ marginTop: 12 }}>
          {list.map((t) => (
            <View key={t.name} style={styles.tripRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.tripName}>{t.name}</Text>
                <Text style={styles.tripMeta}>
                  {t.legs.length} leg{t.legs.length === 1 ? '' : 's'} · saved{' '}
                  {new Date(t.savedAt).toLocaleDateString()}
                </Text>
              </View>
              <Pressable onPress={() => onLoad(t.name)} hitSlop={8}>
                <Text style={styles.tripAction}>Load</Text>
              </Pressable>
              <Pressable onPress={() => onDelete(t.name)} hitSlop={8}>
                <Text style={[styles.tripAction, styles.tripDelete]}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
      <Pressable onPress={onClear} hitSlop={6} style={{ marginTop: 12, alignSelf: 'flex-start' }}>
        <Text style={styles.tripDelete}>Clear current trip</Text>
      </Pressable>
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

/**
 * On web, render the browser's native date/time picker via a real <input>.
 * Falls back to a plain TextInput on native — DateTimePicker is a native-only
 * dependency we can layer in later if we publish a native build.
 */
function PickerField({
  label,
  value,
  onChange,
  type,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type: 'date' | 'time';
  placeholder?: string;
}) {
  if (Platform.OS === 'web') {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        {React.createElement('input', {
          type,
          value,
          onChange: (e: any) => onChange(e.target.value),
          style: webInputStyle,
        })}
      </View>
    );
  }
  return (
    <Field
      label={label}
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? (type === 'date' ? 'YYYY-MM-DD' : 'HH:MM')}
    />
  );
}

const webInputStyle: any = {
  backgroundColor: '#0b1020',
  borderColor: '#2a3160',
  borderWidth: 1,
  borderStyle: 'solid',
  borderRadius: 8,
  paddingLeft: 12,
  paddingRight: 12,
  paddingTop: 10,
  paddingBottom: 10,
  color: '#fff',
  fontSize: 15,
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  colorScheme: 'dark',
};

function Section({
  title,
  subtitle,
  step,
  children,
}: {
  title: string;
  subtitle?: string;
  step?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        {step && (
          <View style={styles.stepBadge}>
            <Text style={styles.stepBadgeText}>{step}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
        </View>
      </View>
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

      {plan.dailySchedule.length > 0 && (
        <Block title="Daily schedule (light & melatonin)">
          {plan.preFlightAdvice.length > 0 && (
            <View style={{ marginBottom: 8 }}>
              {plan.preFlightAdvice.map((a, i) => (
                <Text key={`pf-${i}`} style={styles.body}>
                  • {a}
                </Text>
              ))}
            </View>
          )}
          {plan.dailySchedule.map((d, i) => (
            <DayCard key={i} day={d} />
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

function DayCard({ day }: { day: DayPlan }) {
  return (
    <View
      style={[
        styles.dayCard,
        day.phase === 'arrival' && styles.dayCardHighlight,
      ]}
    >
      <Text style={styles.dayCardTitle}>{day.label}</Text>
      <View style={styles.dayCardRows}>
        {day.bedtime && day.wakeTime && (
          <DayRow icon="🛏️" label="Sleep" value={`${day.bedtime} – ${day.wakeTime}`} />
        )}
        {day.brightLight && (
          <DayRow
            icon="☀️"
            label="Bright light"
            value={`${day.brightLight.start} – ${day.brightLight.end}`}
          />
        )}
        {day.avoidLight && (
          <DayRow
            icon="🌑"
            label="Avoid bright light"
            value={`${day.avoidLight.start} – ${day.avoidLight.end}`}
          />
        )}
        {day.melatonin && (
          <DayRow
            icon="💊"
            label="Melatonin"
            value={`${day.melatonin.dose} at ${day.melatonin.time}`}
          />
        )}
      </View>
      {day.notes.map((n, i) => (
        <Text key={i} style={styles.dayCardNote}>
          {n}
        </Text>
      ))}
    </View>
  );
}

function DayRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.dayRow}>
      <Text style={styles.dayRowIcon}>{icon}</Text>
      <Text style={styles.dayRowLabel}>{label}</Text>
      <Text style={styles.dayRowValue}>{value}</Text>
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
  flex: { flex: 1, backgroundColor: '#070b1c' },
  container: {
    padding: 20,
    paddingTop: 56,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  hero: { marginBottom: 28 },
  eyebrow: {
    fontSize: 12,
    color: '#a5b4fc',
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: '700',
    marginBottom: 6,
  },
  title: { fontSize: 36, fontWeight: '800', color: '#fff', letterSpacing: -0.5, marginBottom: 10 },
  subtitle: { fontSize: 15, color: '#9aa3c7', lineHeight: 22 },
  section: {
    backgroundColor: '#10172e',
    borderRadius: 16,
    padding: 20,
    marginBottom: 18,
    borderColor: '#1a2150',
    borderWidth: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 16,
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#4f46e5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#fff', letterSpacing: -0.2 },
  sectionSubtitle: { fontSize: 13, color: '#7c84ad', marginTop: 4, lineHeight: 18 },
  removeText: { fontSize: 13, color: '#ff9b9b', fontWeight: '600' },
  field: { marginBottom: 14 },
  row2: { flexDirection: 'row', gap: 10 },
  col: { flex: 1 },
  label: { fontSize: 12, color: '#9aa3c7', marginBottom: 6, fontWeight: '600', letterSpacing: 0.2 },
  input: {
    backgroundColor: '#070b1c',
    borderColor: '#252c54',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: '#fff',
    fontSize: 15,
  },
  hint: { fontSize: 12, color: '#6b73a0', marginTop: 4, lineHeight: 17 },
  hintGood: { fontSize: 12, color: '#86efac', marginTop: 6, fontWeight: '600' },
  hintBad: { fontSize: 12, color: '#fca5a5', marginTop: 6, fontWeight: '600' },
  suggestions: {
    marginTop: 6,
    backgroundColor: '#070b1c',
    borderColor: '#252c54',
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
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
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonPressed: { backgroundColor: '#4338ca' },
  buttonDisabled: { backgroundColor: '#252c54' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  bigButton: {
    backgroundColor: '#6366f1',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 8,
    shadowColor: '#6366f1',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  bigButtonPressed: { backgroundColor: '#4f46e5' },
  bigButtonDisabled: { backgroundColor: '#252c54', shadowOpacity: 0 },
  bigButtonText: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderColor: '#4f46e5',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 16,
  },
  dashedButton: {
    backgroundColor: 'transparent',
    borderColor: '#3a4280',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 4,
  },
  secondaryPressed: { backgroundColor: '#1a2150' },
  secondaryText: { color: '#a5b4fc', fontSize: 14, fontWeight: '600' },
  error: { color: '#fca5a5', marginVertical: 12, fontSize: 14, fontWeight: '600' },
  errorMuted: { color: '#7c84ad', marginTop: 4, marginBottom: 12, fontSize: 12, textAlign: 'center' },
  results: {
    backgroundColor: '#10172e',
    borderRadius: 16,
    padding: 20,
    marginTop: 12,
    borderColor: '#3a4280',
    borderWidth: 1,
  },
  resultsTitle: { fontSize: 22, fontWeight: '800', color: '#fff', marginBottom: 16, letterSpacing: -0.4 },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8, marginHorizontal: -4 },
  summary: {
    width: '50%',
    paddingHorizontal: 4,
    marginBottom: 14,
  },
  summaryLabel: { fontSize: 10, color: '#7c84ad', textTransform: 'uppercase', letterSpacing: 1, fontWeight: '700' },
  summaryValue: { fontSize: 15, color: '#fff', fontWeight: '700', marginTop: 4 },
  block: {
    backgroundColor: '#070b1c',
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    borderColor: '#1a2150',
    borderWidth: 1,
  },
  blockTitle: { fontSize: 14, fontWeight: '700', color: '#a5b4fc', marginBottom: 10, letterSpacing: 0.2, textTransform: 'uppercase' },
  bigLine: { fontSize: 15, color: '#fff', marginBottom: 4, lineHeight: 22 },
  body: { fontSize: 13, color: '#c5cae9', lineHeight: 20, marginBottom: 4 },
  bold: { fontWeight: '700', color: '#fff' },
  layover: {
    backgroundColor: '#10172e',
    borderLeftColor: '#a5b4fc',
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  layoverTitle: { fontSize: 13, fontWeight: '700', color: '#fff', marginBottom: 4 },
  dayCard: {
    backgroundColor: '#10172e',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderColor: '#1a2150',
    borderWidth: 1,
  },
  dayCardHighlight: { borderColor: '#6366f1', backgroundColor: '#1a205a' },
  dayCardTitle: { fontSize: 13, fontWeight: '700', color: '#fff', marginBottom: 8 },
  dayCardRows: {},
  dayRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3, gap: 8 },
  dayRowIcon: { fontSize: 14, width: 22 },
  dayRowLabel: { fontSize: 12, color: '#9aa3c7', flex: 1 },
  dayRowValue: { fontSize: 13, color: '#fff', fontWeight: '600' },
  dayCardNote: { fontSize: 11, color: '#7c84ad', marginTop: 6, lineHeight: 16, fontStyle: 'italic' },
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
  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopColor: '#2a3160',
    borderTopWidth: 1,
    gap: 14,
  },
  tripName: { fontSize: 14, color: '#fff', fontWeight: '600' },
  tripMeta: { fontSize: 11, color: '#9aa3c7', marginTop: 2 },
  tripAction: { fontSize: 13, color: '#a5b4fc', fontWeight: '600' },
  tripDelete: { color: '#ff9b9b' },
});
