import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { authService, type AdminSessionSummary } from '../../services/api';
import { Card } from '../common';

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function AdminSessions() {
  const { logoutAll } = useAuth();
  const [sessions, setSessions] = useState<AdminSessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authService.listSessions()
      .then(setSessions)
      .catch(() => setError('Could not load administrator sessions.'))
      .finally(() => setLoading(false));
  }, []);

  const revoke = async (sessionId: string) => {
    try {
      await authService.revokeSession(sessionId);
      setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
    } catch {
      setError('Could not revoke that session.');
    }
  };

  return (
    <Card>
      <div className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-text-primary">Administrator sessions</h3>
            <p className="text-sm text-text-secondary mt-1">
              Review active browser sessions and revoke devices you no longer use.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void logoutAll()}
            className="px-3 py-2 rounded-lg bg-status-error-bg text-status-error-text text-sm font-medium"
          >
            Log out all
          </button>
        </div>

        {loading && <p className="text-sm text-text-secondary">Loading sessions...</p>}
        {error && <p role="alert" className="text-sm text-status-error-text">{error}</p>}
        {!loading && !error && sessions.length === 0 && (
          <p className="text-sm text-text-secondary">No active sessions.</p>
        )}
        <ul className="divide-y divide-border-light">
          {sessions.map((session) => (
            <li key={session.sessionId} className="py-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">
                  {session.userAgent || 'Unknown browser'} {session.current ? '(this session)' : ''}
                </p>
                <p className="text-xs text-text-secondary">
                  Last active {formatDate(session.lastSeenAt)} · expires {formatDate(session.expiresAt)}
                </p>
              </div>
              {!session.current && (
                <button
                  type="button"
                  onClick={() => void revoke(session.sessionId)}
                  className="px-3 py-1.5 rounded-lg border border-border-light text-sm text-text-primary"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
