import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

export default function SignInPage() {
  const navigate = useNavigate()
  const [formData, setFormData] = useState({ email: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [showPass, setShowPass] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    setLoading(true)
    setTimeout(() => {
      setLoading(false)
      navigate('/dashboard')
    }, 1200)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', background: 'var(--color-background)', fontFamily: 'var(--font-inter)' }}>
      {/* Left panel */}
      <div className="animate-slide-left" style={{ width: '45%', background: 'var(--color-inverse-surface)', display: 'flex', flexDirection: 'column', padding: '48px 56px', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: -80, right: -80, width: 300, height: 300, borderRadius: '50%', background: 'var(--color-primary)', opacity: 0.08, filter: 'blur(40px)' }} />
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 18, color: 'var(--color-inverse-on-surface)', textDecoration: 'none', marginBottom: 64 }}>
          <span className="material-symbols-outlined icon-fill" style={{ color: 'var(--color-primary-fixed-dim)', fontSize: 22 }}>terminal</span>
          Inflynx Code
        </Link>
        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 32 }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, lineHeight: 1.2, letterSpacing: '-0.03em', color: 'var(--color-inverse-on-surface)', marginBottom: 12 }}>
              Welcome back.
            </h2>
            <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.65, color: 'rgba(230,242,255,0.65)' }}>
              Your agents are waiting. Sign in to resume your sessions or start a new task.
            </p>
          </div>
          {/* Recent activity preview */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { icon: 'check_circle', color: 'var(--color-tertiary-fixed)', text: 'Token refresh fix — Completed 2h ago' },
              { icon: 'memory', color: 'var(--color-primary-fixed-dim)', text: 'Auth migration plan — Ready for review' },
              { icon: 'pending', color: 'var(--color-secondary-fixed-dim)', text: 'Security audit — In progress' },
            ].map(({ icon, color, text }) => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'rgba(230,242,255,0.05)', borderRadius: 8, border: '1px solid rgba(195,198,215,0.1)' }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18, color }}>{icon}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(230,242,255,0.7)' }}>{text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right: Form */}
      <div className="animate-slide-right" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '48px 40px' }}>
        <div style={{ width: '100%', maxWidth: 400 }}>
          <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 28, letterSpacing: '-0.02em', color: 'var(--color-on-surface)', marginBottom: 8 }}>Sign in</h1>
          <p style={{ fontFamily: 'var(--font-inter)', fontSize: 15, color: 'var(--color-on-surface-variant)', marginBottom: 32 }}>
            New here?{' '}
            <Link to="/signup" style={{ color: 'var(--color-primary)', fontWeight: 600, textDecoration: 'none' }}>Create an account</Link>
          </p>

          {/* SSO */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
            {['GitHub', 'Google'].map(p => (
              <button key={p} className="btn-secondary" style={{ flex: 1, justifyContent: 'center', fontSize: 14 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{p === 'GitHub' ? 'code' : 'g_translate'}</span>
                {p}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
            <div style={{ flex: 1, height: 1, background: 'var(--color-outline-variant)' }} />
            <span style={{ fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-on-surface-variant)' }}>or email</span>
            <div style={{ flex: 1, height: 1, background: 'var(--color-outline-variant)' }} />
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>Email</label>
              <input className="input" type="email" placeholder="you@company.com" required value={formData.email} onChange={e => setFormData(d => ({ ...d, email: e.target.value }))} />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)' }}>Password</label>
                <Link to="#" style={{ fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-primary)', textDecoration: 'none' }}>Forgot?</Link>
              </div>
              <div style={{ position: 'relative' }}>
                <input className="input" type={showPass ? 'text' : 'password'} placeholder="Your password" required value={formData.password} onChange={e => setFormData(d => ({ ...d, password: e.target.value }))} style={{ paddingRight: 44 }} />
                <button type="button" onClick={() => setShowPass(!showPass)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-on-surface-variant)', display: 'flex' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 20 }}>{showPass ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
            </div>
            <button type="submit" className="btn-primary" style={{ justifyContent: 'center', width: '100%', padding: '14px', fontSize: 15, marginTop: 8 }} disabled={loading}>
              {loading ? (
                <><span className="material-symbols-outlined" style={{ fontSize: 18, animation: 'spin 0.8s linear infinite' }}>progress_activity</span> Signing in...</>
              ) : (
                <><span className="material-symbols-outlined" style={{ fontSize: 18 }}>login</span> Sign in</>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
