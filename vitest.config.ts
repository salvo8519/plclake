import { defineConfig } from 'vitest/config';

// Test-only credentials. Application code contains no default passwords: built-in accounts
// read them from the environment (see seedBuiltInUsers in src/authAudit.ts).
export const TEST_CREDENTIALS = {
  AUTH_ADMIN_PASSWORD: 'AdminPlant2026!',
  AUTH_DEMO_OPERATOR_PASSWORD: 'OperatorPlant2026!',
  AUTH_DEMO_VIEWER_PASSWORD: 'ViewerPlant2026!',
} as const;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      ...TEST_CREDENTIALS,
      AUTH_SEED_DEMO_USERS: 'true',
      // Fail fast in tests instead of retrying an unreachable database.
      DATABASE_CONNECT_RETRIES: '1',
    },
  },
});
