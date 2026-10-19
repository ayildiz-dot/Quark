import { useState, useEffect, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../App'
import CoachingQueue, { getMeta, isCoachable, coachingSla } from '../components/CoachingQueue'
import { getEvaluatorScope } from '../lib/evaluatorScope'

// ─── Constants ────────────────────────────────────────────────────────────────
const MODELS = [
  { value: 'GROW',     label: 'GROW (Goal · Reality · Options · Will)' },
  { value: 'CLEAR',    label: 'CLEAR (Contract · Listen · Explore · Action · Review)' },
  { value: 'freeform', label: 'Free-form' },
]
const MODEL_NOTES = {
  GROW: 'A structured improvement conversation: set the Goal, look at the Reality, explore Options, agree the Will (next steps). Best for most performance-improvement plans.',
  CLEAR: 'A deeper, behaviour-focused frame: Contract, Listen, Explore, Action, Review. Best when the root cause is attitudinal or needs reflection rather than a quick fix.',
  freeform: 'No fixed structure — capture observations and actions in your own way. Best for light-touch or ad-hoc coaching.',
}

const STATUS = {
  draft:                { label: 'Draft',                color: '#64748b', bg: '#64748b22' },
  active:               { label: 'Active',               color: '#6366f1', bg: '#6366f122' },
  pending_verification: { label: 'Pending verification', color: '#f59e0b', bg: '#f59e0b22' },
  closed_met:           { label: 'Closed · Met',         color: '#22c55e', bg: '#22c55e22' },
  closed_not_met:       { label: 'Closed · Not met',     color: '#ef4444', bg: '#ef444422' },
  cancelled:            { label: 'Cancelled',            color: '#94a3b8', bg: '#94a3b822' },
}
const ACTIVE_STATUSES = ['active', 'pending_verification']
const CLOSED_STATUSES = ['closed_met', 'closed_not_met', 'cancelled']

const StatusBadge = ({ status }) => {
  const s = STATUS[status] || STATUS.draft
  return (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600,
      backgroundColor: s.bg, color: s.color, whiteSpace: 'nowrap' }}>{s.label}</span>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0] }
const fmtDate = (d) => d ? new Date(d).toLocaleDateString() : '—'
function isoWeek(dateStr) {
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const week1 = new Date(d.getFullYear(), 0, 4)
  const wk = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
  return `${d.getFullYear()}-W${String(wk).padStart(2, '0')}`
}

// ─── Confirm modal ────────────────────────────────────────────────────────────
function ConfirmModal({ message, onYes, onNo }) {
  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: '#00000066',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
      <div className="card" style={{ width: 400, padding: '28px', textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Are you sure?</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>{message}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button className="btn btn-danger" style={{ minWidth: 80 }} onClick={onYes}>Yes</button>
          <button className="btn btn-ghost" style={{ minWidth: 80 }} onClick={onNo}>No</button>
        </div>
      </div>
    </div>
  )
}

// ─── New Observation Session modal (floating, Calibration style) ────────────
function NewObservationModal({ profile, isPrivileged, gov, parent, flash, onClose, onSaved }) {
  const [agentSearch, setAgentSearch] = useState('')
  const [agentId, setAgentId]   = useState(parent?.agent_id || '')
  const [ctxQueueId, setCtxQ]   = useState('')
  const [model, setModel]       = useState('GROW')
  const [strengths, setStr]     = useState('')
  const [observations, setObs]  = useState('')
  const [rootCause, setRoot]    = useState('')
  const [focus, setFocus]       = useState([{ label: '' }])
  const [actions, setActions]   = useState([{ description: '', done_test: '', due_date: '' }])
  const [closeDate, setClose]   = useState(plusDays(7))
  const [saving, setSaving]     = useState(false)

  // Governance-derived option lists
  const myQueues = useMemo(() => {
    if (isPrivileged) return gov.queues
    return gov.queues.filter(q => gov.myQueueIds.has(q.id))
  }, [gov, isPrivileged])

  const agents = useMemo(() => {
    if (isPrivileged) return gov.agents
    const qids = new Set(myQueues.map(q => q.id))
    const agentIds = new Set(gov.userQueues.filter(uq => qids.has(uq.queue_id)).map(uq => uq.user_id))
    return gov.agents.filter(a => agentIds.has(a.id))
  }, [myQueues, gov, isPrivileged])

  const candidateCtx = useMemo(() => {
    if (!agentId) return []
    const agentQ = new Set(gov.userQueues.filter(uq => uq.user_id === agentId).map(uq => uq.queue_id))
    return myQueues.filter(q => agentQ.has(q.id))
  }, [agentId, myQueues, gov])

  useEffect(() => { setCtxQ(candidateCtx.length === 1 ? candidateCtx[0].id : '') }, [candidateCtx])

  const setFocusField  = (i, v) => setFocus(f => f.map((x, j) => j === i ? { label: v } : x))
  const setActionField = (i, k, v) => setActions(a => a.map((x, j) => j === i ? { ...x, [k]: v } : x))

  const save = async (deliver) => {
    if (!agentId) return flash('Select the agent being observed.', false)
    const cleanFocus   = focus.filter(f => f.label.trim())
    const cleanActions = actions.filter(a => a.description.trim())
    if (deliver && cleanFocus.length === 0) return flash('Add at least one focus area before delivering.', false)
    if (deliver && cleanActions.length === 0) return flash('Add at least one action item before delivering.', false)

    const ctx = ctxQueueId ? gov.queueCtx[ctxQueueId] : (candidateCtx.length === 1 ? gov.queueCtx[candidateCtx[0].id] : null)

    setSaving(true)
    const { data: session, error } = await supabase.from('coaching_sessions').insert({
      agent_id: agentId,
      coach_id: profile.id,
      status: deliver ? 'active' : 'draft',
      coaching_model: model,
      strengths: strengths.trim() || null,
      observations: observations.trim() || null,
      root_cause: rootCause.trim() || null,
      division: ctx?.division_name || null,
      workspace_id: ctx?.workspace_id || null,
      hub_id: ctx?.hub_id || null,
      queue_id: ctxQueueId || (candidateCtx.length === 1 ? candidateCtx[0].id : null),
      market: ctx?.market || null,
      planned_close_date: closeDate || null,
      parent_session_id: parent?.id || null,
    }).select().single()
    if (error) { setSaving(false); return flash(error.message, false) }

    if (cleanFocus.length) {
      await supabase.from('coaching_focus_areas').insert(cleanFocus.map((f, i) => ({
        session_id: session.id, label: f.label.trim(), sort_order: i,
      })))
    }
    if (cleanActions.length) {
      await supabase.from('coaching_action_items').insert(cleanActions.map((a, i) => ({
        session_id: session.id, description: a.description.trim(),
        done_test: a.done_test.trim() || null, owner_id: agentId,
        due_date: a.due_date || null, sort_order: i,
      })))
    }
    setSaving(false)
    flash(deliver ? 'Observation session delivered' : 'Draft saved')
    onSaved()
  }

  const lbl = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }
  const inp = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }
  const sect = { fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '6px 0 2px' }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header" style={{ flexShrink: 0 }}>
          <h2>{parent ? 'Re-coaching session' : 'New Observation Session'}</h2>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', minHeight: 0 }}>
          {parent && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Follow-up to a previous session that was not sustained.</div>
          )}

          <div>
            <label style={lbl}>Agent being observed *</label>
            {agentId ? (
              <div style={{ ...inp, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{(() => { const a = agents.find(x => x.id === agentId); return a ? `${a.name} (${a.email})` : 'Selected agent' })()}</span>
                {!parent && <button type="button" onClick={() => { setAgentId(''); setAgentSearch('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 14 }}>✕</button>}
              </div>
            ) : (
              <>
                <input style={inp} placeholder="Type to search an agent in your queues…" value={agentSearch} onChange={e => setAgentSearch(e.target.value)} />
                {agentSearch.trim() && (
                  <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, background: 'var(--bg-secondary)' }}>
                    {agents.filter(a => `${a.name} ${a.email}`.toLowerCase().includes(agentSearch.trim().toLowerCase())).slice(0, 50).map(a => (
                      <div key={a.id} onClick={() => { setAgentId(a.id); setAgentSearch('') }} style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 13 }}>{a.name} ({a.email})</div>
                    ))}
                    {agents.filter(a => `${a.name} ${a.email}`.toLowerCase().includes(agentSearch.trim().toLowerCase())).length === 0 && (
                      <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)' }}>No matching agent in your queues.</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {candidateCtx.length > 1 && (
            <div>
              <label style={lbl}>Queue / Market</label>
              <select style={inp} value={ctxQueueId} onChange={e => setCtxQ(e.target.value)}>
                <option value="">— Select which queue this relates to —</option>
                {candidateCtx.map(q => {
                  const c = gov.queueCtx[q.id]
                  return <option key={q.id} value={q.id}>{c?.workspace_name} › {c?.hub_name} › {c?.market || q.name}</option>
                })}
              </select>
            </div>
          )}

          <div>
            <label style={lbl}>Observation model</label>
            <select style={inp} value={model} onChange={e => setModel(e.target.value)}>
              {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 5, lineHeight: 1.5 }}>{MODEL_NOTES[model]}</div>
          </div>

          <div>
            <label style={lbl}>Suggested close date</label>
            <input type="date" style={{ ...inp, maxWidth: 200 }} value={closeDate} onChange={e => setClose(e.target.value)} />
          </div>

          <div style={sect}>Session notes</div>
          <div>
            <label style={lbl}>Strengths / what went well</label>
            <textarea style={{ ...inp, resize: 'vertical', minHeight: 54 }} value={strengths} onChange={e => setStr(e.target.value)} placeholder="Recognise what the agent is doing well." />
          </div>
          <div>
            <label style={lbl}>Observations</label>
            <textarea style={{ ...inp, resize: 'vertical', minHeight: 54 }} value={observations} onChange={e => setObs(e.target.value)} placeholder="What you've observed overall." />
          </div>
          <div>
            <label style={lbl}>Agreed root cause</label>
            <textarea style={{ ...inp, resize: 'vertical', minHeight: 54 }} value={rootCause} onChange={e => setRoot(e.target.value)} placeholder="The root cause you and the agent agreed on." />
          </div>

          <div style={sect}>Focus areas (keep to 1–2)</div>
          {focus.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input style={inp} value={f.label} onChange={e => setFocusField(i, e.target.value)} placeholder={`Focus area ${i + 1} — e.g. Empathy statements`} />
              {focus.length > 1 && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setFocus(f => f.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          {focus.length < 3 && <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setFocus(f => [...f, { label: '' }])}>+ Add focus area</button>}

          <div style={sect}>Action plan</div>
          {actions.map((a, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
              <label style={lbl}>Action {i + 1} — what the agent will do</label>
              <input style={{ ...inp, marginBottom: 8 }} value={a.description} onChange={e => setActionField(i, 'description', e.target.value)} placeholder="e.g. Open every chat with a personalised greeting" />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label style={lbl}>Done test (how we'll know it worked)</label>
                  <input style={inp} value={a.done_test} onChange={e => setActionField(i, 'done_test', e.target.value)} placeholder="e.g. Empathy scored PASS on next 3 evaluations" />
                </div>
                <div style={{ width: 160 }}>
                  <label style={lbl}>Due date</label>
                  <input type="date" style={inp} value={a.due_date} onChange={e => setActionField(i, 'due_date', e.target.value)} />
                </div>
                {actions.length > 1 && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setActions(a => a.filter((_, j) => j !== i))}>Remove</button>}
              </div>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setActions(a => [...a, { description: '', done_test: '', due_date: '' }])}>+ Add action item</button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '16px 20px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <button className="btn btn-ghost" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="btn btn-ghost" disabled={saving} onClick={() => save(false)}>Save as draft</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => save(true)}>{saving ? 'Saving…' : 'Deliver session'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Session detail modal ─────────────────────────────────────────────────────
function SessionDetail({ session, profile, isCoach, flash, onClose, onChanged, onRecoach, onResumeDraft }) {
  const [focus, setFocus]     = useState([])
  const [actions, setActions] = useState([])
  const [ackComment, setAck]  = useState('')
  const [confirm, setConfirm] = useState(null)
  const isOwnAgent = session.agent_id === profile.id

  const load = async () => {
    const [{ data: f }, { data: a }] = await Promise.all([
      supabase.from('coaching_focus_areas').select('*').eq('session_id', session.id).order('sort_order'),
      supabase.from('coaching_action_items').select('*').eq('session_id', session.id).order('sort_order'),
    ])
    setFocus(f || []); setActions(a || [])
  }
  useEffect(() => { load() }, [])

  const setActionStatus = async (item, status) => {
    const patch = { status }
    if (status === 'met' || status === 'not_met') { patch.verified_by = profile.id; patch.verified_at = new Date().toISOString() }
    const { error } = await supabase.from('coaching_action_items').update(patch).eq('id', item.id)
    if (error) return flash(error.message, false)
    await load()
  }
  const moveToVerification = async () => {
    const { error } = await supabase.from('coaching_sessions').update({ status: 'pending_verification' }).eq('id', session.id)
    if (error) return flash(error.message, false)
    flash('Moved to pending verification'); onChanged(); onClose()
  }
  const cancelSession = () => setConfirm({
    message: 'Cancel this observation session? It will move to Cancelled and be excluded from insights.',
    onYes: async () => {
      setConfirm(null)
      const { error } = await supabase.from('coaching_sessions').update({ status: 'cancelled', closed_at: new Date().toISOString() }).eq('id', session.id)
      if (error) return flash(error.message, false)
      flash('Session cancelled'); onChanged(); onClose()
    }
  })
  const closeSession = (met) => setConfirm({
    message: met ? 'Close this session as MET — improvement was verified and sustained?' : 'Close as NOT MET? You can then create a re-coaching session.',
    onYes: async () => {
      setConfirm(null)
      const { error } = await supabase.from('coaching_sessions').update({ status: met ? 'closed_met' : 'closed_not_met', closed_at: new Date().toISOString() }).eq('id', session.id)
      if (error) return flash(error.message, false)
      flash(met ? 'Session closed — met' : 'Session closed — not met'); onChanged(); onClose()
      if (!met) onRecoach(session)
    }
  })
  const acknowledge = async () => {
    const { error } = await supabase.from('coaching_sessions').update({ agent_acknowledged_at: new Date().toISOString(), agent_comment: ackComment.trim() || null }).eq('id', session.id)
    if (error) return flash(error.message, false)
    flash('Acknowledged'); onChanged(); onClose()
  }

  const isClosed = CLOSED_STATUSES.includes(session.status)
  const allResolved = actions.length > 0 && actions.every(a => a.status === 'met' || a.status === 'not_met')
  const label = { fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '18px 0 8px' }
  const box = { fontSize: 13, lineHeight: 1.6, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', whiteSpace: 'pre-wrap' }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {confirm && <ConfirmModal message={confirm.message} onYes={confirm.onYes} onNo={() => setConfirm(null)} />}
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <h2>Observation session</h2>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <StatusBadge status={session.status} />
            <span style={{ fontSize: 13 }}><b>Agent:</b> {session.agent?.name || '—'}</span>
            <span style={{ fontSize: 13 }}><b>Coach:</b> {session.coach?.name || '—'}</span>
            <span style={{ fontSize: 13 }}><b>Model:</b> {session.coaching_model}</span>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{fmtDate(session.session_date || session.created_at)}</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {session.division && <span>Division: {session.division}</span>}
            {session.market && <span>Market: {session.market}</span>}
            {session.planned_close_date && <span>Suggested close: {fmtDate(session.planned_close_date)}</span>}
          </div>

          {session.status === 'draft' && isCoach && session.coach_id === profile.id && (
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary btn-sm" onClick={() => { onClose(); onResumeDraft?.(session) }}>Resume / edit draft</button>
            </div>
          )}

          {session.strengths && (<><div style={label}>Strengths</div><div style={box}>{session.strengths}</div></>)}
          {session.observations && (<><div style={label}>Observations</div><div style={box}>{session.observations}</div></>)}
          {session.root_cause && (<><div style={label}>Agreed root cause</div><div style={box}>{session.root_cause}</div></>)}

          {focus.length > 0 && (
            <>
              <div style={label}>Focus areas</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {focus.map(f => (
                  <div key={f.id} style={{ fontSize: 13, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 12px' }}>{f.label}</div>
                ))}
              </div>
            </>
          )}

          <div style={label}>Action plan</div>
          {actions.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No action items.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {actions.map(a => (
                <div key={a.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.description}</div>
                    <span style={{ fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                      color: a.status === 'met' ? 'var(--success)' : a.status === 'not_met' ? 'var(--danger)' : 'var(--text-secondary)' }}>
                      {a.status === 'met' ? '✓ Met' : a.status === 'not_met' ? '✗ Not met' : a.status === 'in_progress' ? 'In progress' : 'Open'}
                    </span>
                  </div>
                  {a.done_test && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>Done test: {a.done_test}</div>}
                  {a.due_date && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Due: {fmtDate(a.due_date)}</div>}
                  {isCoach && !isClosed && session.status !== 'draft' && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setActionStatus(a, 'in_progress')}>In progress</button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)' }} onClick={() => setActionStatus(a, 'met')}>Mark met</button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setActionStatus(a, 'not_met')}>Mark not met</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {isOwnAgent && !session.agent_acknowledged_at && session.status !== 'draft' && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={label}>Your acknowledgement</div>
              <textarea className="input" rows={2} value={ackComment} onChange={e => setAck(e.target.value)} style={{ width: '100%', resize: 'vertical', marginBottom: 8 }} placeholder="Optional comment…" />
              <button className="btn btn-primary btn-sm" onClick={acknowledge}>Acknowledge session</button>
            </div>
          )}
          {session.agent_acknowledged_at && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--success)' }}>
              ✓ Acknowledged by agent on {fmtDate(session.agent_acknowledged_at)}
              {session.agent_comment && <div style={{ ...box, marginTop: 6, color: 'var(--text-primary)' }}>{session.agent_comment}</div>}
            </div>
          )}

          {isCoach && !isClosed && session.status !== 'draft' && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={label}>Verification &amp; close-out</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {session.status === 'active' && <button className="btn btn-ghost btn-sm" onClick={moveToVerification}>Move to pending verification</button>}
                <button className="btn btn-sm btn-primary" disabled={!allResolved} title={allResolved ? '' : 'Resolve all action items first'} onClick={() => closeSession(true)}>Close — Met</button>
                <button className="btn btn-sm btn-danger" disabled={!allResolved} title={allResolved ? '' : 'Resolve all action items first'} onClick={() => closeSession(false)}>Close — Not met</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--text-secondary)' }} onClick={cancelSession}>Cancel session</button>
              </div>
              {!allResolved && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>Mark every action item met or not met to close the session.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Drafts modal (own drafts, like Evaluations page) ────────────────────────
function DraftsModal({ drafts, onClose, onOpen, onDelete }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-header"><h2>Draft observation sessions</h2><button className="btn-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {drafts.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 24 }}>No drafts.</p>
          ) : drafts.map(d => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{d.agent?.name || 'No agent'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{d.division || '—'} · saved {fmtDate(d.created_at)}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={() => onOpen(d)}>Open</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => onDelete(d)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Sessions table ───────────────────────────────────────────────────────────
function SessionsTable({ rows, counts, onView }) {
  const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }
  const tdStyle = { padding: '10px 16px' }
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={thStyle}>Agent</th><th style={thStyle}>Coach</th><th style={thStyle}>Division</th>
            <th style={thStyle}>Date</th><th style={thStyle}>Status</th><th style={thStyle}>Action plan</th>
            <th style={thStyle}>Acknowledged</th><th style={{ ...thStyle, textAlign: 'right' }} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan="8" style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>Nothing here.</td></tr>}
          {rows.map(s => {
            const c = counts[s.id] || { total: 0, done: 0 }
            return (
              <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ ...tdStyle, fontWeight: 500 }}>{s.agent?.name || '—'}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{s.coach?.name || '—'}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{s.division || '—'}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{fmtDate(s.session_date || s.created_at)}</td>
                <td style={tdStyle}><StatusBadge status={s.status} /></td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{c.total ? `${c.done}/${c.total} resolved` : '—'}</td>
                <td style={tdStyle}>{s.agent_acknowledged_at ? <span style={{ color: 'var(--success)', fontSize: 12 }}>✓ {fmtDate(s.agent_acknowledged_at)}</span> : <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>—</span>}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}><button className="btn btn-ghost btn-sm" onClick={() => onView(s)}>View</button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Observation Insights tab ─────────────────────────────────────────────────
function InsightsTab({ sessions, counts, govNames }) {
  const [fAgent, setAgent] = useState('')
  const [fCoach, setCoach] = useState('')
  const [fDiv, setDiv]     = useState('')
  const [fBpo, setBpo]     = useState('')
  const [fHub, setHub]     = useState('')
  const [fMarket, setMkt]  = useState('')
  const [fStatus, setStat] = useState('')
  const [fYear, setYear]   = useState('')
  const [fMonth, setMonth] = useState('')
  const [fWeek, setWeek]   = useState('')
  const [fFrom, setFrom]   = useState('')
  const [fTo, setTo]       = useState('')

  // Exclude cancelled entirely from insights
  const base = useMemo(() => sessions.filter(s => s.status !== 'cancelled').map(s => {
    const d = s.session_date || s.created_at
    return { ...s,
      _date: d,
      _year: d ? String(new Date(d).getFullYear()) : '',
      _month: d ? new Date(d).toISOString().slice(0, 7) : '',
      _week: d ? isoWeek(d) : '',
      _bpo: s.workspace_id ? (govNames.ws[s.workspace_id] || '') : '',
      _hub: s.hub_id ? (govNames.hub[s.hub_id] || '') : '',
      _queue: s.queue_id ? (govNames.queue?.[s.queue_id] || '') : '',
      _agent: s.agent?.name || '', _coach: s.coach?.name || '',
    }
  }), [sessions, govNames])

  const opts = (key) => [...new Set(base.map(r => r[key]).filter(Boolean))].sort()

  const rows = base.filter(r =>
    (!fAgent || r._agent === fAgent) && (!fCoach || r._coach === fCoach) &&
    (!fDiv || r.division === fDiv) && (!fBpo || r._bpo === fBpo) &&
    (!fHub || r._hub === fHub) && (!fMarket || r.market === fMarket) &&
    (!fStatus || r.status === fStatus) && (!fYear || r._year === fYear) &&
    (!fMonth || r._month === fMonth) && (!fWeek || r._week === fWeek) &&
    (!fFrom || (r._date && r._date >= fFrom)) && (!fTo || (r._date && r._date <= fTo))
  )

  const n = (st) => rows.filter(r => r.status === st).length
  const total = rows.length
  const ackd = rows.filter(r => r.agent_acknowledged_at).length
  const closed = n('closed_met') + n('closed_not_met')
  const metRate = closed ? Math.round((n('closed_met') / closed) * 100) : 0

  const sel = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }
  const card = { flex: 1, minWidth: 150, textAlign: 'center', padding: '18px 16px' }
  const cnum = { fontSize: 26, fontWeight: 700 }
  const clbl = { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }
  const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }
  const tdStyle = { padding: '10px 16px' }

  const exportCsv = async () => {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const ids = rows.map(r => r.id)
    const faMap = {}, apMap = {}
    if (ids.length) {
      const { data: fa } = await supabase.from('coaching_focus_areas').select('session_id, label, sort_order').in('session_id', ids).order('sort_order')
      const { data: ap } = await supabase.from('coaching_action_items').select('session_id, description, sort_order').in('session_id', ids).order('sort_order')
      ;(fa || []).forEach(x => { (faMap[x.session_id] = faMap[x.session_id] || []).push(x.label) })
      ;(ap || []).forEach(x => { (apMap[x.session_id] = apMap[x.session_id] || []).push(x.description) })
    }
    const headers = ['Date', 'Agent', 'Coach', 'Division', 'BPO', 'Hub', 'Queue', 'Market', 'Status', 'ISO Week', 'Acknowledged', 'Actions resolved', 'Observation model', 'Strengths / what went well', 'Observations', 'Agreed root cause', 'Focus Areas', 'Action Plan']
    const lines = [headers.map(esc).join(',')]
    rows.forEach(r => {
      const c = counts[r.id] || { total: 0, done: 0 }
      lines.push([esc(fmtDate(r._date)), esc(r._agent), esc(r._coach), esc(r.division), esc(r._bpo), esc(r._hub), esc(r._queue), esc(r.market), esc(STATUS[r.status]?.label), esc(r._week), esc(r.agent_acknowledged_at ? 'Yes' : 'No'), esc(`${c.done}/${c.total}`), esc(r.coaching_model), esc(r.strengths), esc(r.observations), esc(r.root_cause), esc((faMap[r.id] || []).join(', ')), esc((apMap[r.id] || []).join(' | '))].join(','))
    })
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `observation-insights-${new Date().toISOString().split('T')[0]}.csv`; a.click(); URL.revokeObjectURL(a.href)
  }

  const clearAll = () => { setAgent(''); setCoach(''); setDiv(''); setBpo(''); setHub(''); setMkt(''); setStat(''); setYear(''); setMonth(''); setWeek(''); setFrom(''); setTo('') }
  const anyFilter = fAgent || fCoach || fDiv || fBpo || fHub || fMarket || fStatus || fYear || fMonth || fWeek || fFrom || fTo

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn btn-accent-soft" onClick={exportCsv}>⬇ Export to Excel</button>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Filter:</span>
        <select style={sel} value={fAgent} onChange={e => setAgent(e.target.value)}><option value="">All Agents</option>{opts('_agent').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fCoach} onChange={e => setCoach(e.target.value)}><option value="">All Coaches</option>{opts('_coach').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fDiv} onChange={e => setDiv(e.target.value)}><option value="">All Divisions</option>{opts('division').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fBpo} onChange={e => setBpo(e.target.value)}><option value="">All BPOs</option>{opts('_bpo').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fHub} onChange={e => setHub(e.target.value)}><option value="">All Hubs</option>{opts('_hub').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fMarket} onChange={e => setMkt(e.target.value)}><option value="">All Markets</option>{opts('market').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fStatus} onChange={e => setStat(e.target.value)}><option value="">All Statuses</option>{Object.entries(STATUS).filter(([k]) => k !== 'cancelled').map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select style={sel} value={fYear} onChange={e => setYear(e.target.value)}><option value="">All Years</option>{opts('_year').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fMonth} onChange={e => setMonth(e.target.value)}><option value="">All Months</option>{opts('_month').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fWeek} onChange={e => setWeek(e.target.value)}><option value="">All ISO Weeks</option>{opts('_week').map(o => <option key={o}>{o}</option>)}</select>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>from</span>
        <input type="date" style={sel} value={fFrom} onChange={e => setFrom(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>to</span>
        <input type="date" style={sel} value={fTo} onChange={e => setTo(e.target.value)} />
        {anyFilter && <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear filters</button>}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <div className="card" style={card}><div style={cnum}>{total}</div><div style={clbl}>Sessions</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#6366f1' }}>{n('active')}</div><div style={clbl}>Active</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#f59e0b' }}>{n('pending_verification')}</div><div style={clbl}>Pending verification</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#22c55e' }}>{n('closed_met')}</div><div style={clbl}>Closed · Met</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#ef4444' }}>{n('closed_not_met')}</div><div style={clbl}>Closed · Not met</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: metRate >= 70 ? '#22c55e' : '#dc2626' }}>{metRate}%</div><div style={clbl}>Met rate (closed)</div></div>
        <div className="card" style={card}><div style={cnum}>{ackd}/{total}</div><div style={clbl}>Acknowledged</div></div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={thStyle}>Date</th><th style={thStyle}>Agent</th><th style={thStyle}>Coach</th>
              <th style={thStyle}>Division</th><th style={thStyle}>Market</th><th style={thStyle}>Status</th><th style={thStyle}>Ack</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="7" style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No results match the selected filters.</td></tr>}
            {rows.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{fmtDate(r._date)}</td>
                <td style={{ ...tdStyle, fontWeight: 500 }}>{r._agent || '—'}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{r._coach || '—'}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{r.division || '—'}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{r.market || '—'}</td>
                <td style={tdStyle}><StatusBadge status={r.status} /></td>
                <td style={tdStyle}>{r.agent_acknowledged_at ? '✓' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Placeholder tab ──────────────────────────────────────────────────────────
function ComingSoon({ title }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--text-secondary)', fontSize: 14 }}>
      {title} is coming in a later update.
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────
// -- Agent view: per-evaluation coachings (acknowledge on page) ---------------
function AgentCoachingDetail({ c, onClose, onAck, busy }) {
  const evalNo = `#${c._evalNo}`
  const isPending = c.status === 'completed'
  const isDsat = c.eval_type === 'dsat'
  const [ev, setEv] = useState(null)
  const [scores, setScores] = useState([])
  const box = { fontSize: 13, lineHeight: 1.6, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', whiteSpace: 'pre-wrap' }
  const label = { fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '16px 0 8px' }

  useEffect(() => {
    if (!c.evaluation_id) return
    supabase.from('evaluations')
      .select('*, scorecards!evaluations_scorecard_id_fkey(name, type, pass_threshold), users!evaluations_evaluator_id_fkey(name, email)')
      .eq('id', c.evaluation_id).maybeSingle()
      .then(({ data }) => setEv(data))
    if (!isDsat) {
      supabase.from('evaluation_scores')
        .select('*, scorecard_questions(title, is_form_critical)')
        .eq('evaluation_id', c.evaluation_id)
        .then(({ data }) => setScores(data || []))
    }
    // eslint-disable-next-line
  }, [c.evaluation_id])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="modal-header"><h2>Coaching &middot; Evaluation {evalNo}</h2><button className="btn-close" onClick={onClose}>&times;</button></div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
            <span><b>Evaluation:</b> {evalNo}</span>
            <span><b>Type:</b> {isDsat ? 'DSAT' : 'Quality'}</span>
            {ev && !isDsat && <span><b>Score:</b> {ev.score}%</span>}
            {ev && <span><b>Scorecard:</b> {ev.scorecards?.name || '-'}</span>}
            <span><b>Coach:</b> {c.coach?.name || '-'}</span>
            {ev && <span style={{ color: 'var(--text-secondary)' }}>{fmtDate(ev.submitted_at)}</span>}
          </div>

          {ev && (ev.metadata_values || []).length > 0 && (
            <>
              <div style={label}>Interaction details</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                {(ev.metadata_values || []).map((m, i) => <span key={i} style={{ fontSize: 12 }}><b style={{ color: 'var(--text-secondary)' }}>{m.label}:</b> {m.value || '-'}</span>)}
              </div>
            </>
          )}

          {ev && isDsat && (
            <>
              <div style={label}>Answers</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(ev.metadata_values || []).map((m, i) => <div key={i} style={box}><b>{m.label}:</b> {m.value || '-'}</div>)}
              </div>
            </>
          )}

          {ev && !isDsat && scores.length > 0 && (
            <>
              <div style={label}>Question scores</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {scores.map((sc, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 12px' }}>
                    <span>{sc.scorecard_questions?.title || '-'}{sc.scorecard_questions?.is_form_critical && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--danger)' }}>critical</span>}</span>
                    <span style={{ fontWeight: 700, color: sc.score === 'pass' ? 'var(--success)' : sc.score === 'fail' ? 'var(--danger)' : 'var(--text-secondary)' }}>{(sc.score || 'na').toUpperCase()}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {ev && !isDsat && ev.overall_comment && (<><div style={label}>Overall comment</div><div style={box}>{ev.overall_comment}</div></>)}

          <div style={label}>What was coached</div>
          <div style={box}>{c.notes || '-'}</div>
          {isPending
            ? <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={() => onAck(c)}>Acknowledge</button>
            : <div style={{ marginTop: 16, fontSize: 12, color: 'var(--success)' }}>Acknowledged{c.acknowledged_at ? ' on ' + fmtDate(c.acknowledged_at) : ''}</div>}
        </div>
      </div>
    </div>
  )
}

function AgentEvalCoachings({ profile, flash, openId }) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows]       = useState([])
  const [detail, setDetail]   = useState(null)
  const [busy, setBusy]       = useState(false)

  const load = async () => {
    setLoading(true)
    const { data } = await supabase.from('eval_coachings')
      .select('*, coach:users!eval_coachings_coach_id_fkey(name)')
      .in('status', ['completed', 'acknowledged'])
      .order('completed_at', { ascending: false })
    const list = data || []
    const evIds = [...new Set(list.map(c => c.evaluation_id).filter(Boolean))]
    const evalMap = {}
    if (evIds.length) {
      const { data: evs } = await supabase.from('evaluations').select('id, eval_id').in('id', evIds)
      ;(evs || []).forEach(e => { evalMap[e.id] = e.eval_id })
    }
    setRows(list.map(c => ({ ...c, _evalNo: evalMap[c.evaluation_id] || c.evaluation_id })))
    setLoading(false)
  }
  useEffect(() => { if (profile?.id) load() /* eslint-disable-next-line */ }, [profile?.id])

  // ?coaching=<id> — arrived from the "acknowledge your coaching" notification.
  // Open that coaching straight away instead of leaving the agent to find the row.
  // Keyed on rows as well as openId so it still fires if the rows load afterwards.
  useEffect(() => {
    if (!openId || !rows.length) return
    const target = rows.find(c => String(c.id) === String(openId))
    if (target) setDetail(target)
    window.history.replaceState({}, '', '/coaching')
  }, [openId, rows])

  const acknowledge = async (c) => {
    setBusy(true)
    const { error } = await supabase.from('eval_coachings')
      .update({ status: 'acknowledged', acknowledged_at: new Date().toISOString() }).eq('id', c.id)
    if (error) { setBusy(false); return flash(error.message, false) }
    await supabase.from('notifications').delete()
      .eq('user_id', profile.id).eq('type', 'eval_coaching').eq('entity_id', String(c.id))
    setBusy(false); setDetail(null)
    flash('Coaching acknowledged'); load()
  }

  const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }
  const tdStyle = { padding: '10px 16px' }

  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</div>

  const ordered = [...rows.filter(r => r.status === 'completed'), ...rows.filter(r => r.status === 'acknowledged')]

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th style={thStyle}>Evaluation</th><th style={thStyle}>Type</th><th style={thStyle}>Coach</th>
          <th style={thStyle}>Date</th><th style={thStyle}>Status</th><th style={{ ...thStyle, textAlign: 'right' }} />
        </tr></thead>
        <tbody>
          {ordered.length === 0 && <tr><td colSpan="6" style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No coaching sessions yet.</td></tr>}
          {ordered.map(c => {
            const isPending = c.status === 'completed'
            return (
              <tr key={c.id} style={{ borderBottom: '1px solid var(--border)', background: isPending ? 'var(--bg-secondary)' : 'transparent' }}>
                <td style={{ ...tdStyle, fontFamily: 'monospace' }}>#{c._evalNo}</td>
                <td style={tdStyle}>{c.eval_type === 'dsat' ? 'DSAT' : 'Quality'}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{c.coach?.name || '-'}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{fmtDate(c.completed_at || c.created_at)}</td>
                <td style={tdStyle}>{isPending
                  ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600, background: '#f59e0b22', color: '#f59e0b' }}>Pending acknowledgement</span>
                  : <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600, background: '#22c55e22', color: '#22c55e' }}>Acknowledged</span>}</td>
                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setDetail(c)}>View</button>
                  {isPending && <button className="btn btn-primary btn-sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => acknowledge(c)}>Acknowledge</button>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {detail && <AgentCoachingDetail c={detail} onClose={() => setDetail(null)} onAck={acknowledge} busy={busy} />}
    </div>
  )
}

// ─── Coaching Insights (per-evaluation coachings from the Coaching Queue) ─────
const EC_STATUS = {
  pending:      { label: 'Not started',              color: '#94a3b8' },
  in_progress:  { label: 'In progress',              color: '#6366f1' },
  completed:    { label: 'Awaiting acknowledgement', color: '#f59e0b' },
  acknowledged: { label: 'Acknowledged',             color: '#22c55e' },
}
// Wording used in the export and the SLA filter, matching the 24h Critical Cases language.
const CRIT_LABEL = { highly_critical: 'Highly Critical', critical: 'Critical' }
const SLA24_LABEL = { met: 'Met', breached: 'Breached', open: 'Still within 24h' }
const SLA_LABEL = {
  met:      'Met',
  breached: 'Breached',
  open:     'Still within 48h',
  unknown:  '—',
}
function CoachingInsightsTab({ profile, isPrivileged, govNames, gov }) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows]       = useState([])
  const [fCoach, setFCoach] = useState('')
  const [fDiv, setFDiv]     = useState('')
  const [fBpo, setFBpo]     = useState('')
  const [fHub, setFHub]     = useState('')
  const [fMarket, setFMkt]  = useState('')
  const [fType, setFType]   = useState('')
  const [fStatus, setFStat] = useState('')
  const [fSla, setFSla]     = useState('')
  const [fCrit, setFCrit]   = useState('')
  const [fFrom, setFrom]    = useState('')
  const [fTo, setTo]        = useState('')

  // Loads every COACHABLE CASE, not just cases someone already picked up. A case nobody
  // touched for three days is exactly what a 48-hour SLA exists to surface, and it has no
  // eval_coachings row at all — so the old "read eval_coachings" approach could never see
  // it. Candidates come from the shared isCoachable() the Coaching Queue uses, so the two
  // screens always describe the same population.
  const load = async () => {
    setLoading(true)
    let hubIds = null
    if (!isPrivileged) {
      const scope = await getEvaluatorScope(profile.id)
      hubIds = scope.hubIds || []
      if (!hubIds.length) { setRows([]); setLoading(false); return }
    }
    let eq = supabase.from('evaluations')
      .select('id, eval_id, score, evaluation_type, metadata_values, submitted_at, hub_id, workspace_id, queue_id, deviated_controllability')
      .eq('status', 'submitted')
      .or('and(evaluation_type.eq.quality,score.lt.100),evaluation_type.eq.dsat')
      .order('submitted_at', { ascending: false })
      .limit(3000)
    if (hubIds) eq = eq.in('hub_id', hubIds)
    const { data: evs } = await eq
    const candidates = (evs || []).filter(isCoachable)

    const ids = candidates.map(e => e.id)
    const cMap = {}
    const critMap = {}
    if (ids.length) {
      const [{ data: cs }, { data: ccs }] = await Promise.all([
        supabase.from('eval_coachings')
          .select('*, coach:users!eval_coachings_coach_id_fkey(name)')
          .in('evaluation_id', ids),
        supabase.from('critical_cases')
          .select('evaluation_id, severity, sla_due_at, sla_breached_at, rta_escalated_at, reason:highly_critical_reasons!critical_cases_highly_critical_reason_id_fkey(name)')
          .in('evaluation_id', ids).is('deleted_at', null),
      ])
      ;(cs || []).forEach(c => { cMap[c.evaluation_id] = c })
      ;(ccs || []).forEach(c => { critMap[c.evaluation_id] = c })
    }
    setRows(candidates.map(ev => ({ ev, coaching: cMap[ev.id] || null, crit: critMap[ev.id] || null })))
    setLoading(false)
  }
  useEffect(() => { if (profile?.id) load() /* eslint-disable-next-line */ }, [profile?.id])

  const base = useMemo(() => (rows || []).map(({ ev, coaching: c, crit }) => {
    const ctx = (gov && gov.queueCtx && gov.queueCtx[ev.queue_id]) || {}
    const { hours, state } = coachingSla(ev.submitted_at, c?.completed_at)
    return { ...(c || {}),
      status: c ? c.status : 'pending',
      // Dated by the evaluation, since that is when the 48-hour clock starts.
      _date: ev.submitted_at ? String(ev.submitted_at).slice(0, 10) : '',
      _submitted: ev.submitted_at,
      _bpo: ctx.workspace_name || (ev.workspace_id ? (govNames.ws[ev.workspace_id] || '') : ''),
      _hub: ctx.hub_name || (ev.hub_id ? (govNames.hub[ev.hub_id] || '') : ''),
      _div: c?.division || ctx.division_name || '',
      _market: c?.market || ctx.market || getMeta(ev, 'Market') || '',
      _agent: c?.agent_email || getMeta(ev, "Agent's Email") || '',
      _coach: c?.coach?.name || '',
      _type: ev.evaluation_type === 'dsat' ? 'DSAT' : 'Quality',
      _evalNo: ev.eval_id || ev.id,
      _slaHours: hours,
      _sla: state,
      _crit: crit?.severity || '',
      _critReason: crit?.reason?.name || '',
      // 24-hour Highly Critical SLA. Reads the server's own sla_breached_at rather than
      // recomputing from timestamps, so this can never disagree with the hourly sweep
      // that sent the breach notification.
      _crit24: !crit || crit.severity !== 'highly_critical' ? ''
        : crit.sla_breached_at ? 'breached'
        : c?.status === 'acknowledged' ? 'met'
        : 'open',
      _rta: crit?.rta_escalated_at || null,
    }
  }), [rows, govNames, gov])

  const opts = (key) => [...new Set(base.map(r => r[key]).filter(Boolean))].sort()
  const flt = base.filter(r =>
    (!fCoach || r._coach === fCoach) && (!fDiv || r._div === fDiv) && (!fBpo || r._bpo === fBpo) &&
    (!fHub || r._hub === fHub) && (!fMarket || r._market === fMarket) && (!fType || r._type === fType) &&
    (!fStatus || r.status === fStatus) && (!fSla || r._sla === fSla) &&
    (!fCrit || (fCrit === 'none' ? !r._crit : r._crit === fCrit)) &&
    (!fFrom || (r._date && r._date >= fFrom)) && (!fTo || (r._date && r._date <= fTo)))

  const total = flt.length
  const nPending = flt.filter(r => r.status === 'pending').length
  const nProg = flt.filter(r => r.status === 'in_progress').length
  const nAwait = flt.filter(r => r.status === 'completed').length
  const nAck = flt.filter(r => r.status === 'acknowledged').length
  const delivered = nAwait + nAck
  const ackRate = delivered ? Math.round((nAck / delivered) * 100) : 0

  // 48-hour SLA. The rate deliberately excludes cases still inside the window and not yet
  // coached ('open') — their outcome isn't decided, and counting them as failures would
  // make the current period always look bad. Uncoached cases past 48h ARE counted, as
  // breaches, which is the whole point of measuring this.
  // 24h Highly Critical SLA, kept separate from the 48h coaching SLA below — they measure
  // different obligations on different populations.
  const n24Met     = flt.filter(r => r._crit24 === 'met').length
  const n24Breach  = flt.filter(r => r._crit24 === 'breached').length
  const n24Open    = flt.filter(r => r._crit24 === 'open').length
  const n24Decided = n24Met + n24Breach
  const rate24     = n24Decided ? Math.round((n24Met / n24Decided) * 100) : null
  const nRta       = flt.filter(r => r._rta).length

  const nMet = flt.filter(r => r._sla === 'met').length
  const nBreach = flt.filter(r => r._sla === 'breached').length
  const nOpen = flt.filter(r => r._sla === 'open').length
  const slaDecided = nMet + nBreach
  const slaRate = slaDecided ? Math.round((nMet / slaDecided) * 100) : 0

  const byCoach = useMemo(() => {
    const m = {}
    flt.forEach(r => {
      const k = r._coach || 'Unassigned'
      m[k] = m[k] || { coach: k, total: 0, delivered: 0, ack: 0, met: 0, breach: 0 }
      m[k].total++
      if (r.status === 'completed' || r.status === 'acknowledged') m[k].delivered++
      if (r.status === 'acknowledged') m[k].ack++
      if (r._sla === 'met') m[k].met++
      if (r._sla === 'breached') m[k].breach++
    })
    return Object.values(m).sort((a, b) => b.total - a.total)
  }, [flt])

  const sel = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }
  const card = { flex: 1, minWidth: 150, textAlign: 'center', padding: '18px 16px' }
  const cnum = { fontSize: 26, fontWeight: 700 }
  const clbl = { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }
  const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }
  const tdStyle = { padding: '10px 16px' }

  const exportCsv = () => {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const headers = ['Evaluation', 'Type', 'Coach', 'Agent', 'Division', 'BPO', 'Hub', 'Market', 'Status',
      'Criticality', 'Highly Critical reason', '24h SLA', 'RTA escalated',
      'Evaluation submitted', 'Taken over', 'Completed', 'Acknowledged',
      'Hours to coach', 'Within 48h', 'Coaching notes']
    const lines = [headers.map(esc).join(',')]
    flt.forEach(r => lines.push([
      esc('#' + r._evalNo), esc(r._type), esc(r._coach || 'Unassigned'), esc(r._agent), esc(r._div),
      esc(r._bpo), esc(r._hub), esc(r._market), esc(EC_STATUS[r.status]?.label || r.status),
      esc(CRIT_LABEL[r._crit] || 'Not critical'), esc(r._critReason),
      esc(SLA24_LABEL[r._crit24] || ''), esc(r._rta ? fmtDate(r._rta) : ''),
      esc(fmtDate(r._submitted)), esc(fmtDate(r.taken_over_at)), esc(fmtDate(r.completed_at)), esc(fmtDate(r.acknowledged_at)),
      // Elapsed so far when not yet coached, so an overdue case shows how overdue it is.
      esc(r._slaHours == null ? '' : r._slaHours),
      esc(SLA_LABEL[r._sla] || ''),
      esc(r.notes),
    ].join(',')))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `coaching-insights-${new Date().toISOString().split('T')[0]}.csv`; a.click(); URL.revokeObjectURL(a.href)
  }

  const clearAll = () => { setFCoach(''); setFDiv(''); setFBpo(''); setFHub(''); setFMkt(''); setFType(''); setFStat(''); setFSla(''); setFCrit(''); setFrom(''); setTo('') }
  const anyFilter = fCoach || fDiv || fBpo || fHub || fMarket || fType || fStatus || fSla || fCrit || fFrom || fTo

  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn btn-accent-soft" onClick={exportCsv}>⬇ Export to Excel</button>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Filter:</span>
        <select style={sel} value={fCoach} onChange={e => setFCoach(e.target.value)}><option value="">All Coaches</option>{opts('_coach').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fDiv} onChange={e => setFDiv(e.target.value)}><option value="">All Divisions</option>{opts('_div').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fBpo} onChange={e => setFBpo(e.target.value)}><option value="">All BPOs</option>{opts('_bpo').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fHub} onChange={e => setFHub(e.target.value)}><option value="">All Hubs</option>{opts('_hub').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fMarket} onChange={e => setFMkt(e.target.value)}><option value="">All Markets</option>{opts('_market').map(o => <option key={o}>{o}</option>)}</select>
        <select style={sel} value={fType} onChange={e => setFType(e.target.value)}><option value="">All Types</option><option>Quality</option><option>DSAT</option></select>
        <select style={sel} value={fStatus} onChange={e => setFStat(e.target.value)}><option value="">All Statuses</option>{Object.entries(EC_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select style={sel} value={fCrit} onChange={e => setFCrit(e.target.value)}>
          <option value="">All Criticality</option>
          <option value="highly_critical">Highly Critical</option>
          <option value="critical">Critical</option>
          <option value="none">Not critical</option>
        </select>
        <select style={sel} value={fSla} onChange={e => setFSla(e.target.value)}>
          <option value="">All 48h SLA</option>
          <option value="met">Met</option>
          <option value="breached">Breached</option>
          <option value="open">Still within 48h</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>from</span>
        <input type="date" style={sel} value={fFrom} onChange={e => setFrom(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>to</span>
        <input type="date" style={sel} value={fTo} onChange={e => setTo(e.target.value)} />
        {anyFilter && <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear filters</button>}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="card" style={card}><div style={cnum}>{total}</div><div style={clbl}>Coachable cases</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#94a3b8' }}>{nPending}</div><div style={clbl}>Not started</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#6366f1' }}>{nProg}</div><div style={clbl}>In progress</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#f59e0b' }}>{nAwait}</div><div style={clbl}>Awaiting ack</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#22c55e' }}>{nAck}</div><div style={clbl}>Acknowledged</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: ackRate >= 70 ? '#22c55e' : '#dc2626' }}>{ackRate}%</div><div style={clbl}>Ack rate</div></div>
      </div>

      {(n24Met + n24Breach + n24Open) > 0 && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <div className="card" style={card}><div style={{ ...cnum, color: '#22c55e' }}>{n24Met}</div><div style={clbl}>Highly Critical coached within 24h</div></div>
            <div className="card" style={card}><div style={{ ...cnum, color: '#dc2626' }}>{n24Breach}</div><div style={clbl}>24h breaches</div></div>
            <div className="card" style={card}><div style={{ ...cnum, color: '#94a3b8' }}>{n24Open}</div><div style={clbl}>Still within 24h</div></div>
            <div className="card" style={card}>
              <div style={{ ...cnum, color: rate24 == null ? 'var(--text-secondary)' : rate24 >= 95 ? '#22c55e' : rate24 >= 80 ? '#f59e0b' : '#dc2626' }}>
                {rate24 == null ? '—' : rate24 + '%'}
              </div>
              <div style={clbl}>24h compliance</div>
            </div>
            <div className="card" style={card}><div style={{ ...cnum, color: nRta ? '#dc2626' : '#94a3b8' }}>{nRta}</div><div style={clbl}>RTA escalations</div></div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 20 }}>
            The 24-hour clock applies to Highly Critical cases only and stops when the <b>agent acknowledges</b> the coaching.
            A breach is what triggers the RTA conversation — Quark records it but never blocks anyone.
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <div className="card" style={card}><div style={{ ...cnum, color: '#22c55e' }}>{nMet}</div><div style={clbl}>Coached within 48h</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#dc2626' }}>{nBreach}</div><div style={clbl}>48h breached</div></div>
        <div className="card" style={card}><div style={{ ...cnum, color: '#94a3b8' }}>{nOpen}</div><div style={clbl}>Still within 48h</div></div>
        <div className="card" style={card}>
          <div style={{ ...cnum, color: slaRate >= 90 ? '#22c55e' : slaRate >= 70 ? '#f59e0b' : '#dc2626' }}>{slaRate}%</div>
          <div style={clbl}>48h coaching rate</div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 24 }}>
        The 48-hour clock starts when the evaluation is submitted and stops when the coach completes the coaching.
        The rate is met ÷ (met + breached) — cases still inside the window are excluded until their outcome is decided,
        but uncoached cases past 48 hours count as breaches.
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={thStyle}>Coach</th><th style={thStyle}>Cases</th><th style={thStyle}>Delivered</th><th style={thStyle}>Acknowledged</th><th style={thStyle}>Ack rate</th>
            <th style={thStyle}>Within 48h</th><th style={thStyle}>Breached</th><th style={thStyle}>48h rate</th>
          </tr></thead>
          <tbody>
            {byCoach.length === 0 && <tr><td colSpan="8" style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No cases match the selected filters.</td></tr>}
            {byCoach.map(c => {
              const rate = c.delivered ? Math.round((c.ack / c.delivered) * 100) : 0
              const decided = c.met + c.breach
              const sRate = decided ? Math.round((c.met / decided) * 100) : null
              return (
                <tr key={c.coach} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...tdStyle, fontWeight: 500 }}>{c.coach}</td>
                  <td style={tdStyle}>{c.total}</td>
                  <td style={tdStyle}>{c.delivered}</td>
                  <td style={tdStyle}>{c.ack}</td>
                  <td style={{ ...tdStyle, fontWeight: 600, color: rate >= 70 ? 'var(--success)' : 'var(--danger)' }}>{rate}%</td>
                  <td style={tdStyle}>{c.met}</td>
                  <td style={{ ...tdStyle, color: c.breach ? 'var(--danger)' : 'var(--text-secondary)' }}>{c.breach}</td>
                  <td style={{ ...tdStyle, fontWeight: 600, color: sRate == null ? 'var(--text-secondary)' : sRate >= 90 ? 'var(--success)' : sRate >= 70 ? '#f59e0b' : 'var(--danger)' }}>
                    {sRate == null ? '—' : `${sRate}%`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function Coaching() {
  const { profile } = useAuth()
  const role = profile?.role
  const isCoach = ['owner', 'admin', 'evaluator', 'team_leader'].includes(role)
  const isPrivileged = ['owner', 'admin'].includes(role)
  const canCreate = ['owner', 'admin', 'evaluator', 'team_leader'].includes(role)

  const [tab, setTab]           = useState('queue')
  const [sessions, setSessions] = useState([])
  const [counts, setCounts]     = useState({})
  const [loading, setLoading]   = useState(true)
  const [creating, setCreating] = useState(false)
  const [recoachOf, setRecoach] = useState(null)
  const [detail, setDetail]     = useState(null)
  const [showDrafts, setDrafts] = useState(false)
  const [msg, setMsg]           = useState(null)
  const [gov, setGov]           = useState(null)
  const [agentTab, setAgentTab] = useState('coaching')

  // Deep link from the "acknowledge your coaching" notification: /coaching?coaching=<id>.
  // Read from the router (not window.location) so it also fires when the agent is already
  // on this page — a same-route navigation doesn't remount the component.
  const location = useLocation()
  const coachingParam = new URLSearchParams(location.search).get('coaching')
  useEffect(() => { if (coachingParam) setAgentTab('coaching') }, [coachingParam])

  // Deep link from a Critical / Highly Critical notification: /coaching?critical=<case id>.
  // Distinct from ?coaching= above: that one targets an EXISTING eval_coachings row, but a
  // critical notification fires the moment the case is registered, before anyone has taken
  // it — so there is no coaching row yet. This targets the critical_cases id instead and
  // lands on the Queue tab, where "Assign to me" lives.
  const criticalParam = new URLSearchParams(location.search).get('critical')
  useEffect(() => { if (criticalParam) setTab('queue') }, [criticalParam])

  const flash = (text, ok = true) => { setMsg({ text, ok }); if (ok) setTimeout(() => setMsg(null), 3000) }

  const loadSessions = async () => {
    setLoading(true)
    const { data } = await supabase.from('coaching_sessions')
      .select('*, agent:users!coaching_sessions_agent_id_fkey(name, email), coach:users!coaching_sessions_coach_id_fkey(name, email)')
      .order('created_at', { ascending: false })
    const rows = data || []
    setSessions(rows)
    const ids = rows.map(r => r.id)
    if (ids.length) {
      const { data: items } = await supabase.from('coaching_action_items').select('session_id, status').in('session_id', ids)
      const c = {}
      ;(items || []).forEach(it => { c[it.session_id] = c[it.session_id] || { total: 0, done: 0 }; c[it.session_id].total++; if (it.status === 'met' || it.status === 'not_met') c[it.session_id].done++ })
      setCounts(c)
    } else setCounts({})
    setLoading(false)
  }

  const loadGovernance = async () => {
    const [{ data: divs }, { data: ws }, { data: hubs }, { data: qs }, { data: uq }, { data: ags }] = await Promise.all([
      supabase.from('divisions').select('id, name, is_active').order('name'),
      supabase.from('workspaces').select('id, name, division_id, deleted_at'),
      supabase.from('hubs').select('id, name, workspace_id, deleted_at'),
      supabase.from('queues').select('id, name, hub_id, workspace_id, market_value, deleted_at'),
      supabase.from('user_queues').select('user_id, queue_id'),
      supabase.from('users').select('id, name, email, role, active').eq('role', 'viewer').order('name'),
    ])
    const wsMap = Object.fromEntries((ws || []).filter(w => !w.deleted_at).map(w => [w.id, w]))
    const hubMap = Object.fromEntries((hubs || []).filter(h => !h.deleted_at).map(h => [h.id, h]))
    const divMap = Object.fromEntries((divs || []).map(d => [d.id, d]))
    const queues = (qs || []).filter(q => !q.deleted_at)
    const queueCtx = {}
    queues.forEach(q => {
      const hub = hubMap[q.hub_id]
      const wspace = hub ? wsMap[hub.workspace_id] : (q.workspace_id ? wsMap[q.workspace_id] : null)
      const div = wspace ? divMap[wspace.division_id] : null
      queueCtx[q.id] = {
        division_id: div?.id || null, division_name: div?.name || null,
        workspace_id: wspace?.id || null, workspace_name: wspace?.name || null,
        hub_id: hub?.id || null, hub_name: hub?.name || null,
        market: q.market_value || null,
      }
    })
    const myQueueIds = new Set((uq || []).filter(u => u.user_id === profile.id).map(u => u.queue_id))
    const myContexts = [...myQueueIds].map(qid => queueCtx[qid]).filter(Boolean)
    setGov({
      divisions: (divs || []).filter(d => d.is_active !== false),
      queues, queueCtx, userQueues: uq || [],
      agents: (ags || []).filter(a => a.active !== false),
      myQueueIds, myContexts,
      ws: Object.fromEntries((ws || []).map(w => [w.id, w.name])),
      hub: Object.fromEntries((hubs || []).map(h => [h.id, h.name])),
      queue: Object.fromEntries((queues || []).map(q => [q.id, q.name])),
    })
  }

  useEffect(() => { if (profile?.id) { loadSessions(); if (isCoach) loadGovernance() } }, [profile])

  // Blank the tab area on the FIRST load only. A background refresh must not unmount the
  // active tab: CoachingQueue holds its own filters, page number and fetched rows in local
  // state, so replacing it with "Loading…" for a moment silently threw all of that away.
  // Once something has been shown, later refreshes happen underneath the existing content.
  const firstLoadDone = useRef(false)
  if (!loading) firstLoadDone.current = true
  const showBlankLoader = loading && !firstLoadDone.current

  // Split by ownership + status
  // Hub-level visibility for coaches: an evaluator/team leader sees observation sessions
  // on any hub they're assigned to (matches Coaching Queue & dashboards), not only their own.
  const myHubIds = gov ? new Set(gov.myContexts.map(c => c.hub_id).filter(Boolean)) : null
  const mine = isPrivileged
    ? sessions
    : (myHubIds ? sessions.filter(s => myHubIds.has(s.hub_id)) : sessions.filter(s => s.coach_id === profile?.id))
  const myDrafts = sessions.filter(s => s.status === 'draft' && s.coach_id === profile?.id)
  const activeRows = mine.filter(s => ACTIVE_STATUSES.includes(s.status))
  const closedRows = mine.filter(s => CLOSED_STATUSES.includes(s.status))

  const startRecoach = (parent) => { setDetail(null); setRecoach(parent); setCreating(true) }
  const openCreate = () => { setRecoach(null); setCreating(true) }
  const afterSave = () => { setCreating(false); setRecoach(null); loadSessions() }
  const resumeDraft = () => { flash('Draft editing opens the create form — full resume comes with the next update.'); }

  const deleteDraft = async (d) => {
    await supabase.from('coaching_action_items').delete().eq('session_id', d.id)
    await supabase.from('coaching_focus_areas').delete().eq('session_id', d.id)
    await supabase.from('coaching_sessions').delete().eq('id', d.id)
    loadSessions()
  }

  const govNames = gov ? { ws: gov.ws, hub: gov.hub, queue: gov.queue } : { ws: {}, hub: {}, queue: {} }

  // Coaching Queue first: it is the work that arrives on its own from failed and critical
  // evaluations, so it is what a coach opens the page to deal with. Observation Sessions
  // are initiated deliberately and follow.
  const TABS = isCoach
    ? [['queue', 'Coaching Queue'], ['coaching_insights', 'Coaching Insights'], ['sessions', 'Observation Sessions'], ['insights', 'Observation Insights']]
    : []

  // Agent (viewer) view — own sessions only
  if (!isCoach) {
    const own = sessions // RLS already limits agents to their own
    return (
      <div className="page">
        <div className="page-header"><div><h1>Coaching</h1></div></div>
        {msg && <div className={`flash ${msg.ok ? 'flash-ok' : 'flash-err'}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><span>{msg.text}</span><button className="btn btn-sm" style={{ background: 'rgba(255,255,255,0.2)', color: 'inherit', flexShrink: 0 }} onClick={() => setMsg(null)}>OK</button></div>}
        {/* Shared pill tabs from index.css, so every page's tab bar looks the same. */}
        <div className="tabs">
          {[['coaching', 'Coaching Sessions'], ['observations', 'Observation Sessions']].map(([key, lbl]) => (
            <button key={key} className={`tab ${agentTab === key ? 'active' : ''}`} onClick={() => setAgentTab(key)}>{lbl}</button>
          ))}
        </div>
        {agentTab === 'coaching'
          ? <AgentEvalCoachings profile={profile} flash={flash} openId={coachingParam} />
          : (showBlankLoader
              ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</div>
              : <SessionsTable rows={own.filter(s => s.status !== 'draft')} counts={counts} onView={setDetail} />)}
        {detail && <SessionDetail session={detail} profile={profile} isCoach={false} flash={flash} onClose={() => setDetail(null)} onChanged={loadSessions} onRecoach={() => {}} />}
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div><h1>Coaching</h1></div>
        {tab === 'sessions' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ opacity: myDrafts.length ? 1 : 0.5 }} disabled={!myDrafts.length} onClick={() => setDrafts(true)}>
              {myDrafts.length ? `Drafts (${myDrafts.length})` : 'Drafts'}
            </button>
            {canCreate && <button className="btn btn-primary" onClick={openCreate}>+ New Observation Session</button>}
          </div>
        )}
      </div>

      {msg && (
        <div className={`flash ${msg.ok ? 'flash-ok' : 'flash-err'}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{msg.text}</span>
          <button className="btn btn-sm" style={{ background: 'rgba(255,255,255,0.2)', color: 'inherit', flexShrink: 0 }} onClick={() => setMsg(null)}>OK</button>
        </div>
      )}

      {/* Shared pill tabs from index.css, so every page's tab bar looks the same. */}
      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {showBlankLoader ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div> : (
        <>
          {tab === 'sessions' && (
            <>
              <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Active &amp; Pending Verification</h2>
              <div style={{ marginBottom: 28 }}><SessionsTable rows={activeRows} counts={counts} onView={setDetail} /></div>
              <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Closed &amp; Cancelled</h2>
              <SessionsTable rows={closedRows} counts={counts} onView={setDetail} />
            </>
          )}
          {tab === 'insights' && <InsightsTab sessions={mine} counts={counts} govNames={govNames} />}
          {tab === 'queue' && <CoachingQueue profile={profile} isPrivileged={isPrivileged} flash={flash} gov={gov} openCriticalId={criticalParam} />}
          {tab === 'coaching_insights' && <CoachingInsightsTab profile={profile} isPrivileged={isPrivileged} govNames={govNames} gov={gov} />}
        </>
      )}

      {creating && gov && (
        <NewObservationModal profile={profile} isPrivileged={isPrivileged} gov={gov} parent={recoachOf}
          flash={flash} onClose={() => { setCreating(false); setRecoach(null) }} onSaved={afterSave} />
      )}
      {showDrafts && <DraftsModal drafts={myDrafts} onClose={() => setDrafts(false)} onOpen={(d) => { setDrafts(false); setDetail(d) }} onDelete={(d) => { setDrafts(false); deleteDraft(d) }} />}
      {detail && <SessionDetail session={detail} profile={profile} isCoach={isCoach} flash={flash} onClose={() => setDetail(null)} onChanged={loadSessions} onRecoach={startRecoach} onResumeDraft={resumeDraft} />}
    </div>
  )
}