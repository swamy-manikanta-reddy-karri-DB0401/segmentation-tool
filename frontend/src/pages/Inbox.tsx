import { api } from '../api'
import { Empty, usePolling, useAsync } from '../components/ui'

interface Batch { received_at: string; action: string; audience: string; row_count: number; sample: unknown[] }

export default function Inbox() {
  const inbox = useAsync(() => api.get<Batch[]>('/inbox'))
  usePolling(inbox.reload, 3000, true)
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Test inbox</h1><p>A built-in webhook receiver for trying out activations. Point a Webhook destination at it to see exactly what gets sent.</p></div>
        <button className="btn" onClick={async () => { await api.del('/inbox'); inbox.reload() }}>Clear</button>
      </div>
      {inbox.data?.length ? (
        <div className="stack">
          {inbox.data.map((b, i) => (
            <div key={i} className="card">
              <div className="card-head">
                <div className="row">
                  <span className={`badge ${b.action === 'remove' ? 'red' : 'green'}`}>{b.action}</span>
                  <strong>{b.row_count.toLocaleString()} records</strong>
                  <span className="muted small">from “{b.audience}”</span>
                </div>
                <span className="small muted">{new Date(b.received_at).toLocaleTimeString()}</span>
              </div>
              <div className="card-body"><pre className="code" style={{ maxHeight: 200 }}>{JSON.stringify(b.sample, null, 2)}{b.row_count > b.sample.length ? `\n… and ${b.row_count - b.sample.length} more` : ''}</pre></div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card"><Empty title="Nothing received yet">Create a Webhook destination, click “Use built-in Test Inbox”, then run an activation.</Empty></div>
      )}
    </div>
  )
}
