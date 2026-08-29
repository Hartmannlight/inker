import type { ReactNode } from 'react';
import { GrafanaConnectionModal } from './GrafanaConnectionModal';

interface PluginInstance {
  id: number;
  pluginId: number;
  name?: string;
  settings: Record<string, any>;
  plugin: { id: number; slug: string; name: string };
}

export interface PluginAction {
  key: string;
  label: string;
  icon: ReactNode;
  iconOnly?: boolean;
  variant?: 'default' | 'primary';
  /** If set, clicking navigates to this path instead of opening a modal */
  navigateTo?: (instance: PluginInstance) => string;
  modalSize?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  modalTitle?: string;
  isVisible: (instance: PluginInstance) => boolean;
  renderModal?: (instance: PluginInstance, onClose: () => void) => ReactNode;
}

const isGrafanaParent = (instance: PluginInstance) =>
  !instance.settings?.parentInstanceId;

const grafanaActions: PluginAction[] = [
  {
    key: 'grafana-connection',
    label: 'Settings',
    iconOnly: true,
    modalSize: 'md',
    modalTitle: 'Grafana Connection',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    isVisible: isGrafanaParent,
    renderModal: (instance, onClose) => (
      <GrafanaConnectionModal
        instanceId={instance.id}
        onSaved={onClose}
      />
    ),
  },
  {
    key: 'grafana-generator',
    label: 'Generate Screen',
    variant: 'primary',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    ),
    isVisible: isGrafanaParent,
    navigateTo: (instance) => `/plugins/instances/${instance.id}/generate`,
  },
];

// Retain the component definitions temporarily for an existing open modal, but
// do not register them for new user flows.
void grafanaActions;

// Grafana plugin actions were retired with the worker-owned Source flow.
// Legacy instances redirect to /integrations/grafana instead of opening these
// legacy settings or creating child instances.
const pluginActionRegistry: Record<string, PluginAction[]> = {};

export function getPluginActions(slug: string): PluginAction[] {
  return pluginActionRegistry[slug] || [];
}
