import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { clerkLoaded, getSessionToken, openSignIn, currentUserSummary, approveDeviceCode, getApiBase } from '../lib/auth'

// Phases of the approve flow — kept explicit so every state renders something honest.
//   sign_in_required  → Clerk is loaded but there's no session yet
//   ready             → signed in, code present, awaiting Approve
//   approving/approved/error/invalid → outcomes
export default function ActivatePage() {
  const [params] = useSearchParams()
  const userCode = (params.get('user_code') || '').trim().toUpperCase()
  const [entered, setEntered] = useState(userCode)
  const code = (userCode || entered).trim().toUpperCase()

  const [phase, setPhase] = useState('checking') // checking | sign_in_required | no_clerk | ready | approving | approved | error
  const [message, setMessage] = useState('')
  const [user, setUser] = useState(null)

  useEffect(() => {
    let alive = true
    async function detect() {
      if (!clerkLoaded()) { setPhase('no_clerk'); return }
      const me = currentUserSummary()
      if (!me) { setPhase('sign_in_required'); return }
      if (alive) { setUser(me); setPhase('ready') }
    }
    detect()
    return () => { alive = false }
  }, [])

  async function handleApprove() {
    setPhase('approving')
    try {
      const token = await getSessionToken()
      if (!token) { setPhase('sign_in_required'); setMessage('Your session expired — sign in again.'); return }
      const r = await approveDeviceCode({ userCode: code, token })
      if (r.ok && r.body?.ok) {
        setPhase('approved')
      } else if (r.status === 401) {
        setPhase('sign_in_required'); setMessage('We could not verify your identity. Please sign in again.')
      } else if (r.status === 404 || r.body?.error === 'invalid_user_code') {
        setPhase('error'); setMessage('That code is not valid or has expired. Start /login again in your terminal.')
      } else {
        setPhase('error'); setMessage(r.body?.error || `Approval failed (HTTP ${r.status}).`)
      }
    } catch (e) {
      setPhase('error'); setMessage(`Could not reach ${getApiBase()}: ${e.message}`)
    }
  }

  // Retry Clerk detection after the user opens sign-in (window.Clerk populates asynchronously).
  function retry() {
    if (!clerkLoaded()) { setPhase('no_clerk'); return }
    const me = currentUserSummary()
    if (me) { setUser(me); setPhase('ready') } else { setPhase('sign_in_required') }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-background)', fontFamily: 'var(--font-inter)', padding: 24 }}>
      <div className="animate-slide-right" style={{ width: '100%', maxWidth: 440, background: 'var(--color-surface)', border: '1px solid rgba(195,198,215,0.12)', borderRadius: 16, padding: '36px 32px', boxShadow: '0 24px 60px rgba(0,0,0,0.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 18, color: 'var(--color-on-surface)', marginBottom: 28 }}>
          <span className="material-symbols-outlined icon-fill" style={{ color: 'var(--color-primary)', fontSize: 22 }}>terminal</span>
          Inflynx Code
        </div>

        {/* The code the CLI is showing — echoed back so the user can confirm it matches. If someone
            lands here without a code in the URL, they can type the one their terminal displayed. */}
        {!userCode && (
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>Enter the code from your terminal</label>
            <input className="input" placeholder="XXXX-XXXX" value={entered} onChange={(e) => setEntered(e.target.value.toUpperCase())} style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.12em' }} />
          </div>
        )}
        {code && (
          <div style={{ marginBottom: 24, padding: '14px 16px', background: 'rgba(230,242,255,0.05)', borderRadius: 10, border: '1px solid rgba(195,198,215,0.14)' }}>
            <div style={{ fontFamily: 'var(--font-inter)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-on-surface-variant)', marginBottom: 6 }}>Your device is requesting access</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--color-on-surface)' }}>{code}</div>
          </div>
        )}

        {phase === 'checking' && <Status icon="progress_activity" spin text="Checking your session…" />}

        {phase === 'no_clerk' && (
          <Panel icon="lock" title="Sign-in is not active yet">
            <p style={p}>This portal needs its identity provider (Clerk) configured before a device can be approved. Once <code style={code_}>VITE_CLERK_PUBLISHABLE_KEY</code> is set and a Clerk client is loaded, this page works with no further changes.</p>
            <p style={p}>Nothing here is broken — it is simply not wired to an account yet.</p>
          </Panel>
        )}

        {phase === 'sign_in_required' && (
          <Panel icon="person_add" title="Sign in to approve this device">
            {message && <p style={{ ...p, color: 'var(--color-error, #ff8a80)' }}>{message}</p>}
            <p style={p}>Approving links this terminal session to your account, so your history and credits follow you.</p>
            <button className="btn-primary" style={btn} onClick={() => { openSignIn(); setTimeout(retry, 1200) }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>login</span> Sign in
            </button>
            <button className="btn-secondary" style={{ ...btn, marginTop: 10 }} onClick={retry}>I'm already signed in</button>
          </Panel>
        )}

        {phase === 'ready' && (
          <Panel icon="verified_user" title={`Approve for ${user?.name || 'your account'}?`}>
            <p style={p}>Make sure this code matches the one shown in your terminal, then approve.</p>
            <button className="btn-primary" style={btn} onClick={handleApprove}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>check_circle</span> Approve device
            </button>
            <Link to="/" style={link}>Cancel — do not approve</Link>
          </Panel>
        )}

        {phase === 'approving' && <Status icon="progress_activity" spin text="Approving…" />}

        {phase === 'approved' && (
          <Panel icon="task_alt" title="Device approved">
            <p style={p}>You can return to your terminal — it should sign you in within a few seconds.</p>
          </Panel>
        )}

        {phase === 'error' && (
          <Panel icon="error" title="Could not approve">
            <p style={{ ...p, color: 'var(--color-error, #ff8a80)' }}>{message}</p>
            <button className="btn-secondary" style={btn} onClick={retry}>Try again</button>
          </Panel>
        )}
      </div>
    </div>
  )
}

function Status({ icon, text, spin }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--color-on-surface-variant)' }}>
      <span className="material-symbols-outlined" style={{ fontSize: 20, animation: spin ? 'spin 0.8s linear infinite' : undefined }}>{icon}</span>
      <span style={{ fontSize: 15 }}>{text}</span>
    </div>
  )
}

function Panel({ icon, title, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 24, color: 'var(--color-primary)' }}>{icon}</span>
        <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 20, letterSpacing: '-0.02em', color: 'var(--color-on-surface)', margin: 0 }}>{title}</h2>
      </div>
      {children}
    </div>
  )
}

const p = { fontFamily: 'var(--font-inter)', fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface-variant)', margin: '10px 0' }
const btn = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '12px', marginTop: 12, cursor: 'pointer' }
const link = { display: 'block', textAlign: 'center', marginTop: 14, fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-on-surface-variant)', textDecoration: 'none' }
const code_ = { fontFamily: 'var(--font-mono)', fontSize: 12 }
