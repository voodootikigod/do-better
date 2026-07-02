# tiny-app

A tiny demo application used as a brownfield analysis target in do-better
tests. It exposes two HTTP routes (`/health`, `/version`) and a small CLI
(`tiny-tool`).

## Run

```bash
npm start          # serve on :3000
npm test           # node --test
tiny-tool greet x  # CLI
```

TODO: document the deploy process.
