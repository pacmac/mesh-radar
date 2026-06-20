module.exports = {
  apps: [
    {
      name: "node-dash",
      script: "src/index.js",
      cwd: "/usr/share/pac/dev/pio/projects/mt-yagi/node-dash",
      interpreter: "node",
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: 8000,
        BRIDGE_URL: "http://localhost:8001",
        BRIDGE_WS_URL: "ws://localhost:8001",
        DB_PATH: "/usr/share/pac/dev/pio/projects/mt-yagi/node-dash/data/node-dash.db",
        ROTATOR_WS_URL: "ws://192.168.10.186:81",
      },
    },
  ],
};
