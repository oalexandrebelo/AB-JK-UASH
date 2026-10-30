import {defineConfig, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';
import macros from 'unplugin-parcel-macros';
import optimizeLocales from '@react-aria/optimize-locales-plugin';
import tailwindcss from '@tailwindcss/vite';
import {fileURLToPath, URL} from 'node:url';

/**
 * Spectrum components stay unchanged. Only Adobe's private Typekit font loader
 * is omitted: the application supplies the open source Inter font locally.
 * Keep this explicit and version-pinned so offline builds never contact Typekit.
 */
function localSpectrumFonts(): Plugin {
  return {
    name: 'ab-uash-local-spectrum-fonts',
    enforce: 'pre',
    load(id) {
      if (id.replaceAll('\\', '/').endsWith('/@react-spectrum/s2/dist/private/Fonts.mjs')) {
        return 'export function Fonts() { return null; }';
      }
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    macros.vite(),
    localSpectrumFonts(),
    react(),
    {...optimizeLocales.vite({locales: ['pt-BR']}), enforce: 'pre'},
  ],
  resolve: {alias: {'@': fileURLToPath(new URL('./src', import.meta.url))}},
  optimizeDeps: {exclude: ['@react-spectrum/s2']},
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {'/api': {
      target: 'http://127.0.0.1:4173',
      changeOrigin: true,
      configure(proxy) {
        proxy.on('proxyReq', request => request.setHeader('Origin', 'http://127.0.0.1:4173'));
      },
    }},
  },
  preview: {host: '127.0.0.1', port: 4174, strictPort: true},
  build: {
    target: ['es2022'],
    cssMinify: 'lightningcss',
    cssCodeSplit: false,
  },
});
