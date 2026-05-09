import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { buildPlan, JetlagInput, JetlagPlan } from './src/lib/jetlag';

const initial: JetlagInput = {
  homeOffsetHours: -5,
  destOffsetHours: 9,
  departureLocalTime: '18:30',
  flightDurationHours: 13.5,
  usualBedtime: '23:00',
  usualWakeTime: '07:00',
  prepDaysAvailable: 3,
};

export default function App() {
  const [form, setForm] = useState<Record<keyof JetlagInput, string>>({
    homeOffsetHours: String(initial.homeOffsetHours),
    destOffsetHours: String(initial.destOffsetHours),
    departureLocalTime: initial.departureLocalTime,
    flightDurationHours: String(initial.flightDurationHours),
    usualBedtime: initial.usualBedtime,
    usualWakeTime: initial.usualWakeTime,
    prepDaysAvailable: String(initial.prepDaysAvailable),
  });

  const set = (k: keyof JetlagInput, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { plan, error } = useMemo<{ plan?: JetlagPlan; error?: string }>(() => {
    try {
      return {
        plan: buildPlan({
          homeOffsetHours: parseFloat(form.homeOffsetHours),
          destOffsetHours: parseFloat(form.destOffsetHours),
          departureLocalTime: form.departureLocalTime,
          flightDurationHours: parseFloat(form.flightDurationHours),
          usualBedtime: form.usualBedtime,
          usualWakeTime: form.usualWakeTime,
          prepDaysAvailable: parseInt(form.prepDaysAvailable, 10) || 0,
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
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>JetLagLess</Text>
        <Text style={styles.subtitle}>
          Tell us about your flight and your sleep — we'll plan when to nap, when to wake, and how
          to prep your body.
        </Text>

        <Section title="Flight">
          <Field
            label="Home timezone offset (UTC±)"
            value={form.homeOffsetHours}
            onChange={(v) => set('homeOffsetHours', v)}
            keyboardType="numbers-and-punctuation"
            hint="e.g. -5 for New York, 0 for London"
          />
          <Field
            label="Destination timezone offset (UTC±)"
            value={form.destOffsetHours}
            onChange={(v) => set('destOffsetHours', v)}
            keyboardType="numbers-and-punctuation"
            hint="e.g. 9 for Tokyo, 1 for Paris"
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
        {plan && <Results plan={plan} />}

        <View style={{ height: 40 }} />
      </ScrollView>
      <StatusBar style="auto" />
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  keyboardType?: 'decimal-pad' | 'number-pad' | 'numbers-and-punctuation' | 'default';
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
      />
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

function Results({ plan }: { plan: JetlagPlan }) {
  const dirLabel =
    plan.direction === 'east'
      ? `Eastward, +${plan.shiftHours}h (advance)`
      : plan.direction === 'west'
        ? `Westward, ${plan.shiftHours}h (delay)`
        : 'No timezone change';

  return (
    <View style={styles.results}>
      <Text style={styles.resultsTitle}>Your plan</Text>

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
