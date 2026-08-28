import type { ReactNode } from 'react';
import type { OperationsCollection, OperationsStatus } from '@inker/contracts';
import { MainLayout } from '../../components/layout';
import { Button } from '../../components/common';
import { useOperations } from './use-operations';

const card = 'bg-bg-card border border-border-light rounded-xl p-6 shadow-theme-sm';
const cell = 'px-3 py-3 text-left align-top border-b border-border-light';
const labels: Record<string, string> = {
  healthy: 'Healthy', degraded: 'Degraded', unavailable: 'Unavailable', ready: 'Ready', unknown: 'Unknown',
  fresh: 'Fresh', stale: 'Stale', error: 'Error', missing: 'Missing', pending: 'Pending', disabled: 'Disabled',
  active: 'Active', unseen: 'Never seen', current: 'Current', unassigned: 'Unassigned',
  connected: 'Connected', disconnected: 'Disconnected', 'not-applicable': 'Not applicable',
};
const reasons: Record<OperationsStatus['reasons'][number], string> = {
  API_DATABASE_UNAVAILABLE: 'API database unavailable', QUEUE_UNAVAILABLE: 'Queue unavailable',
  WORKER_UNAVAILABLE: 'Worker unavailable', QUEUE_BACKLOG: 'Queue backlog', DEAD_LETTERS: 'Dead letters present',
  SOURCE_ERRORS: 'Source errors', REMOTE_ERRORS: 'Remote errors', STALE_DEVICES: 'Stale devices',
  RENDER_ERRORS: 'Render errors', METRICS_UNAVAILABLE: 'Metrics unavailable',
};
function number(value: number | null): string { return value === null ? 'Unknown' : String(value); }
function age(value: number | null): string {
  if (value === null) return 'Unknown';
  if (value < 60) return `${Math.floor(value)} s`;
  if (value < 3600) return `${Math.floor(value / 60)} min`;
  if (value < 86400) return `${Math.floor(value / 3600)} h`;
  return `${Math.floor(value / 86400)} d`;
}
function Time({ value }: { value: string | null }) {
  return value === null ? <>Not recorded</> : <time dateTime={value} className="whitespace-nowrap">{value.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC')}</time>;
}
function Sample({ value, now }: { value: string | null; now: number }) {
  return <span className="text-xs text-text-muted">Sample: {value === null ? 'Unknown' : <Time value={value} />}
    {value !== null && now - Date.parse(value) > 60000 && <strong className="text-status-warning-text"> · Sample older than 60 s</strong>}
  </span>;
}
function Status({ value }: { value: string }) {
  const warning = ['degraded', 'stale', 'pending', 'disconnected', 'unseen', 'missing'].includes(value);
  const error = ['unavailable', 'error'].includes(value);
  return <span className={`font-semibold ${error ? 'text-status-error-text' : warning ? 'text-status-warning-text' : 'text-text-primary'}`}>{labels[value] ?? value}</span>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className={card} aria-label={title}><h2 className="text-xl font-bold text-text-primary mb-3">{title}</h2>{children}</section>;
}
function Table({ title, headers, children }: { title: string; headers: string[]; children: ReactNode }) {
  return <div className="overflow-x-auto mt-3" role="region" aria-label={`${title} table`} tabIndex={0}>
    <table className="w-full text-sm text-text-primary"><caption className="sr-only">{title}</caption>
      <thead><tr>{headers.map(header => <th scope="col" className={`${cell} font-semibold bg-bg-muted`} key={header}>{header}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}
function Collection<T>({ title, data, now, children }: {
  title: string; data: OperationsCollection<T>; now: number; children: ReactNode;
}) {
  return <Section title={title}>
    <Sample value={data.sampledAt} now={now} />
    {data.total === null ? <p className="text-sm text-text-muted mt-2">Unknown: this collection has no measurement.</p>
      : <p className="text-sm text-text-muted mt-2">Showing {data.items.length} of {data.total}.
        {data.truncated && <strong className="text-status-warning-text"> Truncated: additional records are not shown.</strong>}</p>}
    {data.total === 0 && <p className="text-sm text-text-muted mt-2">No records in this sample.</p>}
    {data.items.length > 0 && children}
  </Section>;
}
function Counters({ rows }: { rows: [string, number | null][] }) {
  return <dl className="grid grid-cols-2 gap-4 mt-4">{rows.map(([label, value]) => <div key={label}>
    <dt className="text-sm text-text-muted">{label}</dt><dd className="text-xl font-semibold text-text-primary">{number(value)}</dd>
  </div>)}</dl>;
}
function ActivityTimes({ attempt, success }: { attempt: string | null; success: string | null }) {
  return <><div>Attempt: <Time value={attempt} /></div><div>Success: <Time value={success} /></div></>;
}

export function Operations() {
  const { snapshot: data, error, busy, elapsed, refresh } = useOperations();
  const old = Boolean(data && (error || elapsed > 60000));
  const now = data ? Date.parse(data.generatedAt) + elapsed : 0;
  return <MainLayout><div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-3xl font-bold text-text-primary">Operations</h1>
        <p className="text-text-muted mt-2">Read-only diagnostics. Refreshes every 15 seconds while visible.</p></div>
      <Button variant="outline" onClick={refresh} disabled={busy}>Refresh diagnostics</Button>
    </div>
    <div role="status" aria-live="polite" className="text-sm text-text-muted">
      {busy ? 'Refreshing diagnostics…' : data ? 'Diagnostics loaded.' : 'No current diagnostics.'}
    </div>
    {error && <p role="alert" className="rounded-xl p-4 border border-status-error-border text-status-error-text">{error}
      {data && ' Last known measurements are shown below; they may be out of date.'}</p>}
    {old && <p className="rounded-xl p-4 border border-status-warning-border text-status-warning-text">Stale view: this is not a current health confirmation.</p>}
    {data && <>
      <Section title="Service health">
        <p className="text-2xl font-bold text-text-primary">{old ? 'Last known: ' : ''}<Status value={data.status} /></p>
        <p className="text-sm text-text-muted mt-2">Snapshot generated: <Time value={data.generatedAt} /> · Protocol {data.protocolVersion}</p>
        {data.reasons.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-text-primary">{data.reasons.map(reason => <li key={reason}>{reasons[reason]} <code className="text-xs">({reason})</code></li>)}</ul>}
        <dl className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-5 text-text-primary">
          <div><dt className="text-sm text-text-muted">API readiness</dt><dd>{data.health.apiReady ? 'Ready' : 'Not ready'}</dd></div>
          <div><dt className="text-sm text-text-muted">Database</dt><dd><Status value={data.health.database} /></dd></div>
          <div><dt className="text-sm text-text-muted">Redis</dt><dd><Status value={data.health.redis} /></dd></div>
          <div><dt className="text-sm text-text-muted">Workers</dt><dd><Status value={data.health.workers.status} /> · {number(data.health.workers.count)}</dd></div>
        </dl>
        <p className="mt-3"><Sample value={data.health.workers.sampledAt} now={now} /></p>
        <p className="text-xs text-text-muted mt-3">API readiness, worker availability and degraded operation are separate states. Counters are measured values; Unknown is not zero.</p>
      </Section>
      <Section title="Queues">
        <p className="text-sm text-text-muted">Durable job state. Due age excludes delayed jobs; processing age includes active claims.</p>
        <Table title="Queue state" headers={['Queue / sample', 'Pending', 'Delayed', 'Processing', 'Dead letters', 'Expired claims', 'Oldest due', 'Oldest processing']}>
          {data.queues.map(queue => <tr key={queue.queue}><th scope="row" className={cell}><code>{queue.queue}</code><div className="font-normal mt-1"><Sample value={queue.sampledAt} now={now} /></div></th>
            <td className={cell}>{number(queue.pending)}</td><td className={cell}>{number(queue.delayed)}</td><td className={cell}>{number(queue.processing)}</td>
            <td className={`${cell} ${(queue.deadLetters ?? 0) > 0 ? 'text-status-error-text font-bold' : ''}`}>{number(queue.deadLetters)}</td>
            <td className={cell}>{number(queue.expiredClaims)}</td><td className={cell}>{age(queue.oldestDueAgeSeconds)}</td><td className={cell}>{age(queue.oldestProcessingAgeSeconds)}</td></tr>)}
        </Table>
      </Section>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Section title="Render cache"><Sample value={data.renderCache.sampledAt} now={now} />
          <Counters rows={[[ 'Hits', data.renderCache.hits], ['Misses', data.renderCache.misses], ['Fallbacks', data.renderCache.fallbacks], ['Rendered', data.renderCache.rendered], ['Failures', data.renderCache.failures]]} />
        </Section>
        <Section title="WebSockets"><Sample value={data.websocket.sampledAt} now={now} />
          <Counters rows={[[ 'Authenticated connections', data.websocket.authenticatedConnections], ['Pending connections', data.websocket.pendingConnections], ['Liveness timeouts', data.websocket.livenessTimeouts], ['Authentication rejected', data.websocket.authRejected]]} />
        </Section>
      </div>
      <Collection title="Source activity" data={data.sources} now={now}>
        <Table title="Source activity" headers={['Source / connector', 'State', 'Last activity', 'Success age', 'Circuit open until', 'Error code']}>
          {data.sources.items.map(source => <tr key={source.sourceDefinitionId}><th scope="row" className={`${cell} font-normal`}><code>{source.sourceDefinitionId}</code><div>{source.connectorType}</div></th>
            <td className={cell}><Status value={source.freshness} />{!source.enabled && <div>Disabled</div>}</td>
            <td className={cell}><ActivityTimes attempt={source.lastAttemptAt} success={source.lastSuccessAt} /></td><td className={cell}>{age(source.ageSeconds)}</td>
            <td className={cell}><Time value={source.circuitOpenUntil} /></td><td className={cell}><code>{source.errorCode ?? 'None recorded'}</code></td></tr>)}
        </Table>
      </Collection>
      <Collection title="Device activity" data={data.devices} now={now}>
        <Table title="Device activity" headers={['Device / delivery', 'State', 'Connection', 'Last activity', 'Seen age', 'Publication']}>
          {data.devices.items.map(device => <tr key={device.deviceId}><th scope="row" className={`${cell} font-normal`}>Device {device.deviceId}<div>{device.deliveryMode}</div></th>
            <td className={cell}><Status value={device.state} />{!device.enabled && device.state !== 'disabled' && <div>Disabled</div>}</td><td className={cell}><Status value={device.connection} /></td>
            <td className={cell}><div>Seen: <Time value={device.lastSeenAt} /></div><div>Connected: <Time value={device.lastConnectedAt} /></div><div>Acknowledged: <Time value={device.acknowledgedAt} /></div></td>
            <td className={cell}>{age(device.ageSeconds)}</td><td className={cell}><Status value={device.publicationState} /></td></tr>)}
        </Table>
      </Collection>
      <Collection title="Remote activity" data={data.remotes} now={now}>
        <Table title="Remote activity" headers={['Subscription', 'State', 'Last activity', 'Success age', 'Next sync / circuit', 'Error code']}>
          {data.remotes.items.map(remote => <tr key={remote.subscriptionId}><th scope="row" className={`${cell} font-normal`}><code>{remote.subscriptionId}</code></th>
            <td className={cell}><Status value={remote.status} /></td><td className={cell}><ActivityTimes attempt={remote.lastAttemptAt} success={remote.lastSuccessAt} /></td><td className={cell}>{age(remote.ageSeconds)}</td>
            <td className={cell}><div>Next: <Time value={remote.nextSyncAt} /></div><div>Circuit open until: <Time value={remote.circuitOpenUntil} /></div></td>
            <td className={cell}><code>{remote.errorCode ?? 'None recorded'}</code></td></tr>)}
        </Table>
      </Collection>
      <Collection title="Dead letters" data={data.deadLetters} now={now}>
        <p className="text-sm text-text-muted mt-3">Diagnostic records only. No replay or deletion is available here.</p>
        <Table title="Dead letters" headers={['Event / correlation', 'Queue', 'Attempts', 'Occurred / processed', 'Error code']}>
          {data.deadLetters.items.map(event => <tr key={event.eventId}><th scope="row" className={`${cell} font-normal`}><code>{event.eventId}</code><div className="mt-1">Correlation: <code>{event.correlationId ?? 'Not recorded'}</code></div></th>
            <td className={cell}><code>{event.queue}</code></td><td className={cell}>{event.attempts}</td><td className={cell}><div>Occurred: <Time value={event.occurredAt} /></div><div>Processed: <Time value={event.processedAt} /></div></td>
            <td className={cell}><code>{event.errorCode}</code></td></tr>)}
        </Table>
      </Collection>
    </>}
  </div></MainLayout>;
}
