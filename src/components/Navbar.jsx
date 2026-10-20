import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../App'
import {
  IconLayoutDashboard, IconClipboardCheck, IconSchool, IconTarget,
  IconMessages, IconBug, IconBook, IconSettings, IconGavel,
} from '@tabler/icons-react'
import { supabase } from '../lib/supabase'
import NotificationBell from './NotificationBell'
import ColorPicker, { applyAccent, clearAccent } from './ColorPicker'

const SCHEMES = [
  { key: 'default',  label: 'Default',  swatch: '#3b82f6' },
  { key: 'midnight', label: 'Violet',   swatch: '#7c6fd6' },
  { key: 'forest',   label: 'Forest',   swatch: '#10b981' },
  { key: 'slate',    label: 'Sunset',   swatch: '#d85a30' },
  { key: 'plum',     label: 'Plum',     swatch: '#a855f7' },
  { key: 'crimson',  label: 'Berry',    swatch: '#d6409f' },
]

// Dark mode variants. The saved users.theme value is the key: 'dark' (Dim) stays the
// default so everyone already on dark mode lands on it without any data change.
// index.css reads data-theme="dark" for all three plus data-dark for Deep and Soft.
const DARK_MODES = [
  { key: 'dark-deep', label: 'Deep', chip: '#16191F', attr: 'deep' },
  { key: 'dark',      label: 'Dim',  chip: '#1F2228', attr: null },
  { key: 'dark-soft', label: 'Soft', chip: '#2C3037', attr: 'soft' },
]
const isDark = (t) => String(t || '').startsWith('dark')

export default function Navbar() {
  const { profile, logout, unsavedChanges, setShowNavModal, setPendingNavPath } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // Fast cache (avoids flash) — DB is source of truth, synced once profile loads.
  const [theme, setTheme]   = useState(() => localStorage.getItem('quark-theme') || 'dark')
  const [scheme, setScheme] = useState(() => localStorage.getItem('quark-scheme') || 'default')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [flash, setFlash] = useState(null)
  const [navOpen, setNavOpen] = useState(false)
  const settingsRef = useRef(null)
  const persistTimer = useRef(null)

  // Apply theme + scheme to <html> and cache them.
  useEffect(() => {
    const root = document.documentElement
    const variant = DARK_MODES.find(m => m.key === theme)
    root.setAttribute('data-theme', isDark(theme) ? 'dark' : 'light')
    if (variant && variant.attr) root.setAttribute('data-dark', variant.attr)
    else root.removeAttribute('data-dark')
    localStorage.setItem('quark-theme', theme)
    // Remember the last dark variant, so switching Light -> Dark returns to it.
    if (isDark(theme)) localStorage.setItem('quark-last-dark', theme)
  }, [theme])
  useEffect(() => {
    const root = document.documentElement
    clearAccent()
    if (scheme && scheme.charAt(0) === '#') {
      root.removeAttribute('data-scheme')
      applyAccent(scheme, isDark(theme) ? 'dark' : 'light')
    } else if (scheme && scheme !== 'default') {
      root.setAttribute('data-scheme', scheme)
    } else {
      root.removeAttribute('data-scheme')
    }
    localStorage.setItem('quark-scheme', scheme)
  }, [scheme, theme])

  // Once profile loads, sync preferences from the DB (source of truth).
  useEffect(() => {
    if (!profile) return
    if (profile.theme && profile.theme !== theme) setTheme(profile.theme)
    if (profile.color_scheme && profile.color_scheme !== scheme) setScheme(profile.color_scheme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])

  // Close the settings menu on outside click.
  useEffect(() => {
    const h = (e) => { if (settingsRef.current && !settingsRef.current.contains(e.target)) setSettingsOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const persist = async (patch) => {
    if (!profile?.id) return
    await supabase.from('users').update(patch).eq('id', profile.id)
  }

  const chooseTheme = (t) => { setTheme(t); persist({ theme: t }) }
  const chooseDark = () => {
    if (isDark(theme)) return
    const last = localStorage.getItem('quark-last-dark')
    chooseTheme(DARK_MODES.some(m => m.key === last) ? last : 'dark')
  }
  const chooseScheme = (sc) => { setScheme(sc); persist({ color_scheme: sc }) }
  const chooseAccent = (hex) => {
    setScheme(hex)
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => persist({ color_scheme: hex }), 500)
  }
  const accentValue = (scheme && scheme.charAt(0) === '#') ? scheme : ((SCHEMES.find(x => x.key === scheme) || {}).swatch || '#3b82f6')

  const sendPasswordReset = async () => {
    if (!profile?.email) return
    const { error } = await supabase.auth.resetPasswordForEmail(profile.email, {
      redirectTo: 'https://quark-iota.vercel.app/reset-password'
    })
    setFlash(error ? { ok: false, text: error.message } : { ok: true, text: 'Password reset link sent to your email.' })
    if (!error) setTimeout(() => setFlash(null), 4000)
  }

  const isActive = (path) => location.pathname.startsWith(path)
  const initials = profile?.name
    ? profile.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : '?'
  const roleLabel = profile?.role === 'viewer' ? 'Agent' : (profile?.role || 'viewer')
  const roleClass = profile?.role || 'viewer' // real CSS class (role-viewer, role-admin, etc.)

  const safeNavigate = (path) => {
    setNavOpen(false)
    if (unsavedChanges) { setPendingNavPath(path); setShowNavModal(true) }
    else navigate(path)
  }

  return (
    <>
      <button className="nav-hamburger" aria-label="Menu" onClick={() => setNavOpen(v => !v)}>☰</button>
      {navOpen && <div className="nav-overlay show" onClick={() => setNavOpen(false)} />}
      <nav className={`navbar ${navOpen ? 'nav-open' : ''}`}>
      <div className="navbar-brand">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="brand-icon" style={{ lineHeight: 0 }}>
            <svg width="40" height="40" viewBox="0 0 90 90" style={{ flexShrink: 0 }} aria-hidden="true">
              <g transform="rotate(0 45 45)">
                <ellipse cx="45" cy="45" rx="38" ry="15" fill="none" stroke="#5f6d85" strokeWidth="2.2" />
                <circle r="5" fill="#3b82f6"><animateMotion dur="5s" repeatCount="indefinite" path="M83,45 A38,15 0 0 1 7,45 A38,15 0 0 1 83,45" /></circle>
              </g>
              <g transform="rotate(60 45 45)">
                <ellipse cx="45" cy="45" rx="38" ry="15" fill="none" stroke="#5f6d85" strokeWidth="2.2" />
                <circle r="5" fill="#10b981"><animateMotion dur="7s" repeatCount="indefinite" path="M83,45 A38,15 0 0 1 7,45 A38,15 0 0 1 83,45" /></circle>
              </g>
              <g transform="rotate(120 45 45)">
                <ellipse cx="45" cy="45" rx="38" ry="15" fill="none" stroke="#5f6d85" strokeWidth="2.2" />
                <circle r="5" fill="#f59e0b"><animateMotion dur="6s" repeatCount="indefinite" path="M83,45 A38,15 0 0 1 7,45 A38,15 0 0 1 83,45" /></circle>
              </g>
              <circle cx="45" cy="45" r="11" fill="#d85a30">
                <animate attributeName="r" values="11;12.4;11" dur="2.2s" repeatCount="indefinite" />
              </circle>
            </svg>
          </span>
          <span className="brand-name" style={{ margin: 0 }}>Quark</span>
        </div>
        <span className="brand-sub" style={{ marginTop: 8 }}>Quality &amp; Control Team</span>
      </div>

      <div className="navbar-links">
        <button className={`nav-item ${isActive('/dashboard') ? 'active' : ''}`}
          onClick={() => safeNavigate('/dashboard')}>
          <IconLayoutDashboard size={18} stroke={1.75} aria-hidden="true" />
          Dashboard
        </button>
        <button className={`nav-item ${isActive('/evaluations') ? 'active' : ''}`}
          onClick={() => safeNavigate('/evaluations')}>
          <IconClipboardCheck size={18} stroke={1.75} aria-hidden="true" />
          Evaluations
        </button>
        {/* Disputes — everyone except agents, the same audience the old Dispute Insights
            tab had. What each role sees inside is scoped by the page and by RLS. */}
        {profile?.role && profile.role !== 'viewer' && (
          <button className={`nav-item ${isActive('/disputes') ? 'active' : ''}`}
            onClick={() => safeNavigate('/disputes')}>
            <IconGavel size={18} stroke={1.75} aria-hidden="true" />
            Disputes
          </button>
        )}
        <button className={`nav-item ${isActive('/coaching') ? 'active' : ''}`}
          onClick={() => safeNavigate('/coaching')}>
          <IconSchool size={18} stroke={1.75} aria-hidden="true" />
          Coaching
        </button>
        {['owner','admin','evaluator'].includes(profile?.role) && (
          <button className={`nav-item ${isActive('/calibration') ? 'active' : ''}`}
            onClick={() => safeNavigate('/calibration')}>
            <IconTarget size={18} stroke={1.75} aria-hidden="true" />
            Calibration
          </button>
        )}
        {['viewer', 'admin', 'owner'].includes(profile?.role) && (
          <button className={`nav-item ${isActive('/contact') ? 'active' : ''}`}
            onClick={() => safeNavigate('/contact')}>
            <IconMessages size={18} stroke={1.75} aria-hidden="true" />
            Contact Us
          </button>
        )}
        {['evaluator', 'team_leader', 'admin', 'owner'].includes(profile?.role) && (
          <button className={`nav-item ${isActive('/issues') ? 'active' : ''}`}
            onClick={() => safeNavigate('/issues')}>
            <IconBug size={18} stroke={1.75} aria-hidden="true" />
            Issue Management
          </button>
        )}
        {/* Quality Documentation — every role can read it, so this is ungated.
            Authoring is restricted inside the page and by RLS. */}
        <button className={`nav-item ${isActive('/quality-docs') ? 'active' : ''}`}
          onClick={() => safeNavigate('/quality-docs')}>
          <IconBook size={18} stroke={1.75} aria-hidden="true" />
          Quality Documentation
        </button>
      </div>

      {['admin', 'owner'].includes(profile?.role) && (
        <div className="navbar-admin-section" style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
          <button className={`nav-item ${isActive('/admin') ? 'active' : ''}`}
            onClick={() => safeNavigate('/admin')}>
            <IconSettings size={18} stroke={1.75} aria-hidden="true" />
            Control Room
          </button>
        </div>
      )}

      <div className="navbar-user" ref={settingsRef} style={{ position: 'relative' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <NotificationBell />
          {/* Clickable account area → opens settings */}
          <button
            onClick={() => setSettingsOpen(o => !o)}
            style={{
              flex: 1, background: settingsOpen ? 'var(--bg-hover)' : 'transparent',
              border: 'none', borderRadius: 'var(--radius)', padding: '8px',
              cursor: 'pointer', textAlign: 'left', transition: 'background .15s',
            }}
            title="Account settings">
            <div className="user-info">
              <div className="avatar">{initials}</div>
              <div style={{ overflow: 'hidden', flex: 1 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Account</div>
                <div className="user-name">{profile?.name || 'User'}</div>
              </div>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{settingsOpen ? '▾' : '▸'}</span>
            </div>
          </button>
        </div>

        {/* Settings popover */}
        {settingsOpen && (
          <div style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', left: 8, right: 8, zIndex: 200,
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow)', padding: '14px',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)',
              textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>
              Account Settings
            </div>
            <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{profile?.name || 'User'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>{profile?.email || ''}</div>
              <span className={`role-chip role-${roleClass}`}>{roleLabel}</span>
            </div>

            {/* Appearance: theme toggle, plus the dark variant when dark is on */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>Appearance</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className={`btn btn-sm ${isDark(theme) ? 'btn-primary' : 'btn-outline'}`}
                  style={{ flex: 1, justifyContent: 'center' }} onClick={chooseDark}>☾ Dark</button>
                <button className={`btn btn-sm ${theme === 'light' ? 'btn-primary' : 'btn-outline'}`}
                  style={{ flex: 1, justifyContent: 'center' }} onClick={() => chooseTheme('light')}>☀ Light</button>
              </div>
              {isDark(theme) && (
                <div className="dark-modes" role="group" aria-label="Dark mode shade">
                  {DARK_MODES.map(m => (
                    <button key={m.key} type="button" className="dark-mode"
                      aria-pressed={theme === m.key} onClick={() => chooseTheme(m.key)}>
                      <span className="dark-mode-chip" style={{ background: m.chip }} />
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Accent color */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>Accent color</div>
              <ColorPicker value={accentValue} onChange={chooseAccent} />
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 8, fontSize: 11 }} onClick={() => chooseScheme('default')}>Reset to default</button>
            </div>

            {/* Inline flash for password reset result */}
            {flash && (
              <div style={{ fontSize: 12, marginBottom: 10, padding: '6px 10px', borderRadius: 6,
                background: flash.ok ? 'var(--success-light)' : 'var(--danger-light)',
                color: flash.ok ? 'var(--success)' : 'var(--danger)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span>{flash.text}</span>
                <button onClick={() => setFlash(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 13, lineHeight: 1, padding: 0 }}>
                  ✕
                </button>
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'center',
                color: 'var(--accent)', border: '1px solid var(--accent-light)' }}
                onClick={sendPasswordReset}>
                Send Password Reset Link
              </button>
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'center' }}
                onClick={logout}>
                Sign Out
              </button>
            </div>
          </div>
        )}
      </div>
    </nav>
    </>
  )
}