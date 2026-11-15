import {defineConfig} from 'vite';

// The UI calls the API on its own origin (/api/v1/..., /health). In development and in
// `npm run preview` Vite forwards those paths to the FastAPI backend, so no CORS setup is needed.
// Another backend address: VITE_BACKEND_URL=http://host:port npm run dev
const backend = process.env.VITE_BACKEND_URL || 'http://127.0.0.1:8000';
const proxy = {
  '/api': {target: backend, changeOrigin: true},
  '/health': {target: backend, changeOrigin: true},
};

export default defineConfig({
  server: {proxy},
  preview: {proxy},
  build: {chunkSizeWarningLimit: 1700},
});
