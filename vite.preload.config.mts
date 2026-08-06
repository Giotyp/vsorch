import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [
    {
      // @electron-forge/plugin-vite hardcodes the deprecated
      // rollupOptions.output.inlineDynamicImports; vite's config merge can't
      // unset a key, so swap it for codeSplitting: false directly on the
      // resolved config to silence the deprecation warning.
      name: 'fix-inline-dynamic-imports-deprecation',
      config(config) {
        const output = config.build?.rollupOptions?.output;
        if (output && !Array.isArray(output)) {
          delete output.inlineDynamicImports;
          output.codeSplitting = false;
        }
      },
    },
  ],
});
