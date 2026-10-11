import type { SessionManager } from '../../src/net/session.js';

/** A real in-memory session for route tests that exercise authenticated gameplay. */
export function adoptGameSession(session: SessionManager, token = 'token', userId = 'u1'): void {
  session.adopt({
    user: { id: userId, handle: userId, country: null, createdAt: '2020-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: token, tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  }, false);
}
