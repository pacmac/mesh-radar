// interval-options — the phone app's curated interval allowlists, ported.
//
// Spec: docs/modules/interval-options.md.
//
// WHY THIS EXISTS. Peter, 2026-08-18: "in fact none of the fields are validated. I
// can enter any value I like for things like send freq for metadata, node dash
// allows it and saves it an breaks the radio because the vales sent are invalid."
//
// THE APP DOES NOT VALIDATE — IT MAKES THE BAD VALUE UNENTERABLE. Its telemetry
// screen renders a DropDownPreference over
// `IntervalConfiguration.BROADCAST_SHORT.allowedIntervals`, so there is no invalid
// state to reject and therefore no rejection path to get wrong. That is the whole
// mechanism behind Peter's "it works 100% of the time", and it is a UI-SHAPE
// decision rather than a validation one.
//
// Ours was a number box carrying an advisory `min` attribute — and because the
// form is read by JS (collectForm) rather than natively submitted, the browser's
// constraint validation never ran at all. The attribute decorated a control that
// enforced nothing.
//
// THE TABLES ARE GENERATED, NOT WRITTEN HERE. They live in ./interval-tables.js,
// produced by scripts/gen_interval_tables.mjs from the vendored
// vendor/meshtastic-android/FixedUpdateIntervals.kt, and `npm run check` fails if
// the two disagree. See docs/modules/interval-tables.md.
//
// They used to be typed into this file by hand, and Peter called it: "my guess is
// you did a 1 time export of the schema. this should be a script". The port had
// ALL wrong — the app's ALL is the enum in DECLARATION order, ending 2147483647,
// 80, 90, 8, 40, and it had been transcribed ascending. The error was not a typo
// but a TIDY-UP, which is the kind review never catches.
//
// What stays hand-written here is what upstream does not state: the field ->
// configuration map below, the labels, and decorateSchema.
//
// The protobuf does NOT carry ranges — `uint32 device_update_interval = 1;` and a
// prose comment — so these curated tables are the real source, and mesh-gw's
// hand-written `min: 1800` is a transcription of BROADCAST_SHORT's first entry.

import { INTERVAL_CONFIGURATIONS } from './interval-tables.js';

export { INTERVAL_CONFIGURATIONS };

/** Seconds -> label. Derived, NOT ported: the app's labels come from Android
 *  plural string resources, and re-implementing that to render "30 minutes" would
 *  import a localisation system to solve arithmetic. */
export function intervalLabel(secs) {
  if (secs === 0) return 'unset';
  if (secs === 2147483647) return 'always on';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (secs % 3600 === 0) return plural(secs / 3600, 'hour');
  if (secs % 60 === 0)   return plural(secs / 60, 'minute');
  return plural(secs, 'second');
}

/** field name -> configuration. Keyed by `section.field` where the same field name
 *  means different things in different sections, otherwise by bare field name.
 *
 *  A FIELD NOT IN THIS MAP IS LEFT EXACTLY AS IT WAS. An unmapped field must never
 *  silently acquire a guessed allowlist — inventing a constraint is the mirror of
 *  the bug this fixes, and would be harder to notice. */
export const FIELD_CONFIGURATION = {
  // telemetry — all four/five intervals share the app's BROADCAST_SHORT
  'telemetry.device_update_interval':      'BROADCAST_SHORT',
  'telemetry.environment_update_interval': 'BROADCAST_SHORT',
  'telemetry.air_quality_interval':        'BROADCAST_SHORT',
  'telemetry.power_update_interval':       'BROADCAST_SHORT',
  'telemetry.health_update_interval':      'BROADCAST_SHORT',

  'device.node_info_broadcast_secs':                 'NODE_INFO_BROADCAST',
  'position.position_broadcast_secs':                'POSITION_BROADCAST',
  'position.broadcast_smart_minimum_interval_secs':  'SMART_BROADCAST_MINIMUM',
  'position.gps_update_interval':                    'GPS_UPDATE',
  'display.screen_on_secs':                          'DISPLAY_SCREEN_ON',
  'display.auto_screen_carousel_secs':               'DISPLAY_CAROUSEL',
  'external_notification.nag_timeout':               'NAG_TIMEOUT',
  'external_notification.output':                    'OUTPUT',
  'external_notification.output_vibra':              'OUTPUT',
  'external_notification.output_buzzer':             'OUTPUT',
  'detection_sensor.minimum_broadcast_secs':         'DETECTION_SENSOR_MINIMUM',
  'detection_sensor.state_broadcast_secs':           'DETECTION_SENSOR_STATE',
  'paxcounter.paxcounter_update_interval':           'PAX_COUNTER',
  'range_test.sender':                               'RANGE_TEST_SENDER',
};

/** The options for one field, or null when it is not a mapped interval field. */
export function optionsFor(section, field) {
  const cfg = FIELD_CONFIGURATION[`${section}.${field}`];
  const secs = cfg && INTERVAL_CONFIGURATIONS[cfg];
  if (!secs) return null;
  return secs.map(value => ({ value, label: intervalLabel(value) }));
}

/** Rewrite a section schema so mapped interval fields become a CHOICE.
 *
 *  `type: 'choice'` is a NEW type and deliberately not `enum`. Enum options are
 *  bare strings used as both value and label, so reusing it would make the select
 *  emit the STRING "1800" where the protobuf needs an int — sending a wrong-TYPED
 *  value in order to fix wrong-VALUED ones.
 *
 *  Returns a copy; the input is not mutated. */
export function decorateSchema(section, schema) {
  if (!schema?.fields) return schema;
  return {
    ...schema,
    fields: schema.fields.map(f => {
      const options = optionsFor(section, f.name);
      if (!options) return f;
      // min/max/hint/unit ALL go. An allowlist has no out-of-range state, and a
      // leftover advisory beside a closed set invites someone to trust it.
      //
      // I stripped only min/max the first time and the browser caught the rest:
      // the telemetry intervals rendered as dropdowns still captioned
      //   "min 1800 (firmware-enforced); 0 = use default (3600 s)"
      // under a list whose lowest option is 1800 and which offers no 0 at all.
      // The caption described a numeric-entry contract that no longer exists, and
      // named a value the control cannot express — worse than no caption, because
      // it reads as instruction.
      //
      // `unit` goes for the same reason: the label said "seconds" beside a value
      // reading "30 minutes". The option labels ARE the units now.
      const { min, max, hint, unit, ...rest } = f;
      return { ...rest, type: 'choice', options };
    }),
  };
}
