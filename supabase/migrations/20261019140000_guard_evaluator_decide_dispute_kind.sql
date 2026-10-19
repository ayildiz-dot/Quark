-- Stop the agent-dispute decision function from acting on criticality disputes.
--
-- Criticality disputes (disputes.kind = 'criticality') share status names with agent
-- disputes ('evaluator_pending', 'evaluator_rejected', 'admin_pending'), and the
-- "/evaluations?dispute=" notification link opens any dispute in the agent dispute modal.
-- That modal calls evaluator_decide_dispute, which had no kind check: upholding through it
-- closed the dispute as 'upheld' without removing the marking and without clearing
-- critical_cases.sla_paused_at, leaving the 24h clock frozen permanently.
--
-- Criticality disputes are decided by criticality_marker_decide (Coaching Queue).
--
-- Change: one guard added after the "Dispute not found" check. The rest of the body is the
-- live definition exactly as returned by pg_get_functiondef on 2026-10-19. Agent disputes
-- (kind NULL) and spot-check disputes (kind 'dsat_spotcheck') are unaffected.
--
-- Additive and re-runnable (CREATE OR REPLACE, same signature).

CREATE OR REPLACE FUNCTION public.evaluator_decide_dispute(p_dispute_id uuid, p_approve boolean, p_comment text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d disputes; ev evaluations; v_med uuid;
begin
  if p_comment is null or length(trim(p_comment))=0 then raise exception 'A comment is required'; end if;
  select * into d from disputes where id=p_dispute_id;
  if d.id is null then raise exception 'Dispute not found'; end if;
  if coalesce(d.kind,'') = 'criticality' then
    raise exception 'This is a criticality dispute. Decide it from the case in the Coaching Queue.';
  end if;
  if d.status not in ('evaluator_pending','nudged') then raise exception 'This dispute is not awaiting the evaluator'; end if;
  if not (auth.uid()=d.evaluator_id or exists(select 1 from users where id=auth.uid() and role in ('owner','admin'))) then
    raise exception 'Only the evaluator can decide this dispute'; end if;
  v_med := case when d.kind='dsat_spotcheck' then d.agent_id else d.tl_id end;
  select * into ev from evaluations where id=d.evaluation_id;
  if p_approve then
    update disputes set status='upheld', outcome='upheld', resolved_at=now(), deadline_at=null, updated_at=now() where id=p_dispute_id;
    insert into dispute_events(dispute_id, actor_id, actor_role, action, comment) values (p_dispute_id, auth.uid(), 'evaluator', 'evaluator_approved', p_comment);
    perform _disp_notify(v_med, 'dispute_update', 'Dispute upheld', 'The evaluator upheld the dispute on evaluation #'||coalesce(ev.eval_id::text,ev.id::text)||'.', p_dispute_id, false);
    if d.agent_id is distinct from v_med then perform _disp_notify(d.agent_id, 'dispute_update', 'Dispute upheld', 'Your dispute on evaluation #'||coalesce(ev.eval_id::text,ev.id::text)||' was upheld.', p_dispute_id, false); end if;
  else
    update disputes set status='evaluator_rejected', deadline_at=now()+interval '48 hours', updated_at=now() where id=p_dispute_id;
    insert into dispute_events(dispute_id, actor_id, actor_role, action, comment) values (p_dispute_id, auth.uid(), 'evaluator', 'evaluator_rejected', p_comment);
    perform _disp_notify(v_med, 'dispute_request', 'Dispute rejected by evaluator', 'The evaluator rejected the dispute on evaluation #'||coalesce(ev.eval_id::text,ev.id::text)||' — review to re-dispute, accept, or escalate.', p_dispute_id, true);
    if d.agent_id is distinct from v_med then perform _disp_notify(d.agent_id, 'dispute_update', 'Dispute rejected by evaluator', 'The dispute on evaluation #'||coalesce(ev.eval_id::text,ev.id::text)||' was rejected.', p_dispute_id, false); end if;
  end if;
end $function$;

notify pgrst, 'reload schema';

-- Verification (run separately; expect guarded = true):
-- select pg_get_functiondef(p.oid) like '%criticality dispute. Decide it from the case%' as guarded
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'evaluator_decide_dispute';