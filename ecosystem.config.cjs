module.exports = {
  apps: [
    {
      name: "node-dash",
      script: "src/index.js",
      cwd: "/usr/share/pac/dev/projects/mt-radar/node-dash",
      interpreter: "node",
      watch: ["src"],
      ignore_watch: ["node_modules", "data", "public"],
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: 8000,
        BRIDGE_URL: "http://localhost:8001",
        BRIDGE_WS_URL: "ws://localhost:8001",
        ROTATOR_WS_URL: "ws://192.168.10.186:81",
        ROTATOR_V5_WS_URL: "ws://192.168.10.195:81",
        // Optional alarm-transport plugin (portnums 256/260/261, chunked
        // transfer). Path-resolved rather than npm-installed: the module moves
        // with the firmware it mirrors, so a vendored copy would drift the
        // moment the wire format changes (agreed with mt-transport, Q&A Q4).
        // Unset or wrong => node-dash boots exactly as before, with the
        // alarm-specific surfaces simply absent.
        MT_TRANSPORT_PATH: "/usr/share/pac/dev/pio/projects/mt-transport/clients/node/index.js",
      },
    },
  ],
};
