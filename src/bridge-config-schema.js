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
    {
      name: 'claude_chat',
      type: 'object',
      label: 'Claude AI Chat',
      fields: [
        { name: 'enabled',          type: 'bool',   label: 'Enable' },
        { name: 'trigger_word',     type: 'string', label: 'Trigger word', hint: 'e.g. @claude' },
        { name: 'system_prompt',    type: 'string', label: 'System prompt' },
        { name: 'max_history',      type: 'int',    label: 'Max history (messages)' },
        { name: 'max_reply_length', type: 'int',    label: 'Max reply length (chars)' },
        { name: 'whitelist',        type: 'string', label: 'Whitelist (comma-separated !hex IDs)', hint: 'Empty = my_nodes only' },
        { name: 'my_nodes',         type: 'string', label: 'My nodes (comma-separated !hex IDs)', hint: 'Always allowed' },
      ],
    },
  ],
};
