import { useEffect, useState } from 'react';
import apiClient, { settingsService } from '../../services/api';
import { useNotification } from '../../contexts/NotificationContext';

interface GrafanaConnectionModalProps {
  instanceId: number;
  onSaved: () => void;
}

const MASK = '••••••••';

const inputClasses =
  'w-full px-3 py-2.5 rounded-lg border border-border-light bg-bg-input text-text-primary placeholder-text-placeholder focus:ring-2 focus:ring-accent/20 focus:border-accent transition-all';

export function GrafanaConnectionModal({ instanceId, onSaved }: GrafanaConnectionModalProps) {
  const { error: notifyError, success: notifySuccess } = useNotification();
  const [grafanaUrl, setGrafanaUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [allowLocalNetwork, setAllowLocalNetwork] = useState(false);

  // Fetch masked instance settings + local network setting on mount
  useEffect(() => {
    Promise.all([
      apiClient.get(`/plugins/instances/${instanceId}`),
      settingsService.getAll(),
    ])
      .then(([instanceRes, settings]) => {
        const s = instanceRes.data.data?.settings || instanceRes.data.settings || {};
        setGrafanaUrl(s.grafana_url ?? '');
        setApiKey(s.api_key ?? '');
        setAllowLocalNetwork(settings.allow_local_network === 'true');
      })
      .catch(() => notifyError('Failed to load settings'))
      .finally(() => setLoading(false));
  }, [instanceId, notifyError]);

  const apiKeyIsSet = apiKey === MASK;

  const handleSave = async () => {
    setSaving(true);
    try {
      const settings: Record<string, unknown> = { grafana_url: grafanaUrl };
      if (!apiKeyIsSet) {
        settings.api_key = apiKey;
      }
      await apiClient.put(`/plugins/instances/${instanceId}`, { settings });
      notifySuccess('Connection settings saved');
      onSaved();
    } catch {
      notifyError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-text-primary mb-1.5">
          Grafana URL <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={grafanaUrl}
          onChange={(e) => setGrafanaUrl(e.target.value)}
          className={inputClasses}
          placeholder="http://localhost:3000"
        />
      </div>

      <div className="flex items-center justify-between p-3 rounded-lg border border-border-light bg-bg-muted">
        <div>
          <h3 className="text-sm font-medium text-text-primary">Allow local network access</h3>
          <p className="text-xs text-text-muted mt-0.5">Required if Grafana is on your local network</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allowLocalNetwork}
          onClick={async () => {
            const newValue = !allowLocalNetwork;
            setAllowLocalNetwork(newValue);
            try {
              await settingsService.update('allow_local_network', String(newValue));
            } catch {
              setAllowLocalNetwork(!newValue);
              notifyError('Failed to update setting');
            }
          }}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
            allowLocalNetwork ? 'bg-accent' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              allowLocalNetwork ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-1.5">
          API Key <span className="text-red-500">*</span>
        </label>
        {apiKeyIsSet && !editingApiKey ? (
          <div className="flex items-center gap-2">
            <div className={`${inputClasses} flex items-center gap-2 text-text-muted`}>
              <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              API key is configured
            </div>
            <button
              onClick={() => { setEditingApiKey(true); setApiKey(''); }}
              className="shrink-0 px-3 py-2.5 rounded-lg text-sm font-medium border border-border-light text-text-secondary hover:bg-bg-muted transition-colors"
            >
              Change
            </button>
          </div>
        ) : (
          <input
            type="password"
            value={apiKey === MASK ? '' : apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className={inputClasses}
            placeholder="Enter API key"
          />
        )}
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving || !grafanaUrl || (!apiKeyIsSet && !apiKey)}
          className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
          ) : (
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          )}
          Save
        </button>
      </div>
    </div>
  );
}
