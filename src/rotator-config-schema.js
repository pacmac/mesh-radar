export const ROTATOR_CONFIG_SCHEMA = {
  fields: [
    {
      name: 'motor',
      type: 'object',
      fields: [
        { name: 'pwm_min',        type: 'int' },
        { name: 'pwm_run',        type: 'int' },
        { name: 'pulses_per_deg', type: 'float' },
      ],
    },
    {
      name: 'scan',
      type: 'object',
      fields: [
        { name: 'step_deg',  type: 'int' },
        { name: 'dwell_sec', type: 'float' },
      ],
    },
    {
      name: 'actv',
      type: 'object',
      fields: [
        { name: 'dwell_sec', type: 'float' },
      ],
    },
  ],
};
