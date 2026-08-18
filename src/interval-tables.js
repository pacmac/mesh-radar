// GENERATED FILE — DO NOT EDIT.
//
// Written by scripts/gen_interval_tables.mjs from
//            vendor/meshtastic-android/FixedUpdateIntervals.kt
//
// Regenerate:  node scripts/gen_interval_tables.mjs
// Verify:      node scripts/gen_interval_tables.mjs --check   (runs in npm run check)
//
// Spec: docs/modules/interval-tables.md. The hand-written half — the field ->
// configuration map, the labels, decorateSchema — lives in src/interval-options.js,
// because none of it is stated in the Kotlin.

/** Every named interval, in the enum's DECLARATION order. */
export const INTERVAL_NAMES = {
  UNSET: 0,
  ONE_SECOND: 1,
  TWO_SECONDS: 2,
  THREE_SECONDS: 3,
  FOUR_SECONDS: 4,
  FIVE_SECONDS: 5,
  TEN_SECONDS: 10,
  FIFTEEN_SECONDS: 15,
  TWENTY_SECONDS: 20,
  THIRTY_SECONDS: 30,
  FORTY_FIVE_SECONDS: 45,
  ONE_MINUTE: 60,
  TWO_MINUTES: 120,
  FIVE_MINUTES: 300,
  TEN_MINUTES: 600,
  FIFTEEN_MINUTES: 900,
  THIRTY_MINUTES: 1800,
  ONE_HOUR: 3600,
  TWO_HOURS: 7200,
  THREE_HOURS: 10800,
  FOUR_HOURS: 14400,
  FIVE_HOURS: 18000,
  SIX_HOURS: 21600,
  TWELVE_HOURS: 43200,
  EIGHTEEN_HOURS: 64800,
  TWENTY_FOUR_HOURS: 86400,
  THIRTY_SIX_HOURS: 129600,
  FORTY_EIGHT_HOURS: 172800,
  SEVENTY_TWO_HOURS: 259200,
  ALWAYS_ON: 2147483647,
  EIGHTY_SECONDS: 80,
  NINETY_SECONDS: 90,
  EIGHT_SECONDS: 8,
  FORTY_SECONDS: 40,
};

/** Each configuration's allowed intervals, in the order the app lists them.
 *
 *  ALL is `FixedUpdateIntervals.entries` — declaration order, NOT ascending. It
 *  ends 2147483647, 80, 90, 8, 40 because four members were appended to the enum
 *  after ALWAYS_ON. Sorting it would be a change to upstream data. */
export const INTERVAL_CONFIGURATIONS = {
  ALL:                      [0, 1, 2, 3, 4, 5, 10, 15, 20, 30, 45, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 18000, 21600, 43200, 64800, 86400, 129600, 172800, 259200, 2147483647, 80, 90, 8, 40],
  BROADCAST_SHORT:          [1800, 3600, 7200, 10800, 14400, 18000, 21600, 43200, 64800, 86400, 129600, 172800, 259200],
  BROADCAST_MEDIUM:         [3600, 7200, 10800, 14400, 18000, 21600, 43200, 64800, 86400, 129600, 172800, 259200],
  BROADCAST_LONG:           [10800, 14400, 18000, 21600, 43200, 64800, 86400, 129600, 172800, 259200],
  NODE_INFO_BROADCAST:      [0, 10800, 14400, 18000, 21600, 43200, 64800, 86400, 129600, 172800, 259200],
  OUTPUT:                   [0, 1, 2, 3, 4, 5, 10],
  DETECTION_SENSOR_MINIMUM: [0, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 18000, 21600, 43200, 64800, 86400, 129600, 172800, 259200],
  DETECTION_SENSOR_STATE:   [0, 900, 1800, 3600, 7200, 10800, 14400, 18000, 21600, 43200, 64800, 86400, 129600, 172800, 259200],
  NAG_TIMEOUT:              [0, 1, 5, 10, 15, 30, 60],
  PAX_COUNTER:              [900, 1800, 3600, 7200, 10800, 14400, 18000, 21600, 43200, 64800, 86400, 129600, 172800, 259200],
  POSITION:                 [1, 2, 5, 10, 15, 20, 30, 45, 60, 120, 300, 600, 900, 1800, 3600],
  POSITION_BROADCAST:       [0, 60, 90, 300, 900, 3600, 7200, 10800, 14400, 18000, 21600, 43200, 64800, 86400, 129600, 172800, 259200],
  GPS_UPDATE:               [0, 8, 20, 40, 60, 80, 120, 300, 600, 900, 1800, 3600, 21600, 43200, 86400],
  RANGE_TEST_SENDER:        [0, 15, 30, 45, 60, 300, 600, 900, 1800, 3600],
  SMART_BROADCAST_MINIMUM:  [15, 30, 45, 60, 300, 600, 900, 1800, 3600],
  DISPLAY_SCREEN_ON:        [15, 30, 60, 300, 600, 900, 1800, 3600, 2147483647],
  DISPLAY_CAROUSEL:         [0, 15, 30, 60, 300, 600, 900],
};
