module.exports = {
  apps: [
    {
      name: 'botvpn-standalone',
      script: 'app.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
