/**
 * TimezoneSelectionModal Component
 * Shows a timezone picker popup when placing clock or date widgets
 */
import { useState, useMemo, useCallback } from 'react';
import { Modal } from '../common/Modal';
import { SearchableSelect } from '../common/SearchableSelect';
import { browserTimezone, getCurrentOffset, timezoneData } from './timezone-options';

interface TimezoneSelectionModalProps {
  isOpen: boolean;
  onConfirm: (timezone: string) => void;
  onUseDefault: () => void;
  widgetType: 'clock' | 'date';
}

// Define regions in display order
const regionOrder = [
  'UTC',
  'Americas',
  'Western Europe',
  'Central Europe',
  'Northern Europe',
  'Eastern Europe',
  'Middle East & Africa',
  'South Asia',
  'Southeast Asia',
  'East Asia',
  'Oceania',
];

// Build timezone options for display with region grouping
const getTimezoneOptions = (): { value: string; label: string; hint?: string; isGroup?: boolean }[] => {
  const result: { value: string; label: string; hint?: string; isGroup?: boolean }[] = [];

  // Check if browser timezone is not in the list, add it at the top
  const browserTzInList = timezoneData.some(tz => tz.value === browserTimezone);
  if (!browserTzInList) {
    result.push({ value: browserTimezone, label: `${browserTimezone} (detected)` });
  }

  // Group timezones by region
  for (const region of regionOrder) {
    const regionTimezones = timezoneData.filter(tz => tz.region === region);
    if (regionTimezones.length > 0) {
      result.push({ value: region, label: region, isGroup: true });
      for (const tz of regionTimezones) {
        result.push({
          value: tz.value,
          label: `${tz.label} (UTC${getCurrentOffset(tz.value)})`,
        });
      }
    }
  }

  return result;
};

// Search function that matches cities to timezones with hints
const searchTimezones = (query: string): { value: string; label: string; hint?: string; isGroup?: boolean }[] => {
  const q = query.toLowerCase().trim();
  if (!q) return getTimezoneOptions();

  const matches: { value: string; label: string; hint?: string; score: number }[] = [];

  for (const tz of timezoneData) {
    let score = 0;
    let matchedCity: string | undefined;

    // Exact label match (highest priority)
    if (tz.label.toLowerCase() === q) {
      score = 100;
    }
    // Label starts with query
    else if (tz.label.toLowerCase().startsWith(q)) {
      score = 80;
    }
    // Label contains query
    else if (tz.label.toLowerCase().includes(q)) {
      score = 60;
    }
    // City exact match
    else {
      for (const city of tz.cities) {
        if (city === q) {
          score = 90;
          matchedCity = city;
          break;
        } else if (city.startsWith(q)) {
          if (score < 70) {
            score = 70;
            matchedCity = city;
          }
        } else if (city.includes(q)) {
          if (score < 50) {
            score = 50;
            matchedCity = city;
          }
        }
      }
    }

    if (score > 0) {
      matches.push({
        value: tz.value,
        label: `${tz.label} (UTC${getCurrentOffset(tz.value)})`,
        hint: matchedCity,
        score,
      });
    }
  }

  // Sort by score (highest first)
  matches.sort((a, b) => b.score - a.score);

  return matches;
};

export function TimezoneSelectionModal({
  isOpen,
  onConfirm,
  onUseDefault,
  widgetType,
}: TimezoneSelectionModalProps) {
  const [selectedTimezone, setSelectedTimezone] = useState(browserTimezone);

  const options = useMemo(() => getTimezoneOptions(), []);

  const handleConfirm = useCallback(() => {
    onConfirm(selectedTimezone);
    setSelectedTimezone(browserTimezone); // Reset for next use
  }, [selectedTimezone, onConfirm]);

  const handleUseDefault = useCallback(() => {
    onUseDefault();
    setSelectedTimezone(browserTimezone); // Reset for next use
  }, [onUseDefault]);

  const widgetLabel = widgetType === 'clock' ? 'Live Clock' : 'Date Display';

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleUseDefault}
      title={`Set Timezone for ${widgetLabel}`}
      size="sm"
      footer={
        <>
          <button
            onClick={handleUseDefault}
            className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            Use Local Time
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent-hover transition-colors"
          >
            Confirm
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Select the timezone for this {widgetType === 'clock' ? 'clock' : 'date'} widget.
          You can search by city name or region.
        </p>

        <SearchableSelect
          value={selectedTimezone}
          onChange={setSelectedTimezone}
          options={options}
          searchFn={searchTimezones}
          placeholder="Search city or timezone..."
        />

        <p className="text-xs text-text-muted">
          Tip: Type a city name like "Tokyo", "London", or "Warsaw" to quickly find the timezone.
        </p>
      </div>
    </Modal>
  );
}
