import { Link, useSearchParams } from 'react-router-dom';
import { MainLayout } from '../../components/layout';

type Tab = 'connections' | 'data-sources';

/** External connections are separate from display extensions. */
export function Integrations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: Tab = searchParams.get('tab') === 'data-sources' ? 'data-sources' : 'connections';
  const select = (tab: Tab) => setSearchParams(tab === 'connections' ? {} : { tab });

  return <MainLayout><div className="space-y-6">
    <div><h1 className="text-2xl font-bold text-text-primary">Integrations</h1>
      <p className="mt-1 text-sm text-text-muted">Manage trusted external connections and their Inker-managed data.</p></div>
    <div className="border-b border-border-light"><nav className="flex gap-8" aria-label="Integration sections">
      <button type="button" onClick={() => select('connections')} className={`pb-4 px-1 border-b-2 font-medium text-sm ${activeTab === 'connections' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-secondary'}`}>Connections</button>
      <button type="button" onClick={() => select('data-sources')} className={`pb-4 px-1 border-b-2 font-medium text-sm ${activeTab === 'data-sources' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-secondary'}`}>Data sources (advanced)</button>
    </nav></div>
    {activeTab === 'connections' ? <section className="rounded-xl border border-border-light bg-bg-card p-6">
      <h2 className="text-lg font-semibold text-text-primary">Grafana</h2>
      <p className="mt-2 text-sm text-text-secondary">Create a beta Grafana panel source. Credentials are encrypted and used only by the Inker connector worker.</p>
      <Link to="/integrations/grafana" className="mt-4 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent-hover">Add Grafana panel</Link>
      <span className="ml-3 inline-flex rounded-full bg-bg-muted px-2.5 py-1 text-xs font-medium text-text-muted">Beta</span>
    </section> : <section className="rounded-xl border border-border-light bg-bg-card p-6">
      <h2 className="text-lg font-semibold text-text-primary">Advanced data sources</h2>
      <p className="mt-2 text-sm text-text-secondary">Data sources provide persisted snapshots for widgets. They are an advanced integration surface, not an extension marketplace.</p>
      <Link to="/data-sources/new" className="mt-4 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent-hover">Create data source</Link>
    </section>}
  </div></MainLayout>;
}
