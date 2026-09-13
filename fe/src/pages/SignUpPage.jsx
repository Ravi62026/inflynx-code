import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

export default function SignUpPage() {
  const navigate = useNavigate()
  const [formData, setFormData] = useState({ name: '', email: '', password: '', plan: 'pro' })
  const [loading, setLoading] = useState(false)
  const [showPass, setShowPass] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    setLoading(true)
    setTimeout(() => {
      setLoading(false)
      navigate('/onboarding')
    }, 1500)
  }

  const providers = [
    { name: 'GitHub', icon: 'code', color: '#24292e' },
    { name: 'Google', icon: 'g_translate', color: '#4285f4' },
    { name: 'GitLab', icon: 'source', color: '#fc6d26' },
  ]

  const plans = [
    { id: 'starter', label: 'Starter', sub: 'Free forever', price: '$0' },
    { id: 'pro', label: 'Pro', sub: '14-day free trial', price: '$49/mo' },
  ]

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        background: 'var(--color-background)',
        fontFamily: 'var(--font-inter)',
      }}
    >
      {/* ═══ LEFT: Feature Panel ═══ */}
      <div
        className="animate-slide-left"
        style={{
          width: '45%',
          background: 'var(--color-inverse-surface)',
          display: 'flex',
          flexDirection: 'column',
          padding: '48px 56px',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Background decoration */}
        <div style={{ position: 'absolute', top: -80, right: -80, width: 300, height: 300, borderRadius: '50%', background: 'var(--color-primary)', opacity: 0.08, filter: 'blur(40px)' }} />
        <div style={{ position: 'absolute', bottom: -60, left: -60, width: 240, height: 240, borderRadius: '50%', background: 'var(--color-secondary)', opacity: 0.08, filter: 'blur(40px)' }} />

        {/* Logo */}
        <Link
          to="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--font-geist)',
            fontWeight: 700,
            fontSize: 18,
            color: 'var(--color-inverse-on-surface)',
            textDecoration: 'none',
            marginBottom: 64,
          }}
        >
          <span className="material-symbols-outlined icon-fill" style={{ color: 'var(--color-primary-fixed-dim)', fontSize: 22 }}>terminal</span>
          Inflynx Code
        </Link>

        {/* Headline */}
        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 32 }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, lineHeight: 1.2, letterSpacing: '-0.03em', color: 'var(--color-inverse-on-surface)', marginBottom: 12 }}>
              Your codebase,<br />fully understood.
            </h2>
            <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.65, color: 'rgba(230,242,255,0.65)' }}>
              Deploy AI agents that actually understand your architecture. Join 2,400+ engineers shipping with confidence.
            </p>
          </div>

          {/* Benefit list */}
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              { icon: 'account_tree', text: 'Dependency graph across your entire repo' },
              { icon: 'compress', text: '1M+ context window with smart ZSTD compression' },
              { icon: 'view_in_ar', text: 'Docker-sandboxed execution — no host access' },
              { icon: 'route', text: 'Frontier multi-provider routing: Claude Opus 5, GPT-6 Astra, Gemini 3.8 Flash' },
              { icon: 'shield', text: 'Automatic secret redaction before any LLM call' },
            ].map(({ icon, text }) => (
              <li key={text} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(230,242,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-primary-fixed-dim)' }}>{icon}</span>
                </div>
                <span style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'rgba(230,242,255,0.8)' }}>{text}</span>
              </li>
            ))}
          </ul>

          {/* Terminal mockup */}
          <div className="code-block" style={{ fontSize: 12, lineHeight: 1.7 }}>
            <div style={{ color: 'rgba(195,198,215,0.4)' }}>$ inflynx init</div>
            <div style={{ color: 'var(--color-tertiary-fixed)', marginTop: 4 }}>✓ Repository indexed (142 files)</div>
            <div style={{ color: 'var(--color-primary-fixed-dim)' }}>✓ Dependency graph built (0.8s)</div>
            <div style={{ color: 'var(--color-secondary-fixed-dim)' }}>✓ Agents ready to deploy</div>
          </div>
        </div>
      </div>

      {/* ═══ RIGHT: Sign Up Form ═══ */}
      <div
        className="animate-slide-right"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '48px 40px',
          overflow: 'auto',
        }}
      >
        <div style={{ width: '100%', maxWidth: 420 }}>
          <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 28, letterSpacing: '-0.02em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
            Create your account
          </h1>
          <p style={{ fontFamily: 'var(--font-inter)', fontSize: 15, color: 'var(--color-on-surface-variant)', marginBottom: 32 }}>
            Already have an account?{' '}
            <Link to="/signin" style={{ color: 'var(--color-primary)', fontWeight: 600, textDecoration: 'none' }}>Sign in</Link>
          </p>

          {/* SSO Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
            {providers.map(({ name, icon }) => (
              <button
                key={name}
                className="btn-secondary"
                style={{ justifyContent: 'center', width: '100%', fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 14 }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{icon}</span>
                Continue with {name}
              </button>
            ))}
          </div>

          {/* Divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
            <div style={{ flex: 1, height: 1, background: 'var(--color-outline-variant)' }} />
            <span style={{ fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-on-surface-variant)' }}>or continue with email</span>
            <div style={{ flex: 1, height: 1, background: 'var(--color-outline-variant)' }} />
          </div>

          {/* Plan Toggle */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 10 }}>Choose your plan</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {plans.map(({ id, label, sub, price }) => (
                <button
                  key={id}
                  onClick={() => setFormData(d => ({ ...d, plan: id }))}
                  style={{
                    padding: '12px 16px',
                    borderRadius: 10,
                    border: `2px solid ${formData.plan === id ? 'var(--color-primary)' : 'var(--color-outline-variant)'}`,
                    background: formData.plan === id ? 'rgba(0,74,198,0.06)' : 'var(--color-surface-container-lowest)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 15, color: formData.plan === id ? 'var(--color-primary)' : 'var(--color-on-surface)' }}>{label}</div>
                  <div style={{ fontFamily: 'var(--font-inter)', fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>{sub}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13, color: 'var(--color-on-surface)', marginTop: 6 }}>{price}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>Full name</label>
              <input
                className="input"
                type="text"
                placeholder="Arjun Sharma"
                required
                value={formData.name}
                onChange={e => setFormData(d => ({ ...d, name: e.target.value }))}
              />
            </div>
            <div>
              <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>Work email</label>
              <input
                className="input"
                type="email"
                placeholder="you@company.com"
                required
                value={formData.email}
                onChange={e => setFormData(d => ({ ...d, email: e.target.value }))}
              />
            </div>
            <div>
              <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  type={showPass ? 'text' : 'password'}
                  placeholder="Min. 8 characters"
                  required
                  value={formData.password}
                  onChange={e => setFormData(d => ({ ...d, password: e.target.value }))}
                  style={{ paddingRight: 44 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-on-surface-variant)', display: 'flex',
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 20 }}>{showPass ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
              {/* Password strength */}
              {formData.password.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
                  {[1, 2, 3, 4].map(i => (
                    <div
                      key={i}
                      style={{
                        flex: 1,
                        height: 3,
                        borderRadius: 9999,
                        background: formData.password.length >= i * 2
                          ? i <= 1 ? 'var(--color-error)'
                          : i <= 2 ? '#e8a020'
                          : i <= 3 ? 'var(--color-tertiary)'
                          : 'var(--color-primary)'
                          : 'var(--color-outline-variant)',
                        transition: 'background 0.3s ease',
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            <button
              type="submit"
              className="btn-primary"
              style={{
                justifyContent: 'center',
                width: '100%',
                padding: '14px',
                fontSize: 15,
                marginTop: 8,
                position: 'relative',
                opacity: loading ? 0.8 : 1,
              }}
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, animation: 'spin 0.8s linear infinite' }}>progress_activity</span>
                  Creating workspace...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>rocket_launch</span>
                  {formData.plan === 'pro' ? 'Start free trial' : 'Create free account'}
                </>
              )}
            </button>

            <p style={{ fontFamily: 'var(--font-inter)', fontSize: 12, color: 'var(--color-on-surface-variant)', textAlign: 'center', lineHeight: 1.5 }}>
              By continuing you agree to our{' '}
              <Link to="/terms" style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>Terms</Link>
              {' '}and{' '}
              <Link to="/privacy" style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>Privacy Policy</Link>.
            </p>
          </form>
        </div>
      </div>
    </div>
  )
}
