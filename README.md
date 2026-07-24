# WAN Super App

Satu shell Electron untuk:

1. **WAN CLIProxyAPI** — Chat, Cowork, Neuron, VS Code / JetBrains (logic dari `wan-cliproxyapi`)
2. **WAN NET** — Cloudflare tunnel + inspector (logic dari `wan-net`)

Buka app → Hub (2 kartu) → pilih modul → UI & fungsi seperti app aslinya.

Lihat [HANDBOOK-WAN-SUPER-APP.md](./HANDBOOK-WAN-SUPER-APP.md) untuk arsitektur lengkap.

## Requirements

- Node.js 20+
- macOS / Windows / Linux

## Setup

```bash
cd wan-super-app
npm install
npm run build
npm start
```

Dev (HMR hub + cliproxy renderer):

```bash
npm run dev
```

## Scripts

| Script | Fungsi |
|--------|--------|
| `npm run build` | compile main + cliproxy main, copy assets, vite hub + cliproxy |
| `npm run dev` | vite dual + electron |
| `npm start` | build lalu electron |
| `npm run dist` | electron-builder |
| `npm run vendor:sync` | rsync dari sibling `wan-cliproxyapi` / `wan-net` |

## Data paths

| Data | Path |
|------|------|
| Hub settings | `{userData}/super-app.json` |
| CLIProxyAPI home | `~/.wan-super-app/cliproxyapi` |
| WAN NET config | `{userData}/wan-net-cfg.json` |

## Layout

```
src/main/           Super App shell (hub, tray, lifecycle)
src/hub-renderer/   Hub UI (2 cards)
modules/cliproxy/   Working copy CLIProxyAPI + super-boot
modules/net/        Working copy WAN NET + embed API
vendor/             Read-only snapshots
```

## Notes

- Electron pinned `^31` (compatible with wan-net CJS + cliproxy ESM shell).
- Net module loads via `createRequire` (`boot.cjs`); cliproxy via dynamic `import`.
- Only Super App owns `app.whenReady`, tray, and quit.
