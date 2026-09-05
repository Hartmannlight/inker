import { type ReactNode, useCallback, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { MainLayout } from '../../components/layout';
import { Button, LoadingSpinner, Modal } from '../../components/common';
import { useApi, useMutation } from '../../hooks/useApi';
import { config } from '../../config';
import apiClient from '../../services/api';
import { getPluginActions, type PluginAction } from '../../components/plugins/plugin-actions';
import type { PluginInstance } from '../../types';

interface ActiveModal {
  title: string;
  size: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  content: ReactNode;
}

export function InstalledPlugins() {
  const navigate = useNavigate();
  const [deleteTarget, setDeleteTarget] = useState<PluginInstance | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);

  const fetchInstances = useCallback(
    () => apiClient.get<{ data: PluginInstance[] }>('/plugins/instances/all').then((res) => res.data.data),
    []
  );

  const { data: instances, isLoading, refetch } = useApi<PluginInstance[]>(fetchInstances);

  const deleteMutation = useMutation<void, number>(
    (instanceId) => apiClient.delete(`/plugins/instances/${instanceId}`).then((res) => res.data),
    {
      successMessage: 'Plugin instance deleted',
      onSuccess: () => {
        setDeleteTarget(null);
        refetch();
      },
    }
  );

  const handleDelete = () => {
    if (deleteTarget) {
      deleteMutation.mutate(deleteTarget.id);
    }
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Installed Plugins</h1>
            <p className="mt-2 text-text-muted">
              Manage your active plugin instances
            </p>
          </div>
          <Button onClick={() => navigate('/plugins')}>
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            Plugin Library
          </Button>
        </div>

        {/* Instance Grid */}
        {isLoading ? (
          <div className="flex justify-center items-center py-20">
            <LoadingSpinner size="lg" />
          </div>
        ) : !instances || instances.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {instances.map((instance) => (
              <InstanceCard
                key={instance.id}
                instance={instance}
                onSettings={() => navigate(`/plugins/instances/${instance.id}`)}
                onDelete={() => setDeleteTarget(instance)}
                onAction={(action) => {
                  if (action.navigateTo) {
                    navigate(action.navigateTo(instance));
                    return;
                  }
                  if (!action.renderModal) return;
                  const closeModal = () => { setActiveModal(null); refetch(); };
                  setActiveModal({
                    title: action.modalTitle || action.label,
                    size: action.modalSize || 'md',
                    content: action.renderModal(instance, closeModal),
                  });
                }}
              />
            ))}
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {deleteTarget && (
          <Modal
            isOpen={true}
            onClose={() => setDeleteTarget(null)}
            title="Delete Plugin Instance"
          >
            <div className="space-y-4">
              <p className="text-text-secondary">
                Are you sure you want to delete{' '}
                <span className="font-semibold text-text-primary">
                  {deleteTarget.name || deleteTarget.plugin.name}
                </span>
                ? This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="px-4 py-2 rounded-lg border border-border-light text-text-secondary hover:bg-bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleteMutation.isLoading}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {deleteMutation.isLoading ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {/* Plugin Action Modal */}
        {activeModal && (
          <Modal
            isOpen={true}
            onClose={() => { setActiveModal(null); refetch(); }}
            title={activeModal.title}
            size={activeModal.size}
          >
            {activeModal.content}
          </Modal>
        )}
      </div>
    </MainLayout>
  );
}

interface InstanceCardProps {
  instance: PluginInstance;
  onSettings: () => void;
  onDelete: () => void;
  onAction: (action: PluginAction) => void;
}

function InstanceCard({ instance, onSettings, onDelete, onAction }: InstanceCardProps) {
  const previewUrl = `${config.apiUrl}/plugins/instances/${instance.id}/render?mode=einkPreview`;
  const actions = getPluginActions(instance.plugin.slug).filter(a => a.isVisible(instance));

  return (
    <div className="bg-bg-card rounded-xl shadow-theme-sm border border-border-light transition-all duration-200 hover:shadow-theme-lg flex flex-col">
      {/* Preview Thumbnail */}
      <div className="p-3 pb-0">
        <div className="bg-bg-muted rounded-lg overflow-hidden border border-border-light" style={{ aspectRatio: '160 / 96' }}>
          <img
            src={previewUrl}
            alt={`${instance.plugin.name} preview`}
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      </div>

      {/* Card Body */}
      <div className="p-5 flex-1">
        <h3 className="text-lg font-semibold text-text-primary truncate">{instance.plugin.name}</h3>
        {instance.name && (
          <p className="text-sm text-text-muted truncate mt-0.5">{instance.name}</p>
        )}

        <div className="mt-3 space-y-2 text-sm">
          {instance.lastFetchedAt && (
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Last fetched</span>
              <span className="text-text-secondary">{formatRelativeTime(instance.lastFetchedAt)}</span>
            </div>
          )}

          {instance.lastError && (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
                Error
              </span>
              <span className="text-xs text-text-muted truncate">{instance.lastError}</span>
            </div>
          )}
        </div>
      </div>

      {/* Card Footer */}
      <div className="px-5 py-3 border-t border-border-light flex items-center gap-2">
        {actions.length > 0 ? (
          <>
            {actions.map((action) => (
              <button
                key={action.key}
                onClick={() => onAction(action)}
                className={`inline-flex items-center justify-center rounded-lg text-sm font-medium transition-colors ${
                  action.iconOnly
                    ? 'px-3 py-2 bg-bg-muted text-text-secondary hover:bg-bg-accent hover:text-text-primary border border-border-light'
                    : action.variant === 'primary'
                      ? 'flex-1 px-4 py-2 bg-accent text-white hover:opacity-90'
                      : 'flex-1 px-3 py-2 bg-bg-muted text-text-secondary hover:bg-bg-accent hover:text-text-primary border border-border-light'
                }`}
                title={action.label}
              >
                {action.icon}
                {!action.iconOnly && <span className="ml-1.5">{action.label}</span>}
              </button>
            ))}
          </>
        ) : (
          <button
            onClick={onSettings}
            className="flex-1 inline-flex items-center justify-center px-3 py-2 rounded-lg text-sm font-medium bg-bg-muted text-text-secondary hover:bg-bg-accent hover:text-text-primary border border-border-light transition-colors"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Settings
          </button>
        )}
        <button
          onClick={onDelete}
          className="inline-flex items-center justify-center px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 border border-border-light transition-colors"
          title="Delete"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-bg-card rounded-xl shadow-theme-sm border border-border-light py-16 px-8 text-center">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-bg-muted text-text-muted mb-4">
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-text-primary mb-2">No plugins installed yet</h3>
      <p className="text-text-muted mb-6 max-w-sm mx-auto">
        Visit the Plugin Library to browse and install plugins for your devices.
      </p>
      <Link
        to="/plugins"
        className="inline-flex items-center px-4 py-2.5 rounded-lg bg-text-primary text-text-inverse font-medium hover:opacity-90 transition-opacity"
      >
        <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
        Browse Plugin Library
      </Link>
    </div>
  );
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
