import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), {
    name: 'books-reader-notices',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'books-reader-notices.txt',
        source: fs.readFileSync(path.resolve(__dirname, '.reader-build', 'notices.txt'), 'utf8') });
      const assets: Array<{ path: string }> = JSON.parse(fs.readFileSync(path.resolve(__dirname, '.reader-build', 'pdf-assets.json'), 'utf8'));
      for (const asset of assets) this.emitFile({
        type: 'asset', fileName: `books-pdf/${asset.path}`,
        source: fs.readFileSync(path.resolve(__dirname, 'node_modules', 'pdfjs-dist', asset.path)),
      });
    },
  }],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:5069',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
