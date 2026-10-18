import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :4000; in production Express serves the built client itself.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
});
