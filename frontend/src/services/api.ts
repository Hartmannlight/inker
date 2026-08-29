import axios, { type AxiosInstance, AxiosError } from 'axios';
import type {
  Device,
  DeviceModel,
  DeviceLog,
  Screen,
  Playlist,
  DashboardStats,
  VersionCheck,
  ApiResponse,
  PaginatedResponse,
  DeviceFormData,
  ScreenFormData,
  PlaylistFormData,
  PlaylistScreen,
  ScreenDesign,
  ScreenWidget,
  WidgetTemplate,
  Plugin,
  PluginInstance,
  DataSource,
  DataSourceFormData,
  DataSourceTestResult,
  TestUrlRequest,
  CustomWidget,
  CustomWidgetFormData,
  CustomWidgetPreview,
} from '../types';
import { config } from '../config';
import {
  csrfHeadersFor,
  rememberCsrfFromHeaders,
  resetCsrfToken,
} from './admin-session';

// Use dynamic API URL from config
const API_URL = config.apiUrl;

/** Public pairing/device routes do not participate in admin cookie sessions. */
export function isPublicDisplayPath(pathname: string): boolean {
  return /^\/display\/[^/]+\/*$/i.test(pathname);
}

// Create axios instance with default config
const apiClient: AxiosInstance = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Browser authentication is cookie-based. Only the non-secret, session-bound
// CSRF token is attached to state-changing requests.
apiClient.interceptors.request.use(
  (config) => {
    Object.assign(config.headers, csrfHeadersFor(config.method));
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle errors
apiClient.interceptors.response.use(
  (response) => {
    rememberCsrfFromHeaders(response.headers);
    return response;
  },
  (error: AxiosError) => {
    // Public device displays use enrollment credentials, not admin sessions.
    // A late admin response must not navigate them away from their display.
    if (error.response?.status === 401) {
      const currentPath = window.location.pathname;
      const rootPairing = currentPath === '/' && new URL(window.location.href, 'http://localhost').searchParams.get('mode') === 'pair';
      if (currentPath !== '/login' && !rootPairing && !isPublicDisplayPath(currentPath)) {
        resetCsrfToken();
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// Helper function to extract error message
function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.message || error.response?.data?.error || error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unexpected error occurred';
}

// Authentication Service - simplified for PIN-based auth
export const authService = {
  async login(password: string): Promise<void> {
    try {
      await apiClient.post('/auth/login', { password });
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async logout(): Promise<void> {
    try {
      await apiClient.post('/auth/logout');
    } catch (error) {
      // Ignore logout errors, clear local state anyway
      console.error('Logout error:', error);
    } finally {
      resetCsrfToken();
    }
  },

  async validate(): Promise<void> {
    try {
      await apiClient.get('/auth/session');
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async listSessions(): Promise<AdminSessionSummary[]> {
    try {
      const response = await apiClient.get<ApiResponse<AdminSessionSummary[]>>('/auth/sessions');
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async revokeSession(sessionId: string): Promise<void> {
    try {
      await apiClient.delete(`/auth/sessions/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async logoutAll(): Promise<void> {
    try {
      await apiClient.post('/auth/logout-all');
    } finally {
      resetCsrfToken();
    }
  },
};

export interface AdminSessionSummary {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

// Device Service
export interface DeviceEnrollment {
  enrollmentId: string;
  deviceId: number;
  code: string;
  expiresAt: string;
  createdAt: string;
}

export type ContentAssignment =
  | { kind: 'none' }
  | { kind: 'screen'; screenId: number; expectedUpdatedAt: string }
  | { kind: 'screen'; publicationRevisionId: string }
  | { kind: 'playlist'; playlistRevisionId: string };

export interface ContentAssignmentChoices {
  current: {
    desiredPublicationRevisionId: string | null;
    playbackVersion: number;
    playlistRevisionId: string | null;
  };
  target?: { width: number; height: number; renderFormats: Array<'html' | 'png' | 'jpeg' | 'bmp1'>; backgroundColor: string };
  screens: Array<{ id: number; name: string; updatedAt: string; width: number | null; height: number | null; compatibility: { kind: 'exact' | 'adaptable' | 'risky' | 'unknown'; reason: string } }>;
  playlists: Array<{ playlistRevisionId: string; playlistId: number; name: string; revision: number; publishedAt: string }>;
}

export const deviceService = {
  async getAll(page = 1, limit = 20): Promise<PaginatedResponse<Device>> {
    try {
      const response = await apiClient.get<ApiResponse<PaginatedResponse<Device>>>(
        `/devices?page=${page}&limit=${limit}`
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getById(id: string): Promise<Device> {
    try {
      const response = await apiClient.get<ApiResponse<Device>>(`/devices/${id}`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async create(data: DeviceFormData): Promise<Device> {
    try {
      const response = await apiClient.post<ApiResponse<Device>>('/devices', data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async update(id: string, data: Partial<DeviceFormData>): Promise<Device> {
    try {
      const response = await apiClient.put<ApiResponse<Device>>(`/devices/${id}`, data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async delete(id: string): Promise<void> {
    try {
      await apiClient.delete(`/devices/${id}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async assignPlaylist(deviceId: string, playlistId: string): Promise<Device> {
    try {
      const response = await apiClient.patch<ApiResponse<Device>>(
        `/devices/${deviceId}`,
        { playlistId: parseInt(playlistId, 10) }
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async unassignPlaylist(deviceId: string): Promise<{
    message: string;
    device: Device;
    previousPlaylist: { id: number; name: string } | null;
    displayContent: { type: string; title: string; subtitle: string; message: string };
  }> {
    try {
      const response = await apiClient.delete<ApiResponse<{
        message: string;
        device: Device;
        previousPlaylist: { id: number; name: string } | null;
        displayContent: { type: string; title: string; subtitle: string; message: string };
      }>>(`/devices/${deviceId}/playlist`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getLogs(deviceId: string): Promise<DeviceLog[]> {
    try {
      const response = await apiClient.get<ApiResponse<DeviceLog[]>>(`/devices/${deviceId}/logs`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async refresh(deviceId: string): Promise<{ message: string; deviceId: number }> {
    try {
      const response = await apiClient.post<ApiResponse<{ message: string; deviceId: number }>>(
        `/devices/${deviceId}/refresh`
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getPublishedPreview(id: string): Promise<Blob | null> {
    try {
      const response = await apiClient.get(`/devices/${id}/preview`, { responseType: 'blob' });
      return response.data as Blob;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return null;
      throw new Error(getErrorMessage(error));
    }
  },

  async getContentAssignmentChoices(id: string): Promise<ContentAssignmentChoices> {
    try {
      const response = await apiClient.get<ApiResponse<ContentAssignmentChoices>>(`/devices/${id}/content-assignment`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async assignContent(id: string, expectedDesiredRevisionId: string | null, expectedPlaybackVersion: number, assignment: ContentAssignment) {
    try {
      const response = await apiClient.put<ApiResponse<unknown>>(`/devices/${id}/content-assignment`, {
        version: 1,
        expectedDesiredRevisionId,
        expectedPlaybackVersion,
        assignment,
      });
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async createEnrollment(deviceId: string): Promise<DeviceEnrollment> {
    try {
      const response = await apiClient.post<ApiResponse<DeviceEnrollment>>(
        `/devices/${deviceId}/enrollments`,
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  // Change a device's model / image format (e.g. og_png -> og_bmp for issue #31)
  async setModel(deviceId: string, modelId: number): Promise<Device> {
    try {
      const response = await apiClient.patch<ApiResponse<Device>>(
        `/devices/${deviceId}`,
        { modelId }
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },
};

// Device Model Service — list available display models (dimensions + PNG/BMP format)
export const modelService = {
  async getAll(): Promise<DeviceModel[]> {
    try {
      const response = await apiClient.get<ApiResponse<DeviceModel[]>>('/models');
      // /models is public and may return either a wrapped ApiResponse or a raw array.
      const body = response.data as unknown;
      if (Array.isArray(body)) return body as DeviceModel[];
      return (response.data.data ?? []) as DeviceModel[];
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },
};

// Screen Service
export const screenService = {
  async getAll(page = 1, limit = 20): Promise<PaginatedResponse<Screen>> {
    try {
      const response = await apiClient.get<ApiResponse<PaginatedResponse<Screen>>>(
        `/screens?page=${page}&limit=${limit}`
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getById(id: string): Promise<Screen> {
    try {
      const response = await apiClient.get<ApiResponse<Screen>>(`/screens/${id}`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async create(data: ScreenFormData): Promise<Screen> {
    try {
      const formData = new FormData();
      formData.append('name', data.name);
      if (data.description) {
        formData.append('description', data.description);
      }
      formData.append('file', data.file);

      const response = await axios.post<ApiResponse<Screen>>(`${API_URL}/screens`, formData, {
        withCredentials: true,
        headers: csrfHeadersFor('post'),
      });
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async update(id: string, data: Partial<ScreenFormData>): Promise<Screen> {
    try {
      const formData = new FormData();
      if (data.name) formData.append('name', data.name);
      if (data.description) formData.append('description', data.description);
      if (data.file) formData.append('file', data.file);

      const response = await axios.put<ApiResponse<Screen>>(`${API_URL}/screens/${id}`, formData, {
        withCredentials: true,
        headers: csrfHeadersFor('put'),
      });
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async delete(id: string): Promise<void> {
    try {
      await apiClient.delete(`/screens/${id}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },
};

// Playlist Service
export const playlistService = {
  async getPlaybackDraft(id: string): Promise<{ draftHash: string }> {
    try {
      const response = await apiClient.get<ApiResponse<{ draftHash: string }>>(`/playback/playlists/${id}/draft`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },
  async publishFromDraft(id: string, idempotencyKey: string, expectedDraftHash: string): Promise<{ playlistRevisionId: string; revision: number; contentHash: string }> {
    try {
      const response = await apiClient.post<ApiResponse<{ playlistRevisionId: string; revision: number; contentHash: string }>>(`/playback/playlists/${id}/publish-from-draft`, { version: 1, idempotencyKey, expectedDraftHash });
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },
  async getAll(page = 1, limit = 20): Promise<PaginatedResponse<Playlist>> {
    try {
      const response = await apiClient.get<ApiResponse<PaginatedResponse<Playlist>>>(
        `/playlists?page=${page}&limit=${limit}`
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getById(id: string): Promise<Playlist> {
    try {
      const response = await apiClient.get<ApiResponse<Playlist>>(`/playlists/${id}`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async create(data: PlaylistFormData): Promise<Playlist> {
    try {
      const response = await apiClient.post<ApiResponse<Playlist>>('/playlists', data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async update(id: string, data: Partial<PlaylistFormData>): Promise<Playlist> {
    try {
      const response = await apiClient.patch<ApiResponse<Playlist>>(`/playlists/${id}`, data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async delete(id: string | number, force = false): Promise<{ message: string; unassignedDevices?: number }> {
    try {
      const url = force ? `/playlists/${id}?force=true` : `/playlists/${id}`;
      const response = await apiClient.delete<ApiResponse<{ message: string; unassignedDevices?: number }>>(url);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async addScreen(playlistId: string, screenData: PlaylistScreen): Promise<Playlist> {
    try {
      const response = await apiClient.post<ApiResponse<Playlist>>(
        `/playlists/${playlistId}/screens`,
        screenData
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async removeScreen(playlistId: string, screenId: string): Promise<Playlist> {
    try {
      const response = await apiClient.delete<ApiResponse<Playlist>>(
        `/playlists/${playlistId}/screens/${screenId}`
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async addItem(playlistId: string, screenId: string, duration = 60): Promise<unknown> {
    const response = await apiClient.post<ApiResponse<unknown>>(`/playlists/${playlistId}/items`, { screenId: Number(screenId), duration });
    return response.data.data;
  },

  async updateItem(playlistId: string, itemId: number, data: { order?: number; duration?: number }): Promise<unknown> {
    const response = await apiClient.patch<ApiResponse<unknown>>(`/playlists/${playlistId}/items/${itemId}`, data);
    return response.data.data;
  },

  async removeItem(playlistId: string, itemId: number): Promise<unknown> {
    const response = await apiClient.delete<ApiResponse<unknown>>(`/playlists/${playlistId}/items/${itemId}`);
    return response.data.data;
  },

  async reorderItems(playlistId: string, items: Array<{ id: number; order: number }>): Promise<unknown> {
    const response = await apiClient.post<ApiResponse<unknown>>(`/playlists/${playlistId}/reorder`, { items });
    return response.data.data;
  },

  async updateScreenOrder(
    playlistId: string,
    screens: PlaylistScreen[]
  ): Promise<Playlist> {
    try {
      const response = await apiClient.put<ApiResponse<Playlist>>(
        `/playlists/${playlistId}/screens/reorder`,
        { screens }
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },
};

// Dashboard Service
export const dashboardService = {
  async getStats(): Promise<DashboardStats> {
    try {
      const response = await apiClient.get<ApiResponse<DashboardStats>>('/dashboard/stats');
      return response.data.data;
    } catch (error) {
      // If endpoint doesn't exist (404), return mock data instead of throwing
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.warn('Dashboard stats endpoint not available, using mock data');
        return {
          totalDevices: 0,
          onlineDevices: 0,
          totalScreens: 0,
          totalPlaylists: 0,
          recentDevices: [],
          recentScreens: [],
        };
      }
      throw new Error(getErrorMessage(error));
    }
  },

  async checkForUpdate(): Promise<VersionCheck> {
    const response = await apiClient.get<ApiResponse<VersionCheck>>('/dashboard/version-check');
    return response.data.data;
  },

  async performUpdate(): Promise<{ success: boolean; message: string }> {
    const response = await apiClient.post<ApiResponse<{ success: boolean; message: string }>>('/dashboard/update');
    return response.data.data;
  },
};

/**
 * Welcome Screen Service
 * Manages default welcome screen configuration for new devices
 */
export interface WelcomeScreenConfig {
  enabled: boolean;
  title: string;
  subtitle: string;
  autoAssignPlaylist: boolean;
}

export const welcomeScreenService = {
  /**
   * Get current welcome screen configuration
   */
  async getConfig(): Promise<WelcomeScreenConfig> {
    try {
      const response = await apiClient.get<ApiResponse<WelcomeScreenConfig>>(
        '/settings/welcome-screen'
      );
      return response.data.data;
    } catch (error) {
      // If endpoint doesn't exist (404), return default config
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.warn('Welcome screen config endpoint not available, using defaults');
        return {
          enabled: true,
          title: 'Hello World',
          subtitle: 'This is inker!',
          autoAssignPlaylist: true,
        };
      }
      throw new Error(getErrorMessage(error));
    }
  },

  /**
   * Save welcome screen configuration
   */
  async saveConfig(config: WelcomeScreenConfig): Promise<WelcomeScreenConfig> {
    try {
      const response = await apiClient.put<ApiResponse<WelcomeScreenConfig>>(
        '/settings/welcome-screen',
        config
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  /**
   * Regenerate welcome screens for all existing devices
   * Returns the count of devices that were updated
   */
  async regenerateAll(): Promise<{ count: number }> {
    try {
      const response = await apiClient.post<ApiResponse<{ count: number }>>(
        '/settings/welcome-screen/regenerate'
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  /**
   * Get the current default welcome screen image URL
   */
  async getDefaultScreenUrl(): Promise<{ url: string }> {
    try {
      const response = await apiClient.get<ApiResponse<{ url: string }>>(
        '/settings/welcome-screen/preview'
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },
};

/**
 * Screen Designer Service
 */
export const screenDesignerService = {
  // Screen Designs
  async getAll(page = 1, limit = 20): Promise<PaginatedResponse<ScreenDesign>> {
    try {
      const response = await apiClient.get<ApiResponse<PaginatedResponse<ScreenDesign>>>(`/screen-designs?page=${page}&limit=${limit}`);
      return response.data.data;
    } catch (error) {
      // Return empty response if endpoint not available
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.warn('Screen designs endpoint not available');
        return { items: [], total: 0, page: 1, limit: 20, hasMore: false };
      }
      throw new Error(getErrorMessage(error));
    }
  },

  async getById(id: number): Promise<ScreenDesign> {
    try {
      const response = await apiClient.get<ApiResponse<ScreenDesign>>(`/screen-designs/${id}`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async create(data: Partial<ScreenDesign>): Promise<ScreenDesign> {
    try {
      const response = await apiClient.post<ApiResponse<ScreenDesign>>('/screen-designs', data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async update(id: number, data: Partial<ScreenDesign>): Promise<ScreenDesign> {
    try {
      const response = await apiClient.put<ApiResponse<ScreenDesign>>(`/screen-designs/${id}`, data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async delete(id: number): Promise<void> {
    try {
      await apiClient.delete(`/screen-designs/${id}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async refreshDevices(id: number): Promise<{ message: string; deviceCount: number }> {
    try {
      const response = await apiClient.post<ApiResponse<{ message: string; deviceCount: number }>>(
        `/screen-designs/${id}/refresh-devices`
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  /**
   * Render and save screen capture for device (legacy - uses Puppeteer re-rendering).
   * Backend renders with Puppeteer, applies e-ink processing (dithering + inversion),
   * and saves the result for direct device display.
   */
  async captureForDevice(id: number): Promise<{ captureUrl: string; filename: string; size: number }> {
    try {
      const response = await apiClient.post<ApiResponse<{ captureUrl: string; filename: string; size: number }>>(
        `/screen-designs/${id}/capture`
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  /**
   * Upload browser-captured PNG for e-ink processing.
   * The image is captured from the browser (exact pixels) and backend only applies
   * e-ink processing (grayscale, dithering, inversion) - no re-rendering.
   * This guarantees pixel-perfect match between designer and device.
   */
  async uploadCapture(id: number, imageBlob: Blob): Promise<{ captureUrl: string; filename: string; size: number }> {
    try {
      const formData = new FormData();
      formData.append('image', imageBlob, 'capture.png');

      // Use axios directly without apiClient default headers (Content-Type: application/json breaks FormData)
      const response = await axios.post<ApiResponse<{ captureUrl: string; filename: string; size: number }>>(
        `${config.apiUrl}/screen-designs/${id}/upload-capture`,
        formData,
        {
          withCredentials: true,
          headers: {
            ...csrfHeadersFor('post'),
            // Let browser set Content-Type with boundary automatically
          },
        }
      );
      return response.data.data;
    } catch (error) {
      console.error('Upload capture error:', error);
      throw new Error(getErrorMessage(error));
    }
  },

  /**
   * Capture screen with optional drawing overlay.
   * Backend renders widgets with Puppeteer, composites drawing on top,
   * and applies e-ink processing.
   */
  async captureWithDrawing(id: number, drawingBlob: Blob | null): Promise<{ captureUrl: string; filename: string; size: number }> {
    try {
      const formData = new FormData();
      if (drawingBlob) {
        formData.append('drawing', drawingBlob, 'drawing.png');
      }

      const response = await axios.post<ApiResponse<{ captureUrl: string; filename: string; size: number }>>(
        `${config.apiUrl}/screen-designs/${id}/capture-with-drawing`,
        formData,
        {
          withCredentials: true,
          headers: {
            ...csrfHeadersFor('post'),
          },
        }
      );
      return response.data.data;
    } catch (error) {
      console.error('Capture with drawing error:', error);
      throw new Error(getErrorMessage(error));
    }
  },

  /**
   * Get drawing overlay for a screen design.
   * Returns the drawing URL if one exists.
   */
  async getDrawing(id: number): Promise<{ exists: boolean; url: string | null; size?: number; updatedAt?: string }> {
    try {
      const response = await apiClient.get<ApiResponse<{ exists: boolean; url: string | null; size?: number; updatedAt?: string }>>(
        `/screen-designs/${id}/drawing`
      );
      return response.data.data;
    } catch (error) {
      console.error('Get drawing error:', error);
      return { exists: false, url: null };
    }
  },

  /**
   * Delete drawing overlay for a screen design.
   */
  async deleteDrawing(id: number): Promise<{ deleted: boolean }> {
    try {
      const response = await apiClient.delete<ApiResponse<{ deleted: boolean }>>(
        `/screen-designs/${id}/drawing`
      );
      return response.data.data;
    } catch (error) {
      console.error('Delete drawing error:', error);
      return { deleted: false };
    }
  },

  // Widgets
  async addWidget(designId: number, widget: Partial<ScreenWidget>): Promise<ScreenWidget> {
    try {
      const response = await apiClient.post<ApiResponse<ScreenWidget>>(
        `/screen-designs/${designId}/widgets`,
        widget
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async updateWidget(designId: number, widgetId: number, data: Partial<ScreenWidget>): Promise<ScreenWidget> {
    try {
      const response = await apiClient.put<ApiResponse<ScreenWidget>>(
        `/screen-designs/${designId}/widgets/${widgetId}`,
        data
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async removeWidget(designId: number, widgetId: number): Promise<void> {
    try {
      await apiClient.delete(`/screen-designs/${designId}/widgets/${widgetId}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  // Device Assignment
  async assignToDevice(designId: number, deviceId: number): Promise<void> {
    try {
      await apiClient.post(`/screen-designs/${designId}/assign`, { deviceId });
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async unassignFromDevice(designId: number, deviceId: number): Promise<void> {
    try {
      await apiClient.delete(`/screen-designs/${designId}/assign/${deviceId}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  // Widget Templates
  async getTemplates(): Promise<WidgetTemplate[]> {
    try {
      const response = await apiClient.get('/widget-templates');
      // API returns { data: { items: [...] } } for paginated response
      const data = response.data?.data;
      if (data?.items && Array.isArray(data.items) && data.items.length > 0) {
        return data.items;
      }
      // Fallback if response is just an array with items
      if (Array.isArray(data) && data.length > 0) {
        return data;
      }
      // Fallback if API returns empty array (DB not seeded yet)
      console.warn('Widget templates empty, using defaults');
      return getDefaultWidgetTemplates();
    } catch (error) {
      // Return default templates if endpoint not available
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.warn('Widget templates endpoint not available, using defaults');
        return getDefaultWidgetTemplates();
      }
      console.error('Failed to load widget templates:', error);
      return getDefaultWidgetTemplates();
    }
  },

  // Widget Image Upload
  async uploadWidgetImage(file: File): Promise<{ url: string; filename: string; size: number; compressed: boolean }> {
    try {
      const formData = new FormData();
      formData.append('file', file);

      // Use axios directly without the apiClient default headers
      // This is necessary because apiClient has Content-Type: application/json which breaks FormData
      const response = await axios.post<ApiResponse<{ url: string; filename: string; size: number; compressed: boolean }>>(
        `${config.apiUrl}/screen-designs/upload-widget-image`,
        formData,
        {
          withCredentials: true,
          headers: {
            ...csrfHeadersFor('post'),
            // Let browser set Content-Type with boundary automatically
          },
        }
      );
      return response.data.data;
    } catch (error) {
      console.error('Upload widget image error:', error);
      throw new Error(getErrorMessage(error));
    }
  },

  // GitHub API Proxy
  async getGitHubStars(owner: string, repo: string): Promise<{ stars: number; name: string } | null> {
    try {
      const response = await apiClient.get<ApiResponse<{ stars: number; name: string } | null>>(
        `/screen-designs/github-stars/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      );
      return response.data.data;
    } catch (error) {
      console.error('GitHub stars fetch error:', error);
      return null;
    }
  },
};

export const publicationService = {
  async get(publicationKey: string): Promise<{ revisions: Array<{ revision: number }> } | null> {
    try {
      const response = await apiClient.get<ApiResponse<{ revisions: Array<{ revision: number }> }>>(`/publications/${publicationKey}`);
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return null;
      throw new Error(getErrorMessage(error));
    }
  },

  async publishDesign(publicationKey: string, input: { idempotencyKey: string; expectedRevision: number; screenDesignId: number; expectedUpdatedAt: string; deviceIds: number[] }) {
    try {
      const response = await apiClient.post<ApiResponse<{ publicationId: string; publicationRevisionId: string; revision: number; deviceIds: number[] }>>(
        `/publications/${publicationKey}/publish`,
        { idempotencyKey: input.idempotencyKey, expectedRevision: input.expectedRevision, deviceIds: input.deviceIds,
          draft: { screenDesignId: input.screenDesignId, expectedUpdatedAt: input.expectedUpdatedAt } },
      );
      return response.data.data;
    } catch (error) { throw new Error(getErrorMessage(error)); }
  },
};

/**
 * Default widget templates for when the backend endpoint is not available
 */
function getDefaultWidgetTemplates(): WidgetTemplate[] {
  return [
    {
      id: 1,
      name: 'clock',
      label: 'Clock',
      description: 'Display current time',
      category: 'time',
      defaultConfig: {
        timezone: 'UTC',
        format: '24h',
        showSeconds: false,
        showDate: false,
        dateFormat: 'YYYY-MM-DD',
        fontFamily: 'monospace',
        fontSize: 48,
      },
      minWidth: 150,
      minHeight: 60,
    },
    {
      id: 2,
      name: 'date',
      label: 'Date',
      description: 'Display current date',
      category: 'time',
      defaultConfig: {
        format: 'MMMM D, YYYY',
        showDayOfWeek: true,
        fontSize: 24,
        fontFamily: 'sans-serif',
      },
      minWidth: 200,
      minHeight: 40,
    },
    {
      id: 99,
      name: 'calendar',
      label: 'Calendar',
      description: 'Month calendar with the current day highlighted',
      category: 'time',
      defaultConfig: {
        timezone: 'local',
        weekStart: 'sunday',
        showHeader: true,
        gridLines: false,
        highlightWeekends: false,
        fontScale: 100,
        fontFamily: 'sans-serif',
      },
      minWidth: 220,
      minHeight: 200,
    },
    {
      id: 3,
      name: 'weather',
      label: 'Weather',
      description: 'Display weather information',
      category: 'weather',
      defaultConfig: {
        location: '',
        latitude: 0,
        longitude: 0,
        units: 'metric',
        showIcon: true,
        showTemperature: true,
        showCondition: true,
        showHumidity: false,
        fontSize: 24,
      },
      minWidth: 150,
      minHeight: 100,
    },
    {
      id: 4,
      name: 'text',
      label: 'Text',
      description: 'Display custom text',
      category: 'content',
      defaultConfig: {
        text: 'Hello World',
        fontSize: 24,
        fontFamily: 'sans-serif',
        fontWeight: 'normal',
        textAlign: 'left',
        color: '#000000',
      },
      minWidth: 100,
      minHeight: 30,
    },
    {
      id: 5,
      name: 'qrcode',
      label: 'QR Code',
      description: 'Display a QR code',
      category: 'content',
      defaultConfig: {
        content: 'https://example.com',
        size: 100,
        errorCorrection: 'M',
      },
      minWidth: 80,
      minHeight: 80,
    },
    {
      id: 6,
      name: 'battery',
      label: 'Battery',
      description: 'Display device battery level',
      category: 'system',
      defaultConfig: {
        showPercentage: true,
        showIcon: true,
        fontSize: 16,
      },
      minWidth: 80,
      minHeight: 30,
    },
  ];
}

/**
 * Data Source Service
 * Manages external API and RSS feed data sources
 */
export const dataSourceService = {
  async getAll(page = 1, limit = 20, activeOnly = false): Promise<PaginatedResponse<DataSource>> {
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        ...(activeOnly && { activeOnly: 'true' }),
      });
      const response = await apiClient.get<ApiResponse<PaginatedResponse<DataSource>>>(`/data-sources?${params}`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getById(id: number): Promise<DataSource> {
    try {
      const response = await apiClient.get<ApiResponse<DataSource>>(`/data-sources/${id}`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async create(data: DataSourceFormData): Promise<DataSource> {
    try {
      const response = await apiClient.post<ApiResponse<DataSource>>('/data-sources', data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async update(id: number, data: Partial<DataSourceFormData>): Promise<DataSource> {
    try {
      const response = await apiClient.patch<ApiResponse<DataSource>>(`/data-sources/${id}`, data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async delete(id: number): Promise<void> {
    try {
      await apiClient.delete(`/data-sources/${id}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async testFetch(id: number): Promise<DataSourceTestResult> {
    try {
      const response = await apiClient.post<ApiResponse<DataSourceTestResult>>(`/data-sources/${id}/test`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async refresh(id: number): Promise<{ success: boolean; data: unknown; dataSource: DataSource }> {
    try {
      const response = await apiClient.post<ApiResponse<{ success: boolean; data: unknown; dataSource: DataSource }>>(
        `/data-sources/${id}/refresh`
      );
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getCachedData(id: number): Promise<unknown> {
    try {
      const response = await apiClient.get<ApiResponse<unknown>>(`/data-sources/${id}/data`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  /**
   * Test a URL without saving - preview available fields before creating a data source.
   * This is useful for discovering what fields are available from an API.
   */
  async testUrl(data: TestUrlRequest): Promise<DataSourceTestResult> {
    try {
      const response = await apiClient.post<ApiResponse<DataSourceTestResult>>('/data-sources/test-url', data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },
};

/**
 * Custom Widget Service
 * Manages user-defined widgets that display data from data sources
 */
export const customWidgetService = {
  async getAll(page = 1, limit = 20): Promise<PaginatedResponse<CustomWidget>> {
    try {
      const response = await apiClient.get<ApiResponse<PaginatedResponse<CustomWidget>>>(`/custom-widgets?page=${page}&limit=${limit}`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getById(id: number): Promise<CustomWidget> {
    try {
      const response = await apiClient.get<ApiResponse<CustomWidget>>(`/custom-widgets/${id}`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async create(data: CustomWidgetFormData): Promise<CustomWidget> {
    try {
      const response = await apiClient.post<ApiResponse<CustomWidget>>('/custom-widgets', data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async update(id: number, data: Partial<CustomWidgetFormData>): Promise<CustomWidget> {
    try {
      const response = await apiClient.patch<ApiResponse<CustomWidget>>(`/custom-widgets/${id}`, data);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async delete(id: number): Promise<void> {
    try {
      await apiClient.delete(`/custom-widgets/${id}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getPreview(id: number): Promise<CustomWidgetPreview> {
    try {
      const response = await apiClient.get<ApiResponse<CustomWidgetPreview>>(`/custom-widgets/${id}/preview`);
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getAsTemplates(): Promise<WidgetTemplate[]> {
    try {
      const response = await apiClient.get<ApiResponse<WidgetTemplate[]>>('/custom-widgets/templates');
      return response.data.data || [];
    } catch {
      // Return empty array if no custom widgets
      return [];
    }
  },
};

/**
 * Settings Service
 * Manages application settings like API tokens
 */
export const settingsService = {
  async getAll(): Promise<Record<string, string | null>> {
    try {
      const response = await apiClient.get<ApiResponse<Record<string, string | null>>>('/settings');
      return response.data.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async update(key: string, value: string): Promise<void> {
    try {
      await apiClient.put(`/settings/${key}`, { value });
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async delete(key: string): Promise<void> {
    try {
      await apiClient.delete(`/settings/${key}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

};

// Plugin service
export const pluginService = {
  async getAll(): Promise<Plugin[]> {
    try {
      const response = await apiClient.get('/plugins');
      return response.data.data || response.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getById(id: number): Promise<Plugin> {
    try {
      const response = await apiClient.get(`/plugins/${id}`);
      return response.data.data || response.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getAllInstances(): Promise<PluginInstance[]> {
    try {
      const response = await apiClient.get('/plugins/instances/all');
      return response.data.data || response.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async getInstance(id: number): Promise<PluginInstance> {
    try {
      const response = await apiClient.get(`/plugins/instances/${id}`);
      return response.data.data || response.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async createInstance(data: { pluginId: number; name?: string; settings?: Record<string, unknown> }): Promise<PluginInstance> {
    try {
      const response = await apiClient.post('/plugins/instances', data);
      return response.data.data || response.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async updateInstance(id: number, data: { name?: string; settings?: Record<string, unknown> }): Promise<PluginInstance> {
    try {
      const response = await apiClient.put(`/plugins/instances/${id}`, data);
      return response.data.data || response.data;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  async deleteInstance(id: number): Promise<void> {
    try {
      await apiClient.delete(`/plugins/instances/${id}`);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  },

  getRenderUrl(id: number, mode: string = 'preview'): string {
    return `${config.apiUrl}/plugins/instances/${id}/render?mode=${mode}&t=${Date.now()}`;
  },
};

// Export API client for custom requests
export default apiClient;
