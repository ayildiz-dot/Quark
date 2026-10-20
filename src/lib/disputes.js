// Shared dispute vocabulary. Lives here so the Evaluations page (dispute modal, badges)
// and the Disputes page (list, filters, export) always label a status the same way.

export const DISPUTE_STATUS = {
  tl_pending:         { label: 'Awaiting Team Leader', color: '#f59e0b' },
  evaluator_pending:  { label: 'Awaiting evaluator', color: '#f59e0b' },
  tl_reconsider:      { label: 'Awaiting Team Leader', color: '#f59e0b' },
  nudged:             { label: 'Awaiting evaluator (nudged)', color: '#f59e0b' },
  admin_pending:      { label: 'Awaiting admin', color: '#f59e0b' },
  evaluator_rejected: { label: 'Rejected by evaluator', color: '#ef4444' },
  tl_rejected:        { label: 'Rejected by Team Leader', color: '#ef4444' },
  upheld:             { label: 'Upheld', color: '#22c55e' },
  accepted:           { label: 'Closed', color: '#64748b' },
  cancelled:          { label: 'Cancelled', color: '#64748b' },
  bpo_review_pending: { label: 'Awaiting BPO review', color: '#f59e0b' },
  post_nudge_pending: { label: 'Awaiting mediator', color: '#f59e0b' },
  bpo_final_pending:  { label: 'Awaiting BPO final review', color: '#f59e0b' },
  rejected_final:     { label: 'Rejected (final)', color: '#ef4444' },
}

// Statuses where nothing further can happen. Used to count what is still pending.
export const DISPUTE_TERMINAL = ['tl_rejected', 'upheld', 'cancelled', 'accepted', 'rejected_final']