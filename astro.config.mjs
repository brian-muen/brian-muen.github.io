// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://brian-muen.github.io',
  redirects: {
    '/writing': '/essays',
    '/writing/archive/[...slug]': '/essays/archive/[...slug]',
  },
});
