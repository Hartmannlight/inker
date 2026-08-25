import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, Input } from '../../components/common';
import { MainLayout } from '../../components/layout';
import { useMutation } from '../../hooks/useApi';
import { deviceService } from '../../services/api';
import type { Device, DeviceFormData } from '../../types';
import { DevicePairingPanel } from '../../components/devices/DevicePairingPanel';

type DeviceType = 'trmnl' | 'web-display';

const DEVICE_PROFILES = {
  'browser-hd-1920x1080': { label: 'Browser kiosk HD', type: 'web-display' as const, width: 1920, height: 1080 },
  'esp32-touch-reference-480x480': { label: 'ESP32 touch reference (unverified hardware mapping)', type: 'web-display' as const, width: 480, height: 480 },
  'trmnl-byod-7.5-mono': { label: 'TRMNL BYOD 7.5 monochrome', type: 'trmnl' as const, width: 800, height: 480 },
};

type ProfileId = keyof typeof DEVICE_PROFILES;

export function AddDevice() {
  const navigate = useNavigate();
  const [deviceType, setDeviceType] = useState<DeviceType>('web-display');
  const [profileId, setProfileId] = useState<ProfileId>('browser-hd-1920x1080');
  const [name, setName] = useState('');
  const [macAddress, setMacAddress] = useState('');
  const [width, setWidth] = useState('1920');
  const [height, setHeight] = useState('1080');
  const [created, setCreated] = useState<Device | null>(null);
  const { mutate: createDevice, isLoading } = useMutation(
    (data: DeviceFormData) => deviceService.create(data),
    { successMessage: 'Device created', onSuccess: setCreated },
  );

  const chooseType = (type: DeviceType) => {
    setDeviceType(type);
    setCreated(null);
    const nextProfile: ProfileId = type === 'web-display'
      ? 'browser-hd-1920x1080'
      : 'trmnl-byod-7.5-mono';
    const profile = DEVICE_PROFILES[nextProfile];
    setProfileId(nextProfile);
    setWidth(String(profile.width));
    setHeight(String(profile.height));
  };

  const chooseProfile = (nextProfileId: ProfileId) => {
    const profile = DEVICE_PROFILES[nextProfileId];
    setProfileId(nextProfileId);
    setWidth(String(profile.width));
    setHeight(String(profile.height));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await createDevice({
      name,
      deviceType,
      profileId,
      ...(deviceType === 'trmnl' ? { macAddress } : {}),
      width: Number(width),
      height: Number(height),
    });
  };

  return (
    <MainLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <Button variant="outline" size="sm" onClick={() => navigate('/devices')} className="mb-4">← Back to Devices</Button>
          <h1 className="text-3xl font-bold text-text-primary">Add Device</h1>
          <p className="mt-2 text-sm text-text-secondary">Choose how this display connects to Inker.</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <TypeCard active={deviceType === 'web-display'} title="Web Display" description="A PC, tablet, TV or kiosk browser. Updates arrive immediately over WebSocket." onClick={() => chooseType('web-display')} />
          <TypeCard active={deviceType === 'trmnl'} title="TRMNL / BYOD E-Ink" description="A compatible e-ink device using the existing setup and pull protocol." onClick={() => chooseType('trmnl')} />
        </div>

        <Card>
          {created ? (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-status-success-bg border border-status-success-border">
                <h2 className="font-semibold text-status-success-text">{created.name} is ready</h2>
                <p className="mt-1 text-sm text-status-success-text">
                  {created.deviceType === 'web-display'
                    ? 'Use the one-time code below on the target display. It expires after ten minutes.'
                    : 'The device can now use the existing TRMNL pull protocol.'}
                </p>
              </div>
              {created.deviceType === 'web-display' && (
                <DevicePairingPanel
                  deviceId={String(created.id)}
                  deviceName={created.name}
                  profileId={created.profileId ?? profileId}
                  autoStart
                />
              )}
              <Link to={`/devices/${created.id}`} className="inline-block text-sm text-accent underline">View device details</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">{deviceType === 'web-display' ? 'Create web display' : 'Register TRMNL device'}</h2>
                <p className="text-sm text-text-muted mt-1">
                  {deviceType === 'web-display' ? 'After creation you will receive a ten-minute one-time pairing code.' : 'Automatic provisioning through /api/setup remains supported.'}
                </p>
              </div>
              <Input label="Device name" value={name} onChange={(event) => setName(event.target.value)} required />
              <div>
                <label htmlFor="device-profile" className="block text-sm font-semibold text-text-secondary mb-2">Device profile</label>
                <select
                  id="device-profile"
                  value={profileId}
                  onChange={(event) => chooseProfile(event.target.value as ProfileId)}
                  className="block w-full rounded-xl border-2 border-border-light bg-bg-input px-4 py-2.5 text-text-primary focus:border-accent focus:outline-none"
                >
                  {Object.entries(DEVICE_PROFILES)
                    .filter(([, profile]) => profile.type === deviceType)
                    .map(([id, profile]) => <option key={id} value={id}>{profile.label}</option>)}
                </select>
                {profileId === 'esp32-touch-reference-480x480' && (
                  <p className="mt-2 text-xs text-status-warning-text">Hardware mapping is a reference assumption until verified on a real device.</p>
                )}
              </div>
              {deviceType === 'trmnl' && <Input label="MAC address" value={macAddress} onChange={(event) => setMacAddress(event.target.value)} placeholder="AA:BB:CC:DD:EE:FF" required />}
              <div className="grid grid-cols-2 gap-4">
                <Input label="Width (px)" type="number" min="1" value={width} onChange={(event) => setWidth(event.target.value)} required />
                <Input label="Height (px)" type="number" min="1" value={height} onChange={(event) => setHeight(event.target.value)} required />
              </div>
              <Button type="submit" isLoading={isLoading}>{deviceType === 'web-display' ? 'Create and pair' : 'Register device'}</Button>
            </form>
          )}
        </Card>
      </div>
    </MainLayout>
  );
}

function TypeCard({ active, title, description, onClick }: { active: boolean; title: string; description: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`text-left rounded-xl border p-5 transition-all ${active ? 'border-accent bg-accent/5 ring-2 ring-accent/20' : 'border-border-light bg-bg-card hover:border-accent/50'}`}>
      <span className="block font-semibold text-text-primary">{title}</span>
      <span className="block mt-1 text-sm text-text-muted">{description}</span>
    </button>
  );
}
