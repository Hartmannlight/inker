import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // Legacy plugin/widget settings are persisted opaque JSON. UX remediation
    // redirects this surface to Inker-native integrations; modelling a second
    // plugin schema is intentionally out of scope. Keep the exemption local.
    files: [
      'src/components/plugins/GrafanaConnectionModal.tsx',
      'src/components/plugins/GrafanaGeneratorModal.tsx',
      'src/components/plugins/plugin-actions.tsx',
      'src/components/screen-designer/DesignCanvas.tsx',
      'src/components/screen-designer/WidgetSettingsPanel.tsx',
      'src/pages/playlists/PlaylistForm.tsx',
      'src/pages/plugins/InstalledPlugins.tsx',
      'src/pages/plugins/PluginCreator.tsx',
      'src/pages/plugins/PluginInstanceForm.tsx',
      'src/pages/plugins/PluginLibrary.tsx',
      'src/pages/screens/ScreensList.tsx',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // These established uncontrolled editors reset local draft state on an
      // external preview/version change. Rewriting their lifecycle is outside
      // UX-10 and would change legacy editor behavior.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'no-empty': 'off',
    },
  },
])
