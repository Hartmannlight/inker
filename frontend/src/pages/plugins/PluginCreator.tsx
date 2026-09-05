import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MainLayout } from '../../components/layout';
import { Button, LoadingSpinner } from '../../components/common';
import { useApi, useMutation } from '../../hooks/useApi';
import { useNotification } from '../../contexts/NotificationContext';
import apiClient from '../../services/api';

interface SettingsField {
  key: string;
  label: string;
  type: string;
  options?: string[];
  required?: boolean;
  encrypted?: boolean;
  default?: string;
}

interface HeaderPair {
  key: string;
  value: string;
}

interface PluginFormData {
  name: string;
  slug: string;
  description: string;
  category: string;
  icon: string;
  dataStrategy: string;
  dataUrl: string;
  dataMethod: string;
  dataHeaders: HeaderPair[];
  dataPath: string;
  dataTransform: string;
  refreshInterval: number;
  markupFull: string;
  markupHalfHorizontal: string;
  markupHalfVertical: string;
  markupQuadrant: string;
  settingsSchema: SettingsField[];
}

const INITIAL_FORM: PluginFormData = {
  name: '',
  slug: '',
  description: '',
  category: 'custom',
  icon: '',
  dataStrategy: 'polling',
  dataUrl: '',
  dataMethod: 'GET',
  dataHeaders: [],
  dataPath: '',
  dataTransform: '',
  refreshInterval: 300,
  markupFull: '<div class="view view--full">\n  <div class="layout layout--col gap--medium">\n    <div class="title">{{ title }}</div>\n    <div class="description">{{ content }}</div>\n  </div>\n  <div class="title_bar">\n    <span class="title">My Plugin</span>\n  </div>\n</div>',
  markupHalfHorizontal: '',
  markupHalfVertical: '',
  markupQuadrant: '',
  settingsSchema: [],
};

const CATEGORIES = ['custom', 'news', 'finance', 'productivity', 'weather', 'health', 'analytics', 'lifestyle', 'ai', 'travel'];

const STEPS = ['Basics', 'Data Source', 'Template', 'Settings', 'Review'];

export function PluginCreator() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const isEdit = !!id;
  const navigate = useNavigate();
  const { success, error: showError } = useNotification();
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<PluginFormData>(() => {
    // Pre-fill from recipe gallery params
    const recipeName = searchParams.get('recipe_name');
    if (recipeName) {
      const recipeSettings = searchParams.get('recipe_settings');
      let settings: SettingsField[] = [];
      try { settings = recipeSettings ? JSON.parse(recipeSettings) : []; } catch {}
      let headers: { key: string; value: string }[] = [];
      try {
        const h = searchParams.get('recipe_data_headers');
        if (h) headers = Object.entries(JSON.parse(h)).map(([k, v]) => ({ key: k, value: String(v) }));
      } catch {}
      return {
        ...INITIAL_FORM,
        name: recipeName,
        slug: recipeName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        description: searchParams.get('recipe_description') || '',
        category: searchParams.get('recipe_category') || 'custom',
        settingsSchema: settings,
        markupFull: searchParams.get('recipe_template') || INITIAL_FORM.markupFull,
        dataUrl: searchParams.get('recipe_data_url') || '',
        dataHeaders: headers.length > 0 ? headers : INITIAL_FORM.dataHeaders,
      };
    }
    return INITIAL_FORM;
  });
  const [sampleData, setSampleData] = useState<unknown>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [activeLayout, setActiveLayout] = useState<'full' | 'half_horizontal' | 'half_vertical' | 'quadrant'>('full');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Load existing plugin for edit mode
  const fetchPlugin = useCallback(
    () => id ? apiClient.get(`/plugins/${id}`).then(r => r.data.data || r.data) : Promise.resolve(null),
    [id]
  );
  const { data: existingPlugin, isLoading: loadingPlugin } = useApi(fetchPlugin);

  useEffect(() => {
    if (existingPlugin && isEdit) {
      const headers: HeaderPair[] = existingPlugin.dataHeaders
        ? Object.entries(existingPlugin.dataHeaders).map(([key, value]) => ({ key, value: String(value) }))
        : [];
      setFormData({
        name: existingPlugin.name || '',
        slug: existingPlugin.slug || '',
        description: existingPlugin.description || '',
        category: existingPlugin.category || 'custom',
        icon: existingPlugin.icon || '',
        dataStrategy: existingPlugin.dataStrategy || 'polling',
        dataUrl: existingPlugin.dataUrl || '',
        dataMethod: existingPlugin.dataMethod || 'GET',
        dataHeaders: headers,
        dataPath: existingPlugin.dataPath || '',
        dataTransform: existingPlugin.dataTransform || '',
        refreshInterval: existingPlugin.refreshInterval || 300,
        markupFull: existingPlugin.markupFull || INITIAL_FORM.markupFull,
        markupHalfHorizontal: existingPlugin.markupHalfHorizontal || '',
        markupHalfVertical: existingPlugin.markupHalfVertical || '',
        markupQuadrant: existingPlugin.markupQuadrant || '',
        settingsSchema: existingPlugin.settingsSchema || [],
      });
    }
  }, [existingPlugin, isEdit]);

  // Save mutation
  const saveMutation = useMutation<unknown, void>(
    async () => {
      const payload = {
        ...formData,
        dataHeaders: formData.dataHeaders.length > 0
          ? Object.fromEntries(formData.dataHeaders.filter(h => h.key).map(h => [h.key, h.value]))
          : undefined,
        settingsSchema: formData.settingsSchema.length > 0 ? formData.settingsSchema : undefined,
        source: 'inker',
        markupHalfHorizontal: formData.markupHalfHorizontal || undefined,
        markupHalfVertical: formData.markupHalfVertical || undefined,
        markupQuadrant: formData.markupQuadrant || undefined,
        dataTransform: formData.dataTransform || undefined,
        dataPath: formData.dataPath || undefined,
        dataUrl: formData.dataUrl || undefined,
      };
      if (isEdit) {
        return apiClient.put(`/plugins/${id}`, payload).then(r => r.data.data || r.data);
      }
      return apiClient.post('/plugins', payload).then(r => r.data.data || r.data);
    },
    {
      onSuccess: () => {
        success(isEdit ? 'Plugin updated' : 'Plugin created');
        navigate('/plugins');
      },
    }
  );

  const update = <Key extends keyof PluginFormData>(key: Key, value: PluginFormData[Key]) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  };

  // Auto-generate slug from name
  const updateName = (name: string) => {
    setFormData(prev => ({
      ...prev,
      name,
      slug: isEdit ? prev.slug : name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    }));
  };

  // Test data URL
  const handleTestUrl = async () => {
    if (!formData.dataUrl) return;
    setTestLoading(true);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      formData.dataHeaders.filter(h => h.key).forEach(h => { headers[h.key] = h.value; });
      const response = await fetch(formData.dataUrl, {
        method: formData.dataMethod,
        headers,
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      setSampleData(data);
      success('Data fetched successfully');
    } catch (error) {
      showError(`Fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setTestLoading(false);
    }
  };

  // Header management
  const addHeader = () => update('dataHeaders', [...formData.dataHeaders, { key: '', value: '' }]);
  const removeHeader = (i: number) => update('dataHeaders', formData.dataHeaders.filter((_, idx) => idx !== i));
  const updateHeader = (i: number, field: 'key' | 'value', val: string) => {
    const headers = [...formData.dataHeaders];
    headers[i] = { ...headers[i], [field]: val };
    update('dataHeaders', headers);
  };

  const getActiveMarkup = useCallback(() => {
    switch (activeLayout) {
      case 'full': return formData.markupFull;
      case 'half_horizontal': return formData.markupHalfHorizontal;
      case 'half_vertical': return formData.markupHalfVertical;
      case 'quadrant': return formData.markupQuadrant;
    }
  }, [activeLayout, formData.markupFull, formData.markupHalfHorizontal, formData.markupHalfVertical, formData.markupQuadrant]);

  // Settings schema management
  // Live preview for template step
  const handlePreview = useCallback(async () => {
    const markup = getActiveMarkup();
    if (!markup) return;
    setPreviewLoading(true);
    try {
      const response = await apiClient.post('/plugins/preview-template', {
        markup,
        data: sampleData || {},
      }, { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
    } catch {
      setPreviewUrl(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [getActiveMarkup, sampleData]);

  const addField = () => update('settingsSchema', [
    ...formData.settingsSchema,
    { key: '', label: '', type: 'text', default: '' },
  ]);
  const removeField = (i: number) => update('settingsSchema', formData.settingsSchema.filter((_, idx) => idx !== i));
  const updateField = <Key extends keyof SettingsField>(i: number, key: Key, val: SettingsField[Key]) => {
    const fields = [...formData.settingsSchema];
    fields[i] = { ...fields[i], [key]: val };
    update('settingsSchema', fields);
  };

  const setActiveMarkup = (value: string) => {
    const key = activeLayout === 'full' ? 'markupFull'
      : activeLayout === 'half_horizontal' ? 'markupHalfHorizontal'
      : activeLayout === 'half_vertical' ? 'markupHalfVertical'
      : 'markupQuadrant';
    update(key, value);
  };

  // Auto-render preview when plugin loads in edit mode
  useEffect(() => {
    if (isEdit && existingPlugin && formData.markupFull && !previewUrl) {
      handlePreview();
    }
  }, [isEdit, existingPlugin, formData.markupFull, previewUrl, handlePreview]);

  const hasTemplate = !!formData.markupFull;

  if (isEdit && loadingPlugin) {
    return <MainLayout><div className="flex justify-center py-20"><LoadingSpinner /></div></MainLayout>;
  }

  return (
    <MainLayout>
      <div className={`mx-auto space-y-6 ${isEdit && hasTemplate ? 'max-w-6xl' : 'max-w-4xl'}`}>
        {/* Header */}
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/plugins')} className="text-text-muted hover:text-text-primary">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-2xl font-bold text-text-primary">
            {isEdit ? 'Edit Plugin' : 'Create Plugin'}
          </h1>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2">
          {STEPS.map((label, i) => (
            <button
              key={label}
              onClick={() => setStep(i)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                i === step
                  ? 'bg-accent text-white'
                  : i < step
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                  : 'bg-bg-card text-text-muted border border-border-light'
              }`}
            >
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs border border-current">
                {i < step ? '✓' : i + 1}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        <div className={isEdit && hasTemplate ? 'grid grid-cols-1 lg:grid-cols-3 gap-6' : ''}>
        {/* Step content */}
        <div className={`bg-bg-card rounded-xl shadow-theme-md border border-border-light p-6 ${isEdit && hasTemplate ? 'lg:col-span-2' : ''}`}>

          {/* Step 0: Basics */}
          {step === 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">Basic Information</h2>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => updateName(e.target.value)}
                  placeholder="My Custom Plugin"
                  className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Slug</label>
                <input
                  type="text"
                  value={formData.slug}
                  onChange={e => update('slug', e.target.value)}
                  placeholder="my_custom_plugin"
                  className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm"
                />
                <p className="text-xs text-text-muted mt-1">Unique identifier. Auto-generated from name.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={e => update('description', e.target.value)}
                  placeholder="What does this plugin display?"
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Category</label>
                  <select
                    value={formData.category}
                    onChange={e => update('category', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    {CATEGORIES.map(cat => (
                      <option key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Icon (emoji)</label>
                  <input
                    type="text"
                    value={formData.icon}
                    onChange={e => update('icon', e.target.value)}
                    placeholder="📊"
                    className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Data Source */}
          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">Data Source</h2>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Strategy</label>
                <div className="flex gap-3">
                  {(['polling', 'static'] as const).map(s => (
                    <label key={s} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="dataStrategy"
                        value={s}
                        checked={formData.dataStrategy === s}
                        onChange={() => update('dataStrategy', s)}
                        className="accent-accent"
                      />
                      <span className="text-sm text-text-primary capitalize">{s}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-text-muted mt-1">
                  Polling fetches data from a URL periodically. Static uses manually provided data.
                </p>
              </div>

              {formData.dataStrategy === 'polling' && (
                <>
                  <div className="grid grid-cols-4 gap-3">
                    <div className="col-span-3">
                      <label className="block text-sm font-medium text-text-secondary mb-1">URL</label>
                      <input
                        type="text"
                        value={formData.dataUrl}
                        onChange={e => update('dataUrl', e.target.value)}
                        placeholder="https://api.example.com/data"
                        className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm"
                      />
                      <p className="text-xs text-text-muted mt-1">Use {'{{setting_name}}'} for user-configured values</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-text-secondary mb-1">Method</label>
                      <select
                        value={formData.dataMethod}
                        onChange={e => update('dataMethod', e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                      </select>
                    </div>
                  </div>

                  {/* Headers */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-sm font-medium text-text-secondary">Headers</label>
                      <button onClick={addHeader} className="text-xs text-accent hover:underline">+ Add header</button>
                    </div>
                    {formData.dataHeaders.map((header, i) => (
                      <div key={i} className="flex gap-2 mb-2">
                        <input
                          type="text"
                          value={header.key}
                          onChange={e => updateHeader(i, 'key', e.target.value)}
                          placeholder="Header name"
                          className="flex-1 px-3 py-1.5 rounded-lg border border-border-default bg-bg-page text-text-primary text-sm font-mono"
                        />
                        <input
                          type="text"
                          value={header.value}
                          onChange={e => updateHeader(i, 'value', e.target.value)}
                          placeholder="Value"
                          className="flex-1 px-3 py-1.5 rounded-lg border border-border-default bg-bg-page text-text-primary text-sm font-mono"
                        />
                        <button onClick={() => removeHeader(i)} className="text-red-500 hover:text-red-700 px-2">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-text-secondary mb-1">JSON Path</label>
                      <input
                        type="text"
                        value={formData.dataPath}
                        onChange={e => update('dataPath', e.target.value)}
                        placeholder="data.items"
                        className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary font-mono text-sm"
                      />
                      <p className="text-xs text-text-muted mt-1">Dot-notation path to extract from response</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-text-secondary mb-1">Refresh Interval (seconds)</label>
                      <input
                        type="number"
                        value={formData.refreshInterval}
                        onChange={e => update('refreshInterval', parseInt(e.target.value) || 300)}
                        min={60}
                        className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-1">Data Transform (JS)</label>
                    <textarea
                      value={formData.dataTransform}
                      onChange={e => update('dataTransform', e.target.value)}
                      placeholder="// Transform fetched data. 'data' and 'settings' are available.\n// Return the object to pass to the template.\nreturn { items: data.slice(0, 10) };"
                      rows={4}
                      className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-page text-text-primary font-mono text-sm"
                    />
                  </div>

                  <Button onClick={handleTestUrl} disabled={!formData.dataUrl || testLoading}>
                    {testLoading ? <LoadingSpinner size="sm" /> : 'Test URL'}
                  </Button>

                  {sampleData && (
                    <div className="mt-3 p-3 bg-bg-page rounded-lg border border-border-light overflow-auto max-h-60">
                      <p className="text-xs font-medium text-text-secondary mb-1">Sample Response:</p>
                      <pre className="text-xs text-text-muted font-mono whitespace-pre-wrap">
                        {JSON.stringify(sampleData, null, 2).slice(0, 2000)}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step 2: Template */}
          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">Liquid Template</h2>
              <p className="text-sm text-text-muted">
                Write your template using <a href="https://liquidjs.com/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Liquid</a> syntax.
                Use TRMNL CSS classes for layout.
              </p>

              {/* Layout tabs */}
              <div className="flex gap-2">
                {(['full', 'half_horizontal', 'half_vertical', 'quadrant'] as const).map(layout => (
                  <button
                    key={layout}
                    onClick={() => setActiveLayout(layout)}
                    className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                      activeLayout === layout
                        ? 'bg-accent text-white'
                        : 'bg-bg-page text-text-muted border border-border-light hover:text-text-primary'
                    }`}
                  >
                    {layout.replace(/_/g, ' ')}
                    {layout === 'full' && ' *'}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Editor */}
                <div>
                  <textarea
                    value={getActiveMarkup()}
                    onChange={e => setActiveMarkup(e.target.value)}
                    rows={18}
                    placeholder={`<div class="view view--${activeLayout}">\n  <div class="layout layout--col gap--medium">\n    <!-- Your template here -->\n  </div>\n</div>`}
                    className="w-full px-4 py-3 rounded-lg border border-border-default bg-bg-page text-text-primary font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-accent"
                    spellCheck={false}
                  />
                  {sampleData !== null && (
                    <p className="text-xs text-text-muted mt-2">
                      Available data keys: {Object.keys(
                        typeof sampleData === 'object' && sampleData !== null && !Array.isArray(sampleData)
                          ? sampleData : {},
                      ).join(', ') || 'none'}
                    </p>
                  )}
                </div>

                {/* Preview */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">Preview</span>
                    <button
                      onClick={handlePreview}
                      disabled={previewLoading || !getActiveMarkup()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-accent border border-accent/30 rounded-lg hover:bg-accent/5 transition-colors disabled:opacity-50"
                    >
                      {previewLoading ? (
                        <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-current" />
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                      Render Preview
                    </button>
                  </div>
                  <div className="bg-bg-muted rounded-lg border border-border-light overflow-hidden min-h-[200px] flex items-center justify-center">
                    {previewUrl ? (
                      <img src={previewUrl} alt="Template preview" className="w-full h-auto" style={{ imageRendering: 'pixelated' }} />
                    ) : (
                      <p className="text-xs text-text-muted p-4 text-center">Click "Render Preview" to see your template</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Settings Schema */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-text-primary">Settings Schema</h2>
                  <p className="text-sm text-text-muted">Define fields users fill in when installing this plugin.</p>
                </div>
                <button onClick={addField} className="text-sm text-accent hover:underline">+ Add field</button>
              </div>

              {formData.settingsSchema.length === 0 && (
                <div className="text-center py-8 text-text-muted">
                  <p>No settings fields defined. Users will install this plugin without configuration.</p>
                  <button onClick={addField} className="mt-2 text-accent hover:underline text-sm">Add a field</button>
                </div>
              )}

              {formData.settingsSchema.map((field, i) => (
                <div key={i} className="p-4 bg-bg-page rounded-lg border border-border-light space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-secondary">Field {i + 1}</span>
                    <button onClick={() => removeField(i)} className="text-red-500 hover:text-red-700 text-sm">Remove</button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Key</label>
                      <input
                        type="text"
                        value={field.key}
                        onChange={e => updateField(i, 'key', e.target.value)}
                        placeholder="api_key"
                        className="w-full px-2 py-1.5 rounded border border-border-default bg-bg-card text-text-primary text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Label</label>
                      <input
                        type="text"
                        value={field.label}
                        onChange={e => updateField(i, 'label', e.target.value)}
                        placeholder="API Key"
                        className="w-full px-2 py-1.5 rounded border border-border-default bg-bg-card text-text-primary text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Type</label>
                      <select
                        value={field.type}
                        onChange={e => updateField(i, 'type', e.target.value)}
                        className="w-full px-2 py-1.5 rounded border border-border-default bg-bg-card text-text-primary text-sm"
                      >
                        <option value="text">Text</option>
                        <option value="number">Number</option>
                        <option value="select">Select</option>
                        <option value="multi_select">Multi Select</option>
                        <option value="toggle">Toggle</option>
                        <option value="date">Date</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Default</label>
                      <input
                        type="text"
                        value={field.default || ''}
                        onChange={e => updateField(i, 'default', e.target.value)}
                        className="w-full px-2 py-1.5 rounded border border-border-default bg-bg-card text-text-primary text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={field.encrypted || false}
                        onChange={e => updateField(i, 'encrypted', e.target.checked)}
                        className="accent-accent"
                      />
                      Encrypted (API keys, secrets)
                    </label>
                    <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={field.required || false}
                        onChange={e => updateField(i, 'required', e.target.checked)}
                        className="accent-accent"
                      />
                      Required
                    </label>
                  </div>
                  {(field.type === 'select' || field.type === 'multi_select') && (
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Options (comma-separated)</label>
                      <input
                        type="text"
                        value={(field.options || []).join(', ')}
                        onChange={e => updateField(i, 'options', e.target.value.split(',').map(o => o.trim()).filter(Boolean))}
                        placeholder="option1, option2, option3"
                        className="w-full px-2 py-1.5 rounded border border-border-default bg-bg-card text-text-primary text-sm"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Step 4: Review */}
          {step === 4 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">Review</h2>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-bg-page rounded-lg border border-border-light">
                  <h3 className="text-sm font-medium text-text-secondary mb-2">Plugin Details</h3>
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-text-muted">Name</dt>
                      <dd className="text-text-primary font-medium">{formData.name || '—'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-text-muted">Slug</dt>
                      <dd className="text-text-primary font-mono text-xs">{formData.slug || '—'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-text-muted">Category</dt>
                      <dd className="text-text-primary capitalize">{formData.category}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-text-muted">Data Strategy</dt>
                      <dd className="text-text-primary capitalize">{formData.dataStrategy}</dd>
                    </div>
                    {formData.dataUrl && (
                      <div className="flex justify-between">
                        <dt className="text-text-muted">URL</dt>
                        <dd className="text-text-primary font-mono text-xs truncate max-w-48">{formData.dataUrl}</dd>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <dt className="text-text-muted">Settings Fields</dt>
                      <dd className="text-text-primary">{formData.settingsSchema.length}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-text-muted">Layout Templates</dt>
                      <dd className="text-text-primary">
                        {[formData.markupFull, formData.markupHalfHorizontal, formData.markupHalfVertical, formData.markupQuadrant]
                          .filter(Boolean).length}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="p-4 bg-bg-page rounded-lg border border-border-light">
                  <h3 className="text-sm font-medium text-text-secondary mb-2">Template Preview</h3>
                  <pre className="text-xs text-text-muted font-mono whitespace-pre-wrap overflow-auto max-h-48">
                    {formData.markupFull.slice(0, 500)}
                    {formData.markupFull.length > 500 && '...'}
                  </pre>
                </div>
              </div>

              {!formData.name && (
                <p className="text-sm text-red-500">Plugin name is required.</p>
              )}
              {!formData.slug && (
                <p className="text-sm text-red-500">Plugin slug is required.</p>
              )}
              {!formData.markupFull && (
                <p className="text-sm text-red-500">Full layout template is required.</p>
              )}
            </div>
          )}
        </div>

        {/* Persistent preview panel (edit mode) */}
        {isEdit && hasTemplate && (
          <div className="space-y-4">
            <div className="bg-bg-card rounded-xl shadow-theme-md border border-border-light p-4 sticky top-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-text-primary">Preview</h3>
                <button
                  onClick={handlePreview}
                  disabled={previewLoading}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-accent border border-accent/30 rounded-lg hover:bg-accent/5 transition-colors disabled:opacity-50"
                >
                  {previewLoading ? (
                    <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" />
                  ) : (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  )}
                  Refresh
                </button>
              </div>
              <div className="bg-bg-muted rounded-lg border border-border-light overflow-hidden">
                {previewUrl ? (
                  <img src={previewUrl} alt="Plugin preview" className="w-full h-auto" style={{ imageRendering: 'pixelated' }} />
                ) : (
                  <div className="flex items-center justify-center py-16 text-xs text-text-muted">
                    Loading preview...
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        </div>

        {/* Navigation buttons */}
        <div className="flex justify-between max-w-4xl">
          <Button
            variant="secondary"
            onClick={() => step > 0 ? setStep(step - 1) : navigate('/plugins')}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </Button>

          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep(step + 1)}>
              Next
            </Button>
          ) : (
            <Button
              onClick={() => void saveMutation.mutate(undefined)}
              disabled={saveMutation.isLoading || !formData.name || !formData.slug || !formData.markupFull}
              isLoading={saveMutation.isLoading}
            >
              {isEdit ? 'Save Changes' : 'Create Plugin'}
            </Button>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
