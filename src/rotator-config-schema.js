// v4 motor: PWM DC motor. v5 motor: NEMA8 stepper / TMC2209.
// scan/actv groups are shared across both firmwares.
const SCAN_GROUP = {
  name: 'scan',
  type: 'object',
  fields: [
    { name: 'step_deg',  type: 'int' },
    { name: 'dwell_sec', type: 'float' },
  ],
};
const ACTV_GROUP = {
  name: 'actv',
  type: 'object',
  fields: [
    { name: 'dwell_sec', type: 'float' },
  ],
};

const V4_FIELDS = [
  {
    name: 'motor',
    type: 'object',
    fields: [
      { name: 'pwm_min',        type: 'int' },
      { name: 'pwm_run',        type: 'int' },
      { name: 'pulses_per_deg', type: 'float' },
    ],
  },
  SCAN_GROUP,
  ACTV_GROUP,
];

const V5_FIELDS = [
  {
    name: 'motor',
    type: 'object',
    fields: [
      { name: 'run_ma',   type: 'int' },
      { name: 'hold_pct', type: 'int' },
      { name: 'sps',      type: 'int' },
      { name: 'usteps',   type: 'int' },
    ],
  },
  SCAN_GROUP,
  ACTV_GROUP,
];

// Top-level `fields` stays == v4 so the current browser settings form renders
// unchanged; `variants` adds the per-firmware schema for a later Domain-2 task.
export const ROTATOR_CONFIG_SCHEMA = {
  fields: V4_FIELDS,
  variants: {
    v4: { fields: V4_FIELDS },
    v5: { fields: V5_FIELDS },
  },
};
