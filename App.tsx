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
import DateTimePicker from '@react-native-community/datetimepicker';
import { Airport, lookupAirport, searchAirports } from './src/lib/airports';
import { readJson, readJsonSync, storage, writeJson } from './src/lib/storage';
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

// Editorial design tokens — soft cream + deep navy + warm gold accent.
const C = {
  bg: '#f4ecdd',
  surface: '#fbf7ee',
  surfaceAlt: '#ede4cf',
  ink: '#15233f',
  inkSoft: '#3e4a66',
  inkMuted: '#7d8499',
  rule: '#d8cfb9',
  ruleSoft: '#e6dec9',
  accent: '#b97a4a',
  accentSoft: '#e8c79a',
  accentInk: '#7a4a26',
  success: '#4f7a52',
  danger: '#a85847',
  highlight: '#fff8e6',
};
const SERIF: string = Platform.OS === 'web' ? 'Fraunces, Georgia, serif' : 'Georgia';
const SANS: string =
  Platform.OS === 'web'
    ? 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'
    : 'System';

if (Platform.OS === 'web' && typeof document !== 'undefined') {
  // Load editorial type pair on first import.
  if (!document.getElementById('jll-fonts')) {
    const pre = document.createElement('link');
    pre.rel = 'preconnect';
    pre.href = 'https://fonts.gstatic.com';
    pre.crossOrigin = 'anonymous';
    document.head.appendChild(pre);
    const link = document.createElement('link');
    link.id = 'jll-fonts';
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,300..700,0..100,0..1&family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(link);
    const style = document.createElement('style');
    style.textContent = `
      html, body, #root { background: ${C.bg}; }
      body { font-family: ${SANS}; color: ${C.ink}; }
      input, button, textarea { font-family: ${SANS}; }
      input:focus { outline: none; border-color: ${C.accent} !important; }
      input::-webkit-calendar-picker-indicator { filter: invert(0.4) sepia(1) saturate(2) hue-rotate(345deg); cursor: pointer; }
      ::selection { background: ${C.accentSoft}; color: ${C.ink}; }
      * { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    `;
    document.head.appendChild(style);
  }
}

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

function applyDraft(saved: Partial<FormState> | undefined): FormState {
  if (!saved || !Array.isArray(saved.legs) || saved.legs.length === 0) return initial;
  return {
    legs: saved.legs.map((l) => ({ ...emptyLeg(), ...l })),
    usualBedtime: saved.usualBedtime ?? initial.usualBedtime,
    usualWakeTime: saved.usualWakeTime ?? initial.usualWakeTime,
    prepDaysAvailable: saved.prepDaysAvailable ?? initial.prepDaysAvailable,
    profile: { ...DEFAULT_PROFILE, ...(saved.profile ?? {}) },
  };
}

/** API base URL. Empty string = same origin (web build). On native, set
 * EXPO_PUBLIC_API_BASE in .env (e.g. https://your-vercel.vercel.app). */
const API_BASE = (process.env.EXPO_PUBLIC_API_BASE ?? '').replace(/\/$/, '');

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function App() {
  // Web can read localStorage synchronously; native must hydrate via async
  // AsyncStorage after first paint.
  const [form, setForm] = useState<FormState>(() => {
    if (Platform.OS === 'web') return applyDraft(readJsonSync<Partial<FormState>>(DRAFT_KEY));
    return initial;
  });
  const [savedTrips, setSavedTrips] = useState<Record<string, SavedTrip>>(() => {
    if (Platform.OS === 'web') return readJsonSync<Record<string, SavedTrip>>(TRIPS_KEY) ?? {};
    return {};
  });
  const [showPlan, setShowPlan] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    void (async () => {
      const draft = await readJson<Partial<FormState>>(DRAFT_KEY);
      if (draft) setForm(applyDraft(draft));
      const trips = await readJson<Record<string, SavedTrip>>(TRIPS_KEY);
      if (trips) setSavedTrips(trips);
    })();
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => {
      void writeJson(DRAFT_KEY, form);
    }, 400);
    return () => clearTimeout(handle);
  }, [form]);

  const persistTrips = (next: Record<string, SavedTrip>) => {
    setSavedTrips(next);
    void writeJson(TRIPS_KEY, next);
  };
  const saveCurrentAs = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    persistTrips({
      ...savedTrips,
      [trimmed]: {
        name: trimmed,
        savedAt: Date.now(),
        legs: form.legs,
        usualBedtime: form.usualBedtime,
        usualWakeTime: form.usualWakeTime,
        prepDaysAvailable: form.prepDaysAvailable,
      },
    });
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
    setShowPlan(false);
  };
  const deleteTrip = (name: string) => {
    const next = { ...savedTrips };
    delete next[name];
    persistTrips(next);
  };
  const clearAll = () => {
    setForm(initial);
    storage.remove(DRAFT_KEY);
    void writeJson(TRIPS_KEY, savedTrips);
    setShowPlan(false);
  };

  const updateLeg = (id: string, patch: Partial<LegForm>) =>
    setForm((f) => ({ ...f, legs: f.legs.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  const addLeg = () => setForm((f) => ({ ...f, legs: [...f.legs, emptyLeg()] }));
  const removeLeg = (id: string) =>
    setForm((f) => ({
      ...f,
      legs: f.legs.length > 1 ? f.legs.filter((l) => l.id !== id) : f.legs,
    }));
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

  const canGenerate = hasMeaningfulLeg(form.legs) && !error;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Hero />

        <Section
          step="01"
          eyebrow="The traveler"
          title="About you"
          subtitle="Five quick questions about how you sleep, eat, and handle flights. We'll use them to tailor every recommendation. Saved across all your trips."
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
          step="02"
          eyebrow="The baseline"
          title="Your usual sleep"
          subtitle="What does a normal night at home look like? We'll shift this gradually toward your destination's clock."
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
          step="03"
          eyebrow="The journey"
          title="Your trip"
          subtitle="Look up by flight number, or fill in legs manually. Add another for layovers."
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
              setShowPlan(false);
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

        <View style={styles.cta}>
          <Pressable
            onPress={() => setShowPlan(true)}
            disabled={!canGenerate}
            style={({ pressed }) => [
              styles.bigButton,
              !canGenerate && styles.bigButtonDisabled,
              pressed && canGenerate && styles.bigButtonPressed,
            ]}
          >
            <Text style={styles.bigButtonText}>Generate my plan →</Text>
          </Pressable>
          {!canGenerate && (
            <Text style={styles.errorMuted}>
              {error ?? 'Add at least one flight leg to generate a plan.'}
            </Text>
          )}
        </View>

        {showPlan && error && <Text style={styles.error}>{error}</Text>}
        {showPlan && plan && <Results plan={plan} legs={form.legs} />}

        <Footer />
        <View style={{ height: 60 }} />
      </ScrollView>
      <StatusBar style="dark" />
    </KeyboardAvoidingView>
  );
}

function Hero() {
  return (
    <View style={styles.hero}>
      <View style={styles.brandRow}>
        <Text style={styles.brandMark}>✦</Text>
        <Text style={styles.brandWord}>JetLagLess</Text>
      </View>
      <Text style={styles.heroEyebrow}>Issue №1 · Travel sleep</Text>
      <Text style={styles.heroTitle}>
        A circadian playbook,{'\n'}
        <Text style={styles.heroTitleItalic}>made for your body.</Text>
      </Text>
      <Text style={styles.heroLede}>
        Tell us about your flight, your sleep habits, and how your body handles travel — and we'll
        write you a day-by-day plan: when to nap on the plane, when to chase morning light, when to
        take melatonin, and when to put down the coffee.
      </Text>
      <View style={styles.heroDivider} />
    </View>
  );
}

function Footer() {
  return (
    <View style={styles.footer}>
      <Text style={styles.footerText}>
        JetLagLess is informational only. Talk to a doctor before starting melatonin or making
        big changes around medication, pregnancy, or sleep disorders.
      </Text>
    </View>
  );
}

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
    <View style={styles.legCard}>
      <View style={styles.legHeader}>
        <Text style={styles.legHeaderTitle}>Leg {index + 1}</Text>
        {total > 1 && (
          <Pressable onPress={onRemove} hitSlop={10}>
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        )}
      </View>
      <AirportPicker
        label="Origin"
        query={leg.originQuery}
        selected={origin}
        onChangeQuery={(v) => onChange({ originQuery: v, originIata: '' })}
        onSelect={(a) => onChange({ originQuery: airportLabel(a), originIata: a.iata })}
        placeholder="JFK, New York…"
      />
      <AirportPicker
        label="Destination"
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
      const url = `${API_BASE}/api/flight?ident=${encodeURIComponent(ident.trim())}&date=${encodeURIComponent(date)}`;
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
    <View style={styles.lookupCard}>
      <View style={styles.lookupHeader}>
        <Text style={styles.lookupTitle}>Look up by flight number</Text>
      </View>
      <Text style={styles.lookupHint}>Auto-fills airports, date, time, and duration.</Text>
      <View style={[styles.row2, { marginTop: 12 }]}>
        <View style={[styles.col, { flex: 1.3 }]}>
          <Text style={styles.label}>Flight</Text>
          <TextInput
            style={styles.input}
            value={ident}
            onChangeText={(v) => setIdent(v.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="AA178, AM25, BA216"
            placeholderTextColor={C.inkMuted}
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
    <NativePickerField
      label={label}
      value={value}
      onChange={onChange}
      type={type}
      placeholder={placeholder}
    />
  );
}

function NativePickerField({
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
  const [show, setShow] = useState(false);

  // Build a Date from the current string. Falls back to "now" if missing.
  const current = useMemo(() => {
    const now = new Date();
    if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map((n) => parseInt(n, 10));
      return new Date(y, m - 1, d, 12, 0, 0);
    }
    if (type === 'time' && /^\d{2}:\d{2}$/.test(value)) {
      const [h, m] = value.split(':').map((n) => parseInt(n, 10));
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    }
    return now;
  }, [value, type]);

  const display = value || (placeholder ?? (type === 'date' ? 'Pick a date' : 'Pick a time'));

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable onPress={() => setShow(true)} style={styles.input}>
        <Text style={{ color: value ? C.ink : C.inkMuted, fontSize: 15, fontFamily: SANS }}>
          {display}
        </Text>
      </Pressable>
      {show && (
        <DateTimePicker
          value={current}
          mode={type}
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={(_event, picked) => {
            if (Platform.OS !== 'ios') setShow(false);
            if (!picked) return;
            if (type === 'date') {
              const y = picked.getFullYear();
              const m = String(picked.getMonth() + 1).padStart(2, '0');
              const d = String(picked.getDate()).padStart(2, '0');
              onChange(`${y}-${m}-${d}`);
            } else {
              const h = String(picked.getHours()).padStart(2, '0');
              const m = String(picked.getMinutes()).padStart(2, '0');
              onChange(`${h}:${m}`);
            }
          }}
        />
      )}
    </View>
  );
}

const webInputStyle: any = {
  backgroundColor: C.surface,
  borderColor: C.rule,
  borderWidth: 1,
  borderStyle: 'solid',
  borderRadius: 8,
  paddingLeft: 14,
  paddingRight: 14,
  paddingTop: 11,
  paddingBottom: 11,
  color: C.ink,
  fontSize: 15,
  fontFamily: SANS,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  colorScheme: 'light',
  transition: 'border-color 120ms ease',
};

function Section({
  title,
  subtitle,
  step,
  eyebrow,
  children,
}: {
  title: string;
  subtitle?: string;
  step?: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        {step && <Text style={styles.stepNumber}>{step}</Text>}
        <View style={{ flex: 1 }}>
          {eyebrow && <Text style={styles.sectionEyebrow}>{eyebrow}</Text>}
          <Text style={styles.sectionTitle}>{title}</Text>
          {subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
        </View>
      </View>
      <View style={styles.sectionBody}>{children}</View>
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
        placeholderTextColor={C.inkMuted}
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
        placeholderTextColor={C.inkMuted}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
      />
      {selected ? (
        <Text style={styles.hintGood}>
          {selected.name} — {selected.city}, {selected.country}
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
    <View style={styles.savedTrips}>
      <Text style={styles.savedHeading}>Saved trips</Text>
      <Text style={styles.hint}>
        Your current trip auto-saves locally. Save it under a name to switch between trips.
      </Text>
      <View style={[styles.row2, { marginTop: 12 }]}>
        <View style={[styles.col, { flex: 1.5 }]}>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Trip name (e.g. Tokyo May 2026)"
            placeholderTextColor={C.inkMuted}
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
      {!canSave && <Text style={styles.hint}>Add at least one flight leg before saving.</Text>}
      {list.length > 0 && (
        <View style={{ marginTop: 14 }}>
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
      <Pressable onPress={onClear} hitSlop={6} style={{ marginTop: 14, alignSelf: 'flex-start' }}>
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

function Results({ plan, legs }: { plan: ItineraryPlan; legs: LegForm[] }) {
  const dirLabel =
    plan.direction === 'east'
      ? `Eastward · +${plan.shiftHours.toFixed(1)}h`
      : plan.direction === 'west'
        ? `Westward · ${plan.shiftHours.toFixed(1)}h`
        : 'No timezone change';
  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];

  return (
    <View style={styles.results}>
      <View style={styles.resultsHero}>
        <Text style={styles.resultsEyebrow}>Your playbook</Text>
        <Text style={styles.resultsTitle}>
          {firstLeg?.originIata || '???'} → {lastLeg?.destIata || '???'}
        </Text>
        <View style={styles.resultsRule} />
      </View>

      <View style={styles.summaryGrid}>
        <Summary label="Direction" value={dirLabel} />
        <Summary label="Severity" value={titleCase(plan.severity)} />
        <Summary label="Full adjust" value={`~${plan.daysToFullyAdjust} days`} />
        <Summary label="Total travel" value={`${plan.totalTravelHours.toFixed(1)} hours`} />
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

      <Block eyebrow="Chapter one" title="In the air">
        {plan.legs.map((lp) => {
          const f = legs[lp.index];
          return (
            <View key={lp.index} style={styles.legPlan}>
              <Text style={styles.legPlanTitle}>
                Leg {lp.index + 1} · {f?.originIata ?? '?'} → {f?.destIata ?? '?'} ·{' '}
                {lp.durationHours.toFixed(1)}h
              </Text>
              {lp.onboardSleep.shouldSleep ? (
                <>
                  <Text style={styles.bigLine}>
                    Sleep at flight hour{' '}
                    <Text style={styles.bold}>{lp.onboardSleep.sleepAtFlightHour.toFixed(1)}</Text>{' '}
                    ({lp.onboardSleep.sleepAtFinalDestLocal} dest.)
                  </Text>
                  <Text style={styles.bigLine}>
                    Wake at flight hour{' '}
                    <Text style={styles.bold}>{lp.onboardSleep.wakeAtFlightHour.toFixed(1)}</Text> (
                    {lp.onboardSleep.wakeAtFinalDestLocal} dest.)
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
            </View>
          );
        })}
      </Block>

      {plan.inflightAdvice.length > 0 && (
        <Block eyebrow="Chapter two" title="Habits in the cabin">
          {plan.inflightAdvice.map((a, i) => (
            <Text key={i} style={styles.body}>
              • {a}
            </Text>
          ))}
        </Block>
      )}

      {plan.dailySchedule.length > 0 && (
        <Block eyebrow="Chapter three" title="Day-by-day">
          {plan.preFlightAdvice.length > 0 && (
            <View style={{ marginBottom: 10 }}>
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

      <Block eyebrow="Chapter four" title="After you land">
        {plan.arrivalAdvice.map((a, i) => (
          <Text key={i} style={styles.body}>
            • {a}
          </Text>
        ))}
      </Block>
    </View>
  );
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function DayCard({ day }: { day: DayPlan }) {
  return (
    <View style={[styles.dayCard, day.phase === 'arrival' && styles.dayCardHighlight]}>
      <Text style={styles.dayCardTitle}>{day.label}</Text>
      <View style={styles.dayCardRows}>
        {day.bedtime && day.wakeTime && (
          <DayRow label="Sleep" value={`${day.bedtime} – ${day.wakeTime}`} />
        )}
        {day.brightLight && (
          <DayRow label="Bright light" value={`${day.brightLight.start} – ${day.brightLight.end}`} />
        )}
        {day.avoidLight && (
          <DayRow label="Avoid light" value={`${day.avoidLight.start} – ${day.avoidLight.end}`} />
        )}
        {day.melatonin && (
          <DayRow label="Melatonin" value={`${day.melatonin.dose} at ${day.melatonin.time}`} />
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

function DayRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.dayRow}>
      <Text style={styles.dayRowLabel}>{label}</Text>
      <View style={styles.dayRowDots} />
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

function Block({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.block}>
      {eyebrow && <Text style={styles.blockEyebrow}>{eyebrow}</Text>}
      <Text style={styles.blockTitle}>{title}</Text>
      <View style={styles.blockRule} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  container: {
    paddingHorizontal: 24,
    paddingTop: 64,
    paddingBottom: 80,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },

  // Hero
  hero: { marginBottom: 36 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 28 },
  brandMark: { fontSize: 18, color: C.accent, fontFamily: SERIF },
  brandWord: {
    fontSize: 16,
    color: C.ink,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: SANS,
  },
  heroEyebrow: {
    fontFamily: SANS,
    fontSize: 11,
    color: C.accent,
    letterSpacing: 3,
    textTransform: 'uppercase',
    fontWeight: '700',
    marginBottom: 18,
  },
  heroTitle: {
    fontFamily: SERIF,
    fontSize: 48,
    color: C.ink,
    fontWeight: '600',
    lineHeight: 54,
    letterSpacing: -1,
    marginBottom: 20,
  },
  heroTitleItalic: { fontStyle: 'italic', color: C.accentInk, fontWeight: '400' },
  heroLede: {
    fontFamily: SERIF,
    fontSize: 18,
    color: C.inkSoft,
    lineHeight: 28,
    fontWeight: '300',
    maxWidth: 560,
  },
  heroDivider: {
    height: 1,
    backgroundColor: C.rule,
    marginTop: 36,
    marginBottom: 4,
  },

  // Section
  section: {
    marginBottom: 32,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
    marginBottom: 20,
  },
  stepNumber: {
    fontFamily: SERIF,
    fontSize: 32,
    color: C.accent,
    fontWeight: '300',
    fontStyle: 'italic',
    lineHeight: 32,
    marginTop: 2,
  },
  sectionEyebrow: {
    fontFamily: SANS,
    fontSize: 10,
    color: C.inkMuted,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    fontWeight: '700',
    marginBottom: 4,
  },
  sectionTitle: {
    fontFamily: SERIF,
    fontSize: 28,
    color: C.ink,
    fontWeight: '600',
    letterSpacing: -0.5,
    lineHeight: 32,
    marginBottom: 6,
  },
  sectionSubtitle: {
    fontFamily: SERIF,
    fontSize: 15,
    color: C.inkSoft,
    lineHeight: 22,
    fontWeight: '300',
    fontStyle: 'italic',
  },
  sectionBody: {
    backgroundColor: C.surface,
    borderRadius: 14,
    padding: 22,
    borderColor: C.rule,
    borderWidth: 1,
  },

  // Inputs
  field: { marginBottom: 16 },
  row2: { flexDirection: 'row', gap: 12 },
  col: { flex: 1 },
  label: {
    fontFamily: SANS,
    fontSize: 11,
    color: C.inkSoft,
    marginBottom: 7,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  input: {
    fontFamily: SANS,
    backgroundColor: C.surface,
    borderColor: C.rule,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: C.ink,
    fontSize: 15,
  },
  hint: { fontFamily: SANS, fontSize: 12, color: C.inkMuted, marginTop: 6, lineHeight: 17 },
  hintGood: { fontFamily: SANS, fontSize: 12, color: C.success, marginTop: 6, fontWeight: '600' },
  hintBad: { fontFamily: SANS, fontSize: 12, color: C.danger, marginTop: 6, fontWeight: '600' },

  // Suggestions
  suggestions: {
    marginTop: 8,
    backgroundColor: C.surface,
    borderColor: C.rule,
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomColor: C.ruleSoft,
    borderBottomWidth: 1,
    gap: 12,
  },
  suggestionPressed: { backgroundColor: C.surfaceAlt },
  suggestionIata: {
    fontFamily: SANS,
    fontSize: 13,
    fontWeight: '700',
    color: C.accent,
    width: 44,
    letterSpacing: 0.5,
  },
  suggestionCity: { fontFamily: SANS, fontSize: 14, color: C.ink, fontWeight: '500' },
  suggestionName: { fontFamily: SANS, fontSize: 11, color: C.inkMuted, marginTop: 1 },

  // Buttons
  button: {
    backgroundColor: C.ink,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 14,
  },
  buttonPressed: { backgroundColor: C.accentInk },
  buttonDisabled: { backgroundColor: C.rule },
  buttonText: { fontFamily: SANS, color: C.bg, fontSize: 14, fontWeight: '600', letterSpacing: 0.3 },
  cta: {
    marginTop: 20,
    marginBottom: 24,
    alignItems: 'center',
  },
  bigButton: {
    backgroundColor: C.accent,
    borderRadius: 100,
    paddingVertical: 18,
    paddingHorizontal: 36,
    alignItems: 'center',
    minWidth: 280,
  },
  bigButtonPressed: { backgroundColor: C.accentInk },
  bigButtonDisabled: { backgroundColor: C.rule },
  bigButtonText: {
    fontFamily: SANS,
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  dashedButton: {
    backgroundColor: 'transparent',
    borderColor: C.rule,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 4,
  },
  secondaryPressed: { backgroundColor: C.surfaceAlt },
  secondaryText: { fontFamily: SANS, color: C.accent, fontSize: 13, fontWeight: '600' },
  removeText: { fontFamily: SANS, fontSize: 12, color: C.danger, fontWeight: '600' },
  error: {
    fontFamily: SANS,
    color: C.danger,
    marginVertical: 14,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  errorMuted: {
    fontFamily: SANS,
    color: C.inkMuted,
    marginTop: 8,
    fontSize: 12,
    textAlign: 'center',
  },

  // Leg card
  legCard: {
    backgroundColor: C.bg,
    borderRadius: 10,
    padding: 18,
    marginTop: 14,
    borderColor: C.ruleSoft,
    borderWidth: 1,
  },
  legHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  legHeaderTitle: {
    fontFamily: SERIF,
    fontSize: 18,
    fontWeight: '600',
    color: C.ink,
    fontStyle: 'italic',
  },

  // Lookup
  lookupCard: {
    backgroundColor: C.surfaceAlt,
    borderRadius: 10,
    padding: 18,
    marginBottom: 6,
    borderColor: C.rule,
    borderWidth: 1,
  },
  lookupHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  lookupTitle: { fontFamily: SERIF, fontSize: 17, color: C.ink, fontWeight: '600' },
  lookupHint: { fontFamily: SANS, fontSize: 12, color: C.inkSoft, marginTop: 4 },

  // Saved trips
  savedTrips: {
    marginBottom: 32,
    paddingTop: 24,
    paddingHorizontal: 22,
    paddingBottom: 24,
    borderTopColor: C.rule,
    borderTopWidth: 1,
    borderBottomColor: C.rule,
    borderBottomWidth: 1,
  },
  savedHeading: {
    fontFamily: SERIF,
    fontSize: 22,
    color: C.ink,
    fontWeight: '600',
    marginBottom: 6,
    fontStyle: 'italic',
  },
  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderTopColor: C.ruleSoft,
    borderTopWidth: 1,
    gap: 16,
  },
  tripName: { fontFamily: SERIF, fontSize: 16, color: C.ink, fontWeight: '600' },
  tripMeta: { fontFamily: SANS, fontSize: 11, color: C.inkMuted, marginTop: 2 },
  tripAction: { fontFamily: SANS, fontSize: 12, color: C.accent, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  tripDelete: { color: C.danger },

  // Segmented
  segmented: {
    flexDirection: 'row',
    borderRadius: 100,
    overflow: 'hidden',
    backgroundColor: C.surfaceAlt,
    padding: 3,
    gap: 2,
  },
  segment: {
    flex: 1,
    paddingVertical: 9,
    paddingHorizontal: 8,
    alignItems: 'center',
    borderRadius: 100,
  },
  segmentFirst: {},
  segmentLast: {},
  segmentActive: { backgroundColor: C.ink },
  segmentPressed: { backgroundColor: C.rule },
  segmentText: { fontFamily: SANS, fontSize: 13, color: C.inkSoft, fontWeight: '500' },
  segmentTextActive: { color: C.bg, fontWeight: '700' },

  // Results
  results: {
    marginTop: 24,
  },
  resultsHero: {
    marginBottom: 28,
  },
  resultsEyebrow: {
    fontFamily: SANS,
    fontSize: 11,
    color: C.accent,
    letterSpacing: 3,
    textTransform: 'uppercase',
    fontWeight: '700',
    marginBottom: 10,
  },
  resultsTitle: {
    fontFamily: SERIF,
    fontSize: 40,
    color: C.ink,
    fontWeight: '600',
    letterSpacing: -1,
    lineHeight: 44,
  },
  resultsRule: { height: 1, backgroundColor: C.rule, marginTop: 18 },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -8,
    marginBottom: 20,
  },
  summary: { width: '50%', paddingHorizontal: 8, marginBottom: 18 },
  summaryLabel: {
    fontFamily: SANS,
    fontSize: 10,
    color: C.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    fontWeight: '700',
  },
  summaryValue: {
    fontFamily: SERIF,
    fontSize: 22,
    color: C.ink,
    fontWeight: '600',
    marginTop: 6,
  },

  // Block
  block: {
    marginTop: 24,
    paddingTop: 24,
    borderTopColor: C.rule,
    borderTopWidth: 1,
  },
  blockEyebrow: {
    fontFamily: SANS,
    fontSize: 10,
    color: C.accent,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    fontWeight: '700',
    marginBottom: 6,
  },
  blockTitle: {
    fontFamily: SERIF,
    fontSize: 26,
    color: C.ink,
    fontWeight: '600',
    letterSpacing: -0.4,
    fontStyle: 'italic',
    marginBottom: 10,
  },
  blockRule: { height: 1, backgroundColor: C.rule, marginBottom: 14 },
  bigLine: { fontFamily: SANS, fontSize: 15, color: C.ink, marginBottom: 4, lineHeight: 22 },
  body: { fontFamily: SANS, fontSize: 14, color: C.inkSoft, lineHeight: 22, marginBottom: 5 },
  bold: { fontWeight: '700', color: C.ink },

  // Leg in plan
  legPlan: {
    marginBottom: 18,
    paddingBottom: 18,
    borderBottomColor: C.ruleSoft,
    borderBottomWidth: 1,
  },
  legPlanTitle: {
    fontFamily: SERIF,
    fontSize: 16,
    fontWeight: '600',
    color: C.ink,
    marginBottom: 10,
    fontStyle: 'italic',
  },
  layover: {
    backgroundColor: C.highlight,
    borderLeftColor: C.accent,
    borderLeftWidth: 3,
    borderRadius: 4,
    padding: 14,
    marginTop: 14,
  },
  layoverTitle: {
    fontFamily: SANS,
    fontSize: 12,
    fontWeight: '700',
    color: C.accentInk,
    marginBottom: 6,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // Day card
  dayCard: {
    paddingVertical: 16,
    borderTopColor: C.ruleSoft,
    borderTopWidth: 1,
  },
  dayCardHighlight: {
    backgroundColor: C.highlight,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderTopColor: C.accent,
    borderTopWidth: 2,
  },
  dayCardTitle: {
    fontFamily: SERIF,
    fontSize: 17,
    fontWeight: '600',
    color: C.ink,
    fontStyle: 'italic',
    marginBottom: 10,
  },
  dayCardRows: {},
  dayRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, gap: 10 },
  dayRowLabel: { fontFamily: SANS, fontSize: 12, color: C.inkSoft, fontWeight: '500' },
  dayRowDots: {
    flex: 1,
    height: 1,
    borderBottomColor: C.rule,
    borderBottomWidth: 1,
    borderStyle: 'dotted',
    marginHorizontal: 4,
    marginBottom: 4,
  },
  dayRowValue: {
    fontFamily: SANS,
    fontSize: 14,
    color: C.ink,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  dayCardNote: {
    fontFamily: SERIF,
    fontSize: 13,
    color: C.inkSoft,
    marginTop: 8,
    lineHeight: 19,
    fontStyle: 'italic',
  },

  footer: {
    marginTop: 56,
    paddingTop: 24,
    borderTopColor: C.rule,
    borderTopWidth: 1,
  },
  footerText: {
    fontFamily: SERIF,
    fontSize: 12,
    color: C.inkMuted,
    fontStyle: 'italic',
    lineHeight: 19,
    textAlign: 'center',
  },
});
