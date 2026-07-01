import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '../../components/layout';
import { Button, Card, Input, LoadingSpinner } from '../../components/common';
import { useApi, useMutation } from '../../hooks/useApi';
import { deviceService } from '../../services/api';
import type { Device, DeviceFormData } from '../../types';

/** Small toggle switch matching the app's design tokens. */
function ToggleSwitch({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
      />
      <div className="w-9 h-5 bg-border-light rounded-full peer peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
    </label>
  );
}

const DEFAULT_SLEEP_START = '22:00';
const DEFAULT_SLEEP_STOP = '07:00';

export function DeviceForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEditMode = id !== 'new' && !!id;

  const [formData, setFormData] = useState<DeviceFormData>({
    name: '',
    macAddress: '',
    sleepStartAt: DEFAULT_SLEEP_START,
    sleepStopAt: DEFAULT_SLEEP_STOP,
    showSleepScreen: false,
  });
  const [sleepEnabled, setSleepEnabled] = useState(false);

  const { data: device, isLoading: isLoadingDevice } = useApi<Device>(
    () => deviceService.getById(id!),
    { showErrorNotification: false }
  );

  const { mutate: createDevice, isLoading: isCreating } = useMutation(
    (data: DeviceFormData) => deviceService.create(data),
    {
      successMessage: 'Device created successfully',
      onSuccess: (newDevice) => navigate(`/devices/${newDevice.id}`),
    }
  );

  const { mutate: updateDevice, isLoading: isUpdating } = useMutation(
    (data: Partial<DeviceFormData>) => deviceService.update(id!, data),
    {
      successMessage: 'Device updated successfully',
      onSuccess: () => navigate(`/devices/${id}`),
    }
  );

  // Populate form data when device is loaded
  // This is an intentional pattern for form initialization from server data
  useEffect(() => {
    if (device) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Form initialization from server data
      setFormData({
        name: device.name,
        macAddress: device.macAddress,
        sleepStartAt: device.sleepStartAt || DEFAULT_SLEEP_START,
        sleepStopAt: device.sleepStopAt || DEFAULT_SLEEP_STOP,
        showSleepScreen: device.showSleepScreen ?? false,
      });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Form initialization from server data
      setSleepEnabled(!!(device.sleepStartAt && device.sleepStopAt));
    }
  }, [device]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isEditMode) {
      await updateDevice({
        name: formData.name,
        // Quiet hours: send times when enabled, null to disable.
        sleepStartAt: sleepEnabled ? formData.sleepStartAt || DEFAULT_SLEEP_START : null,
        sleepStopAt: sleepEnabled ? formData.sleepStopAt || DEFAULT_SLEEP_STOP : null,
        showSleepScreen: !!formData.showSleepScreen,
      });
    } else {
      await createDevice({ name: formData.name, macAddress: formData.macAddress });
    }
  };

  const handleChange = (field: keyof DeviceFormData) => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setFormData((prev) => ({
      ...prev,
      [field]: e.target.value,
    }));
  };

  if (isEditMode && isLoadingDevice) {
    return (
      <MainLayout>
        <div className="flex justify-center items-center min-h-[400px]">
          <LoadingSpinner size="lg" />
        </div>
      </MainLayout>
    );
  }

  const isLoading = isCreating || isUpdating;

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/devices')}
            className="mb-4"
          >
            ← Back to Devices
          </Button>
          <h1 className="text-3xl font-bold text-text-primary">
            {isEditMode ? 'Edit Device' : 'Add New Device'}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {isEditMode
              ? 'Update device information'
              : 'Register a new device'}
          </p>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="space-y-6">
            <Input
              label="Device Name"
              value={formData.name}
              onChange={handleChange('name')}
              placeholder="Enter device name"
              required
            />

            <Input
              label="MAC Address"
              value={formData.macAddress}
              onChange={handleChange('macAddress')}
              placeholder="00:00:00:00:00:00"
              required
              disabled={isEditMode}
              helperText={
                isEditMode
                  ? 'MAC address cannot be changed'
                  : 'Enter the device MAC address'
              }
            />

            {isEditMode && (
              <div className="border-t border-border-light pt-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-text-primary">Night Sleep</h2>
                    <p className="text-xs text-text-secondary mt-0.5">
                      Stop refreshing the device during quiet hours so it deep-sleeps overnight.
                    </p>
                  </div>
                  <ToggleSwitch
                    id="sleep-enabled"
                    checked={sleepEnabled}
                    onChange={setSleepEnabled}
                  />
                </div>

                {sleepEnabled && (
                  <div className="space-y-4 pl-1">
                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="Sleep from"
                        type="time"
                        value={formData.sleepStartAt || ''}
                        onChange={handleChange('sleepStartAt')}
                        required
                      />
                      <Input
                        label="Wake at"
                        type="time"
                        value={formData.sleepStopAt || ''}
                        onChange={handleChange('sleepStopAt')}
                        required
                      />
                    </div>
                    <p className="text-xs text-text-muted">
                      Evaluated in the server timezone (DEFAULT_TIMEZONE). Windows past midnight (e.g. 22:00–07:00) are supported.
                    </p>

                    <div className="flex items-center justify-between">
                      <div>
                        <label htmlFor="show-sleep-screen" className="text-sm text-text-secondary">
                          Show sleep screen
                        </label>
                        <p className="text-xs text-text-muted mt-0.5">
                          Off keeps the current screen on display until morning.
                        </p>
                      </div>
                      <ToggleSwitch
                        id="show-sleep-screen"
                        checked={!!formData.showSleepScreen}
                        onChange={(checked) =>
                          setFormData((prev) => ({ ...prev, showSleepScreen: checked }))
                        }
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3 justify-end pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/devices')}
              >
                Cancel
              </Button>
              <Button type="submit" isLoading={isLoading}>
                {isEditMode ? 'Update Device' : 'Create Device'}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </MainLayout>
  );
}
