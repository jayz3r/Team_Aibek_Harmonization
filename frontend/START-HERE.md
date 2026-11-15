# Quick start

Install Node.js 22.12+ (or 20.19+). In this folder:

```sh
npm ci
npm run dev
```

Open the address Vite prints. With the backend running on port 8000 (see ../README.md) the header
shows **LIVE API**; without it the app runs as an offline showcase.

- Production build: `npm run build` (then the backend serves it at http://localhost:8000)
- Tests: `npm test`
- Another backend address: `VITE_BACKEND_URL=http://host:port npm run dev`, or set it in the Data panel

Internet is required for map tiles and elevation. node_modules is not included; `npm ci` restores it.
