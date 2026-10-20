import { useState, useEffect, useRef, createContext, useContext } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase } from './lib/supabase'
import Navbar from './components/Navbar'
import ScrollToTopButton from './components/ScrollToTopButton'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import DashboardHome from './pages/DashboardHome'
import ScorecardDashboard from './pages/ScorecardDashboard'
import Evaluations from './pages/Evaluations'
import Admin from './pages/Admin'
import ScorecardBuilder from './pages/ScorecardBuilder'
import EvaluationForm from './pages/EvaluationForm'
import ScorecardHistory from './pages/ScorecardHistory'
import ResetPassword from './pages/ResetPassword'
import { usePresence } from './hooks/usePresence'
import DuckLoader from './components/DuckLoader'
import Calibration from './pages/Calibration'
import Coaching from './pages/Coaching'
import ContactUs from './pages/ContactUs'
import Issues from './pages/Issues'
import QualityDocs, { QualityDocView, QualityDocEdit, QualityDocHistory } from './pages/QualityDocs'
import Disputes from './pages/Disputes'

export const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

function UnsavedModal({ show, onLeave, onStay }) {
  if (!show) return null
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
    }}>
      <div className="card" style={{ maxWidth: 420, width: '100%', padding: 32 }}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>⚠️ Unsaved Changes</div>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 24, lineHeight: 1.6 }}>
          You have unsaved changes on this scorecard. If you leave now, your changes will be lost.
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-danger" onClick={onLeave}>Leave without saving</button>
          <button className="btn btn-primary" onClick={onStay}>Stay on page</button>
        </div>
      </div>
    </div>
  )
}

function AppShell({ user, profile, logout, fetchProfile }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [unsavedChanges, setUnsavedChanges] = useState(false)
  const [showNavModal, setShowNavModal] = useState(false)
  const [pendingNavPath, setPendingNavPath] = useState(null)

  usePresence(user)

  const isAdminOrOwner = ['admin', 'owner'].includes(profile?.role)

  const handleLeave = () => {
    setUnsavedChanges(false)
    setShowNavModal(false)
    const dest = pendingNavPath
    setPendingNavPath(null)
    if (dest === -1) {
      // Go back twice: once to undo our dummy pushState, once to actually leave
      navigate(-1)
      setTimeout(() => navigate(-1), 50)
    } else if (dest) navigate(dest)
  }

  const handleStay = () => {
    setShowNavModal(false)
    setPendingNavPath(null)
  }

  const safeNavigate = (path) => {
    if (unsavedChanges) {
      setPendingNavPath(path)
      setShowNavModal(true)
    } else {
      navigate(path)
    }
  }

  return (
    <AuthContext.Provider value={{
      user, profile, logout,
      refreshProfile: () => fetchProfile(user),
      unsavedChanges, setUnsavedChanges,
      showNavModal, setShowNavModal,
      pendingNavPath, setPendingNavPath,
      safeNavigate
    }}>
      <div className="app-shell">
        <UnsavedModal show={showNavModal} onLeave={handleLeave} onStay={handleStay} />
        <div aria-hidden="true" style={{ position: 'fixed', top: 14, right: 22, zIndex: 30, display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
          <svg width="24" height="17" viewBox="0 0 44 32"><polygon points="0,0 0,32 26,16" fill="#EE7623" /><polygon points="44,6 44,26 29,16" fill="#1B368C" /></svg>
          <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1 }}>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px', color: 'var(--text-primary)' }}>kaizen</span>
            <span style={{ fontSize: 7, fontWeight: 600, letterSpacing: '2.5px', color: 'var(--text-secondary)', alignSelf: 'flex-end', marginTop: 1 }}>GAMING</span>
          </span>
        </div>
        <Navbar />
        <main className="main-content">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            >
              <Routes location={location}>
                <Route path="/" element={<Navigate to="/evaluations" replace />} />
                <Route path="/dashboard" element={<DashboardHome />} />
                <Route path="/dashboard/:division" element={<DashboardHome />} />
                <Route path="/dashboard/:division/:scorecardId" element={<ScorecardDashboard />} />
                <Route path="/evaluations" element={<Evaluations />} />
                <Route path="/evaluations/new" element={<EvaluationForm />} />
                {/* Disputes — every role except agents (viewer). The page scopes what each
                    role sees, and RLS enforces it. */}
                <Route path="/disputes" element={profile?.role && profile.role !== 'viewer' ? <Disputes /> : <Navigate to="/dashboard" replace />} />
                <Route path="/scorecards/:id/edit" element={isAdminOrOwner ? <ScorecardBuilder /> : <Navigate to="/dashboard" replace />} />
                <Route path="/scorecards/:id/history" element={isAdminOrOwner ? <ScorecardHistory /> : <Navigate to="/dashboard" replace />} />
                <Route path="/admin" element={isAdminOrOwner ? <Admin /> : <Navigate to="/dashboard" replace />} />
                <Route path="/calibration" element={['owner','admin','evaluator'].includes(profile?.role) ? <Calibration /> : <Navigate to="/dashboard" replace />} />
                <Route path="/coaching" element={<Coaching />} />
                <Route path="/contact" element={['viewer','admin','owner'].includes(profile?.role) ? <ContactUs /> : <Navigate to="/dashboard" replace />} />
                {/* Quality Documentation — readable by every role; authoring is gated
                    inside the pages and enforced by RLS. */}
                <Route path="/quality-docs" element={<QualityDocs />} />
                <Route path="/quality-docs/:id" element={<QualityDocView />} />
                <Route path="/quality-docs/:id/edit" element={['owner','admin'].includes(profile?.role) ? <QualityDocEdit /> : <Navigate to="/quality-docs" replace />} />
                <Route path="/quality-docs/:id/history" element={<QualityDocHistory />} />
                <Route path="/issues" element={['evaluator','team_leader','admin','owner'].includes(profile?.role) ? <Issues /> : <Navigate to="/dashboard" replace />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </motion.div>
          </AnimatePresence>
        </main>
        <ScrollToTopButton />
      </div>
    </AuthContext.Provider>
  )
}

export default function App() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  // Which user id we have already recorded a login for — see the SIGNED_IN handler below.
  const signedInFor = useRef(null)
  const [emailConfirmed] = useState(() =>
    typeof window !== 'undefined' &&
    (window.location.hash.includes('type=signup') ||
     sessionStorage.getItem('quark_email_confirmed') === '1')
  )

  // When a user clicks the email-confirmation link, Supabase auto-creates a
  // session. We don't want to drop them straight into Quark — sign that
  // session out and reload to a clean state so they land on the sign-in page.
  useEffect(() => {
    if (window.location.hash.includes('type=signup')) {
      sessionStorage.setItem('quark_email_confirmed', '1')
      supabase.auth.signOut().then(() => {
        window.location.replace('/')
      })
    }
  }, [])

  // Supabase refreshes the access token whenever the window regains focus, and fires
  // onAuthStateChange each time. Naively calling setUser/setProfile there hands React a
  // BRAND-NEW OBJECT even though nothing about the user changed — and every effect keyed
  // on [profile] (seven in Evaluations, three in Calibration, one in Coaching) treats a
  // new identity as a change and refetches. Tabbing away and back therefore triggered a
  // burst of redundant queries and visible list flicker.
  //
  // These two helpers keep the PREVIOUS object when the contents are unchanged, so the
  // identity stays stable and those effects go quiet. Effects keyed on [profile?.id] were
  // never affected — a string compares by value.
  //
  // Deliberately compares content, not just id: a genuine change (role, name, hub) must
  // still propagate, which is exactly what a shallow id check would miss.
  //
  // VOLATILE_FIELDS are excluded because they change on their own without meaning anything
  // to the UI. last_login is the important one: we write it ourselves on SIGNED_IN, and
  // supabase-js fires SIGNED_IN on tab focus — so a plain content compare found a genuine
  // difference every single time and defeated the whole point of this function.
  const VOLATILE_FIELDS = ['last_login', 'updated_at', 'last_seen_at']
  const stable = (o) => {
    if (!o) return o
    const c = { ...o }
    VOLATILE_FIELDS.forEach(k => { delete c[k] })
    // Key order from PostgREST is stable for a given select, but sort anyway so this can
    // never produce a false "changed" for a reason that has nothing to do with the data.
    return JSON.stringify(Object.keys(c).sort().map(k => [k, c[k]]))
  }
  const sameProfile = (prev, next) => {
    if (prev === next) return true
    if (!prev || !next) return false
    return stable(prev) === stable(next)
  }
  const applyProfile = (next) => setProfile(prev => (sameProfile(prev, next) ? prev : next))

  // The auth user is compared on id alone: Supabase mutates volatile fields such as
  // last_sign_in_at on every refresh, so a content compare would never match and we'd be
  // back where we started. Identity is all any consumer cares about here.
  const applyUser = (next) => setUser(prev => ((prev?.id && prev.id === next?.id) ? prev : next))

  const fetchProfile = async (u) => {
    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('id', u.id)
      .maybeSingle()
    if (data) {
      applyProfile(data)
    } else {
      const { data: np } = await supabase
        .from('users')
        .upsert({ id: u.id, email: u.email, name: u.email.split('@')[0], role: 'viewer' })
        .select()
        .maybeSingle()
      applyProfile(np)
    }
    setLoading(false)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      applyUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user)
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      applyUser(session?.user ?? null)
      if (session?.user) {
        // Still refetched on every event — the profile really can change server-side
        // (a role grant, a hub reassignment) and this is when we'd learn of it. The
        // difference is that an UNCHANGED result no longer looks like a change.
        fetchProfile(session.user)
        // supabase-js fires SIGNED_IN whenever the tab regains focus and the session is
        // revalidated — not only when someone actually signs in. Stamping last_login on
        // every one of those was both wrong (it recorded tab-switching as logins) and the
        // direct cause of the list-reload bug: the write changed the profile row, the
        // refetch saw a different row, and every [profile] effect refired.
        //
        // signedInFor tracks which user id we have already stamped in this page lifetime.
        // A genuine sign-in always follows a page load or a sign-out, so the ref is unset
        // and the stamp happens exactly once.
        if (event === 'SIGNED_IN' && signedInFor.current !== session.user.id) {
          signedInFor.current = session.user.id
          sessionStorage.removeItem('quark_email_confirmed')
          supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', session.user.id).then(({ error }) => {
            if (error) console.error('last_login update failed:', error.message)
          })
        }
      } else { applyProfile(null); signedInFor.current = null; setLoading(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  const logout = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setProfile(null)
  }

  // Just confirmed their email via the link — force the sign-in page.
  if (emailConfirmed && !user) return <Login confirmed />

  if (loading) return (
    <div className="fullpage-loader">
      <DuckLoader />
    </div>
  )

  // Public routes — shown regardless of auth state
  // Also intercept when Supabase auto-signs in via recovery token
  const isRecovery = window.location.pathname === '/reset-password' ||
    window.location.hash.includes('type=recovery')
  if (isRecovery) return <ResetPassword />

  if (!user) return <Login />

  return <AppShell user={user} profile={profile} logout={logout} fetchProfile={fetchProfile} />
}