export const BRIDGE_CONFIG_SCHEMA = {
  fields: [
    {
      name: 'message_cache',
      type: 'object',
      fields: [
        { name: 'enabled',         type: 'bool' },
        { name: 'max_messages',    type: 'int' },
        { name: 'max_age_seconds', type: 'int' },
      ],
    },
    {
      name: 'mqtt_publish',
      type: 'object',
      fields: [
        { name: 'enabled',             type: 'bool' },
        { name: 'broker',              type: 'string' },
        { name: 'port',                type: 'int' },
        { name: 'username',            type: 'string' },
        { name: 'password',            type: 'string' },
        { name: 'use_tls',             type: 'bool' },
        { name: 'topic_prefix',        type: 'string' },
        { name: 'ha_discovery',        type: 'bool' },
        { name: 'ha_discovery_prefix', type: 'string' },
      ],
    },
  ],
};
