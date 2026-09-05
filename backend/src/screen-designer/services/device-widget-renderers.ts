export interface DeviceWidgetContext {
  battery?: number;
  wifi?: number;
  deviceName?: string;
  firmwareVersion?: string;
  macAddress?: string;
}

export interface WidgetHtmlTools {
  escapeHtml(value: string): string;
  sanitizeColor(value: string, fallback?: string): string;
}

type WidgetConfig = Record<string, unknown>;

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value ? value : fallback;
const number = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function batteryWidget(
  config: WidgetConfig,
  device: DeviceWidgetContext | undefined,
): string {
  const showPercentage = config.showPercentage === true;
  const showIcon = config.showIcon === true;
  const batteryLevel = device?.battery;

  if (batteryLevel === undefined) {
    return '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:20px">⚡</span><span>External power</span></div>';
  }

  let html = '<div style="display: flex; align-items: center; gap: 8px;">';
  if (showIcon) {
    const fillWidth = Math.round((batteryLevel / 100) * 14);
    html += `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="1" y="6" width="18" height="12" rx="2" />
      <rect x="19" y="9" width="4" height="6" rx="1" />
      <rect x="3" y="8" width="${fillWidth}" height="8" fill="currentColor" rx="1" />
    </svg>`;
  }
  if (showPercentage) html += `<span>${batteryLevel}%</span>`;
  return `${html}</div>`;
}

export function batteryWidgetStyles(config: WidgetConfig): string {
  return `font-size: ${number(config.fontSize, 16)}px; justify-content: center;`;
}

export function wifiWidget(config: WidgetConfig, device: DeviceWidgetContext | undefined): string {
  const showStrength = config.showStrength !== false;
  const showIcon = config.showIcon !== false;
  const signalStrength = device?.wifi;

  let html = '<div style="display: flex; align-items: center; gap: 8px;">';
  if (showIcon) {
    html += `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8.111 16.404a5.5 5.5 0 017.778 0" />
      <path d="M12 20h.01" />
      <path d="M4.93 13.071c3.904-3.905 10.236-3.905 14.141 0" />
      <path d="M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
    </svg>`;
  }
  if (showStrength) {
    html += `<span>${signalStrength === undefined ? 'Signal unavailable' : `${Math.round(signalStrength)} dBm`}</span>`;
  }
  return `${html}</div>`;
}

export function wifiWidgetStyles(config: WidgetConfig): string {
  return `font-size: ${number(config.fontSize, 16)}px; justify-content: center;`;
}

export function deviceInfoWidget(
  config: WidgetConfig,
  device: DeviceWidgetContext | undefined,
  tools: WidgetHtmlTools,
): string {
  const showName = config.showName !== false;
  const showFirmware = config.showFirmware !== false;
  const showMac = config.showMac === true;
  const deviceName = device?.deviceName || 'Device unavailable';
  const firmware = device?.firmwareVersion || 'unknown';
  const mac = device?.macAddress || 'not reported';

  let html = '<div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">';
  if (showName) html += `<div style="font-weight: bold;">${tools.escapeHtml(deviceName)}</div>`;
  if (showFirmware) html += `<div style="color: #666;">Firmware: ${tools.escapeHtml(firmware)}</div>`;
  if (showMac) html += `<div style="color: #888; font-size: 12px;">${tools.escapeHtml(mac)}</div>`;
  return `${html}</div>`;
}

export function deviceInfoWidgetStyles(config: WidgetConfig): string {
  return `font-size: ${number(config.fontSize, 14)}px; justify-content: center;`;
}

export function dividerWidget(config: WidgetConfig, tools: WidgetHtmlTools): string {
  const orientation = text(config.orientation, 'horizontal');
  const thickness = number(config.thickness, 2);
  const color = tools.sanitizeColor(text(config.color, '#000000'));
  const style = text(config.style, 'solid');
  const horizontal = orientation === 'horizontal';
  const lineStyle = style === 'solid'
    ? `background-color: ${color};`
    : `border-style: ${style}; border-color: ${color}; border-width: ${thickness}px; background-color: transparent;`;

  return `<div style="display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;">
    <div style="${lineStyle} ${horizontal ? `width: 100%; height: ${thickness}px;` : `width: ${thickness}px; height: 100%;`}"></div>
  </div>`;
}

export function rectangleWidget(config: WidgetConfig, tools: WidgetHtmlTools): string {
  const background = tools.sanitizeColor(text(config.backgroundColor, '#000000'));
  const borderColor = tools.sanitizeColor(text(config.borderColor, '#000000'));
  const borderWidth = number(config.borderWidth, 0);
  const border = borderWidth > 0 ? `border: ${borderWidth}px solid ${borderColor};` : 'border: none;';
  return `<div style="width: 100%; height: 100%; background-color: ${background}; ${border}"></div>`;
}
