import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { supabase } from '../lib/supabase'
import { getEvaluatorScope } from '../lib/evaluatorScope'
import { DISPUTE_STATUS, DISPUTE_TERMINAL } from '../lib/disputes'

/*
  Disputes.

  Agent disputes (kind NULL) and DSAT spot-check disputes (kind 'dsat_spotcheck') across
  the viewer's scope. Criticality disputes are left out on purpose: they are a Team Leader
  challenging a critical marking, decided in the Coaching Queue, and are not agent disputes.

  Visibility: Admins and Owners see everything; Team Leaders see every dispute on their
  hubs, spot-check disputes included; Evaluators see disputes on their own evaluations plus
  spot-check disputes they raised as the BPO QA. Agents have no access to this page. RLS
  still has the final say on every query below.

  "View" reuses the dispute window on the Evaluations page through its ?dispute= deep link,
  so the decision logic exists in exactly one place.
*/

const PAGE_SIZE = 25

// PostgREST puts .in() lists in the URL, so long id lists are fetched in slices.
async function inChunks(ids, size, run) {
  const out = []
  for (let i = 0; i < ids.length; i += size) {
    const { data, error } = await run(ids.slice(i, i + size))
    if (error) console.error('Disputes load:', error.message)
    out.push(...(data || []))
  }
  return out
}

const day = (ts) => (ts ? String(ts).slice(0, 10) : '')
const fmt = (ts) => (ts ? new Date(ts).toLocaleDateString() : '—')

export default function Disputes() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState([])
  const [page, setPage] = useState(1)

  const [fDiv, setFDiv] = useState('')
  const [fWs, setFWs] = useState('')
  const [fHub, setFHub] = useState('')
  const [fMarket, setFMarket] = useState('')
  const [fScorecard, setFScorecard] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fType, setFType] = useState('')
  const [fFrom, setFrom] = useState('')
  const [fTo, setTo] = useState('')

  const load = async () => {
    setLoading(true)
    const priv = ['owner', 'admin'].includes(profile?.role)
    const isTL = profile?.role === 'team_leader'

    let q = supabase.from('disputes')
      .select('*, evaluator:users!disputes_evaluator_id_fkey(name), agent:users!disputes_agent_id_fkey(name, email)')
      .order('created_at', { ascending: false }).limit(5000)
    if (priv) {
      q = q.or('kind.is.null,kind.neq.criticality')
    } else if (isTL) {
      const sc = await getEvaluatorScope(profile.id); const hubIds = sc.hubIds || []
      if (!hubIds.length) { setRows([]); setLoading(false); return }
      q = q.in('hub_id', hubIds).or('kind.is.null,kind.neq.criticality')
    } else {
      // Evaluators: disputes on evaluations they did (agent disputes, and spot-check
      // disputes where they are the KG QA), PLUS spot-check disputes they raised
      // themselves as the BPO QA. In a spot-check dispute the raiser is stored in
      // agent_id, which is why the second branch matches on agent_id.
      // Written as one or() so criticality disputes stay excluded in every branch.
      const me = profile.id
      q = q.or(
        `and(evaluator_id.eq.${me},kind.is.null),` +
        `and(evaluator_id.eq.${me},kind.eq.dsat_spotcheck),` +
        `and(agent_id.eq.${me},kind.eq.dsat_spotcheck)`
      )
    }
    const { data: disputes, error } = await q
    if (error) console.error('Disputes load:', error.message)
    const list = disputes || []
    if (!list.length) { setRows([]); setLoading(false); return }

    const evalIds = [...new Set(list.map(d => d.evaluation_id).filter(Boolean))]
    const disputeIds = list.map(d => d.id)

    const [evs, approvals, { data: hubs }, { data: wss }, { data: divs }, { data: queues }] = await Promise.all([
      inChunks(evalIds, 150, ids => supabase.from('evaluations')
        .select('id, eval_id, scorecard_id, submitted_at, created_at, hub_id, workspace_id, queue_id').in('id', ids)),
      // The Team Leader who approved the dispute is whoever wrote the tl_approved event.
      // Read from the history rather than disputes.tl_id, because tl_id is the Team Leader
      // the agent addressed, not proof that anyone approved.
      inChunks(disputeIds, 150, ids => supabase.from('dispute_events')
        .select('dispute_id, created_at, actor:users!dispute_events_actor_id_fkey(name)')
        .eq('action', 'tl_approved').in('dispute_id', ids)),
      supabase.from('hubs').select('id, name, workspace_id'),
      supabase.from('workspaces').select('id, name, division_id'),
      supabase.from('divisions').select('id, name'),
      supabase.from('queues').select('id, market_value'),
    ])

    const scIds = [...new Set(evs.map(e => e.scorecard_id).filter(Boolean))]
    const scs = scIds.length
      ? await inChunks(scIds, 150, ids => supabase.from('scorecards').select('id, name').in('id', ids))
      : []

    const evMap = Object.fromEntries(evs.map(e => [e.id, e]))
    const scMap = Object.fromEntries(scs.map(s => [s.id, s.name]))
    const hubMap = Object.fromEntries((hubs || []).map(h => [h.id, h]))
    const wsMap = Object.fromEntries((wss || []).map(w => [w.id, w]))
    const divMap = Object.fromEntries((divs || []).map(d => [d.id, d.name]))
    const mktMap = Object.fromEntries((queues || []).map(x => [x.id, x.market_value]))
    // Latest approval wins, so a dispute approved again after a re-dispute shows who
    // approved it most recently.
    const tlMap = {}
    approvals.forEach(a => {
      const prev = tlMap[a.dispute_id]
      if (!prev || a.created_at > prev.created_at) tlMap[a.dispute_id] = a
    })

    setRows(list.map(d => {
      const ev = evMap[d.evaluation_id] || {}
      const hub = hubMap[d.hub_id || ev.hub_id]
      const ws = wsMap[hub?.workspace_id || ev.workspace_id]
      const spot = d.kind === 'dsat_spotcheck'
      return {
        ...d,
        _evalNo: ev.eval_id ?? null,
        _type: spot ? 'DSAT spot-check' : (d.eval_type === 'dsat' ? 'DSAT' : 'Quality'),
        _scorecard: scMap[ev.scorecard_id] || '',
        _division: ws ? (divMap[ws.division_id] || '') : '',
        _workspace: ws?.name || '',
        _hub: hub?.name || '',
        _market: mktMap[d.queue_id || ev.queue_id] || '',
        _raisedBy: d.agent?.name || d.agent?.email || '—',
        _tl: spot ? 'Spot-check' : (tlMap[d.id]?.actor?.name || '—'),
        _evaluator: d.evaluator?.name || '—',
        _evalDate: ev.submitted_at || ev.created_at || null,
        _date: day(d.created_at),
      }
    }))
    setLoading(false)
  }
  useEffect(() => { if (profile?.id) load() /* eslint-disable-next-line */ }, [profile?.id])

  // Any filter change goes back to page 1, or you can be left on a page that no longer exists.
  useEffect(() => { setPage(1) }, [fDiv, fWs, fHub, fMarket, fScorecard, fStatus, fType, fFrom, fTo])

  // Cascading options: each level only offers values that exist under the levels above it,
  // and only values that actually appear on disputes the viewer can see.
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort()
  const inDiv = rows.filter(r => !fDiv || r._division === fDiv)
  const inWs = inDiv.filter(r => !fWs || r._workspace === fWs)
  const inHub = inWs.filter(r => !fHub || r._hub === fHub)
  const divOpts = uniq(rows.map(r => r._division))
  const wsOpts = uniq(inDiv.map(r => r._workspace))
  const hubOpts = uniq(inWs.map(r => r._hub))
  const mktOpts = uniq(inHub.map(r => r._market))
  const scOpts = uniq(rows.map(r => r._scorecard))

  const flt = rows.filter(r =>
    (!fDiv || r._division === fDiv) && (!fWs || r._workspace === fWs) &&
    (!fHub || r._hub === fHub) && (!fMarket || r._market === fMarket) &&
    (!fScorecard || r._scorecard === fScorecard) &&
    (!fStatus || r.status === fStatus) && (!fType || r._type === fType) &&
    (!fFrom || (r._date && r._date >= fFrom)) && (!fTo || (r._date && r._date <= fTo)))

  const total = flt.length
  const upheld = flt.filter(r => r.outcome === 'upheld').length
  const rejected = flt.filter(r => r.outcome === 'rejected').length
  const cancelled = flt.filter(r => r.outcome === 'cancelled').length
  const pending = flt.filter(r => !DISPUTE_TERMINAL.includes(r.status)).length
  const redisputed = flt.filter(r => (r.re_dispute_count || 0) > 0).length
  const decided = upheld + rejected
  const acceptRate = decided ? Math.round((upheld / decided) * 100) : 0

  const byEvalMap = {}
  flt.forEach(r => {
    const k = r._evaluator
    byEvalMap[k] = byEvalMap[k] || { name: k, total: 0, upheld: 0, rejected: 0, pending: 0 }
    byEvalMap[k].total++
    if (r.outcome === 'upheld') byEvalMap[k].upheld++
    if (r.outcome === 'rejected') byEvalMap[k].rejected++
    if (!DISPUTE_TERMINAL.includes(r.status)) byEvalMap[k].pending++
  })
  const byEval = Object.values(byEvalMap).sort((a, b) => b.total - a.total)

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const curPage = Math.min(page, pageCount)
  const start = (curPage - 1) * PAGE_SIZE
  const paged = flt.slice(start, start + PAGE_SIZE)

  const exportCsv = () => {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const headers = ['Evaluation', 'Type', 'Scorecard', 'Division', 'Workspace', 'Hub', 'Market',
      'Raised by', 'Accepted by (Team Leader)', 'Evaluator', 'Status', 'Outcome', 'Re-disputes',
      'Evaluation date', 'Dispute date']
    const lines = [headers.map(esc).join(',')]
    flt.forEach(r => lines.push([
      esc(r._evalNo != null ? '#' + r._evalNo : ''), esc(r._type), esc(r._scorecard),
      esc(r._division), esc(r._workspace), esc(r._hub), esc(r._market),
      esc(r._raisedBy), esc(r._tl), esc(r._evaluator),
      esc(DISPUTE_STATUS[r.status]?.label || r.status), esc(r.outcome || 'open'), esc(r.re_dispute_count || 0),
      esc(day(r._evalDate)), esc(r._date),
    ].join(',')))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `disputes-${new Date().toISOString().split('T')[0]}.csv`; a.click(); URL.revokeObjectURL(a.href)
  }

  const clearAll = () => {
    setFDiv(''); setFWs(''); setFHub(''); setFMarket(''); setFScorecard('')
    setFStatus(''); setFType(''); setFrom(''); setTo('')
  }
  const anyFilter = fDiv || fWs || fHub || fMarket || fScorecard || fStatus || fType || fFrom || fTo

  const sel = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }
  const card = { flex: 1, minWidth: 130, textAlign: 'center', padding: '18px 16px' }
  const cnum = { fontSize: 26, fontWeight: 700 }
  const clbl = { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }
  const thStyle = { padding: '10px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }
  const tdStyle = { padding: '10px 14px' }
  const section = { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }

  if (loading) return <div className="page"><div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div></div>

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1>Disputes</h1>
          <p className="page-sub">Agent and DSAT spot-check disputes in your scope.</p>
        </div>
        <button className="btn btn-accent-soft" onClick={exportCsv}>⬇ Export to Excel</button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Filter:</span>
        <select style={sel} value={fDiv} onChange={e => { setFDiv(e.target.value); setFWs(''); setFHub(''); setFMarket('') }}>
          <option value="">All Divisions</option>{divOpts.map(o => <option key={o}>{o}</option>)}
        </select>
        <select style={sel} value={fWs} onChange={e => { setFWs(e.target.value); setFHub(''); setFMarket('') }}>
          <option value="">All Workspaces</option>{wsOpts.map(o => <option key={o}>{o}</option>)}
        </select>
        <select style={sel} value={fHub} onChange={e => { setFHub(e.target.value); setFMarket('') }}>
          <option value="">All Hubs</option>{hubOpts.map(o => <option key={o}>{o}</option>)}
        </select>
        <select style={sel} value={fMarket} onChange={e => setFMarket(e.target.value)}>
          <option value="">All Markets</option>{mktOpts.map(o => <option key={o}>{o}</option>)}
        </select>
        <select style={sel} value={fScorecard} onChange={e => setFScorecard(e.target.value)}>
          <option value="">All Scorecards</option>{scOpts.map(o => <option key={o}>{o}</option>)}
        </select>
        <select style={sel} value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {Object.entries(DISPUTE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select style={sel} value={fType} onChange={e => setFType(e.target.value)}>
          <option value="">All Types</option><option>Quality</option><option>DSAT</option><option>DSAT spot-check</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>raised from</span>
        <input type="date" style={sel} value={fFrom} onChange={e => setFrom(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>to</span>
        <input type="date" style={sel} value={fTo} onChange={e => setTo(e.target.value)} />
        {anyFilter && <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear filters</button>}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <div className="card" style={card}><div style={cnum}>{total}</div><div style={clbl}>Raised</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#22c55e' }}>{upheld}</div><div style={clbl}>Upheld</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#ef4444' }}>{rejected}</div><div style={clbl}>Rejected</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#f59e0b' }}>{pending}</div><div style={clbl}>Pending</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#6366f1' }}>{redisputed}</div><div style={clbl}>Re-disputed</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#64748b' }}>{cancelled}</div><div style={clbl}>Cancelled</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: acceptRate >= 50 ? '#22c55e' : '#dc2626' }}>{acceptRate}%</div><div style={clbl}>Acceptance rate</div></div>
      </div>

      <div style={section}>By evaluator</div>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 24 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={thStyle}>Evaluator</th><th style={thStyle}>Disputes</th><th style={thStyle}>Upheld</th>
            <th style={thStyle}>Rejected</th><th style={thStyle}>Pending</th><th style={thStyle}>Acceptance</th>
          </tr></thead>
          <tbody>
            {byEval.length === 0 && <tr><td colSpan="6" style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No disputes match the selected filters.</td></tr>}
            {byEval.map(c => {
              const dec = c.upheld + c.rejected; const rate = dec ? Math.round((c.upheld / dec) * 100) : 0
              return (
                <tr key={c.name} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...tdStyle, fontWeight: 500 }}>{c.name}</td>
                  <td style={tdStyle}>{c.total}</td>
                  <td style={tdStyle}>{c.upheld}</td>
                  <td style={tdStyle}>{c.rejected}</td>
                  <td style={tdStyle}>{c.pending}</td>
                  <td style={{ ...tdStyle, fontWeight: 600, color: rate >= 50 ? 'var(--success)' : 'var(--danger)' }}>{rate}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={section}>Disputes</div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={thStyle}>Eval</th><th style={thStyle}>Type</th><th style={thStyle}>Scorecard</th>
            <th style={thStyle}>Hub / Market</th><th style={thStyle}>Raised by</th><th style={thStyle}>Accepted by (TL)</th>
            <th style={thStyle}>Evaluator</th><th style={thStyle}>Status</th>
            <th style={thStyle}>Evaluation date</th><th style={thStyle}>Dispute date</th>
            <th style={{ ...thStyle, textAlign: 'right' }} />
          </tr></thead>
          <tbody>
            {paged.length === 0 && <tr><td colSpan="11" style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No disputes.</td></tr>}
            {paged.map(r => {
              const st = DISPUTE_STATUS[r.status] || { label: r.status, color: 'var(--text-secondary)' }
              return (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{r._evalNo != null ? `#${r._evalNo}` : '—'}</td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{r._type}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{r._scorecard || '—'}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{[r._hub, r._market].filter(Boolean).join(' · ') || '—'}</td>
                  <td style={tdStyle}>{r._raisedBy}</td>
                  <td style={{ ...tdStyle, color: r._tl === '—' ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>{r._tl}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{r._evaluator}</td>
                  <td style={tdStyle}><span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: st.color + '22', color: st.color, whiteSpace: 'nowrap' }}>{st.label}</span></td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fmt(r._evalDate)}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fmt(r.created_at)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/evaluations?dispute=${r.id}`)}>View</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {pageCount > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Showing {start + 1}–{Math.min(start + PAGE_SIZE, total)} of {total} disputes
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn btn-ghost btn-sm" disabled={curPage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>← Previous</button>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 92, textAlign: 'center' }}>Page {curPage} of {pageCount}</span>
              <button className="btn btn-ghost btn-sm" disabled={curPage >= pageCount} onClick={() => setPage(p => Math.min(pageCount, p + 1))}>Next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}