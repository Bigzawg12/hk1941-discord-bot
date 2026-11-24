import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests never read the real environment: every config is built from a literal object.
    clearMocks: true,
    restoreMocks: true,
  },
});
