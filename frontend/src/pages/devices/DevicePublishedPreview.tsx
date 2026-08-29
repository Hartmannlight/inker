interface DevicePublishedPreviewProps {
  loading: boolean;
  previewUrl: string | null;
  error: string | null;
}

/** Presentation-only states for the authenticated immutable device artifact. */
export function DevicePublishedPreview({ loading, previewUrl, error }: DevicePublishedPreviewProps) {
  if (loading) {
    return <div className="bg-bg-muted rounded-lg px-4 py-10 text-center text-sm text-text-muted">Loading published preview…</div>;
  }
  if (previewUrl) {
    return <img src={previewUrl} alt="Current published device content" className="w-full rounded-lg border border-border-light" />;
  }
  if (error) {
    return <div className="bg-status-error-bg rounded-lg px-4 py-10 text-center text-sm text-status-error-text">Unable to load the published preview: {error}</div>;
  }
  return <>
    <div className="bg-bg-muted rounded-lg px-4 py-10 text-center text-sm text-text-muted">No published content is assigned to this device.</div>
    <p className="text-xs text-text-muted mt-2 text-center">Assign a publication to preview its immutable device artifact.</p>
  </>;
}
