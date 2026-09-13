import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

/* ── Sidebar link component ── */
function SideLink({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="sidebar-link"
      style={{ width: '100%', border: 'none', fontFamily: 'var(--font-inter)', fontSize: 14, fontWeight: active ? 600 : 500, color: active ? 'var(--color-on-primary-container)' : 'var(--color-on-surface-variant)', background: active ? 'var(--color-primary-container)' : 'transparent', cursor: 'pointer' }}
    >
      <span className={`material-symbols-outlined ${active ? 'icon-fill' : ''}`} style={{ fontSize: 22 }}>{icon}</span>
      {label}
    </button>
  )
}

/* ── Stat Card ── */
function StatCard({ icon, label, value, accent, ping, delay }) {
  return (
    <div
      className="card animate-fade-in-up"
      style={{
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 12,
        animationDelay: delay,
        background: accent ? accent.bg : 'var(--color-surface-container-lowest)',
        border: `1px solid ${accent ? accent.border : 'var(--color-outline-variant)'}`,
        borderRadius: 12,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {accent?.glow && (
        <div style={{ position: 'absolute', top: -24, right: -24, width: 80, height: 80, background: accent.glow, borderRadius: '50%', filter: 'blur(24px)', opacity: 0.3 }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 20, color: accent?.icon || 'var(--color-on-surface-variant)' }}>{icon}</span>
        <span style={{ fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: 500, color: accent?.text || 'var(--color-on-surface-variant)' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 32, color: accent?.value || 'var(--color-on-surface)', letterSpacing: '-0.03em' }}>{value}</span>
        {ping && (
          <span style={{ position: 'relative', display: 'inline-flex', width: 12, height: 12 }}>
            <span style={{ position: 'absolute', width: '100%', height: '100%', borderRadius: '50%', background: 'var(--color-tertiary)', animation: 'ping 1s ease-in-out infinite', opacity: 0.5 }} />
            <span style={{ position: 'relative', width: 12, height: 12, borderRadius: '50%', background: 'var(--color-tertiary)', display: 'inline-flex' }} />
          </span>
        )}
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const [activeNav, setActiveNav] = useState('overview')
  const navigate = useNavigate()

  const navItems = [
    { id: 'overview', icon: 'dashboard', label: 'Overview' },
    { id: 'sessions', icon: 'memory', label: 'Agent sessions' },
    { id: 'repos', icon: 'folder_open', label: 'Repositories' },
    { id: 'usage', icon: 'insert_chart', label: 'Usage' },
    { id: 'plans', icon: 'layers', label: 'Plans' },
    { id: 'billing', icon: 'payments', label: 'Billing' },
    { id: 'settings', icon: 'settings', label: 'Settings' },
  ]

  const sessions = [
    { icon: 'terminal', color: 'var(--color-tertiary)', bg: 'rgba(0,96,86,0.08)', title: 'Fix token refresh race condition', model: 'Claude Opus 5', repo: 'core-auth-service', time: '2h ago', status: 'Completed' },
    { icon: 'shield_lock', color: 'var(--color-secondary)', bg: 'rgba(99,70,200,0.08)', title: 'Audit shell security boundaries', model: 'GPT-6 Astra', repo: 'infrastructure-as-code', time: '5h ago', status: 'Completed' },
    { icon: 'bug_report', color: 'var(--color-error)', bg: 'rgba(186,26,26,0.08)', title: 'Debug API rate limiter regression', model: 'Gemini 3.8 Flash', repo: 'gateway-service', time: 'Yesterday', status: 'In Review' },
    { icon: 'memory', color: 'var(--color-primary)', bg: 'rgba(0,74,198,0.08)', title: 'Optimize memory allocations in parser', model: 'DeepSeek V4 Flash', repo: 'core-compiler', time: '2d ago', status: 'Completed' },
  ]

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--color-background)', fontFamily: 'var(--font-inter)' }}>

      {/* ═══ SIDEBAR ═══ */}
      <nav
        style={{
          width: 260,
          position: 'fixed',
          left: 0,
          top: 0,
          height: '100%',
          background: 'var(--color-surface-container-low)',
          borderRight: '1px solid var(--color-outline-variant)',
          display: 'flex',
          flexDirection: 'column',
          padding: 16,
          gap: 4,
          zIndex: 40,
        }}
        className="animate-slide-left"
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, padding: '8px 8px 0' }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--color-surface-container-high)', border: '1px solid var(--color-outline-variant)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            <span className="material-symbols-outlined icon-fill" style={{ color: 'var(--color-primary)', fontSize: 22 }}>terminal</span>
          </div>
          <div>
            <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 16, color: 'var(--color-on-surface)' }}>Inflynx Code</div>
            <div style={{ fontFamily: 'var(--font-inter)', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>Enterprise Plan</div>
          </div>
        </div>

        {/* Nav Links */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1 }}>
          {navItems.map(({ id, icon, label }) => (
            <SideLink key={id} icon={icon} label={label} active={activeNav === id} onClick={() => setActiveNav(id)} />
          ))}
        </div>

        {/* Footer Links */}
        <div style={{ borderTop: '1px solid var(--color-outline-variant)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SideLink icon="help" label="Help Center" active={false} onClick={() => {}} />
          <SideLink icon="logout" label="Log out" active={false} onClick={() => navigate('/')} />
        </div>
      </nav>

      {/* ═══ MAIN CONTENT ═══ */}
      <main style={{ marginLeft: 260, flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>

        {/* Top Bar */}
        <header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 30,
            background: 'var(--color-surface)',
            borderBottom: '1px solid var(--color-outline-variant)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 24px',
            height: 64,
          }}
        >
          <div style={{ flex: 1, maxWidth: 400 }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <span className="material-symbols-outlined" style={{ position: 'absolute', left: 12, fontSize: 20, color: 'var(--color-on-surface-variant)' }}>search</span>
              <input
                className="input"
                placeholder="Search across workspace..."
                style={{ paddingLeft: 44, borderRadius: 9999, fontSize: 14 }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {['notifications', 'account_circle'].map(icon => (
              <button
                key={icon}
                style={{
                  width: 36, height: 36, borderRadius: '50%', background: 'none', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-on-surface-variant)',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface-container)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{icon}</span>
              </button>
            ))}
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 13, cursor: 'pointer', marginLeft: 4 }}>
              A
            </div>
          </div>
        </header>

        {/* Dashboard Content */}
        <div style={{ padding: '32px', maxWidth: 1280, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 32, flexGrow: 1 }}>

          {/* Header */}
          <section style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }} className="animate-fade-in-up">
            <div>
              <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 'clamp(24px, 3vw, 40px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)', marginBottom: 8 }}>
                Welcome back, Arjun.
              </h1>
              <p style={{ fontFamily: 'var(--font-inter)', fontSize: 17, color: 'var(--color-on-surface-variant)' }}>
                Here is your engineering activity this month.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn-secondary"
                style={{ padding: '8px 16px', fontSize: 13 }}
                onClick={() => {}}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add_link</span>
                Connect repository
              </button>
              <button
                className="btn-primary"
                style={{ padding: '8px 16px', fontSize: 13 }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add_task</span>
                New agent task
              </button>
            </div>
          </section>

          {/* Stats Grid */}
          <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
            <div style={{ gridColumn: 'span 2' }}>
              <StatCard
                icon="toll"
                label="Credits remaining"
                value="1,258"
                delay="0s"
                accent={{
                  bg: 'var(--color-primary-container)',
                  border: 'rgba(0,74,198,0.2)',
                  icon: 'var(--color-primary)',
                  text: 'var(--color-on-primary-container)',
                  value: 'var(--color-on-primary-container)',
                  glow: 'var(--color-primary)',
                }}
              />
            </div>
            <StatCard icon="data_usage" label="Credits used" value="742" delay="0.1s" />
            <StatCard icon="memory" label="Active sessions" value="3" ping delay="0.2s" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="card animate-fade-in-up" style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', animationDelay: '0.3s' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-on-surface-variant)' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>folder_open</span>
                  <span style={{ fontFamily: 'var(--font-inter)', fontSize: 13 }}>Repositories</span>
                </div>
                <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 22, color: 'var(--color-on-surface)' }}>4</span>
              </div>
              <div className="animate-fade-in-up" style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(186,26,26,0.06)', border: '1px solid rgba(186,26,26,0.15)', borderRadius: 12, animationDelay: '0.35s' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-error)' }}>bug_report</span>
                  <span style={{ fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-error)' }}>Issues found</span>
                </div>
                <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 22, color: 'var(--color-error)' }}>18</span>
              </div>
            </div>
          </section>

          {/* Charts Row */}
          <section style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
            {/* Usage Chart */}
            <div className="card animate-fade-in-up" style={{ padding: 24, animationDelay: '0.4s' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 18, color: 'var(--color-on-surface)' }}>Credit usage over time</h3>
                <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-on-surface-variant)' }}>
                  <span className="material-symbols-outlined">more_horiz</span>
                </button>
              </div>
              {/* SVG Chart */}
              <div style={{ height: 160, position: 'relative' }}>
                <svg width="100%" height="100%" viewBox="0 0 600 160" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path d="M 0 140 L 60 120 L 120 100 L 180 115 L 240 80 L 300 90 L 360 60 L 420 45 L 480 30 L 540 20 L 600 10" fill="none" stroke="var(--color-primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M 0 140 L 60 120 L 120 100 L 180 115 L 240 80 L 300 90 L 360 60 L 420 45 L 480 30 L 540 20 L 600 10 L 600 160 L 0 160 Z" fill="url(#chartGrad)" />
                  {/* Grid lines */}
                  {[40, 80, 120].map(y => (
                    <line key={y} x1="0" y1={y} x2="600" y2={y} stroke="var(--color-outline-variant)" strokeWidth="1" strokeDasharray="4,4" opacity="0.4" />
                  ))}
                  {/* Data points */}
                  {[[60,120],[180,115],[300,90],[420,45],[540,20]].map(([x,y], i) => (
                    <circle key={i} cx={x} cy={y} r="4" fill="var(--color-primary)" />
                  ))}
                </svg>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                  {['Jul', 'Aug', 'Sep', 'Oct', 'Nov'].map(m => <span key={m}>{m}</span>)}
                </div>
              </div>
            </div>

            {/* Radial Chart */}
            <div className="card animate-fade-in-up" style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', animationDelay: '0.45s' }}>
              <div style={{ alignSelf: 'stretch', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 16, color: 'var(--color-on-surface)', maxWidth: 120, lineHeight: 1.3 }}>Verification pass rate</h3>
                <span className="material-symbols-outlined" style={{ color: 'var(--color-tertiary)', fontSize: 22 }}>check_circle</span>
              </div>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="140" height="140" viewBox="0 0 160 160" style={{ transform: 'rotate(-90deg)' }}>
                  <circle cx="80" cy="80" r="64" fill="transparent" stroke="var(--color-surface-container-highest)" strokeWidth="12" />
                  <circle cx="80" cy="80" r="64" fill="transparent" stroke="var(--color-tertiary)" strokeWidth="12" strokeLinecap="round"
                    strokeDasharray={`${0.91 * 2 * Math.PI * 64} ${2 * Math.PI * 64}`}
                  />
                </svg>
                <div style={{ position: 'absolute', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 32, color: 'var(--color-on-surface)', letterSpacing: '-0.03em' }}>91%</div>
                  <span className="badge badge-success" style={{ fontSize: 11 }}>Healthy</span>
                </div>
              </div>
            </div>
          </section>

          {/* Recent Sessions */}
          <section className="card animate-fade-in-up" style={{ overflow: 'hidden', animationDelay: '0.5s' }}>
            <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--color-outline-variant)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(226,239,254,0.4)' }}>
              <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 18, color: 'var(--color-on-surface)' }}>Recent Sessions</h3>
              <button
                onClick={() => setActiveNav('sessions')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-primary)', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                View all <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
              </button>
            </div>
            {sessions.map(({ icon, color, bg, title, model, repo, time, status }, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '16px 24px',
                  borderBottom: i < sessions.length - 1 ? '1px solid var(--color-outline-variant)' : 'none',
                  cursor: 'pointer',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface-container-low)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 8, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color, transition: 'all 0.15s ease' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{icon}</span>
                  </div>
                  <div>
                    <div style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 2 }}>{title}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
                      <span>repo: {repo}</span>
                      <span>•</span>
                      <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{model}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <span
                    style={{
                      padding: '4px 12px',
                      borderRadius: 9999,
                      background: 'var(--color-surface-container)',
                      border: '1px solid var(--color-outline-variant)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--color-on-surface-variant)',
                    }}
                  >
                    {status} · {time}
                  </span>
                  <span className="material-symbols-outlined" style={{ fontSize: 20, color: 'var(--color-on-surface-variant)' }}>chevron_right</span>
                </div>
              </div>
            ))}
          </section>
        </div>
      </main>
    </div>
  )
}
