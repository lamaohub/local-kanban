// Example pm2 config. Copy it to ecosystem.config.cjs (git-ignored, so local paths and env
// never leave your machine), adjust it, then: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'kanban',
      script: 'src/server.js',
      // cwd: '/absolute/path/to/local-kanban', // when starting pm2 outside the project folder
      env: {
        PORT: '3100',              // the board listens on 127.0.0.1 ONLY — never expose it
        NODE_ENV: 'production',
        // KB_DATA_DIR: '',        // data directory (defaults to ~/.local-kanban, or data/ in a clone)
        // KB_LOCAL_ROOT: '',      // root of local project folders (defaults to ~/claude-projects)
        // KB_GH_OWNER: '',        // GitHub sync; empty = sync off (can also be set in Settings)
        // KB_GH_REPO: '',         // repository for issues, owner/repo
        // KB_PANEL_URL: '',       // custom HTTP source of service statuses; empty = local pm2
        // KB_PANEL_INFO: '',      // optional info.json of an external panel, for category sync
        //                         // (the older names PANEL_URL/PANEL_INFO still work)
        // KB_SKILLS_EXTRA: '',    // extra skill root directories, ':'-separated
      },
      max_memory_restart: '200M',
      merge_logs: true,
    },
  ],
};
