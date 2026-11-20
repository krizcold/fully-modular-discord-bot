// Builds the web panel's scripts: node scripts/buildFrontend.cjs writes <repo root>/webui-built/.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'src', 'webui', 'public');

// The source files are classic global-scope scripts: each list is the load order of its page.
const ADMIN_FILES = [
  'utils/api.js',
  'utils/graveyardRestore.js',
  'utils/websocket.js',
  'utils/discordFormatters.js',
  'utils/toast.js',
  'assets/utils/uiHelpers.jsx',
  'components/BotControlPanel.jsx',
  'components/DataBackupsPanel.jsx',
  'components/credentials/BotCredentialsSection.jsx',
  'components/credentials/OAuthCredentialsSection.jsx',
  'components/credentials/OwnerMessagesSection.jsx',
  'components/CredentialsPanel.jsx',
  'components/ConfigPanel.jsx',
  'components/LogsPanel.jsx',
  'components/update/UpdateStatus.jsx',
  'components/update/UpdateBackups.jsx',
  'components/UpdatePanel.jsx',
  'assets/components/panels/PanelComponents.jsx',
  'assets/components/panels/PanelRenderer.jsx',
  'assets/components/panels/PanelViewer.jsx',
  'assets/components/panels/PanelList.jsx',
  'components/PanelsPanel.jsx',
  'components/premium/PremiumComponents.jsx',
  'components/AppStorePanel.jsx',
  'components/DevModulesPanel.jsx',
  'components/usage/UsageCharts.jsx',
  'components/usage/FleetView.jsx',
  'components/UsagePanel.jsx',
  'app.jsx',
];

// The member page may load only files under /assets/, so its bundle holds only files from public/assets/.
const GUILD_FILES = [
  'assets/utils/guildApi.js',
  'assets/utils/uiHelpers.jsx',
  'assets/components/panels/PanelComponents.jsx',
  'assets/components/panels/PanelRenderer.jsx',
  'assets/components/panels/PanelViewer.jsx',
  'assets/components/panels/PanelList.jsx',
  'assets/components/guild/OAuthLogin.jsx',
  'assets/components/guild/GuildSelector.jsx',
  'assets/components/guild/GuildPanelsPanel.jsx',
  'assets/components/guild/GuildSubscriptionPanel.jsx',
  'assets/guildApp.jsx',
];

const VENDOR_OUTPUT = 'assets/vendor.js';
const GUILD_OUTPUT = 'assets/guild.js';
const ADMIN_OUTPUT = 'admin.js';
const OUTPUT_FILES = [VENDOR_OUTPUT, GUILD_OUTPUT, ADMIN_OUTPUT];

const VENDOR_ENTRY = [
  "import React from 'react';",
  "import ReactDOM from 'react-dom';",
  'window.React = React;',
  'window.ReactDOM = ReactDOM;',
].join('\n');

function write(outDir, rel, text) {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function buildVendor(outDir) {
  const result = await esbuild.build({
    stdin: { contents: VENDOR_ENTRY, resolveDir: REPO_ROOT, sourcefile: 'vendor-entry.js', loader: 'js' },
    bundle: true,
    format: 'iife',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    write: false,
    logLevel: 'silent',
  });
  write(outDir, VENDOR_OUTPUT, result.outputFiles[0].text);
}

// Joined and transformed, never bundled: the result stays one classic script, so top-level names stay global.
async function buildClassic(outDir, rel, files) {
  const joined = files.map(f => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf-8')).join('\n;\n');
  const result = await esbuild.transform(joined, {
    loader: 'jsx',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    minifyWhitespace: true,
    minifySyntax: true,
    sourcefile: rel,
    logLevel: 'silent',
  });
  write(outDir, rel, result.code);
}

async function build(outDir) {
  await buildVendor(outDir);
  await buildClassic(outDir, GUILD_OUTPUT, GUILD_FILES);
  await buildClassic(outDir, ADMIN_OUTPUT, ADMIN_FILES);
}

module.exports = { ADMIN_FILES, GUILD_FILES, OUTPUT_FILES, build };

if (require.main === module) {
  const outDir = path.join(REPO_ROOT, 'webui-built');
  build(outDir).then(() => {
    for (const f of OUTPUT_FILES) {
      console.log(`[WebUI] Built ${f} (${fs.statSync(path.join(outDir, f)).size} bytes)`);
    }
  }).catch(err => {
    console.error(`[WebUI] The web panel's scripts were not built: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
