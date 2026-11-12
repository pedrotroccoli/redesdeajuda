// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
// Site estático no GitHub Pages com domínio próprio (apex) → base na raiz.
export default defineConfig({
  site: 'https://redesdeapoio.com.br',
  base: '/',
});
