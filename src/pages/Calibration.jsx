import { useState, useEffect, useRef, Fragment } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '../App'
import { supabase } from '../lib/supabase'
import { calculateQualityScore, answerEarnsWeight } from '../lib/scoring'

// ── Shared ────────────────────────────────────────────────────────────────────

// Today as YYYY-MM-DD in the user's local timezone. Built from local date parts rather
// than toISOString(), which converts to UTC first and can hand back yesterday for anyone
// west of UTC late in the evening.
const TODAY_STR = (() => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
})()

function TypeBadge({ type }) {
  const isDsat = type === 'dsat'
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
      backgroundColor: isDsat ? '#dc262622' : '#2563eb22',
      color: isDsat ? '#dc2626' : '#2563eb',
    }}>{(type || '').toUpperCase()}</span>
  )
}

function ResultBadge({ calibrated }) {
  return (
    <span style={{
      padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
      backgroundColor: calibrated ? '#16a34a22' : '#dc262622',
      color: calibrated ? '#16a34a' : '#dc2626',
      border: `1px solid ${calibrated ? '#16a34a44' : '#dc262644'}`,
    }}>{calibrated ? 'Calibrated' : 'Not Calibrated'}</span>
  )
}

// ── CalibrationHome ───────────────────────────────────────────────────────────

function CalibrationHome({ onScore }) {
  const { profile } = useAuth()
  const uid = profile?.id
  const [activeSessions, setActive] = useState([])
  const [pastResults, setPast]      = useState([])
  const [loading, setLoading]       = useState(true)
  const [pastPage, setPastPage]     = useState(1)

  useEffect(() => { if (uid) load() }, [uid])

  async function load() {
    setLoading(true)

    // The per-scorecard Certification Status cards were removed from this page, so the
    // certification-history derivation that fed them is gone too — it was three queries
    // per page load doing nothing. The history table itself is untouched and still
    // written on every scoring; Insights and the certification ledger still use it.

    const { data: parts } = await supabase
      .from('calibration_participants')
      .select('session_id')
      .eq('evaluator_id', uid)

    const sessionIds = (parts || []).map(p => p.session_id)
    let evalSessions = []

    if (sessionIds.length > 0) {
      const { data: sessions } = await supabase
        .from('calibration_sessions')
        .select('id, title, type, session_date, status, gauge_user_id, scorecard_id, scoring_deadline, results_released')
        .in('id', sessionIds)
        .in('status', ['open', 'scoring'])
        .order('session_date', { ascending: false })

      const { data: mySubs } = await supabase
        .from('calibration_submissions')
        .select('session_id, id, status, is_calibrated, delta')
        .eq('evaluator_id', uid)
        .in('session_id', sessionIds)

      const subMap = Object.fromEntries((mySubs || []).map(s => [s.session_id, s]))
      evalSessions = (sessions || []).map(s => ({
        ...s,
        submission: subMap[s.id] || null,
        isGaugeRole: s.gauge_user_id === uid,
      }))
    }

    const { data: gaugeSessions } = await supabase
      .from('calibration_sessions')
      .select('id, title, type, session_date, status, gauge_user_id, scorecard_id')
      .eq('gauge_user_id', uid)
      .in('status', ['open', 'scoring'])
      .order('session_date', { ascending: false })

    if ((gaugeSessions || []).length > 0) {
      const gaugeIds = gaugeSessions.map(s => s.id)
      const { data: gaugeSubs } = await supabase
        .from('calibration_submissions')
        .select('session_id, id, status')
        .eq('evaluator_id', uid)
        .in('session_id', gaugeIds)
      const gsMap = Object.fromEntries((gaugeSubs || []).map(s => [s.session_id, s]))
      const existingIds = new Set(evalSessions.map(s => s.id))
      const newGauge = (gaugeSessions || [])
        .filter(s => !existingIds.has(s.id))
        .map(s => ({ ...s, submission: gsMap[s.id] || null, isGaugeRole: true }))
      evalSessions = [...evalSessions, ...newGauge]
    }

    setActive(evalSessions)

    const { data: results } = await supabase
      .from('calibration_submissions')
      .select('id, status, is_calibrated, delta, submitted_at, session_id')
      .eq('evaluator_id', uid)
      .eq('status', 'evaluated')
      .order('submitted_at', { ascending: false })
      .limit(20)

    if ((results || []).length > 0) {
      const rsIds = results.map(r => r.session_id)
      const { data: rsSessions } = await supabase
        .from('calibration_sessions')
        .select('id, title, type, session_date, results_released')
        .in('id', rsIds)
      const rsMap = Object.fromEntries((rsSessions || []).map(s => [s.id, s]))
      setPast(results.map(r => ({ ...r, session: rsMap[r.session_id] })))
    }

    setLoading(false)
  }

  if (loading) return (
    <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>Loading…</div>
  )

  const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }
  const tdStyle = { padding: '10px 16px' }

  // Past Results pagination. 15 rows a page, matching Insights › Sessions Overview.
  // The page is clamped so a reload that returns fewer results cannot strand the view
  // on an empty page.
  const PAST_PER_PAGE = 15
  const pastPageCount = Math.max(1, Math.ceil(pastResults.length / PAST_PER_PAGE))
  const currentPastPage = Math.min(pastPage, pastPageCount)
  const pastStart = (currentPastPage - 1) * PAST_PER_PAGE
  const pagedPastResults = pastResults.slice(pastStart, pastStart + PAST_PER_PAGE)

  return (
    <div>
      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Active Sessions
        </h2>
        {activeSessions.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 36, color: 'var(--text-secondary)', fontSize: 14 }}>
            No active sessions assigned to you
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={thStyle}>Title</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>Status</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {activeSessions.map(session => {
                  const sub = session.submission
                  const scored = sub?.status === 'submitted' || sub?.status === 'evaluated'
                  const canScore = session.status === 'scoring' && !scored
                  return (
                    <tr key={session.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ ...tdStyle, fontWeight: 500 }}>{session.title}</td>
                      <td style={tdStyle}><TypeBadge type={session.type} /></td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>
                        {session.session_date ? new Date(session.session_date).toLocaleDateString() : '—'}
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontSize: 12, fontWeight: session.isGaugeRole ? 600 : 400, color: session.isGaugeRole ? '#7c3aed' : 'var(--text-secondary)' }}>
                          {session.isGaugeRole ? 'Gauge' : 'Evaluator'}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        {scored
                          ? <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 500 }}>✓ Submitted</span>
                          : session.status === 'open'
                            ? <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Waiting to open</span>
                            : <span style={{ fontSize: 12, color: '#d97706', fontWeight: 500 }}>● Pending</span>
                        }
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {canScore && (
                          <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 14px' }}
                            onClick={() => onScore(session)}>
                            Score
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {pastResults.length > 0 && (
        <section>
          <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Past Results
          </h2>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={thStyle}>Session</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Delta</th>
                  <th style={thStyle}>Result</th>
                </tr>
              </thead>
              <tbody>
                {pagedPastResults.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...tdStyle, fontWeight: 500 }}>{r.session?.title || '—'}</td>
                    <td style={tdStyle}>{r.session?.type ? <TypeBadge type={r.session.type} /> : '—'}</td>
                    <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>
                      {r.session?.session_date ? new Date(r.session.session_date).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>
                      {r.delta != null ? `${(r.results_released ?? r.session?.results_released) ? `${(r.delta * 100).toFixed(1)}%` : '—'}` : '—'}
                    </td>
                    <td style={tdStyle}>{(r.results_released ?? r.session?.results_released) ? <ResultBadge calibrated={r.is_calibrated} /> : <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Pending release</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pastPageCount > 1 && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, padding: '10px 16px', borderTop: '1px solid var(--border)',
                flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Showing {pastStart + 1}–{Math.min(pastStart + PAST_PER_PAGE, pastResults.length)} of {pastResults.length} results
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="btn btn-ghost btn-sm"
                    onClick={() => setPastPage(p => Math.max(1, p - 1))}
                    disabled={currentPastPage <= 1}
                    style={{ opacity: currentPastPage <= 1 ? 0.45 : 1, cursor: currentPastPage <= 1 ? 'default' : 'pointer' }}>
                    ← Previous
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 92, textAlign: 'center' }}>
                    Page {currentPastPage} of {pastPageCount}
                  </span>
                  <button className="btn btn-ghost btn-sm"
                    onClick={() => setPastPage(p => Math.min(pastPageCount, p + 1))}
                    disabled={currentPastPage >= pastPageCount}
                    style={{ opacity: currentPastPage >= pastPageCount ? 0.45 : 1, cursor: currentPastPage >= pastPageCount ? 'default' : 'pointer' }}>
                    Next →
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

// ── CalibrationSubmit (Steps 5 + 6) ───────────────────────────────────────────

function CalibrationSubmit({ session, onBack, onSubmitted }) {
  const { profile } = useAuth()
  const uid = profile?.id
  const isGauge = session?.gauge_user_id === uid

  const [questions, setQuestions]     = useState([])
  const [answers, setAnswers]         = useState({})
  const [overallComment, setComment]  = useState('')
  const [loading, setLoading]         = useState(true)
  const [submitting, setSubmitting]   = useState(false)
  const [existingSub, setExistingSub] = useState(null)
  const [error, setError]             = useState('')
  const [showLgtmConfirm, setShowLgtmConfirm] = useState(false)
  const commentRef = useRef(null)

  // Floating progress bar: a 1px sentinel sits where the inline bar renders; once it
  // scrolls past the top of the viewport the pill takes over. Same approach as the
  // evaluation form.
  //
  // These must stay above the `if (loading) return` below — hooks cannot sit after an
  // early return, or the hook count changes between renders once loading flips and React
  // throws "rendered more hooks than during the previous render".
  const barSentinelRef = useRef(null)
  const [barFloating, setBarFloating] = useState(false)
  useEffect(() => {
    const onScroll = () => {
      const el = barSentinelRef.current
      if (!el) { setBarFloating(false); return }
      setBarFloating(el.getBoundingClientRect().top < 8)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [loading])

  useEffect(() => { if (uid && session?.id) load() }, [uid, session?.id])

  async function load() {
    setLoading(true)
    const { data: qs } = await supabase
      .from('scorecard_questions')
      .select('id, title, weight, is_weighted, is_form_critical, is_group_critical, group_id, allow_na, position')
      .eq('scorecard_id', session.scorecard_id)
      .order('position')
    setQuestions(qs || [])

    const { data: sub } = await supabase
      .from('calibration_submissions')
      .select('id, status, overall_score, comment')
      .eq('session_id', session.id)
      .eq('evaluator_id', uid)
      .maybeSingle()

    if (sub) {
      setExistingSub(sub)
      setComment(sub.comment || '')
      const { data: prevAnswers } = await supabase
        .from('calibration_answers')
        .select('question_id, answer_value')
        .eq('submission_id', sub.id)
      const ansMap = {}
      for (const a of (prevAnswers || [])) ansMap[a.question_id] = a.answer_value
      setAnswers(ansMap)
    }

    setLoading(false)
  }

  // Scoring is shared with the evaluation form (lib/scoring.js) so a calibration score
  // means the same thing as the score the same answers would produce in a real
  // evaluation. Previously this page carried its own copy, which had drifted on N/A,
  // group-critical, unweighted questions and the empty-scorecard case.
  function calcScore(qs, ans) {
    const { score, failedCritical } = calculateQualityScore(qs, q => ans[q.id] ?? null)
    return { score, failedCritical }
  }

  // ── Delta + certification logic (Step 6) ──────────────────────────────────

  // Computes delta + the calibrated flag for ONE participant submission and appends its
  // certification-history row. Runs server-side via SECURITY DEFINER RPC.
  //
  // Why server-side: the calculation needs the Gauge's submission and answers, which RLS
  // deliberately hides from participants — the Gauge's answer sheet is the reference key,
  // and a participant able to read it could copy it before submitting, which would make
  // calibration meaningless. Previously this ran in the browser, so once RLS was enabled
  // a participant's submit silently produced no delta at all.
  async function evaluateSubmission(submissionId) {
    const { error } = await supabase.rpc('evaluate_calibration_submission', {
      p_submission_id: submissionId,
    })
    if (error) console.error('delta calculation failed:', error.message)
  }

  // Scores every participant submission still waiting, then re-checks completion.
  // Called on the Gauge's own submit — until the Gauge has scored there is no reference
  // to compare anyone against. The per-submission maths lives in the RPC above, so the
  // Gauge and participant paths share one implementation instead of two that can drift.
  async function runDeltaForAll() {
    const { data: evalSubs } = await supabase.from('calibration_submissions')
      .select('id')
      .eq('session_id', session.id)
      .eq('is_gauge', false)
      .eq('status', 'submitted')

    for (const es of (evalSubs || [])) {
      await evaluateSubmission(es.id)
    }

    await checkSessionCompletion()
  }

  // Marks the session 'completed' once the Gauge has submitted AND every participant's
  // submission has reached 'evaluated'. Called from both the Gauge's own submit path
  // (runDeltaForAll, above) and the regular-evaluator submit path below — previously this
  // only ran inside runDeltaForAll, so a session where the Gauge submitted before all
  // participants finished would silently stay stuck on "Scoring" forever.
  //
  // Now runs server-side via SECURITY DEFINER RPC. Row-Level Security on
  // calibration_sessions permits UPDATE only by privileged users and the Gauge, and RLS
  // cannot be restricted to a single column — so a participant completing the last
  // submission could not flip the status from the client, and the write failed silently
  // (the old code ignored its error), reintroducing the stuck-on-"Scoring" bug.
  // The RPC performs its own authorisation check and applies the same completion
  // condition. Errors are logged rather than swallowed.
  async function checkSessionCompletion() {
    const { error } = await supabase.rpc('complete_calibration_session_if_ready', {
      p_session_id: session.id,
    })
    if (error) console.error('session completion check failed:', error.message)
  }

  // "Looks Good to Me" — bulk-marks every attribute as Pass, then jumps
  // straight to the Overall Comment field. Hidden for DSAT-type sessions.
  function applyLgtm() {
    setAnswers(prev => {
      const next = { ...prev }
      for (const q of questions) next[q.id] = 'pass'
      return next
    })
    setShowLgtmConfirm(false)
    setTimeout(() => {
      commentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      commentRef.current?.focus()
    }, 50)
  }

  // ── Submit handler ────────────────────────────────────────────────────────

  async function handleSubmit() {
    const unanswered = questions.filter(q => !answers[q.id])
    if (unanswered.length > 0) {
      setError(`${unanswered.length} question${unanswered.length > 1 ? 's' : ''} still need an answer.`)
      return
    }
    if (!overallComment.trim()) {
      setError('Please add an overall comment before submitting.')
      return
    }
    setError('')
    setSubmitting(true)

    try {
      const { score } = calcScore(questions, answers)
      let subId = existingSub?.id

      if (!subId) {
        const { data: newSub, error: subErr } = await supabase.from('calibration_submissions')
          .insert({
            session_id: session.id,
            evaluator_id: uid,
            is_gauge: isGauge,
            status: 'submitted',
            overall_score: score,
            comment: overallComment || null,
            submitted_at: new Date().toISOString(),
          })
          .select('id').single()
        if (subErr) { setError('Error: ' + subErr.message); return }
        subId = newSub.id
      } else {
        await supabase.from('calibration_submissions').update({
          status: 'submitted',
          overall_score: score,
          comment: overallComment || null,
          submitted_at: new Date().toISOString(),
        }).eq('id', subId)
        await supabase.from('calibration_answers').delete().eq('submission_id', subId)
      }

      const ansRows = questions.map(q => {
        const val = answers[q.id] || 'na'
        const w = q.is_weighted ? (q.weight || 1) : 1
        return {
          submission_id: subId,
          question_id: String(q.id),
          question_label: q.title,
          answer_value: val,
          // Earned weight under the shared rule — N/A earns, same as Pass. (Was null for
          // N/A, from when N/A was excluded from scoring altogether.)
          score: answerEarnsWeight(val) ? w : 0,
          weight: w,
          is_critical: q.is_form_critical || false,
        }
      })
      await supabase.from('calibration_answers').insert(ansRows)

      if (isGauge) {
        await runDeltaForAll()
      } else {
        // No client-side lookup of the Gauge's submission any more — RLS hides it from
        // participants by design. The RPC finds it server-side and returns false if the
        // Gauge hasn't scored yet, in which case this submission is picked up later by
        // the Gauge's own runDeltaForAll.
        await evaluateSubmission(subId)
        await checkSessionCompletion()
      }

      onSubmitted?.()
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return (
    <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
      Loading questions…
    </div>
  )

  const answeredCount = questions.filter(q => !!answers[q.id]).length
  const allAnswered = answeredCount === questions.length && questions.length > 0
  const pct = questions.length > 0 ? Math.round((answeredCount / questions.length) * 100) : 0

  // Live score "so far": answeredOnly keeps unanswered questions out of the denominator,
  // so the figure converges on the final score as you work rather than climbing from zero.
  // Same module and same option the evaluation form uses, so the two read identically.
  const live = calculateQualityScore(questions, q => answers[q.id] ?? null, { answeredOnly: true })
  const previewScore = live.score
  const showQc = session.type !== 'dsat' && questions.length > 0
  const qcColor = live.failedCritical ? '#dc2626'
    : !live.answeredAny ? 'var(--text-secondary)'
    : previewScore >= 90 ? '#16a34a'
    : previewScore >= 75 ? '#d97706'
    : '#dc2626'
  const qcText = !live.answeredAny ? '—' : (live.failedCritical ? '0% · critical fail' : previewScore + '%')
  const qcTextShort = !live.answeredAny ? '—' : (live.failedCritical ? '0%' : previewScore + '%')

  return (
    <div>
      <button onClick={onBack}
        style={{ marginBottom: 20, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13 }}>
        ← Back to sessions
      </button>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ margin: 0, marginBottom: 6 }}>{session.title}</h2>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <TypeBadge type={session.type} />
              {isGauge && (
                <span style={{ fontSize: 12, color: '#7c3aed', fontWeight: 600 }}>You are the Gauge</span>
              )}
              {session.session_date && (
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {new Date(session.session_date).toLocaleDateString()}
                </span>
              )}
            </div>
            {session.type !== 'dsat' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowLgtmConfirm(true)}
                  style={{ fontWeight: 600 }}>
                  LGTM
                </button>
                <span
                  title='Clicking this button will mark all the attributes as "Pass" and will take you directly to the comments section.'
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 16, height: 16, borderRadius: '50%', fontSize: 11, fontWeight: 700,
                    border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'help'
                  }}>
                  ?
                </span>
              </div>
            )}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>
              {answeredCount} / {questions.length} answered
            </div>
            {showQc && live.answeredAny && (
              <div style={{ fontSize: 22, fontWeight: 700, color: qcColor }}>
                {qcTextShort}
              </div>
            )}
          </div>
        </div>
      </div>

      <div ref={barSentinelRef} style={{ height: 1 }} />
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>{answeredCount}/{questions.length} answered</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {showQc && (
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                Live QC Score: <span style={{ color: qcColor, fontWeight: 700 }}>{qcText}</span>
              </span>
            )}
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>{pct}%</span>
          </div>
        </div>
        <div style={{ height: 4, background: 'var(--border)', borderRadius: 4 }}>
          <div style={{ height: 4, borderRadius: 4, background: 'var(--accent)', width: `${pct}%`, transition: 'width 0.3s' }} />
        </div>
      </div>

      <AnimatePresence>
        {barFloating && (
          <motion.div
            initial={{ opacity: 0, y: -24, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -24, x: '-50%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            style={{
              position: 'fixed', top: 14, left: 'calc(50% + 110px)', zIndex: 40,
              display: 'flex', alignItems: 'center', gap: 14, minWidth: 300,
              padding: '9px 20px', borderRadius: 999,
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.28)'
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{answeredCount}/{questions.length}</span>
            <div style={{ flex: 1, minWidth: 130, height: 5, background: 'var(--border)', borderRadius: 999 }}>
              <div style={{ height: 5, borderRadius: 999, background: 'var(--accent)', width: `${pct}%`, transition: 'width 0.3s' }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>{pct}%</span>
            {showQc && (
              <>
                <span style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0 }} />
                <span title="Live QC score from your current selections" style={{ fontSize: 12, fontWeight: 700, color: qcColor, whiteSpace: 'nowrap' }}>QC {qcTextShort}</span>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {questions.map((q, idx) => {
          const sel = answers[q.id]
          return (
            <div key={q.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-secondary)', marginRight: 6 }}>{idx + 1}.</span>
                    {q.title}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {q.is_form_critical && (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, fontWeight: 600, backgroundColor: '#dc262622', color: '#dc2626', border: '1px solid #dc262644' }}>
                        Critical
                      </span>
                    )}
                    
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {q.is_weighted && <span style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, marginRight: 8, whiteSpace: 'nowrap' }}>{q.weight} pts</span>}
                  {/* N/A is offered only where the scorecard allows it, matching the
                      evaluation form. allow_na defaults to true, so `!== false` keeps
                      older rows with a null value behaving as before. */}
                  {['pass', 'fail', ...(q.allow_na !== false ? ['na'] : [])].map(opt => (
                    <button key={opt}
                      onClick={() => setAnswers(prev => ({ ...prev, [q.id]: opt }))}
                      style={{
                        padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1.5px solid',
                        borderColor: sel === opt ? (opt === 'pass' ? '#16a34a' : opt === 'fail' ? '#dc2626' : '#6b7280') : 'var(--border)',
                        backgroundColor: sel === opt ? (opt === 'pass' ? '#16a34a22' : opt === 'fail' ? '#dc262622' : 'var(--bg-secondary)') : 'transparent',
                        color: sel === opt ? (opt === 'pass' ? '#16a34a' : opt === 'fail' ? '#dc2626' : '#6b7280') : 'var(--text-secondary)',
                      }}>
                      {opt === 'na' ? 'N/A' : opt.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          Overall Comment <span style={{ color: '#dc2626' }}>*</span>
        </div>
        <textarea
          ref={commentRef}
          placeholder="Add an overall comment for this calibration…"
          value={overallComment}
          onChange={e => setComment(e.target.value)}
          style={{
            width: '100%', fontSize: 13, padding: '10px 12px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg-secondary)',
            color: 'var(--text-primary)', resize: 'vertical', minHeight: 72, boxSizing: 'border-box',
          }}
        />
      </div>

      {error && (
        <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn btn-ghost" onClick={onBack}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting || !allAnswered}>
          {submitting ? 'Submitting…' : isGauge ? 'Submit as Gauge' : 'Submit Scoring'}
        </button>
      </div>

      {showLgtmConfirm && (
        <div className="modal-backdrop" onClick={() => setShowLgtmConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420, textAlign: 'center' }}>
            <div className="modal-body" style={{ padding: '32px 28px' }}>
              <h2 style={{ marginBottom: 12, fontSize: 17 }}>Mark all as Pass?</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, marginBottom: 24 }}>
                This will mark every attribute on this scorecard as "Pass" and take you to the comments section. Any existing answers will be overwritten.
              </p>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                <button className="btn btn-ghost" onClick={() => setShowLgtmConfirm(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={applyLgtm}>Yes, mark all Pass</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── CalibrationAdmin (Step 8) ─────────────────────────────────────────────────

function CalibrationAdmin() {
  const { profile } = useAuth()
  const [sessions, setSessions]     = useState([])
  const [scorecards, setScorecards] = useState([])
  const [users, setUsers]           = useState([])
  const [loading, setLoading]       = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected]     = useState(null)
  const [detail, setDetail]         = useState(null)
  const [creating, setCreating]     = useState(false)
  // Completed sessions are hidden by default to keep this list focused on active work,
  // but they must stay reachable — Release Results lives on THIS screen, not Insights,
  // so a session that finishes scoring can't be allowed to become permanently unreachable.
  const [showCompleted, setShowCompleted] = useState(false)
  const [bpoOptions, setBpoOptions]       = useState([])
  const [wsList, setWsList]               = useState([])
  const [hubsAll, setHubsAll]             = useState([])
  const [queuesAll, setQueuesAll]         = useState([])
  const [metadataLoadError, setMetadataLoadError] = useState(null)

  const [form, setForm] = useState({
    title: '', type: 'quality', scoring_deadline: '', scorecard_id: '',
    case_reference: '', session_date: new Date().toISOString().split('T')[0],
    bpo: '', hub: '', market: '',
    participants: [],
  })

  useEffect(() => { if (profile) loadAll() }, [profile])

  async function loadAll() {
    setLoading(true)
    // Same rule as loadResults: admins/owners see every session; everyone else only
    // sees sessions where they are the Gauge.
    const isPrivileged = ['admin', 'owner'].includes(profile?.role)
    let sessionsQuery = supabase.from('calibration_sessions').select('*').order('created_at', { ascending: false })
    if (!isPrivileged) sessionsQuery = sessionsQuery.eq('gauge_user_id', profile?.id)
    const [{ data: sess }, { data: scs }, { data: us }] = await Promise.all([
      sessionsQuery,
      supabase.from('scorecards').select('id, name, type').eq('is_calibration', true).eq('is_published', true).order('name'),
      // Participants can be any Evaluator/Team Leader/Admin/Owner — Kaizen Gaming or
      // BPO — never Agents. `viewer` is the Agent role, and an agent has no business
      // scoring a calibration case. Creating/managing sessions stays KG-gated via
      // `canManage` below; this list only controls who can be picked as a participant
      // or Gauge when a KG QA builds a session.
      supabase.from('users').select('id, name, email, role').neq('role', 'viewer').order('email'),
    ])
    setSessions(sess || [])
    setScorecards(scs || [])
    setUsers(us || [])
    setLoading(false)
  }

  useEffect(() => { if (profile) loadMetadataOptions() }, [profile])

  async function loadMetadataOptions() {
    // Cascading sources: BPO (workspace) -> HUB (hubs in that workspace) -> Market
    // (markets operated by that hub's queues). Governance / Reference Data only.
    const [{ data: wsp }, { data: hb }, { data: qs }] = await Promise.all([
      supabase.from('workspaces').select('id, name').is('deleted_at', null).order('name'),
      supabase.from('hubs').select('id, name, workspace_id').is('deleted_at', null).order('name'),
      supabase.from('queues').select('hub_id, market_value').is('deleted_at', null),
    ])
    setWsList(wsp || [])
    setHubsAll(hb || [])
    setQueuesAll(qs || [])
    setBpoOptions((wsp || []).map(w => w.name))
    setMetadataLoadError(null)
  }

  // Cascading choices for the create modal.
  const hubChoices = () => {
    const w = wsList.find(x => x.name === form.bpo)
    return w ? hubsAll.filter(h => h.workspace_id === w.id) : []
  }
  const marketChoicesFor = () => {
    const h = hubsAll.find(x => x.name === form.hub)
    return h ? [...new Set(queuesAll.filter(q => q.hub_id === h.id).map(q => q.market_value).filter(Boolean))].sort() : []
  }

  // Who can be picked as a participant. The Gauge is always the session creator (see the
  // read-only Gauge field in the create modal, and gauge_user_id: profile.id in
  // handleCreate), and the Gauge is the reference the others are measured against — so
  // they are never also a participant.
  //
  // This is not cosmetic. If the Gauge is listed as a participant the session can never
  // complete: runDeltaForAll only evaluates submissions where is_gauge = false, so the
  // Gauge's own submission is never evaluated as a participant one, and
  // complete_calibration_session_if_ready waits for every participant to reach
  // 'evaluated'. The session would sit on "Scoring" forever. A self-comparison would also
  // contribute a guaranteed 0% delta and quietly inflate the session's calibration rate.
  //
  // Derived here rather than filtered inline at the checkbox map so any future surface
  // that needs the pickable list gets the same rule.
  const participantChoices = () => (users || []).filter(u => u.id !== profile?.id)

  async function openDetail(session) {
    setSelected(session)
    setDetail(null)
    const [{ data: parts }, { data: subs }] = await Promise.all([
      supabase.from('calibration_participants').select('evaluator_id').eq('session_id', session.id),
      supabase.from('calibration_submissions')
        .select('evaluator_id, status, overall_score, is_calibrated, delta, is_gauge')
        .eq('session_id', session.id),
    ])
    const subMap = Object.fromEntries((subs || []).map(s => [s.evaluator_id, s]))
    const partIds = (parts || []).map(p => p.evaluator_id)
    const partUsers = (users || []).filter(u => partIds.includes(u.id))
    const gaugeUser = (users || []).find(u => u.id === session.gauge_user_id)

    // Session-wide delta/calibration-rate summary, computed from every participant
    // who has actually been scored ('evaluated') — pending submissions don't count yet.
    const evaluatedSubs = (subs || []).filter(s => !s.is_gauge && s.status === 'evaluated')
    const avgDelta = evaluatedSubs.length > 0
      ? evaluatedSubs.reduce((sum, s) => sum + (s.delta || 0), 0) / evaluatedSubs.length
      : null
    const calibratedCount = evaluatedSubs.filter(s => s.is_calibrated).length

    setDetail({
      participants: partUsers.map(u => ({ ...u, sub: subMap[u.id] || null })),
      gaugeUser,
      gaugeSub: subMap[session.gauge_user_id] || null,
      avgDelta,
      calibratedCount,
      evaluatedCount: evaluatedSubs.length,
    })
  }

  async function updateStatus(newStatus) {
    await supabase.from('calibration_sessions').update({ status: newStatus }).eq('id', selected.id)
    setSessions(prev => prev.map(s => s.id === selected.id ? { ...s, status: newStatus } : s))
    setSelected(s => ({ ...s, status: newStatus }))
  }

  async function handleCreate() {
    if (!form.title || !form.scorecard_id) {
      alert('Title and scorecard are required.')
      return
    }
    // `min` on a date input only constrains the picker — a typed value slips past it,
    // so the rule is enforced here too.
    const today = TODAY_STR
    if (form.session_date && form.session_date < today) {
      alert('The session date cannot be in the past.')
      return
    }
    if (form.scoring_deadline && form.scoring_deadline < today) {
      alert('The scoring deadline cannot be in the past.')
      return
    }
    if (form.scoring_deadline && form.session_date && form.scoring_deadline < form.session_date) {
      alert('The scoring deadline cannot be earlier than the session date.')
      return
    }
    setCreating(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { data: sess, error } = await supabase.from('calibration_sessions').insert({
      title: form.title,
      type: form.type,
      scorecard_id: form.scorecard_id,
      gauge_user_id: profile.id,
      case_reference: form.case_reference || null,
      session_date: form.session_date || null,
      scoring_deadline: form.scoring_deadline || null,
      bpo: form.bpo || null,
      hub: form.hub || null,
      market: form.market || null,
      status: 'open',
      created_by: user?.id,
    }).select('id').single()

    if (error) { alert('Error: ' + error.message); setCreating(false); return }

    // Last line of defence on the write path. The picker excludes the Gauge and
    // toggleParticipant refuses them, but form state is long-lived across a modal session
    // and a stale entry here would insert a participant row that makes the session
    // impossible to complete. Enforced at the point of the write for the same reason the
    // date rules above are re-checked rather than left to the input's `min`.
    const participantIds = form.participants.filter(uid => uid !== profile.id)
    if (participantIds.length > 0) {
      const { error: partError } = await supabase.from('calibration_participants').insert(
        participantIds.map(uid => ({ session_id: sess.id, evaluator_id: uid }))
      )
      // Previously this error was discarded, so a blocked or failed participant insert
      // produced a session with a Gauge and no participants and no indication why.
      if (partError) {
        alert('The session was created, but adding participants failed: ' + partError.message
          + '\n\nOpen the session and add them again before scoring starts.')
      }
    }

    await loadAll()
    setShowCreate(false)
    setForm({ title: '', type: 'quality', scorecard_id: '', case_reference: '', session_date: new Date().toISOString().split('T')[0], bpo: '', hub: '', market: '', participants: [] })
    setCreating(false)
  }

  function toggleParticipant(uid) {
    // The Gauge is never a participant. participantChoices() already excludes them, so
    // this is a guard rather than a reachable path — kept so the invariant does not
    // depend on one call site continuing to filter correctly.
    if (uid === profile?.id) return
    setForm(f => ({
      ...f,
      participants: f.participants.includes(uid)
        ? f.participants.filter(id => id !== uid)
        : [...f.participants, uid],
    }))
  }

  const statusColor = { open: '#d97706', scoring: '#2563eb', awaiting_release: '#d97706', completed: '#16a34a' }
  const statusLabel = { open: 'Open', scoring: 'Scoring', awaiting_release: 'Awaiting Release', completed: 'Completed' }
  const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }
  const tdStyle = { padding: '10px 16px' }
  const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }
  // Scoring can finish (server marks status='completed') well before anyone chooses to
  // release results. Treating THAT as "Completed" made a session vanish from this list
  // the instant scoring wrapped up — taking Release Results with it. A session is only
  // truly done once its results are released too; until then it displays and behaves
  // as "Awaiting Release" and stays in the default (non-toggled) view.
  const displayStatus = (s) => (s.status === 'completed' && !s.results_released) ? 'awaiting_release' : s.status
  const isTrulyCompleted = (s) => s.status === 'completed' && !!s.results_released
  const visibleSessions = sessions.filter(s => showCompleted || !isTrulyCompleted(s))

  if (loading) return (
    <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>Loading…</div>
  )

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Calibration Sessions</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showCompleted} onChange={e => setShowCompleted(e.target.checked)} />
            Show completed
          </label>
          <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => setShowCreate(true)}>
            + New Session
          </button>
        </div>
      </div>

      {visibleSessions.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 36, color: 'var(--text-secondary)', fontSize: 14 }}>
          {showCompleted ? 'No sessions yet.' : 'No open or in-progress sessions. Tick "Show completed" above to find one that\'s finished scoring — that\'s also where Release Results lives.'}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={thStyle}>Title</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Gauge</th>
                <th style={thStyle}>Status</th>
                <th style={{ ...thStyle, textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {visibleSessions.map(s => {
                const gaugeUser = users.find(u => u.id === s.gauge_user_id)
                return (
                  <tr key={s.id} style={{
                    borderBottom: '1px solid var(--border)',
                    background: selected?.id === s.id ? 'rgba(37,99,235,0.08)' : 'transparent',
                    borderLeft: selected?.id === s.id ? '3px solid #2563eb' : '3px solid transparent',
                  }}>
                    <td style={{ ...tdStyle, fontWeight: 500 }}>{s.title}</td>
                    <td style={tdStyle}><TypeBadge type={s.type} /></td>
                    <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>
                      {s.session_date ? new Date(s.session_date).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: 12 }}>
                      {gaugeUser?.name || gaugeUser?.email || '—'}
                    </td>
                    <td style={tdStyle}>
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                        backgroundColor: (statusColor[displayStatus(s)] || '#6b7280') + '22',
                        color: statusColor[displayStatus(s)] || '#6b7280',
                        border: '1px solid ' + (statusColor[displayStatus(s)] || '#6b7280') + '44',
                      }}>
                        {statusLabel[displayStatus(s)] || s.status}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => openDetail(s)}>Manage</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Session detail — floating modal, not inline, so it doesn't get lost at the
          bottom of a long session list. */}
      {selected && (
        <div className="modal-backdrop" onClick={() => { setSelected(null); setDetail(null) }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header" style={{ flexShrink: 0 }}>
              <h2>{selected.title}</h2>
              <button className="btn-close" onClick={() => { setSelected(null); setDetail(null) }}>✕</button>
            </div>
            <div className="modal-body" style={{ overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <TypeBadge type={selected.type} />
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                    backgroundColor: (statusColor[displayStatus(selected)] || '#6b7280') + '22',
                    color: statusColor[displayStatus(selected)] || '#6b7280',
                  }}>
                    {statusLabel[displayStatus(selected)] || selected.status}
                  </span>
                  {selected.case_reference && (
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Ref: {selected.case_reference}</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {selected.status === 'open' && (
                    <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => updateStatus('scoring')}>
                      Open for Scoring
                    </button>
                  )}
                  {selected.status === 'scoring' && (
                    <button className="btn btn-outline" style={{ fontSize: 12 }} onClick={() => updateStatus('completed')}>
                      Mark Completed
                    </button>
                  )}
                  <button className="btn btn-secondary btn-sm"
                    onClick={async () => {
                      await supabase.from('calibration_sessions').update({ results_released: true }).eq('id', selected.id)
                      setSelected(s => ({ ...s, results_released: true }))
                      setSessions(prev => prev.map(s => s.id === selected.id ? { ...s, results_released: true } : s))
                    }}>
                    {selected.results_released ? '✓ Released' : 'Release Results'}
                  </button>
                </div>
              </div>

              {!detail ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</div>
              ) : (
                <>
                  {detail.evaluatedCount > 0 && (
                    <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                      <div className="card" style={{ flex: 1, textAlign: 'center', padding: '14px 16px' }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: detail.avgDelta <= 0.10 ? '#16a34a' : '#dc2626' }}>
                          {(detail.avgDelta * 100).toFixed(1)}%
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>
                          Overall Delta
                        </div>
                      </div>
                      <div className="card" style={{ flex: 1, textAlign: 'center', padding: '14px 16px' }}>
                        <div style={{ fontSize: 22, fontWeight: 700 }}>
                          {detail.calibratedCount}/{detail.evaluatedCount}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>
                          Calibrated
                        </div>
                      </div>
                      <div className="card" style={{ flex: 1, textAlign: 'center', padding: '14px 16px' }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: detail.calibratedCount === detail.evaluatedCount ? '#16a34a' : '#dc2626' }}>
                          {Math.round((detail.calibratedCount / detail.evaluatedCount) * 100)}%
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>
                          Calibration Rate
                        </div>
                      </div>
                    </div>
                  )}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                      Gauge
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                      <div>
                        <span style={{ fontWeight: 500, fontSize: 13 }}>{detail.gaugeUser?.name || detail.gaugeUser?.email || 'Unknown'}</span>
                        {detail.gaugeUser?.name && <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>{detail.gaugeUser.email}</span>}
                      </div>
                      {detail.gaugeSub
                        ? <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 500 }}>✓ Submitted ({detail.gaugeSub.overall_score}%)</span>
                        : <span style={{ fontSize: 12, color: '#d97706' }}>Pending</span>
                      }
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                      Participants ({detail.participants.length})
                    </div>
                    {detail.participants.length === 0 ? (
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No participants assigned to this session.</div>
                    ) : (
                      detail.participants.map(p => (
                        <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                          <div>
                            <span style={{ fontWeight: 500, fontSize: 13 }}>{p.name || p.email}</span>
                            {p.name && <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>{p.email}</span>}
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            {!p.sub && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Pending</span>}
                            {p.sub?.status === 'submitted' && (
                              <span style={{ fontSize: 12, color: '#2563eb', fontWeight: 500 }}>Submitted ({p.sub.overall_score}%)</span>
                            )}
                            {p.sub?.status === 'evaluated' && (
                              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <ResultBadge calibrated={p.sub.is_calibrated} />
                                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                  Δ {p.sub.delta != null ? (p.sub.delta * 100).toFixed(1) + '%' : '—'}
                                </span>
                              </span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create session modal */}
      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 540, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header" style={{ flexShrink: 0 }}>
              <h2>New Calibration Session</h2>
              <button className="btn-close" onClick={() => setShowCreate(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', minHeight: 0 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }}>Title *</label>
                <input style={inputStyle} value={form.title} placeholder="e.g. Q3 DSAT Calibration" onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }}>Type *</label>
                  <select style={inputStyle} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                    <option value="quality">Quality</option>
                    <option value="dsat">DSAT</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }}>Session Date</label>
                  {/* A calibration can't be scheduled into the past. `min` stops the date
                      picker offering earlier dates; handleCreate re-checks, because a typed
                      value can bypass `min`. */}
                  <input type="date" style={inputStyle} min={TODAY_STR} value={form.session_date} onChange={e => setForm(f => ({ ...f, session_date: e.target.value }))} />
            </div>
            <div style={{ marginTop: 8 }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Scoring Deadline</label>
            {/* Not before today, and never before the session date itself. */}
            <input type="date" style={inputStyle} min={form.session_date && form.session_date > TODAY_STR ? form.session_date : TODAY_STR} value={form.scoring_deadline}
              onChange={e => setForm(f => ({ ...f, scoring_deadline: e.target.value }))} />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }}>Calibration Scorecard *</label>
                <select style={inputStyle} value={form.scorecard_id} onChange={e => setForm(f => ({ ...f, scorecard_id: e.target.value }))}>
                  <option value="">— Select scorecard —</option>
                  {scorecards.map(sc => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
                </select>
                {scorecards.length === 0 && (
                  <div style={{ fontSize: 11, color: '#d97706', marginTop: 4 }}>
                    No calibration scorecards found. Create one in Scorecards and enable the Calibration flag.
                  </div>
                )}
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }}>Gauge (Reference Evaluator)</label>
                <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', background: 'var(--bg-hover, #eef0f3)', color: 'var(--text-secondary)' }}>
                  {profile?.name || profile?.email} <span style={{ marginLeft: 6, fontSize: 11 }}>— you (the session creator) are always the gauge</span>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }}>Case Reference (optional)</label>
                <input style={inputStyle} value={form.case_reference} placeholder="e.g. CASE-12345" onChange={e => setForm(f => ({ ...f, case_reference: e.target.value }))} />
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }}>BPO</label>
                  <select style={inputStyle} value={form.bpo} onChange={e => setForm(f => ({ ...f, bpo: e.target.value, hub: '', market: '' }))}>
                    <option value="">— Select a BPO —</option>
                    {bpoOptions.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }}>HUB</label>
                  <select style={{ ...inputStyle, opacity: form.bpo ? 1 : 0.5 }} value={form.hub} disabled={!form.bpo}
                    onChange={e => setForm(f => ({ ...f, hub: e.target.value, market: '' }))}>
                    <option value="">{form.bpo ? '— Select a HUB —' : 'Select a BPO first'}</option>
                    {hubChoices().map(h => <option key={h.id} value={h.name}>{h.name}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: 'var(--text-secondary)' }}>Market</label>
                  <select style={{ ...inputStyle, opacity: form.hub ? 1 : 0.5 }} value={form.market} disabled={!form.hub}
                    onChange={e => setForm(f => ({ ...f, market: e.target.value }))}>
                    <option value="">{form.hub ? '— Select a Market —' : 'Select a HUB first'}</option>
                    {marketChoicesFor().map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </div>
              </div>
              {metadataLoadError && (
                <div style={{ fontSize: 11, color: '#dc2626' }}>
                  Couldn't load the saved BPO/HUB/Market lists ({metadataLoadError}). Values you type here will still save on this session — reload the page and try again to get the full dropdown lists back.
                </div>
              )}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  Participants
                </label>
                <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                  {participantChoices().length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '6px 4px' }}>
                      No other evaluators are available to invite.
                    </div>
                  ) : participantChoices().map(u => (
                    <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', cursor: 'pointer', fontSize: 13 }}>
                      <input type="checkbox" checked={form.participants.includes(u.id)} onChange={() => toggleParticipant(u.id)} />
                      <span>{u.name || u.email}</span>
                      {u.name && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{u.email}</span>}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{form.participants.length} selected</div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '16px 20px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
              <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
                {creating ? 'Creating…' : 'Create Session'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── WeeklyDeltaChart (dependency-free inline SVG line chart) ─────────────────

function WeeklyDeltaChart({ data }) {
  const width = 680
  const height = 200
  const marginLeft = 44
  const marginRight = 16
  const marginTop = 16
  const marginBottom = 28
  const innerWidth = width - marginLeft - marginRight
  const innerHeight = height - marginTop - marginBottom

  if (!data.length) return (
    <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
      No scored submissions in this range.
    </div>
  )

  // The y-axis is derived from the data instead of a fixed 0-30% ladder. The old version
  // hard-coded gridValues up to 0.30, so any average delta above 30% drew the line above
  // every gridline with nothing to read it against, and the labels bunched into the lower
  // half of the plot. Now: pick a step giving ~5 ticks, then round the top up to a whole
  // step so the highest gridline is always at or above the highest point.
  const rawMax = Math.max(0.15, ...data.map(d => d.avgDelta))
  const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1].find(s => rawMax / s <= 5) || 1
  const maxDelta = Math.ceil(rawMax / step) * step

  const xFor = i => data.length === 1 ? marginLeft + innerWidth / 2 : marginLeft + (i / (data.length - 1)) * innerWidth
  const yFor = delta => marginTop + innerHeight - (delta / maxDelta) * innerHeight

  const points = data.map((d, i) => `${xFor(i)},${yFor(d.avgDelta)}`).join(' ')
  const thresholdY = yFor(0.10)
  const labelStep = Math.max(1, Math.ceil(data.length / 8))
  const gridValues = []
  for (let v = 0; v <= maxDelta + 1e-9; v += step) gridValues.push(Number(v.toFixed(4)))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {gridValues.map(v => (
        <g key={v}>
          <line x1={marginLeft} x2={width - marginRight} y1={yFor(v)} y2={yFor(v)} stroke="var(--border)" strokeWidth="1" />
          <text x={marginLeft - 8} y={yFor(v) + 4} textAnchor="end" fontSize="10" fill="var(--text-secondary)">{Math.round(v * 100)}%</text>
        </g>
      ))}
      <line x1={marginLeft} x2={width - marginRight} y1={thresholdY} y2={thresholdY} stroke="#dc2626" strokeWidth="1" strokeDasharray="4 3" />
      <text x={width - marginRight} y={thresholdY - 4} textAnchor="end" fontSize="10" fill="#dc2626">10% threshold</text>
      <polyline points={points} fill="none" stroke="#2563eb" strokeWidth="2" />
      {data.map((d, i) => (
        <circle key={d.week} cx={xFor(i)} cy={yFor(d.avgDelta)} r="4" fill={d.avgDelta <= 0.10 ? '#16a34a' : '#dc2626'}>
          <title>{`Week of ${new Date(d.week).toLocaleDateString()}: ${(d.avgDelta * 100).toFixed(1)}%`}</title>
        </circle>
      ))}
      {data.map((d, i) => (i % labelStep === 0) && (
        <text key={d.week} x={xFor(i)} y={height - 8} textAnchor="middle" fontSize="10" fill="var(--text-secondary)">
          {new Date(d.week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </text>
      ))}
    </svg>
  )
}

// ── CalibrationInsights (BI overview) ─────────────────────────────────────────

function CalibrationInsights() {
  const { profile } = useAuth()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState([])
  const [filterBpo, setFilterBpo] = useState('')
  const [filterHub, setFilterHub] = useState('')
  const [filterMarket, setFilterMarket] = useState('')
  const [filterScorecard, setFilterScorecard] = useState('')
  const [filterSession, setFilterSession] = useState('')
  const [filterGauge, setFilterGauge] = useState('')
  const [filterEvaluator, setFilterEvaluator] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [questionLabels, setQuestionLabels] = useState([])
  const [expandedSessions, setExpandedSessions] = useState({})
  const [sessionPage, setSessionPage] = useState(1)

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    setLoading(true)

    // BPO/HUB/Market filter choices are derived from the sessions actually shown
    // (below), so both old and new values remain filterable without depending on any
    // calibration-only options table.
    // Same visibility rule as Manage Sessions: admins/owners see every session;
    // everyone else only sees sessions where they were the Gauge.
    const isPrivileged = ['admin', 'owner'].includes(profile?.role)
    let sessionIdsFilter = null
    if (!isPrivileged) {
      // Non-privileged viewers (any Evaluator — Kaizen Gaming or BPO) only see sessions
      // they were actually part of: as Gauge, or as a listed participant. Previously this
      // only checked Gauge, so a BPO QA (never a Gauge) saw nothing at all here even
      // once the tab was opened up to them.
      const [{ data: myGaugeSessions }, { data: myParticipantRows }] = await Promise.all([
        supabase.from('calibration_sessions').select('id').eq('gauge_user_id', profile?.id),
        supabase.from('calibration_participants').select('session_id').eq('evaluator_id', profile?.id),
      ])
      const idSet = new Set([
        ...(myGaugeSessions || []).map(s => s.id),
        ...(myParticipantRows || []).map(p => p.session_id),
      ])
      sessionIdsFilter = [...idSet]
      if (sessionIdsFilter.length === 0) { setRows([]); setLoading(false); return }
    }

    // Admins/owners can read every row directly (RLS presumably grants them a broad
    // SELECT policy already, same as elsewhere in this app). Non-privileged viewers,
    // however, are almost certainly restricted by RLS to their OWN calibration_submissions
    // row — that's the right default (it's what keeps a participant from reading the
    // Gauge's reference answers pre-submission) but it also means a plain evaluator_id
    // filter never returns a session-mate's row. get_calibration_session_results is a
    // SECURITY DEFINER RPC (see the accompanying SQL) that re-validates server-side that
    // the caller is privileged, the session's Gauge, or a listed participant AND that
    // results_released is true, then returns every evaluated submission for that one
    // session — bypassing the narrower row-level policy on purpose, only once released.
    let subs
    if (isPrivileged) {
      const { data } = await supabase
        .from('calibration_submissions')
        .select('id, evaluator_id, session_id, is_calibrated, delta, status, submitted_at, comment')
        .eq('status', 'evaluated')
        .eq('is_gauge', false)
      subs = data
    } else {
      const perSession = await Promise.all(
        sessionIdsFilter.map(sid => supabase.rpc('get_calibration_session_results', { p_session_id: sid }))
      )
      subs = perSession.flatMap((r, i) => (r.data || []).map(row => ({ ...row, session_id: sessionIdsFilter[i] })))
      const anyError = perSession.find(r => r.error)
      if (anyError?.error) console.error('get_calibration_session_results failed:', anyError.error.message)
    }

    if (!subs || subs.length === 0) { setRows([]); setLoading(false); return }

    const sessionIds = [...new Set(subs.map(s => s.session_id))]
    const evaluatorIds = [...new Set(subs.map(s => s.evaluator_id))]

    const [{ data: sessionsData }, { data: usersData }] = await Promise.all([
      supabase.from('calibration_sessions').select('id, title, type, session_date, scorecard_id, gauge_user_id, bpo, hub, market, results_released').in('id', sessionIds),
      supabase.from('users').select('id, name, email').in('id', evaluatorIds),
    ])
    const scorecardIds = [...new Set((sessionsData || []).map(s => s.scorecard_id).filter(Boolean))]
    const { data: scorecardsData } = scorecardIds.length > 0
      ? await supabase.from('scorecards').select('id, name').in('id', scorecardIds)
      : { data: [] }
    const scorecardMap = Object.fromEntries((scorecardsData || []).map(s => [s.id, s]))
    const sessionMap = Object.fromEntries((sessionsData || []).map(s => [s.id, s]))
    const userMap = Object.fromEntries((usersData || []).map(u => [u.id, u]))

    // Pull every individual answer for these submissions, so the export can show one
    // column per attribute (question) alongside each evaluator's selection.
    const submissionIds = subs.map(s => s.id)
    const { data: answerRows } = await supabase
      .from('calibration_answers')
      .select('submission_id, question_label, answer_value')
      .in('submission_id', submissionIds)

    const answersBySubmission = {}
    const labelOrder = []
    const seenLabels = new Set()
    for (const a of (answerRows || [])) {
      (answersBySubmission[a.submission_id] ||= {})[a.question_label] = a.answer_value
      if (!seenLabels.has(a.question_label)) {
        seenLabels.add(a.question_label)
        labelOrder.push(a.question_label)
      }
    }

    // Flatten into one row per evaluated submission, carrying each session's BPO/HUB/
    // Market along with it so the tables below can be filtered by any of the three.
    // Non-privileged viewers (any Evaluator, KG or BPO) only ever see a session's own
    // deltas/results once Released — the exact same gate CalibrationHome already
    // applies on "My Sessions." Admin/Owner keep seeing everything unreleased, since
    // deciding whether to release is their call to make from this same data.
    const joined = subs
      .filter(sub => isPrivileged || sessionMap[sub.session_id]?.results_released)
      .map(sub => {
        const s = sessionMap[sub.session_id]
        return {
          ...sub,
          sessionTitle: s?.title || 'Unknown session',
          scorecardName: scorecardMap[s?.scorecard_id]?.name || (s?.type || '').toUpperCase(),
          sessionDate: s?.session_date,
          gaugeName: userMap[s?.gauge_user_id]?.name || userMap[s?.gauge_user_id]?.email || '—',
          evaluatorName: userMap[sub.evaluator_id]?.name || userMap[sub.evaluator_id]?.email || 'Unknown',
          bpo: s?.bpo || null,
          hub: s?.hub || null,
          market: s?.market || null,
          answers: answersBySubmission[sub.id] || {},
        }
      })

    setQuestionLabels(labelOrder)
    setRows(joined)
    setLoading(false)
  }

  if (loading) return (
    <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>Loading insights…</div>
  )

  if (rows.length === 0) return (
    <div className="card" style={{ textAlign: 'center', padding: 36, color: 'var(--text-secondary)', fontSize: 14 }}>
      No completed calibration results yet.
    </div>
  )

  const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }
  const tdStyle = { padding: '10px 16px' }
  const filterSelectStyle = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }

  // BPO/HUB/Market options come from the shared metadata list loaded above, so they
  // show up as filters as soon as they exist — even before any session using them has
  // been evaluated. Scorecard/Gauge/Evaluator options are derived from the data itself,
  // since those only make sense once there's actually something to filter.
  const bpoOptions = [...new Set(rows.map(r => r.bpo).filter(Boolean))].sort()
  const hubOptions = [...new Set(rows.map(r => r.hub).filter(Boolean))].sort()
  const marketOptions = [...new Set(rows.map(r => r.market).filter(Boolean))].sort()
  const scorecardOptions = [...new Set(rows.map(r => r.scorecardName).filter(Boolean))].sort()
  const sessionOptions = [...new Set(rows.map(r => r.sessionTitle).filter(Boolean))].sort()
  const gaugeOptions = [...new Set(rows.map(r => r.gaugeName).filter(Boolean))].sort()
  const evaluatorOptions = [...new Set(rows.map(r => r.evaluatorName).filter(Boolean))].sort()

  const filteredRows = rows.filter(r =>
    (!filterBpo || r.bpo === filterBpo) &&
    (!filterHub || r.hub === filterHub) &&
    (!filterMarket || r.market === filterMarket) &&
    (!filterScorecard || r.scorecardName === filterScorecard) &&
    (!filterSession || r.sessionTitle === filterSession) &&
    (!filterGauge || r.gaugeName === filterGauge) &&
    (!filterEvaluator || r.evaluatorName === filterEvaluator) &&
    (!filterDateFrom || (r.sessionDate && r.sessionDate >= filterDateFrom)) &&
    (!filterDateTo || (r.sessionDate && r.sessionDate <= filterDateTo))
  )

  // Per-session aggregation, computed from the filtered rows.
  const bySession = {}
  for (const r of filteredRows) {
    (bySession[r.session_id] ||= []).push(r)
  }
  const sessionStats = Object.entries(bySession).map(([sessionId, sRows]) => {
    const avgDelta = sRows.reduce((sum, r) => sum + (r.delta || 0), 0) / sRows.length
    const calibratedCount = sRows.filter(r => r.is_calibrated).length
    const first = sRows[0]
    return {
      id: sessionId,
      title: first.sessionTitle,
      scorecardName: first.scorecardName,
      date: first.sessionDate,
      gaugeName: first.gaugeName,
      bpo: first.bpo, hub: first.hub, market: first.market,
      avgDelta,
      calibratedCount,
      total: sRows.length,
    }
  }).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))

  // Per-evaluator aggregation, also computed from the filtered rows — so "needs
  // attention" reflects only the sessions currently in view.
  const byEvaluator = {}
  for (const r of filteredRows) {
    (byEvaluator[r.evaluator_id] ||= []).push(r)
  }
  const evaluatorStats = Object.entries(byEvaluator).map(([evalId, eRows]) => {
    const avgDelta = eRows.reduce((sum, r) => sum + (r.delta || 0), 0) / eRows.length
    const calibratedCount = eRows.filter(r => r.is_calibrated).length
    const withDates = [...eRows].sort((a, b) => new Date(b.sessionDate || 0) - new Date(a.sessionDate || 0))
    let consecutiveFailures = 0
    for (const r of withDates) {
      if (r.is_calibrated) break
      consecutiveFailures++
    }
    return {
      id: evalId,
      name: eRows[0].evaluatorName,
      sessions: eRows.length,
      calibratedCount,
      avgDelta,
      consecutiveFailures,
    }
  }).sort((a, b) => b.avgDelta - a.avgDelta)

  const totalSessions = sessionStats.length

  // Sessions Overview pagination. 15 rows a page.
  //
  // The page is clamped rather than stored blindly: changing a filter can shrink the
  // result set, and without this you would land on an empty page with no obvious way
  // back. Clamping keeps the view on the last page that actually has rows.
  const SESSIONS_PER_PAGE = 15
  const sessionPageCount = Math.max(1, Math.ceil(totalSessions / SESSIONS_PER_PAGE))
  const currentSessionPage = Math.min(sessionPage, sessionPageCount)
  const sessionPageStart = (currentSessionPage - 1) * SESSIONS_PER_PAGE
  const pagedSessionStats = sessionStats.slice(sessionPageStart, sessionPageStart + SESSIONS_PER_PAGE)
  const totalEvaluations = filteredRows.length
  const totalCalibrated = filteredRows.filter(r => r.is_calibrated).length
  const overallRate = totalEvaluations > 0 ? Math.round((totalCalibrated / totalEvaluations) * 100) : 0
  const overallAvgDelta = totalEvaluations > 0
    ? filteredRows.reduce((sum, r) => sum + (r.delta || 0), 0) / totalEvaluations
    : 0

  // Week-over-week delta trend, computed from the same filtered rows as everything
  // else on this tab — lets you see if calibration accuracy is improving over time.
  function weekStart(dateStr) {
    const d = new Date(dateStr)
    const day = d.getDay()
    const diff = (day === 0 ? -6 : 1) - day
    d.setDate(d.getDate() + diff)
    d.setHours(0, 0, 0, 0)
    return d.toISOString().split('T')[0]
  }
  const byWeek = {}
  for (const r of filteredRows) {
    if (!r.sessionDate) continue
    ;(byWeek[weekStart(r.sessionDate)] ||= []).push(r)
  }
  const weeklyTrend = Object.entries(byWeek)
    .map(([week, wRows]) => ({
      week,
      avgDelta: wRows.reduce((sum, r) => sum + (r.delta || 0), 0) / wRows.length,
    }))
    .sort((a, b) => new Date(a.week) - new Date(b.week))

  // Exports one row per evaluated submission (not an aggregate), respecting every
  // active filter and — for non-admins — the gauge-only visibility rule from load()
  // above, so a Gauge can hand over their own raw data without needing DB access.
  function exportToCsv() {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const headers = ['Submission Date', 'Session', 'Scorecard', 'Evaluator', 'BPO', 'HUB', 'Market', ...questionLabels, 'Delta', 'Comment']
    const lines = [headers.map(esc).join(',')]
    filteredRows
      .slice()
      .sort((a, b) => new Date(a.submitted_at || 0) - new Date(b.submitted_at || 0))
      .forEach(r => {
        const row = [
          esc(r.submitted_at ? new Date(r.submitted_at).toLocaleString() : ''),
          esc(r.sessionTitle),
          esc(r.scorecardName),
          esc(r.evaluatorName),
          esc(r.bpo || ''),
          esc(r.hub || ''),
          esc(r.market || ''),
          ...questionLabels.map(label => esc(r.answers?.[label] ?? '')),
          (r.delta * 100).toFixed(1) + '%',
          esc(r.comment || ''),
        ]
        lines.push(row.join(','))
      })
    const csv = lines.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `calibration-submissions-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn btn-accent-soft" onClick={exportToCsv}>⬇ Export to Excel</button>
      </div>

      {(bpoOptions.length > 0 || hubOptions.length > 0 || marketOptions.length > 0 || scorecardOptions.length > 0 || sessionOptions.length > 0 || gaugeOptions.length > 0 || evaluatorOptions.length > 0) && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Filter:</span>
          {sessionOptions.length > 0 && (
            <select style={filterSelectStyle} value={filterSession} onChange={e => setFilterSession(e.target.value)}>
              <option value="">All Sessions</option>
              {sessionOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {scorecardOptions.length > 0 && (
            <select style={filterSelectStyle} value={filterScorecard} onChange={e => setFilterScorecard(e.target.value)}>
              <option value="">All Scorecards</option>
              {scorecardOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {gaugeOptions.length > 0 && (
            <select style={filterSelectStyle} value={filterGauge} onChange={e => setFilterGauge(e.target.value)}>
              <option value="">All Gauges</option>
              {gaugeOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {evaluatorOptions.length > 0 && (
            <select style={filterSelectStyle} value={filterEvaluator} onChange={e => setFilterEvaluator(e.target.value)}>
              <option value="">All Evaluators</option>
              {evaluatorOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {bpoOptions.length > 0 && (
            <select style={filterSelectStyle} value={filterBpo} onChange={e => setFilterBpo(e.target.value)}>
              <option value="">All BPOs</option>
              {bpoOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {hubOptions.length > 0 && (
            <select style={filterSelectStyle} value={filterHub} onChange={e => setFilterHub(e.target.value)}>
              <option value="">All HUBs</option>
              {hubOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {marketOptions.length > 0 && (
            <select style={filterSelectStyle} value={filterMarket} onChange={e => setFilterMarket(e.target.value)}>
              <option value="">All Markets</option>
              {marketOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>from</span>
          <input type="date" style={filterSelectStyle} value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} />
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>to</span>
          <input type="date" style={filterSelectStyle} value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} />
          {(filterBpo || filterHub || filterMarket || filterScorecard || filterSession || filterGauge || filterEvaluator || filterDateFrom || filterDateTo) && (
            <button className="btn btn-ghost btn-sm" onClick={() => {
              setFilterBpo(''); setFilterHub(''); setFilterMarket('')
              setFilterScorecard(''); setFilterSession(''); setFilterGauge(''); setFilterEvaluator('')
              setFilterDateFrom(''); setFilterDateTo('')
            }}>
              Clear filters
            </button>
          )}
        </div>
      )}

      {filteredRows.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 36, color: 'var(--text-secondary)', fontSize: 14 }}>
          No results match the selected filters.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <div className="card" style={{ flex: 1, minWidth: 160, textAlign: 'center', padding: '18px 16px' }}>
              <div style={{ fontSize: 26, fontWeight: 700 }}>{totalSessions}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>Sessions</div>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 160, textAlign: 'center', padding: '18px 16px' }}>
              <div style={{ fontSize: 26, fontWeight: 700 }}>{totalEvaluations}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>Evaluations Scored</div>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 160, textAlign: 'center', padding: '18px 16px' }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: overallRate >= 70 ? '#16a34a' : '#dc2626' }}>{overallRate}%</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>Calibration Rate</div>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 160, textAlign: 'center', padding: '18px 16px' }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: overallAvgDelta <= 0.10 ? '#16a34a' : '#dc2626' }}>{(overallAvgDelta * 100).toFixed(1)}%</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>Avg Delta</div>
            </div>
          </div>

          {weeklyTrend.length >= 2 ? (
            <section style={{ marginBottom: 28 }}>
              <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Delta Trend (Week over Week)
              </h2>
              <div className="card" style={{ padding: 16 }}>
                <WeeklyDeltaChart data={weeklyTrend} />
              </div>
            </section>
          ) : weeklyTrend.length === 1 ? (
            <div className="card" style={{ textAlign: 'center', padding: 20, color: 'var(--text-secondary)', fontSize: 13, marginBottom: 28 }}>
              Not enough weeks of data yet for a trend line — check back once results span more than one week.
            </div>
          ) : null}

          <section style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Sessions Overview
            </h2>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={thStyle}>Session</th>
                    <th style={thStyle}>Scorecard</th>
                    <th style={thStyle}>Date</th>
                    <th style={thStyle}>BPO</th>
                    <th style={thStyle}>HUB</th>
                    <th style={thStyle}>Market</th>
                    <th style={thStyle}>Gauge</th>
                    <th style={thStyle}>Overall Delta</th>
                    <th style={thStyle}>Calibration Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedSessionStats.map(s => {
                    const parts = (bySession[s.id] || []).slice().sort((a, b) => (a.delta || 0) - (b.delta || 0))
                    const open = !!expandedSessions[s.id]
                    return (
                    <Fragment key={s.id}>
                    <tr style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => setExpandedSessions(m => ({ ...m, [s.id]: !m[s.id] }))}>
                      <td style={{ ...tdStyle, fontWeight: 500 }}>{open ? '▾' : '▸'} {s.title}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{s.scorecardName}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{s.date ? new Date(s.date).toLocaleDateString() : '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{s.bpo || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{s.hub || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{s.market || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{s.gaugeName}</td>
                      <td style={{ ...tdStyle, color: s.avgDelta <= 0.10 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{(s.avgDelta * 100).toFixed(1)}%</td>
                      <td style={tdStyle}>{s.calibratedCount}/{s.total} ({Math.round((s.calibratedCount / s.total) * 100)}%)</td>
                    </tr>
                    {open && (
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                        <td colSpan={9} style={{ padding: '4px 16px 14px 34px' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr style={{ color: 'var(--text-secondary)' }}>
                                <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Participant</th>
                                <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Delta</th>
                                <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Result</th>
                                <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Comment</th>
                              </tr>
                            </thead>
                            <tbody>
                              {parts.map(p => (
                                <tr key={p.id}>
                                  <td style={{ padding: '6px 10px' }}>{p.evaluatorName}</td>
                                  <td style={{ padding: '6px 10px', color: (p.delta || 0) <= 0.10 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{((p.delta || 0) * 100).toFixed(1)}%</td>
                                  <td style={{ padding: '6px 10px' }}>{p.is_calibrated ? 'Calibrated' : 'Not calibrated'}</td>
                                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{p.comment || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                    )
                  })}
                </tbody>
              </table>
              {sessionPageCount > 1 && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 12, padding: '10px 16px', borderTop: '1px solid var(--border)',
                  flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    Showing {sessionPageStart + 1}–{Math.min(sessionPageStart + SESSIONS_PER_PAGE, totalSessions)} of {totalSessions} sessions
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => setSessionPage(p => Math.max(1, p - 1))}
                      disabled={currentSessionPage <= 1}
                      style={{ opacity: currentSessionPage <= 1 ? 0.45 : 1, cursor: currentSessionPage <= 1 ? 'default' : 'pointer' }}>
                      ← Previous
                    </button>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 92, textAlign: 'center' }}>
                      Page {currentSessionPage} of {sessionPageCount}
                    </span>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => setSessionPage(p => Math.min(sessionPageCount, p + 1))}
                      disabled={currentSessionPage >= sessionPageCount}
                      style={{ opacity: currentSessionPage >= sessionPageCount ? 0.45 : 1, cursor: currentSessionPage >= sessionPageCount ? 'default' : 'pointer' }}>
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section>
            <h2 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Evaluator Performance
            </h2>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={thStyle}>Evaluator</th>
                    <th style={thStyle}>Sessions</th>
                    <th style={thStyle}>Calibration Rate</th>
                    <th style={thStyle}>Avg Delta</th>
                    <th style={thStyle}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluatorStats.map(e => (
                    <tr key={e.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ ...tdStyle, fontWeight: 500 }}>{e.name}</td>
                      <td style={tdStyle}>{e.sessions}</td>
                      <td style={tdStyle}>{e.calibratedCount}/{e.sessions} ({Math.round((e.calibratedCount / e.sessions) * 100)}%)</td>
                      <td style={{ ...tdStyle, color: e.avgDelta <= 0.10 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{(e.avgDelta * 100).toFixed(1)}%</td>
                      <td style={tdStyle}>
                        {e.consecutiveFailures >= 3 ? (
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#dc2626', background: 'rgba(220,38,38,0.1)', padding: '2px 8px', borderRadius: 10 }}>
                            Needs attention
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#16a34a', background: 'rgba(22,163,74,0.1)', padding: '2px 8px', borderRadius: 10 }}>
                            On track
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ── Root shell ────────────────────────────────────────────────────────────────

export default function Calibration() {
  const { profile } = useAuth()
  const isAdmin = ['admin', 'owner'].includes(profile?.role)
  const isKgUser = profile?.email?.endsWith('@kaizengaming.com')
  const canManage = isAdmin || isKgUser
  // Insights is broader than canManage: any Evaluator (Kaizen Gaming or BPO) can see it
  // too, scoped inside CalibrationInsights to only the sessions they were actually part
  // of (as Gauge or participant) — Admin/Owner and KG evaluators keep their existing,
  // wider visibility there. Team Leaders and Agents still see nothing on this page.
  const canSeeInsights = canManage || profile?.role === 'evaluator'
  const [tab, setTab]                = useState('sessions')
  const [scoringSession, setScoring] = useState(null)
  const [refreshKey, setRefreshKey]  = useState(0)

  const tabs = [
    ['sessions', 'My Sessions'],
    ...(canManage ? [['admin', 'Manage Sessions']] : []),
    ...(canSeeInsights ? [['insights', 'Insights']] : []),
  ]

  return (
    <div className="page">
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h1>Calibration</h1>
        </div>
      </div>

      {(canManage || canSeeInsights) && (
        // Shared pill tabs from index.css, so every page's tab bar looks the same.
        <div className="tabs">
          {tabs.map(([key, label]) => (
            <button key={key} className={`tab ${tab === key ? 'active' : ''}`}
              onClick={() => { setTab(key); setScoring(null) }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'sessions' && (
        scoringSession
          ? <CalibrationSubmit
              session={scoringSession}
              onBack={() => setScoring(null)}
              onSubmitted={() => { setScoring(null); setRefreshKey(k => k + 1) }}
            />
          : <CalibrationHome key={refreshKey} onScore={s => setScoring(s)} />
      )}
      {tab === 'admin' && canManage && <CalibrationAdmin />}
      {tab === 'insights' && canSeeInsights && <CalibrationInsights />}
    </div>
  )
}