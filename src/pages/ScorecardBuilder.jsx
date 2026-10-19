import React, { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../App'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  DragOverlay, useDroppable
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, verticalListSortingStrategy, useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// Agent dispute window (hours). Required on every scorecard: a whole number from 1 to 8760.
// Mirrors the scorecards_dispute_window_hours_check constraint in the database, so a bad
// value is caught here with a readable message instead of a raw constraint error.
// Returns the number when valid, otherwise null.
const parseDisputeHours = (v) => {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 8760) return null
  return n
}

export default function ScorecardBuilder() {
  const { id } = useParams()
  const { profile, unsavedChanges, setUnsavedChanges, setShowNavModal, setPendingNavPath, safeNavigate } = useAuth()
  const navigate = useNavigate()

  const [tab, setTab] = useState('settings')
  const [scorecard, setScorecard] = useState(null)
  // Display-only: the name of the scorecard this one spot-checks. Resolved from
  // spot_check_source_scorecard_id so the relationship is visible without SQL.
  const [spotParentName, setSpotParentName] = useState('')
  const [metadata, setMetadata] = useState([])
  const [groups, setGroups] = useState([])
  const [questions, setQuestions] = useState([])
  const [sections, setSections] = useState([])
  const [dsatQuestions, setDsatQuestions] = useState([])
  const [dsatOptions, setDsatOptions] = useState([])
  const [msg, setMsg] = useState(null)
  const [showVersionModal, setShowVersionModal] = useState(false)
  const [versionReason, setVersionReason] = useState('')
  const [pendingSave, setPendingSave] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activeQuestion, setActiveQuestion] = useState(null)
  const [division, setDivision] = useState('')
  const [divisions, setDivisions] = useState([])

  const sensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: { distance: 5 }
  }))

  const leavingRef = React.useRef(false)
  const skipSaveRef = React.useRef(false)

  const markChanged = () => setUnsavedChanges(true)
  const clearChanged = () => setUnsavedChanges(false)

  const logHistory = async (changeType, reason = null, versionNum = null) => {
    try {
      const { error: hErr } = await supabase.from('scorecard_history').insert({
        scorecard_id: id,
        changed_by: profile.id,
        change_type: changeType,
        changed_at: new Date().toISOString(),
        version_reason: reason,
        version_number: versionNum,
        snapshot: {
          scorecard: {
            name: scorecard.name, description: scorecard.description, is_published: scorecard.is_published,
            dispute_window_hours: scorecard.dispute_window_hours
          },
          questions: questions.map(q => ({
            title: q.title, weight: q.weight, description: q.description,
            is_form_critical: q.is_form_critical, allow_na: q.allow_na
          }))
        }
      })
      if (hErr) console.error('scorecard_history insert failed:', hErr.message)
    } catch (e) {
      console.warn('History log failed:', e.message)
    }
  }

  

  useEffect(() => {
    leavingRef.current = false
    skipSaveRef.current = false
    return () => {
      leavingRef.current = true
      skipSaveRef.current = true
      setUnsavedChanges(false)
    }
  }, [])

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (unsavedChanges) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [unsavedChanges])




  useEffect(() => {
    if (!unsavedChanges) return
    window.history.pushState(null, '', window.location.href)
    const handlePopState = () => {
      window.history.pushState(null, '', window.location.href)
      setPendingNavPath(-1)
      setShowNavModal(true)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [unsavedChanges])
  useEffect(() => { loadAll() }, [id])

  const loadAll = async () => {
    const [sc, meta, grp, qs] = await Promise.all([
      supabase.from('scorecards').select('*').eq('id', id).single(),
      supabase.from('scorecard_metadata_fields').select('*').eq('scorecard_id', id).order('position'),
      supabase.from('scorecard_question_groups').select('*').eq('scorecard_id', id).order('position'),
      supabase.from('scorecard_questions').select('*').eq('scorecard_id', id).eq('is_archived', false).order('position'),
    ])
    // A failed scorecard read leaves the builder blank with no explanation, so it is
    // called out rather than swallowed. The child reads are logged individually: losing
    // just the questions, say, would otherwise look like an empty scorecard.
    if (sc.error) {
      console.error('scorecard failed to load:', sc.error.message)
      flash('Could not load this scorecard: ' + sc.error.message, false)
      return
    }
    ;[['metadata fields', meta], ['question groups', grp], ['questions', qs]].forEach(([what, r]) => {
      if (r.error) {
        console.error(`${what} failed to load:`, r.error.message)
        flash(`Some of this scorecard could not be loaded (${what}). Do not save until it loads correctly.`, false)
      }
    })

    setScorecard(sc.data)
    setDivision(sc.data?.division || '')
    // Resolve the parent's name for the read-only Spot-check field in Settings.
    if (sc.data?.spot_check_source_scorecard_id) {
      const { data: parent } = await supabase
        .from('scorecards').select('name').eq('id', sc.data.spot_check_source_scorecard_id).maybeSingle()
      setSpotParentName(parent?.name || '')
    } else {
      setSpotParentName('')
    }
    const { data: divData, error: divErr } = await supabase.from('divisions').select('*').order('position')
    if (divErr) console.error('divisions failed to load — the Division picker will be empty:', divErr.message)
    setDivisions(divData || [])
    setMetadata(meta.data || [])
    setGroups(grp.data || [])
    setQuestions(qs.data || [])

    if (sc.data?.type === 'dsat') {
      const [secs, dqs, opts] = await Promise.all([
        supabase.from('dsat_sections').select('*').eq('scorecard_id', id).order('position'),
        supabase.from('dsat_questions').select('*').eq('scorecard_id', id).order('position'),
        supabase.from('dsat_options').select('*').order('position'),
      ])
      ;[['sections', secs], ['DSAT questions', dqs], ['options', opts]].forEach(([what, r]) => {
        if (r.error) {
          console.error(`${what} failed to load:`, r.error.message)
          flash(`Some of this scorecard could not be loaded (${what}). Do not save until it loads correctly.`, false)
        }
      })
      setSections(secs.data || [])
      setDsatQuestions(dqs.data || [])
      setDsatOptions(opts.data || [])
    }
    setLoading(false)
  }

  const flash = (text, ok = true) => {
    setMsg({ text, ok })
    if (ok) setTimeout(() => setMsg(null), 3000)
  }

  const isPublishedRef = React.useRef(false)
  if (scorecard?.is_published !== undefined) {
    isPublishedRef.current = scorecard.is_published
  }
  const isPublished = isPublishedRef.current


  const checkTotalWeight = () => {
    if (scorecard?.type !== 'quality') return true
    const total = questions.reduce((sum, q) => sum + (q.weight || 1), 0)
    if (total > 100) {
      return confirm(`The total weight of all questions is ${total}, which exceeds 100. Scores will still calculate correctly as a percentage but may not reflect your intended scoring. Are you sure you want to continue?`)
    }
    if (total < 100) {
      return confirm(`The total weight of all questions is ${total}, which is below 100. Scores will still calculate correctly as a percentage but may not reflect your intended scoring. Are you sure you want to continue?`)
    }
    return true
  }

  // Spot-check scorecards never show the field (agents never see those evaluations), so
  // they are not blocked here; their stored value is simply carried through unchanged.
  const checkDisputeWindow = () => {
    if (scorecard?.is_spot_check) return true
    if (parseDisputeHours(scorecard?.dispute_window_hours) === null) {
      flash('Agent dispute window must be a whole number of hours between 1 and 8760.', false)
      return false
    }
    return true
  }

  const saveAllChanges = async () => {
    if (leavingRef.current || skipSaveRef.current) return
    if (!division) return flash('Please select a division before saving. Every scorecard must belong to a division.', false)
    if (!checkDisputeWindow()) return
    if (!checkTotalWeight()) return
    // Show version reason modal — actual save runs in executeVersionSave
    setVersionReason('')
    setShowVersionModal(true)
  }

  const executeVersionSave = async (reason) => {
    if (leavingRef.current || skipSaveRef.current) return

    // A version save is a SEQUENCE of separate statements, not one transaction, so a
    // partial failure is genuinely possible. Supabase returns errors in the result object
    // rather than throwing, which means the try/catch below never saw them — every write
    // reported success regardless. Each one now goes through `wr`, which collects failures.
    // If anything failed we say exactly what, and deliberately do NOT clear the unsaved-
    // changes state, bump the version or log history — none of which would be true.
    const failures = []
    const wr = async (label, q) => {
      const { data, error } = await q
      if (error) {
        failures.push(`${label} — ${error.message}`)
        console.error('scorecard save failed:', label, error)
        return null
      }
      return data
    }

    try {
      await wr('scorecard settings', supabase.from('scorecards').update({
        name: scorecard.name,
        description: scorecard.description,
        pass_threshold: scorecard.type === 'quality' ? (Number(scorecard.pass_threshold) || 90) : null,
        division: division,
        is_calibration: scorecard.is_calibration || false,
        ai_dsat_enabled: scorecard.ai_dsat_enabled || false,
        ai_dsat_prompt: scorecard.ai_dsat_prompt || null,
        dispute_window_hours: parseDisputeHours(scorecard.dispute_window_hours) ?? 72,
        updated_at: new Date().toISOString()
      }).eq('id', id))

      // Groups — insert new, update existing
      const groupIdMap = {}
      for (const g of groups) {
        if (g._isNew) {
          const data = await wr(`group "${g.name}"`, supabase.from('scorecard_question_groups').insert({
            scorecard_id: id, name: g.name, position: g.position
          }).select().single())
          if (data) groupIdMap[g.id] = data.id
        } else {
          await wr(`group "${g.name}"`, supabase.from('scorecard_question_groups')
            .update({ name: g.name }).eq('id', g.id))
        }
      }

      // Questions — insert new (resolving temp group IDs), update existing
      for (const [i, q] of questions.entries()) {
        const realGroupId = groupIdMap[q.group_id] || q.group_id
        if (q._isNew) {
          await wr(`question "${q.title}"`, supabase.from('scorecard_questions').insert({
            scorecard_id: id, group_id: realGroupId, title: q.title,
            description: q.description, weight: q.weight, is_weighted: q.is_weighted,
            is_form_critical: q.is_form_critical, is_group_critical: q.is_group_critical,
            allow_na: q.allow_na, is_ai_attribute: q.is_ai_attribute || false,
            ai_prompt: q.ai_prompt || null, position: i + 1
          }))
        } else {
          await wr(`question "${q.title}"`, supabase.from('scorecard_questions').update({
            title: q.title, description: q.description,
            weight: q.weight, is_weighted: q.is_weighted,
            is_form_critical: q.is_form_critical,
            is_group_critical: q.is_group_critical,
            allow_na: q.allow_na,
            is_ai_attribute: q.is_ai_attribute || false,
            ai_prompt: q.ai_prompt || null,
            group_id: realGroupId, position: i + 1
          }).eq('id', q.id))
        }
      }

      // Metadata — insert new, update existing
      for (const f of metadata) {
        if (f._isNew) {
          await wr(`metadata field "${f.label}"`, supabase.from('scorecard_metadata_fields').insert({
            scorecard_id: id, label: f.label, field_type: f.field_type,
            is_required: f.is_required, options: f.options, position: f.position,
            source: f.source || 'custom'
          }))
        } else {
          await wr(`metadata field "${f.label}"`, supabase.from('scorecard_metadata_fields').update({
            label: f.label, field_type: f.field_type,
            is_required: f.is_required, options: f.options,
            source: f.source || 'custom', position: f.position
          }).eq('id', f.id))
        }
      }

      if (scorecard.type === 'dsat') {
        // Save sections — insert new, update existing
        const sectionIdMap = {}
        for (const s of sections) {
          if (s._isNew) {
            const data = await wr(`section "${s.title}"`, supabase.from('dsat_sections').insert({
              scorecard_id: id, title: s.title, description: s.description, position: s.position
            }).select().single())
            if (data) sectionIdMap[s.id] = data.id
          } else {
            await wr(`section "${s.title}"`, supabase.from('dsat_sections')
              .update({ title: s.title, description: s.description }).eq('id', s.id))
          }
        }
        // Save questions — insert new (resolving temp section IDs), update existing
        const questionIdMap = {}
        for (const q of dsatQuestions) {
          const realSectionId = sectionIdMap[q.section_id] || q.section_id
          if (q._isNew) {
            const data = await wr(`DSAT question "${q.title}"`, supabase.from('dsat_questions').insert({
              scorecard_id: id, section_id: realSectionId, title: q.title,
              description: q.description, is_required: q.is_required,
              question_type: q.question_type || 'options', position: q.position
            }).select().single())
            if (data) questionIdMap[q.id] = data.id
          } else {
            await wr(`DSAT question "${q.title}"`, supabase.from('dsat_questions').update({
              title: q.title, description: q.description, is_required: q.is_required,
              question_type: q.question_type || 'options'
            }).eq('id', q.id))
          }
        }
        // Save options — insert new, update existing.
        //
        // BOTH foreign keys have to be resolved through the maps built above, not just
        // question_id. An option can jump to a section that was created in this same save
        // and therefore still carries a client-side temp id ("temp_1786367229346") rather
        // than a UUID. Sending that straight to Postgres produced:
        //   invalid input syntax for type uuid: "temp_..."
        // and failed every option pointing at a new section — on the update branch too,
        // which is why re-routing an EXISTING option to a NEW section failed as well.
        const resolveJump = (jumpId) => {
          if (!jumpId) return null
          return sectionIdMap[jumpId] || jumpId
        }
        const optionIdMap = {}
        for (const o of dsatOptions) {
          const realQuestionId = questionIdMap[o.question_id] || o.question_id
          if (o._isNew) {
            const data = await wr(`option "${o.label}"`, supabase.from('dsat_options').insert({
              question_id: realQuestionId, label: o.label,
              jump_to_section_id: resolveJump(o.jump_to_section_id), position: o.position
            }).select().single())
            if (data) optionIdMap[o.id] = data.id
          } else {
            await wr(`option "${o.label}"`, supabase.from('dsat_options').update({
              label: o.label, jump_to_section_id: resolveJump(o.jump_to_section_id)
            }).eq('id', o.id))
          }
        }

        // ---- Sync the rows that DID write back into local state ----
        //
        // Without this, a partial failure left successfully-inserted sections and questions
        // still flagged _isNew, so pressing Save again inserted a SECOND copy of each. The
        // retry was more destructive than the original failure.
        //
        // Rewriting temp ids to the real ones here makes a retry idempotent: whatever
        // already landed is treated as existing, and only the genuinely failed rows are
        // attempted again.
        if (Object.keys(sectionIdMap).length) {
          setSections(prev => prev.map(sec =>
            sectionIdMap[sec.id] ? { ...sec, id: sectionIdMap[sec.id], _isNew: false } : sec))
        }
        if (Object.keys(sectionIdMap).length || Object.keys(questionIdMap).length) {
          setDsatQuestions(prev => prev.map(q => {
            const next = { ...q }
            if (sectionIdMap[q.section_id]) next.section_id = sectionIdMap[q.section_id]
            if (questionIdMap[q.id]) { next.id = questionIdMap[q.id]; next._isNew = false }
            return next
          }))
        }
        setDsatOptions(prev => prev.map(o => {
          const next = { ...o }
          if (questionIdMap[o.question_id]) next.question_id = questionIdMap[o.question_id]
          if (o.jump_to_section_id && sectionIdMap[o.jump_to_section_id]) {
            next.jump_to_section_id = sectionIdMap[o.jump_to_section_id]
          }
          if (optionIdMap[o.id]) { next.id = optionIdMap[o.id]; next._isNew = false }
          return next
        }))
      }

      // Anything failed? Then this is NOT a saved version. Keep the unsaved-changes state
      // so the user can retry without losing work, and skip the version bump and the
      // history row — recording a version that never fully wrote would be worse than the
      // failure itself.
      if (failures.length) {
        console.error('scorecard save: ' + failures.length + ' write(s) failed', failures)
        flash(
          `Not saved — ${failures.length} item${failures.length === 1 ? '' : 's'} failed. ` +
          `First: ${failures[0]}. Your changes are still here; fix the cause and save again.`,
          false)
        return
      }

      clearChanged()
      // Get current version number from latest history entry
      const { data: latestHistory, error: histErr } = await supabase
        .from('scorecard_history')
        .select('version_number')
        .eq('scorecard_id', id)
        .order('changed_at', { ascending: false })
        .limit(1)
        .single()
      // A missing history row is normal on a first save; only log a real failure.
      if (histErr && histErr.code !== 'PGRST116') console.error('version lookup failed:', histErr.message)
      const nextVersion = ((latestHistory?.version_number) || 1) + 1
      // Update the version column on the scorecard row
      const { error: verErr } = await supabase.from('scorecards').update({ version: nextVersion }).eq('id', id)
      if (verErr) {
        console.error('version bump failed:', verErr.message)
        return flash('Changes saved, but the version number could not be updated: ' + verErr.message, false)
      }
      setScorecard(s => ({ ...s, version: nextVersion }))
      await logHistory('save', reason, nextVersion)
      flash('All changes saved ✓')
    } catch (err) {
      flash('Failed to save: ' + err.message, false)
    }
  }

  const togglePublish = async () => {
    if (!scorecard.is_published && !checkTotalWeight()) return
    const newVal = !scorecard.is_published
    const { error } = await supabase.from('scorecards').update({ is_published: newVal }).eq('id', id)
    if (error) return flash(error.message, false)
    setScorecard(s => ({ ...s, is_published: newVal }))
    await logHistory(newVal ? 'publish' : 'unpublish')
  flash(newVal ? 'Scorecard published' : 'Scorecard unpublished')
  }

  const [fieldTemplates, setFieldTemplates] = useState([])
  useEffect(() => {
    supabase.from('metadata_field_templates').select('*').eq('is_active', true).order('position')
      .then(({ data, error }) => {
        if (error) console.error('field library failed to load:', error.message)
        setFieldTemplates(data || [])
      })
  }, [])

  const addFromLibrary = async (tplId) => {
    const tpl = fieldTemplates.find(t => t.id === tplId)
    if (!tpl) return
    if (metadata.length >= 10) return flash('Maximum 10 metadata fields allowed.', false)
    const base = { scorecard_id: id, label: tpl.label, field_type: tpl.field_type, is_required: tpl.is_required, options: tpl.options || [], source: tpl.source || 'custom', position: metadata.length + 1 }
    if (isPublished) {
      const tempId = 'temp_m_' + Date.now()
      setMetadata(m => [...m, { id: tempId, ...base, _isNew: true }]); markChanged()
    } else {
      const { data, error } = await supabase.from('scorecard_metadata_fields').insert(base).select().single()
      if (error) return flash(error.message, false)
      setMetadata(m => [...m, data])
    }
  }

  const addMetaField = async () => {
    if (metadata.length >= 10) return flash('Maximum 10 metadata fields allowed.', false)
    if (isPublished) {
      const tempId = 'temp_m_' + Date.now()
      setMetadata(m => [...m, { id: tempId, scorecard_id: id, label: 'New Field', field_type: 'text', is_required: true, position: m.length + 1, source: 'custom', _isNew: true }])
      markChanged()
    } else {
      const { data, error } = await supabase.from('scorecard_metadata_fields').insert({
        scorecard_id: id, label: 'New Field', field_type: 'text',
        is_required: true, position: metadata.length + 1
      }).select().single()
      if (error) return flash(error.message, false)
      setMetadata(m => [...m, data])
    }
  }

  const updateMetaField = async (fieldId, updates) => {
    if (leavingRef.current) return
    setMetadata(m => m.map(f => f.id === fieldId ? { ...f, ...updates } : f))
    // Draft autosave. Console-only: this fires on ordinary edits, so a flash would be
    // constant noise — but a silent failure here means the draft quietly diverges from
    // what is on screen, so it must not be invisible.
    if (!isPublished) {
      const { error } = await supabase.from('scorecard_metadata_fields').update(updates).eq('id', fieldId)
      if (error) console.error('draft autosave failed (metadata field):', error.message)
    }
    else markChanged()
  }

  const deleteMetaField = async (fieldId) => {
    const field = metadata.find(f => f.id === fieldId)
    // A field added but not yet saved exists only locally (temp id) — never hit the DB.
    if (field?._isNew || String(fieldId).startsWith('temp_')) {
      setMetadata(m => m.filter(f => f.id !== fieldId))
      if (isPublished) markChanged()
      return
    }
    const { error } = await supabase.from('scorecard_metadata_fields').delete().eq('id', fieldId)
    if (error) return flash('Failed to delete field: ' + error.message, false)
    setMetadata(m => m.filter(f => f.id !== fieldId))
    if (isPublished) markChanged()
  }

  const handleMetaDragEnd = async (event) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = metadata.findIndex(f => f.id === active.id)
    const newIndex = metadata.findIndex(f => f.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(metadata, oldIndex, newIndex).map((f, i) => ({ ...f, position: i + 1 }))
    setMetadata(reordered)
    if (isPublished) { markChanged(); return }
    for (const f of reordered) {
      if (!String(f.id).startsWith('temp_')) {
        const { error } = await supabase.from('scorecard_metadata_fields').update({ position: f.position }).eq('id', f.id)
        if (error) console.error('field reorder failed:', error.message)
      }
    }
  }

  const addGroup = async () => {
    if (isPublished) {
      const tempId = 'temp_g_' + Date.now()
      setGroups(g => [...g, { id: tempId, scorecard_id: id, name: 'New Group', position: g.length + 1, _isNew: true }])
      markChanged()
    } else {
      const { data, error } = await supabase.from('scorecard_question_groups').insert({
        scorecard_id: id, name: 'New Group', position: groups.length + 1
      }).select().single()
      if (error) return flash(error.message, false)
      setGroups(g => [...g, data])
    }
  }

  const updateGroup = async (groupId, updates) => {
    if (leavingRef.current) return
    setGroups(g => g.map(gr => gr.id === groupId ? { ...gr, ...updates } : gr))
    // Draft autosave. Console-only: this fires on ordinary edits, so a flash would be
    // constant noise — but a silent failure here means the draft quietly diverges from
    // what is on screen, so it must not be invisible.
    if (!isPublished) {
      const { error } = await supabase.from('scorecard_question_groups').update(updates).eq('id', groupId)
      if (error) console.error('draft autosave failed (group):', error.message)
    }
    else markChanged()
  }

  const deleteGroup = async (groupId) => {
    if (!confirm('Delete this group? Questions inside will become ungrouped.')) return
    const { error: ungroupErr } = await supabase.from('scorecard_questions').update({ group_id: null }).eq('group_id', groupId)
    if (ungroupErr) return flash('Failed to ungroup questions: ' + ungroupErr.message, false)
    const { error } = await supabase.from('scorecard_question_groups').delete().eq('id', groupId)
    if (error) return flash('Failed to delete group: ' + error.message, false)
    setGroups(g => g.filter(gr => gr.id !== groupId))
    setQuestions(q => q.map(qs => qs.group_id === groupId ? { ...qs, group_id: null } : qs))
    if (isPublished) markChanged()
  }

  const addQuestion = async (groupId = null) => {
    if (isPublished) {
      const tempId = 'temp_q_' + Date.now()
      setQuestions(q => [...q, { id: tempId, scorecard_id: id, group_id: groupId, title: 'New Question', weight: 1, is_weighted: true, is_form_critical: false, is_group_critical: false, allow_na: true, position: q.length + 1, _isNew: true }])
      markChanged()
    } else {
      const { data, error } = await supabase.from('scorecard_questions').insert({
        scorecard_id: id, group_id: groupId, title: 'New Question',
        weight: 1, is_weighted: true, is_form_critical: false,
        is_group_critical: false, allow_na: true, position: questions.length + 1
      }).select().single()
      if (error) return flash(error.message, false)
      setQuestions(q => [...q, data])
    }
  }

  const updateQuestion = async (qId, updates) => {
    if (leavingRef.current) return
    setQuestions(q => q.map(qs => qs.id === qId ? { ...qs, ...updates } : qs))
    // Draft autosave. Console-only: this fires on ordinary edits, so a flash would be
    // constant noise — but a silent failure here means the draft quietly diverges from
    // what is on screen, so it must not be invisible.
    if (!isPublished) {
      const { error } = await supabase.from('scorecard_questions').update(updates).eq('id', qId)
      if (error) console.error('draft autosave failed (question):', error.message)
    }
    else markChanged()
  }

  const deleteQuestion = async (qId) => {
    if (!confirm('Delete this question?')) return
    const { error } = await supabase.from('scorecard_questions').delete().eq('id', qId)
    if (error) {
      if (error.code === '23503') {
        const { error: archiveErr } = await supabase.from('scorecard_questions').update({ is_archived: true }).eq('id', qId)
        if (archiveErr) return flash('Failed to remove question: ' + archiveErr.message, false)
        setQuestions(q => q.filter(qs => qs.id !== qId))
        if (isPublished) markChanged()
        return flash('This question has past evaluation history, so it was archived instead of deleted. It will no longer appear in new evaluations.')
      }
      return flash('Failed to delete question: ' + error.message, false)
    }
    setQuestions(q => q.filter(qs => qs.id !== qId))
    if (isPublished) markChanged()
  }

  const handleDragStart = (event) => {
    const q = questions.find(q => q.id === event.active.id)
    setActiveQuestion(q)
  }

  const handleDragEnd = async (event) => {
    const { active, over } = event
    setActiveQuestion(null)
    if (!over) return
    const activeQ = questions.find(q => q.id === active.id)
    if (!activeQ) return

    let newGroupId = activeQ.group_id
    if (over.id.startsWith('group-')) newGroupId = over.id.replace('group-', '')
    else if (over.id === 'ungrouped') newGroupId = null
    else {
      const overQ = questions.find(q => q.id === over.id)
      if (overQ) newGroupId = overQ.group_id
    }

    let reordered = questions.map(q =>
      q.id === active.id ? { ...q, group_id: newGroupId } : q
    )
    const oldIndex = reordered.findIndex(q => q.id === active.id)
    const newIndex = over.id === active.id ? oldIndex : reordered.findIndex(q => q.id === over.id)
    if (newIndex !== -1 && oldIndex !== newIndex) reordered = arrayMove(reordered, oldIndex, newIndex)

    setQuestions(reordered)

    if (!isPublished) {
      const results = await Promise.all(reordered.map((q, i) =>
        supabase.from('scorecard_questions').update({ position: i + 1, group_id: q.group_id }).eq('id', q.id)
      ))
      const failed = results.filter(r => r.error)
      if (failed.length) {
        console.error('question reorder failed:', failed.map(r => r.error.message))
        flash(`Reorder not saved (${failed.length} of ${results.length} failed). Refresh to see the true order.`, false)
      }
    } else {
      markChanged()
    }
  }

  const addSection = async () => {
    if (isPublished) {
      const tempId = 'temp_' + Date.now()
      setSections(s => [...s, { id: tempId, scorecard_id: id, title: 'New Section', position: s.length + 1, _isNew: true }])
      markChanged()
    } else {
      const { data, error } = await supabase.from('dsat_sections').insert({
        scorecard_id: id, title: 'New Section', position: sections.length + 1
      }).select().single()
      if (error) return flash(error.message, false)
      setSections(s => [...s, data])
    }
  }

  const addCommentSection = async () => {
    if (isPublished) {
      const tempSectionId = 'temp_' + Date.now()
      const tempQuestionId = 'temp_q_' + Date.now()
      setSections(s => [...s, { id: tempSectionId, scorecard_id: id, title: 'Comments', position: s.length + 1, _isNew: true }])
      setDsatQuestions(q => [...q, { id: tempQuestionId, scorecard_id: id, section_id: tempSectionId, title: 'Comments', is_required: false, question_type: 'free_text', position: 1, _isNew: true }])
      markChanged()
      flash('Comment section added ✓')
    } else {
      const { data: sectionData, error: sectionError } = await supabase.from('dsat_sections').insert({
        scorecard_id: id, title: 'Comments', position: sections.length + 1
      }).select().single()
      if (sectionError) return flash(sectionError.message, false)
      setSections(s => [...s, sectionData])
      const { data: questionData, error: questionError } = await supabase.from('dsat_questions').insert({
        scorecard_id: id, section_id: sectionData.id, title: 'Comments',
        is_required: false, question_type: 'free_text', position: 1
      }).select().single()
      if (questionError) return flash(questionError.message, false)
      setDsatQuestions(q => [...q, questionData])
      flash('Comment section added ✓')
    }
  }

  const updateSection = async (sId, updates) => {
    if (leavingRef.current) return
    setSections(s => s.map(sec => sec.id === sId ? { ...sec, ...updates } : sec))
    // Draft autosave. Console-only: this fires on ordinary edits, so a flash would be
    // constant noise — but a silent failure here means the draft quietly diverges from
    // what is on screen, so it must not be invisible.
    if (!isPublished) {
      const { error } = await supabase.from('dsat_sections').update(updates).eq('id', sId)
      if (error) console.error('draft autosave failed (section):', error.message)
    }
    else markChanged()
  }

  const deleteSection = async (sId) => {
    if (!confirm('Delete this section and all its questions?')) return
    const childQIds = dsatQuestions.filter(q => q.section_id === sId).map(q => q.id)
    if (childQIds.length) {
      const { error: optErr } = await supabase.from('dsat_options').delete().in('question_id', childQIds)
      if (optErr) return flash('Failed to delete section: ' + optErr.message, false)
      const { error: qErr } = await supabase.from('dsat_questions').delete().in('id', childQIds)
      if (qErr) return flash('Failed to delete section: ' + qErr.message, false)
    }
    const { error: routeErr } = await supabase.from('dsat_options').update({ jump_to_section_id: null }).eq('jump_to_section_id', sId)
    if (routeErr) return flash('Failed to clear routing into this section: ' + routeErr.message, false)
    const { error } = await supabase.from('dsat_sections').delete().eq('id', sId)
    if (error) return flash('Failed to delete section: ' + error.message, false)
    setSections(s => s.filter(sec => sec.id !== sId))
    setDsatQuestions(q => q.filter(dq => dq.section_id !== sId))
    if (isPublished) markChanged()
  }

  const addDsatQuestion = async (sectionId) => {
    if (isPublished) {
      const tempId = 'temp_q_' + Date.now()
      setDsatQuestions(q => [...q, { id: tempId, scorecard_id: id, section_id: sectionId, title: 'New Question', is_required: true, question_type: 'options', position: dsatQuestions.filter(q => q.section_id === sectionId).length + 1, _isNew: true }])
      markChanged()
    } else {
      const { data, error } = await supabase.from('dsat_questions').insert({
        scorecard_id: id, section_id: sectionId, title: 'New Question',
        is_required: true, position: dsatQuestions.filter(q => q.section_id === sectionId).length + 1
      }).select().single()
      if (error) return flash(error.message, false)
      setDsatQuestions(q => [...q, data])
    }
  }

  const updateDsatQuestion = async (qId, updates) => {
    if (leavingRef.current) return
    setDsatQuestions(q => q.map(dq => dq.id === qId ? { ...dq, ...updates } : dq))
    // Draft autosave. Console-only: this fires on ordinary edits, so a flash would be
    // constant noise — but a silent failure here means the draft quietly diverges from
    // what is on screen, so it must not be invisible.
    if (!isPublished) {
      const { error } = await supabase.from('dsat_questions').update(updates).eq('id', qId)
      if (error) console.error('draft autosave failed (DSAT question):', error.message)
    }
    else markChanged()
  }

  const deleteDsatQuestion = async (qId) => {
    if (!confirm('Delete this question?')) return
    const { error: optErr } = await supabase.from('dsat_options').delete().eq('question_id', qId)
    if (optErr) return flash('Failed to delete question: ' + optErr.message, false)
    const { error } = await supabase.from('dsat_questions').delete().eq('id', qId)
    if (error) return flash('Failed to delete question: ' + error.message, false)
    setDsatQuestions(q => q.filter(dq => dq.id !== qId))
    setDsatOptions(o => o.filter(opt => opt.question_id !== qId))
    if (isPublished) markChanged()
  }

  const addOption = async (questionId) => {
    const count = dsatOptions.filter(o => o.question_id === questionId).length
    if (isPublished) {
      const tempId = 'temp_o_' + Date.now()
      setDsatOptions(o => [...o, { id: tempId, question_id: questionId, label: `Option ${count + 1}`, position: count + 1, _isNew: true }])
      markChanged()
    } else {
      const { data, error } = await supabase.from('dsat_options').insert({
        question_id: questionId, label: `Option ${count + 1}`, position: count + 1
      }).select().single()
      if (error) return flash(error.message, false)
      setDsatOptions(o => [...o, data])
    }
  }

  const updateOption = async (optId, updates) => {
    if (leavingRef.current) return
    setDsatOptions(o => o.map(opt => opt.id === optId ? { ...opt, ...updates } : opt))
    // Draft autosave. Console-only: this fires on ordinary edits, so a flash would be
    // constant noise — but a silent failure here means the draft quietly diverges from
    // what is on screen, so it must not be invisible.
    if (!isPublished) {
      const { error } = await supabase.from('dsat_options').update(updates).eq('id', optId)
      if (error) console.error('draft autosave failed (option):', error.message)
    }
    else markChanged()
  }

  const deleteOption = async (optId) => {
    const { error } = await supabase.from('dsat_options').delete().eq('id', optId)
    if (error) return flash('Failed to delete option: ' + error.message, false)
    setDsatOptions(o => o.filter(opt => opt.id !== optId))
    if (isPublished) markChanged()
  }

  if (loading) return <div className="page"><div className="spinner" /></div>
  if (!scorecard) return <div className="page"><p>Scorecard not found.</p></div>

  const ungroupedQuestions = questions.filter(q => !q.group_id)
  const tabs = scorecard.type === 'dsat' ? ['settings', 'metadata', 'sections', 'ai'] : ['settings', 'metadata', 'questions']

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }}
            onClick={() => safeNavigate('/admin?tab=scorecards')}>
            ← Back to Scorecards
          </button>
          <h1>{scorecard.name}</h1>
          <p className="page-sub">
            {scorecard.type === 'quality' ? 'Quality Scorecard Builder' : 'DSAT Scorecard Builder'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {unsavedChanges && (
            <span style={{ fontSize: 12, color: '#f59e0b' }}>● Unsaved changes</span>
          )}
          <span className={`badge ${scorecard.is_published ? 'badge-pass' : 'badge-fail'}`}>
            {scorecard.is_published ? 'Published' : 'Draft'}
          </span>
          {scorecard.is_published && (
            <button
              className="btn btn-sm btn-primary"
              style={{ opacity: unsavedChanges ? 1 : 0.4 }}
              onClick={unsavedChanges ? saveAllChanges : undefined}>
              Save Changes
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => navigate(`/scorecards/${id}/history`)}>
            History
          </button>
          <button
            className={`btn btn-sm ${scorecard.is_published ? 'btn-danger' : 'btn-primary'}`}
            onClick={togglePublish}>
            {scorecard.is_published ? 'Unpublish' : 'Publish'}
          </button>
        </div>
      </div>

      {msg && <div className={`flash ${msg.ok ? 'flash-ok' : 'flash-err'}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><span>{msg.text}</span><button className="btn btn-sm" style={{ background: 'rgba(255,255,255,0.2)', color: 'inherit', flexShrink: 0 }} onClick={() => setMsg(null)}>OK</button></div>}

      {showVersionModal && (
        <div className="modal-backdrop" onClick={() => { setShowVersionModal(false); setPendingSave(false) }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h2>Reason for Change</h2>
              <button className="btn-close" onClick={() => { setShowVersionModal(false); setPendingSave(false) }}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: 14 }}>
                This scorecard is published. Please provide a reason for this change — it will be recorded in the version history.
              </p>
              <div className="form-field" style={{ marginBottom: 20 }}>
                <label>Reason <span style={{ color: 'var(--danger)' }}>*</span></label>
                <textarea
                  className="input"
                  rows={3}
                  placeholder="e.g. Updated question weights following calibration session on 20 June 2026"
                  value={versionReason}
                  onChange={e => setVersionReason(e.target.value)}
                  style={{ resize: 'vertical' }}
                  autoFocus
                />
                {versionReason.trim().length === 0 && pendingSave && (
                  <span style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4, display: 'block' }}>
                    A reason is required before saving.
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" onClick={() => { setShowVersionModal(false); setPendingSave(false) }}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    setPendingSave(true)
                    if (!versionReason.trim()) return
                    setShowVersionModal(false)
                    await executeVersionSave(versionReason.trim())
                    setVersionReason('')
                    setPendingSave(false)
                  }}
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="tabs">
        {tabs.map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'ai' ? 'AI Evaluation Setting' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'settings' && (
        <div className="card" style={{ maxWidth: 600 }}>
          <div className="card-title" style={{ marginBottom: 16 }}>Scorecard Settings</div>
          <div className="form-field" style={{ marginBottom: 16 }}>
            <label>Name</label>
            <input className="input" value={scorecard.name}
              onChange={e => { setScorecard(s => ({ ...s, name: e.target.value })); markChanged() }} />
          </div>
          <div className="form-field" style={{ marginBottom: 16 }}>
            <label>Description</label>
            <textarea className="input" rows={3} value={scorecard.description || ''}
              onChange={e => { setScorecard(s => ({ ...s, description: e.target.value })); markChanged() }}
              style={{ resize: 'vertical' }} />
          </div>
          <div className="form-field" style={{ marginBottom: 16 }}>
            <label>Type</label>
            <input className="input" value={scorecard.type === 'quality' ? 'Quality Evaluation' : 'DSAT'}
              disabled style={{ opacity: 0.6 }} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, display: 'block' }}>
              Scorecard type cannot be changed after creation.
            </span>
          </div>
          {scorecard.is_spot_check && (
            <div className="form-field" style={{ marginBottom: 16 }}>
              <label>Spot-check of</label>
              <input className="input" value={spotParentName || 'Parent scorecard not recorded'}
                disabled style={{ opacity: 0.6 }} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, display: 'block' }}>
                This scorecard reviews evaluations submitted on the scorecard above, and was
                created as a copy of it so the question and answer-option wording matches.
                Neither the spot-check setting nor its parent can be changed after creation.
              </span>
            </div>
          )}
          {scorecard.type === 'quality' && (
            <div className="form-field" style={{ marginBottom: 16 }}>
              <label>Pass Threshold (%)</label>
              <input type="number" className="input" min={0} max={100}
                value={scorecard.pass_threshold ?? 90}
                onChange={e => { setScorecard(s => ({ ...s, pass_threshold: e.target.value === '' ? '' : Number(e.target.value) })); markChanged() }} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, display: 'block' }}>
                Evaluations scoring at or above this value count as a pass. Editable after publishing.
              </span>
            </div>
          )}
          {/* Hidden on spot-check scorecards: agents never see those evaluations, so they
              can never be disputed by an agent. */}
          {!scorecard.is_spot_check && (
            <div className="form-field" style={{ marginBottom: 16 }}>
              <label>Agent dispute window (hours) <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input type="number" className="input" min={1} max={8760} step={1}
                value={scorecard.dispute_window_hours ?? ''}
                onChange={e => { setScorecard(s => ({ ...s, dispute_window_hours: e.target.value === '' ? '' : Number(e.target.value) })); markChanged() }} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, display: 'block' }}>
                How long an agent has to dispute an evaluation on this scorecard, counted from when it was submitted.
                Whole hours, 1 to 8760. A change applies only to evaluations submitted after you save it.
              </span>
            </div>
          )}
          <div className="form-field" style={{ marginBottom: 16 }}>
            <label>Division</label>
            <select className="select" value={division}
              onChange={e => { setDivision(e.target.value); markChanged() }}>
              <option value="">— Select a division —</option>
              {divisions.filter(d => d.is_active || d.name === division).map(d => (
                <option key={d.id} value={d.name}>{d.name}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, display: 'block' }}>
              Each scorecard belongs to one division. It will appear under that division on the dashboard.
            </span>
          </div>

          <div className="form-field" style={{ marginBottom: 16 }}>
            <label>Calibration Scorecard</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 6 }}>
              <input type="checkbox" checked={!!scorecard.is_calibration}
                onChange={e => { setScorecard(s => ({ ...s, is_calibration: e.target.checked })); markChanged() }} />
              <span style={{ fontSize: 13 }}>This scorecard is for calibration sessions only</span>
            </label>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, display: 'block' }}>
              When enabled, this scorecard will only appear in the Calibration section and not in regular evaluations.
            </span>
          </div>

          {!isPublished && (
            <button className="btn btn-primary" onClick={async () => {
              if (!division) return flash('Please select a division before saving. Every scorecard must belong to a division.', false)
              if (!checkDisputeWindow()) return
              const { error } = await supabase.from('scorecards')
                .update({ name: scorecard.name, description: scorecard.description,
                  pass_threshold: scorecard.type === 'quality' ? (Number(scorecard.pass_threshold) || 90) : null,
                  division: division,
                  is_calibration: scorecard.is_calibration || false,
                  ai_dsat_enabled: scorecard.ai_dsat_enabled || false,
                  ai_dsat_prompt: scorecard.ai_dsat_prompt || null,
                  dispute_window_hours: parseDisputeHours(scorecard.dispute_window_hours) ?? 72,
                  updated_at: new Date().toISOString() })
                .eq('id', id)
              if (error) return flash(error.message, false)
              clearChanged()
              flash('Settings saved')
            }}>Save Settings</button>
          )}
        </div>
      )}

      {tab === 'metadata' && (
        <div>
          {scorecard.type === 'dsat' && !metadata.some(f => f.label?.trim().toLowerCase() === 'communication date') && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)',
              borderRadius: 8, padding: '12px 14px', marginBottom: 16, fontSize: 13
            }}>
              <span style={{ fontSize: 16, lineHeight: 1 }}>⚠️</span>
              <span style={{ color: 'var(--text-primary)' }}>
                This DSAT scorecard needs a metadata field named exactly <strong>"Communication Date"</strong> (type Date).
                The DSAT dashboard uses it as the date axis for all charts and filters. Without it, the dashboard cannot plot results over time.
              </span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
            <p style={{ color: 'var(--text-secondary)' }}>{metadata.length}/10 metadata fields</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {fieldTemplates.length > 0 && (
                <select className="select select-sm" value="" disabled={metadata.length >= 10}
                  onChange={e => { const v = e.target.value; if (v) { addFromLibrary(v); e.target.value = '' } }}>
                  <option value="">+ Add from library…</option>
                  {fieldTemplates.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              )}
              <button className="btn btn-primary btn-sm" onClick={addMetaField} disabled={metadata.length >= 10}>
                + Add Field
              </button>
            </div>
          </div>
          {metadata.length === 0 && (
            <div className="card" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 40 }}>
              No metadata fields yet.
            </div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleMetaDragEnd}>
            <SortableContext items={metadata.map(f => f.id)} strategy={verticalListSortingStrategy}>
              {metadata.map(field => (
                <SortableMetaField key={field.id} field={field} updateMetaField={updateMetaField} deleteMetaField={deleteMetaField} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      {tab === 'questions' && scorecard.type === 'quality' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={() => addQuestion(null)}>+ Add Question</button>
              <button className="btn btn-ghost btn-sm" onClick={addGroup}>+ Add Group</button>
            </div>
            {(() => {
              const total = questions.reduce((sum, q) => sum + (q.weight || 1), 0)
              const color = total === 100 ? 'var(--success)' : total > 100 ? 'var(--danger)' : '#f59e0b'
              const label = total === 100 ? '✓' : total > 100 ? '▲' : '▼'
              return (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: '8px 16px', fontSize: 13
                }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Total Weight:</span>
                  <span style={{ fontWeight: 700, fontSize: 16, color }}>{total}</span>
                  <span style={{ color, fontSize: 12 }}>{label} {total === 100 ? 'Perfect' : total > 100 ? 'Exceeds 100' : 'Below 100'}</span>
                </div>
              )
            })()}
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter}
            onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <DroppableZone id="ungrouped">
              <div style={{ minHeight: 40 }}>
                {ungroupedQuestions.length === 0 && (
                  <div style={{
                    padding: '12px 16px', border: '2px dashed var(--border)', borderRadius: 8,
                    color: 'var(--text-secondary)', fontSize: 13, marginBottom: 8, textAlign: 'center'
                  }}>Drop questions here to ungroup them</div>
                )}
                <SortableContext items={ungroupedQuestions.map(q => q.id)} strategy={verticalListSortingStrategy}>
                  {ungroupedQuestions.map(q => (
                    <SortableQuestionCard key={q.id} question={q}
                      onUpdate={updateQuestion} onDelete={deleteQuestion} groupId={null} />
                  ))}
                </SortableContext>
              </div>
            </DroppableZone>

            {groups.map(group => {
              const groupQs = questions.filter(q => q.group_id === group.id)
              return (
                <div key={group.id} className="card" style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <input className="input" style={{ fontWeight: 600, fontSize: 15, maxWidth: 400 }}
                      value={group.name} onChange={e => updateGroup(group.id, { name: e.target.value })} />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => addQuestion(group.id)}>
                        + Add Question to Group
                      </button>
                      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }}
                        onClick={() => deleteGroup(group.id)}>Delete Group</button>
                    </div>
                  </div>
                  <DroppableZone id={`group-${group.id}`}>
                    <div style={{ minHeight: 40 }}>
                      {groupQs.length === 0 && (
                        <div style={{
                          padding: '12px 16px', border: '2px dashed var(--border)', borderRadius: 8,
                          color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center'
                        }}>Drop questions here</div>
                      )}
                      <SortableContext items={groupQs.map(q => q.id)} strategy={verticalListSortingStrategy}>
                        {groupQs.map(q => (
                          <SortableQuestionCard key={q.id} question={q}
                            onUpdate={updateQuestion} onDelete={deleteQuestion} groupId={group.id} />
                        ))}
                      </SortableContext>
                    </div>
                  </DroppableZone>
                </div>
              )
            })}

            <DragOverlay>
              {activeQuestion && (
                <div className="card" style={{ borderLeft: '3px solid var(--accent)', opacity: 0.9, boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
                  <div style={{ padding: '8px 12px', fontWeight: 500 }}>{activeQuestion.title}</div>
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {tab === 'ai' && scorecard.type === 'dsat' && (
        <div className="card" style={{ maxWidth: 600 }}>
          <div className="card-title" style={{ marginBottom: 16 }}>AI Evaluation Setting</div>
          <div className="form-field" style={{ marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!scorecard.ai_dsat_enabled}
                onChange={e => { setScorecard(s => ({ ...s, ai_dsat_enabled: e.target.checked })); markChanged() }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>Activate AI DSAT Evaluation</span>
            </label>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, display: 'block' }}>
              When enabled, evaluators paste the case transcript and the AI predicts the DSAT section chain (Controllability, Level 1, Level 2), and per-section accuracy is tracked. When disabled, this scorecard is evaluated manually - no case transcript, no AI.
            </span>
          </div>
          {scorecard.ai_dsat_enabled && (
            <div className="form-field" style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>AI Evaluation Prompt</label>
              <textarea className="input" rows={6}
                value={scorecard.ai_dsat_prompt || ''}
                onChange={e => { setScorecard(s => ({ ...s, ai_dsat_prompt: e.target.value })); markChanged() }}
                placeholder="Tell the AI how to judge this DSAT: e.g. what makes a case Controllable vs Non-Controllable, what counts as a Knowledge Gap, how to choose the information-type level, etc."
                style={{ resize: 'vertical' }} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, display: 'block' }}>
                This guidance is sent to the AI with every section prediction for this scorecard.
              </span>
            </div>
          )}
          {!isPublished && (
            <button className="btn btn-primary" onClick={async () => {
              const { error } = await supabase.from('scorecards')
                .update({ ai_dsat_enabled: scorecard.ai_dsat_enabled || false, ai_dsat_prompt: scorecard.ai_dsat_prompt || null, updated_at: new Date().toISOString() })
                .eq('id', id)
              if (error) return flash(error.message, false)
              clearChanged()
              flash('AI setting saved')
            }}>Save AI Setting</button>
          )}
        </div>
      )}

      {tab === 'sections' && scorecard.type === 'dsat' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <p style={{ color: 'var(--text-secondary)' }}>
              Build sections and questions. Each answer option can jump to a specific section.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={addSection}>+ Add Section</button>
              <button className="btn btn-ghost btn-sm" onClick={addCommentSection}>+ Add Comment Section</button>
            </div>
          </div>
          {sections.length === 0 && (
            <div className="card" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 40 }}>
              No sections yet.
            </div>
          )}
          {sections.map((section, sIdx) => (
            <div key={section.id} className="card" style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                <div style={{ flex: 1, marginRight: 16 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>SECTION {sIdx + 1}</div>
                  <input className="input" style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}
                    value={section.title} onChange={e => updateSection(section.id, { title: e.target.value })} />
                  <input className="input" style={{ fontSize: 13 }} placeholder="Section description (optional)"
                    value={section.description || ''} onChange={e => updateSection(section.id, { description: e.target.value })} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm btn-ghost" onClick={() => addDsatQuestion(section.id)}>+ Add Question</button>
                  <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }}
                    onClick={() => deleteSection(section.id)}>Delete Section</button>
                </div>
              </div>
              {dsatQuestions.filter(q => q.section_id === section.id).map(q => (
                <DsatQuestionCard key={q.id} question={q}
                  options={dsatOptions.filter(o => o.question_id === q.id)}
                  sections={sections}
                  onUpdateQuestion={updateDsatQuestion}
                  onDeleteQuestion={deleteDsatQuestion}
                  onAddOption={addOption}
                  onUpdateOption={updateOption}
                  onDeleteOption={deleteOption} />
              ))}
              {dsatQuestions.filter(q => q.section_id === section.id).length === 0 && (
                <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No questions in this section yet.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DroppableZone({ id, children }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef} style={{
      transition: 'background 0.2s',
      background: isOver ? 'rgba(99,102,241,0.07)' : 'transparent',
      borderRadius: 8, padding: 4
    }}>
      {children}
    </div>
  )
}

function SortableMetaField({ field, updateMetaField, deleteMetaField }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, marginBottom: 12 }
  return (
    <div ref={setNodeRef} style={style} className="card">
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <span {...attributes} {...listeners} title="Drag to reorder"
          style={{ cursor: 'grab', color: 'var(--text-secondary)', fontSize: 18, lineHeight: '34px', padding: '0 2px', userSelect: 'none', touchAction: 'none' }}>⠿</span>
        <div className="form-field" style={{ flex: 2, minWidth: 170 }}>
          <label>Field Label</label>
          <input className="input" value={field.label}
            onChange={e => updateMetaField(field.id, { label: e.target.value })} />
        </div>
        <div className="form-field" style={{ flex: 1, minWidth: 150 }}>
          <label>Source</label>
          <select className="select" value={field.source || 'custom'}
            onChange={e => updateMetaField(field.id, { source: e.target.value })}>
            <option value="custom">Custom</option>
            <option value="market">Linked · Market</option>
            <option value="hub">Linked · BPO-Hub</option>
            <option value="channel">Linked · Channel</option>
            <option value="agent_email">Linked · Agent's Email</option>
          </select>
        </div>
        {(field.source || 'custom') === 'custom' && (
          <div className="form-field" style={{ flex: 1, minWidth: 120 }}>
            <label>Type</label>
            <select className="select" value={field.field_type}
              onChange={e => updateMetaField(field.id, { field_type: e.target.value })}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="dropdown">Dropdown</option>
              <option value="date">Date</option>
            </select>
          </div>
        )}
        <div className="form-field" style={{ flex: 1, minWidth: 120 }}>
          <label>Required?</label>
          <select className="select" value={field.is_required ? 'yes' : 'no'}
            onChange={e => updateMetaField(field.id, { is_required: e.target.value === 'yes' })}>
            <option value="yes">Required</option>
            <option value="no">Optional</option>
          </select>
        </div>
        {(field.source || 'custom') === 'custom' && field.field_type === 'dropdown' && (
          <div className="form-field" style={{ flex: 3, minWidth: 200 }}>
            <label>Options — type and press Enter or comma to add (max 50)</label>
            <DropdownOptionsEditor
              options={field.options || []}
              onChange={opts => updateMetaField(field.id, { options: opts })}
            />
          </div>
        )}
        {(field.source || 'custom') !== 'custom' && (
          <div className="form-field" style={{ flex: 3, minWidth: 220 }}>
            <label>Options</label>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '7px 0', lineHeight: 1.5 }}>
              {field.source === 'agent_email'
                ? "Resolved per queue at evaluation time — no options to manage here."
                : 'Options come from the master list — manage them in Control Room → Reference Data.'}
            </div>
          </div>
        )}
        <div className="form-field form-field-btn">
          <label>&nbsp;</label>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
            onClick={() => deleteMetaField(field.id)}>Remove</button>
        </div>
      </div>
    </div>
  )
}

function SortableQuestionCard({ question, onUpdate, onDelete, groupId }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: question.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 }
  const [expanded, setExpanded] = useState(false)

  return (
    <div ref={setNodeRef} style={{ ...style, marginBottom: 10 }}>
      <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
            <span {...attributes} {...listeners}
              style={{ cursor: 'grab', color: 'var(--text-secondary)', fontSize: 18, userSelect: 'none', touchAction: 'none' }}>
              ⠿
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(e => !e)}>
              {expanded ? '▲' : '▼'}
            </button>
            <input className="input" style={{ flex: 1 }} value={question.title}
              onChange={e => onUpdate(question.id, { title: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8 }}>
            {question.is_ai_attribute && <span className="badge badge-admin">✨ AI</span>}
            {question.is_form_critical && <span className="badge badge-fail">Form Critical</span>}
            {question.is_group_critical && groupId && <span className="badge badge-fail">Group Critical</span>}
            {!question.allow_na && <span className="badge badge-channel">No N/A</span>}
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
              onClick={() => onDelete(question.id)}>✕</button>
          </div>
        </div>
        {expanded && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div className="form-row">
              <div className="form-field" style={{ flex: 3 }}>
                <label>Description (optional)</label>
                <input className="input" placeholder="Add helper text for evaluators..."
                  value={question.description || ''}
                  onChange={e => onUpdate(question.id, { description: e.target.value })} />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label>Weight</label>
                <input type="number" className="input" min={0} step={0.5}
                  value={question.weight ?? ''} disabled={!question.is_weighted}
                  onChange={e => onUpdate(question.id, { weight: e.target.value === '' ? '' : parseFloat(e.target.value) })}
                  onBlur={e => onUpdate(question.id, { weight: e.target.value === '' ? 0 : parseFloat(e.target.value) || 0 })} />
              </div>
            </div>
            <div className="form-row" style={{ marginTop: 12 }}>
              <div className="form-field">
                <label>Form Critical?</label>
                <select className="select" value={question.is_form_critical ? 'yes' : 'no'}
                  onChange={e => onUpdate(question.id, { is_form_critical: e.target.value === 'yes' })}>
                  <option value="no">No</option>
                  <option value="yes">Yes — fails entire evaluation</option>
                </select>
              </div>
              {groupId && (
                <div className="form-field">
                  <label>Group Critical?</label>
                  <select className="select" value={question.is_group_critical ? 'yes' : 'no'}
                    onChange={e => onUpdate(question.id, { is_group_critical: e.target.value === 'yes' })}>
                    <option value="no">No</option>
                    <option value="yes">Yes — fails group score</option>
                  </select>
                </div>
              )}

              <div className="form-field">
                <label>Allow N/A?</label>
                <select className="select" value={question.allow_na !== false ? 'yes' : 'no'}
                  onChange={e => onUpdate(question.id, { allow_na: e.target.value === 'yes' })}>
                  <option value="yes">Yes — evaluator can select N/A</option>
                  <option value="no">No — must be Pass or Fail</option>
                </select>
              </div>
              <div className="form-field">
                <label>AI Attribute?</label>
                <select className="select" value={question.is_ai_attribute ? 'yes' : 'no'}
                  onChange={e => onUpdate(question.id, { is_ai_attribute: e.target.value === 'yes' })}>
                  <option value="no">No — scored manually</option>
                  <option value="yes">Yes — Gemini suggests a score, evaluator reviews</option>
                </select>
              </div>
            </div>
            {question.is_ai_attribute && (
              <div className="form-field" style={{ marginTop: 12 }}>
                <label>AI Evaluation Instructions</label>
                <textarea className="input" rows={3}
                  placeholder="Tell the AI exactly how to judge this attribute — e.g. 'Pass if the agent acknowledged the customer's issue within the first two replies and used their name at least once. Fail otherwise.'"
                  value={question.ai_prompt || ''}
                  onChange={e => onUpdate(question.id, { ai_prompt: e.target.value })}
                  style={{ resize: 'vertical', fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Be specific — this is the only guidance the AI gets. Vague instructions (e.g. "check if the agent was polite") produce inconsistent suggestions.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function DsatQuestionCard({ question, options, sections, onUpdateQuestion, onDeleteQuestion, onAddOption, onUpdateOption, onDeleteOption, freeTextValue, onFreeTextChange }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="card" style={{ marginBottom: 10, borderLeft: '3px solid var(--accent)', background: 'var(--bg-main)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(e => !e)}>
            {expanded ? '▲' : '▼'}
          </button>
          <input className="input" style={{ flex: 1 }} value={question.title}
            onChange={e => onUpdateQuestion(question.id, { title: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8 }}>
          <span className={`badge ${question.is_required ? 'badge-fail' : 'badge-channel'}`}>
            {question.is_required ? 'Required' : 'Optional'}
          </span>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
            onClick={() => onDeleteQuestion(question.id)}>✕</button>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div className="form-row">
            <div className="form-field" style={{ flex: 3 }}>
              <label>Description (optional)</label>
              <input className="input" placeholder="Add helper text..."
                value={question.description || ''}
                onChange={e => onUpdateQuestion(question.id, { description: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Required?</label>
              <select className="select" value={question.is_required ? 'yes' : 'no'}
                onChange={e => onUpdateQuestion(question.id, { is_required: e.target.value === 'yes' })}>
                <option value="yes">Required</option>
                <option value="no">Optional</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            {question.question_type === 'free_text' ? (
              <div>
                <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 8 }}>FREE TEXT RESPONSE</label>
                <textarea
                  className="input"
                  rows={4}
                  placeholder="Evaluator will type their response here…"
                  disabled
                  style={{ resize: 'vertical', opacity: 0.6, cursor: 'not-allowed', width: '100%' }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, display: 'block' }}>
                  This field will accept free-text input during evaluation.
                </span>
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>ANSWER OPTIONS</label>
                  <button className="btn btn-ghost btn-sm" onClick={() => onAddOption(question.id)}>+ Add Option</button>
                </div>
                {options.length === 0 && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No options yet. Add at least 2.</p>
                )}
                {options.map(opt => (
                  <div key={opt.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>○</span>
                    <input className="input" style={{ flex: 2 }} placeholder="Option label"
                      value={opt.label} onChange={e => onUpdateOption(opt.id, { label: e.target.value })} />
                    <select className="select" style={{ flex: 2 }}
                      value={opt.jump_to_section_id ?? ''}
                      onChange={e => {
                        const val = e.target.value
                        onUpdateOption(opt.id, { jump_to_section_id: val === '' ? null : val })
                      }}>
                      <option value="">Continue to next section</option>
                      {sections.map(s => (
                        <option key={s.id} value={s.id}>Jump to: {s.title}</option>
                      ))}

                    </select>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                      onClick={() => onDeleteOption(opt.id)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DropdownOptionsEditor({ options, onChange }) {
  const [inputVal, setInputVal] = useState('')

  const addOption = (raw) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    if (options.length >= 50) return
    if (options.includes(trimmed)) return
    onChange([...options, trimmed])
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addOption(inputVal)
      setInputVal('')
    } else if (e.key === 'Backspace' && inputVal === '' && options.length > 0) {
      onChange(options.slice(0, -1))
    }
  }

  const removeOption = (idx) => {
    onChange(options.filter((_, i) => i !== idx))
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '6px 8px',
        background: 'var(--bg-card)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        minHeight: 42,
        cursor: 'text'
      }}
      onClick={(e) => e.currentTarget.querySelector('input')?.focus()}
    >
      {options.map((opt, idx) => (
        <span key={idx} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'var(--bg-main)', border: '1px solid var(--border)',
          borderRadius: 4, padding: '2px 8px', fontSize: 13,
          color: 'var(--text-primary)', whiteSpace: 'nowrap'
        }}>
          {opt}
          <button
            onClick={() => removeOption(idx)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', fontSize: 14, padding: 0,
              lineHeight: 1, display: 'flex', alignItems: 'center'
            }}
          >×</button>
        </span>
      ))}
      {options.length < 50 && (
        <input
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => { addOption(inputVal); setInputVal('') }}
          placeholder={options.length === 0 ? 'Type an option, press Enter or comma…' : '+'}
          style={{
            border: 'none', outline: 'none', background: 'transparent',
            color: 'var(--text-primary)', fontSize: 13,
            minWidth: options.length === 0 ? 260 : 40, flex: 1
          }}
        />
      )}
      {options.length >= 50 && (
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', alignSelf: 'center' }}>
          Max 50 options reached
        </span>
      )}
    </div>
  )
}
// force redeploy Fri Jun 19 08:45:34 UTC 2026