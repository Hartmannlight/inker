import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DevicePublishedPreview } from './DevicePublishedPreview';

describe('DevicePublishedPreview', () => {
  it('shows an explicit loading state', () => {
    render(<DevicePublishedPreview loading previewUrl={null} error={null} />);
    expect(screen.getByText('Loading published preview…')).toBeInTheDocument();
  });

  it('shows the immutable artifact on success', () => {
    render(<DevicePublishedPreview loading={false} previewUrl="blob:published" error={null} />);
    expect(screen.getByRole('img', { name: 'Current published device content' })).toHaveAttribute('src', 'blob:published');
  });

  it('shows a stable failure state', () => {
    render(<DevicePublishedPreview loading={false} previewUrl={null} error="RENDER_FAILED" />);
    expect(screen.getByText('Unable to load the published preview: RENDER_FAILED')).toBeInTheDocument();
  });

  it('explains when no immutable artifact is assigned', () => {
    render(<DevicePublishedPreview loading={false} previewUrl={null} error={null} />);
    expect(screen.getByText('No published content is assigned to this device.')).toBeInTheDocument();
  });
});
