import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

/* ── Intersection Observer Hook ── */
function useInView(threshold = 0.15) {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setInView(true) }, { threshold })
    if (ref.current) obs.observe(ref.current)
    return () => obs.disconnect()
  }, [threshold])
  return [ref, inView]
}

/* ── Typewriter Component ── */
function Typewriter({ words, speed = 80, pause = 2000 }) {
  const [text, setText] = useState('')
  const [wordIdx, setWordIdx] = useState(0)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const current = words[wordIdx]
    const timeout = setTimeout(() => {
      if (!deleting) {
        setText(current.slice(0, text.length + 1))
        if (text.length + 1 === current.length) {
          setTimeout(() => setDeleting(true), pause)
        }
      } else {
        setText(current.slice(0, text.length - 1))
        if (text.length - 1 === 0) {
          setDeleting(false)
          setWordIdx((prev) => (prev + 1) % words.length)
        }
      }
    }, deleting ? speed / 2 : speed)
    return () => clearTimeout(timeout)
  }, [text, deleting, wordIdx, words, speed, pause])

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
      <span style={{ whiteSpace: 'nowrap' }}>{text}</span>
      <span
        style={{
          display: 'inline-block',
          width: '3px',
          height: '0.85em',
          background: 'var(--color-primary)',
          marginLeft: '4px',
          borderRadius: '2px',
          animation: 'blink 0.9s step-end infinite',
          flexShrink: 0,
        }}
      />
    </span>
  )
}

/* ── Animated Counter ── */
function Counter({ target, suffix = '', duration = 1500 }) {
  const [val, setVal] = useState(0)
  const [ref, inView] = useInView(0.5)
  useEffect(() => {
    if (!inView) return
    const step = target / (duration / 16)
    let curr = 0
    const timer = setInterval(() => {
      curr = Math.min(curr + step, target)
      setVal(Math.floor(curr))
      if (curr >= target) clearInterval(timer)
    }, 16)
    return () => clearInterval(timer)
  }, [inView, target, duration])
  return <span ref={ref}>{val.toLocaleString()}{suffix}</span>
}

export default function HomePage() {
  const [heroRef, heroInView] = useInView(0.1)
  const [contextRef, contextInView] = useInView(0.15)
  const [modelsRef, modelsInView] = useInView(0.15)
  const [workflowRef, workflowInView] = useInView(0.1)
  const [securityRef, securityInView] = useInView(0.15)
  const [ctaRef, ctaInView] = useInView(0.2)

  return (
    <div className="bg-grid-pattern min-h-screen" style={{ background: 'var(--color-background)' }}>
      {/* ═══════════════════════════════════════
          HERO SECTION
      ═══════════════════════════════════════ */}
      <section
        ref={heroRef}
        style={{
          maxWidth: 'var(--max-width)',
          margin: '0 auto',
          padding: '56px 24px 72px',
          display: 'flex',
          flexDirection: 'column',
          gap: 48,
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', gap: 48, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
          {/* Left: Copy */}
          <div
            style={{
              flex: '1 1 480px',
              minWidth: 320,
              display: 'flex',
              flexDirection: 'column',
              gap: 24,
              opacity: heroInView ? 1 : 0,
              transform: heroInView ? 'translateX(0)' : 'translateX(-30px)',
              transition: 'opacity 0.6s ease, transform 0.6s ease',
            }}
          >
            {/* Badge */}
            <div>
              <span
                style={{
                  background: 'rgba(0, 74, 198, 0.08)',
                  color: 'var(--color-primary)',
                  border: '1px solid rgba(0, 74, 198, 0.2)',
                  padding: '5px 14px',
                  borderRadius: 6,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>memory</span>
                Repository Intelligence Engine
              </span>
            </div>

            {/* Headline */}
            <h1
              style={{
                fontFamily: 'var(--font-geist)',
                fontWeight: 700,
                fontSize: 'clamp(32px, 4.5vw, 58px)',
                lineHeight: 1.15,
                letterSpacing: '-0.035em',
                color: 'var(--color-on-surface)',
              }}
            >
              Deep context.<br />
              <span
                style={{
                  display: 'inline-block',
                  whiteSpace: 'nowrap',
                  background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  paddingBottom: '4px',
                  minHeight: '1.25em',
                }}
              >
                <Typewriter words={['Precise execution.', 'Zero hallucinations.', 'Full autonomy.']} />
              </span>
            </h1>

            {/* Description */}
            <p
              style={{
                fontFamily: 'var(--font-inter)',
                fontSize: 17,
                lineHeight: 1.65,
                color: 'var(--color-on-surface-variant)',
                maxWidth: 520,
              }}
            >
              Inflynx Code maps your entire codebase into an interactive dependency graph, allowing AI agents to navigate, plan, and execute complex changes with deterministic accuracy.
            </p>

            {/* CTAs */}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <Link to="/signup" className="btn-primary" style={{ fontSize: 14, padding: '12px 26px' }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>rocket_launch</span>
                Deploy Agent
              </Link>
              <Link to="/docs" className="btn-secondary" style={{ fontSize: 14, padding: '12px 24px' }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>terminal</span>
                View Documentation
              </Link>
            </div>

            {/* Meta strip */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 24,
                paddingTop: 24,
                marginTop: 8,
                borderTop: '1px solid var(--color-outline-variant)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  Supported Languages
                </span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {['JS', 'TS', 'PY', 'Go'].map(lang => (
                    <span
                      key={lang}
                      style={{
                        background: 'var(--color-surface-container)',
                        border: '1px solid var(--color-outline-variant)',
                        padding: '3px 9px',
                        borderRadius: 5,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--color-on-surface)',
                      }}
                    >
                      {lang}
                    </span>
                  ))}
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--color-primary)' }}>+12 more</span>
                </div>
              </div>
              <div style={{ width: 1, height: 44, background: 'var(--color-outline-variant)' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Context Window</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 16, color: 'var(--color-primary)' }}>200k+ Tokens</span>
              </div>
            </div>
          </div>

          {/* Right: IDE Mockup */}
          <div
            style={{
              flex: '1 1 500px',
              minWidth: 320,
              maxWidth: 580,
              opacity: heroInView ? 1 : 0,
              transform: heroInView ? 'translateX(0)' : 'translateX(30px)',
              transition: 'opacity 0.8s ease 0.2s, transform 0.8s ease 0.2s',
            }}
          >
            <div
              style={{
                background: '#121d27',
                borderRadius: 14,
                border: '1px solid rgba(195, 198, 215, 0.2)',
                boxShadow: '0 24px 70px rgba(16, 29, 39, 0.35)',
                overflow: 'hidden',
                height: 560,
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
              }}
            >
              {/* IDE Window Title Bar */}
              <div
                style={{
                  height: 42,
                  background: '#0d161f',
                  borderBottom: '1px solid rgba(195, 198, 215, 0.12)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0 16px',
                  flexShrink: 0,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#ff5f56' }} />
                  <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#ffbd2e' }} />
                  <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#27c93f' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(230, 242, 255, 0.6)' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 14, color: 'var(--color-primary-fixed-dim)' }}>account_tree</span>
                  Dependency Graph: <span style={{ color: '#fff', fontWeight: 600 }}>auth_service.ts</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(0, 74, 198, 0.25)', color: 'var(--color-primary-fixed-dim)', padding: '3px 9px', borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 10, border: '1px solid rgba(0, 74, 198, 0.3)' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#27c93f', display: 'inline-block' }} />
                  Live Sync
                </div>
              </div>

              {/* Dependency Graph Canvas */}
              <div style={{ flex: 1, position: 'relative', background: '#101d27', overflow: 'hidden' }}>
                {/* Precise SVG Curved Edges */}
                <svg
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                  viewBox="0 0 540 370"
                  preserveAspectRatio="none"
                >
                  <defs>
                    <linearGradient id="edgeGrad1" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.6" />
                      <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.2" />
                    </linearGradient>
                    <linearGradient id="edgeGrad2" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="var(--color-secondary)" stopOpacity="0.8" />
                      <stop offset="100%" stopColor="var(--color-error)" stopOpacity="0.6" />
                    </linearGradient>
                  </defs>
                  {/* Root (270, 52) to Node 2 (135, 172) */}
                  <path d="M 270 72 C 270 120, 135 120, 135 150" stroke="url(#edgeGrad1)" strokeWidth="2" strokeDasharray="5 5" fill="none" />
                  {/* Root (270, 52) to Node 3 (405, 172) */}
                  <path d="M 270 72 C 270 120, 405 120, 405 148" stroke="url(#edgeGrad2)" strokeWidth="2.5" fill="none" />
                  {/* Node 2 (135, 172) to Node 4 (270, 292) */}
                  <path d="M 135 194 C 135 240, 270 240, 270 270" stroke="rgba(195, 198, 215, 0.25)" strokeWidth="2" strokeDasharray="4 4" fill="none" />
                  {/* Node 3 (405, 172) to Node 4 (270, 292) */}
                  <path d="M 405 196 C 405 240, 270 240, 270 270" stroke="rgba(195, 198, 215, 0.3)" strokeWidth="2" fill="none" />
                </svg>

                {/* Node 1 — Root */}
                <div
                  style={{
                    position: 'absolute',
                    top: 28,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: '#172736',
                    border: '1.5px solid var(--color-primary)',
                    borderRadius: 10,
                    padding: '8px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    boxShadow: '0 4px 20px rgba(0, 74, 198, 0.3)',
                    zIndex: 10,
                    minWidth: 170,
                  }}
                >
                  <div style={{ width: 30, height: 30, borderRadius: 6, background: 'rgba(0, 74, 198, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="material-symbols-outlined" style={{ color: 'var(--color-primary-fixed-dim)', fontSize: 18 }}>description</span>
                  </div>
                  <div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: '#fff' }}>auth_service.ts</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(230, 242, 255, 0.5)' }}>Exports: 4 functions</div>
                  </div>
                </div>

                {/* Node 2 — Left Dep */}
                <div
                  style={{
                    position: 'absolute',
                    top: 150,
                    left: '25%',
                    transform: 'translateX(-50%)',
                    background: '#15222e',
                    border: '1px solid rgba(195, 198, 215, 0.2)',
                    borderRadius: 10,
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    zIndex: 10,
                    minWidth: 150,
                  }}
                >
                  <span className="material-symbols-outlined" style={{ color: 'var(--color-tertiary-fixed-dim)', fontSize: 18 }}>lock</span>
                  <div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#e6f2ff' }}>token_mgr.ts</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(230, 242, 255, 0.45)' }}>Imports: 1</div>
                  </div>
                </div>

                {/* Node 3 — Right Dep (Target / Issue) */}
                <div
                  style={{
                    position: 'absolute',
                    top: 148,
                    left: '75%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(186, 26, 26, 0.08)',
                    border: '1.5px solid rgba(239, 68, 68, 0.7)',
                    borderRadius: 10,
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    boxShadow: '0 0 24px rgba(239, 68, 68, 0.25)',
                    zIndex: 10,
                    minWidth: 165,
                  }}
                >
                  <span className="material-symbols-outlined" style={{ color: '#f87171', fontSize: 18 }}>database</span>
                  <div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#fff' }}>session_store.ts</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444', animation: 'ping 1s infinite' }} />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: '#fca5a5', fontWeight: 700, textTransform: 'uppercase' }}>Race Condition</span>
                    </div>
                  </div>
                </div>

                {/* Node 4 — Bottom Dep */}
                <div
                  style={{
                    position: 'absolute',
                    top: 270,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: '#15222e',
                    border: '1px solid rgba(195, 198, 215, 0.2)',
                    borderRadius: 10,
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    zIndex: 10,
                    minWidth: 150,
                  }}
                >
                  <span className="material-symbols-outlined" style={{ color: 'rgba(195, 198, 215, 0.6)', fontSize: 18 }}>api</span>
                  <div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#e6f2ff' }}>redis_client.ts</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(230, 242, 255, 0.45)' }}>External Dep</div>
                  </div>
                </div>
              </div>

              {/* Sleek Agent Analysis Console Drawer (Bottom of IDE) */}
              <div
                style={{
                  background: '#0d161f',
                  borderTop: '1px solid rgba(195, 198, 215, 0.15)',
                  padding: '12px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  zIndex: 20,
                }}
              >
                {/* Console Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(195, 198, 215, 0.1)', paddingBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 14, color: 'var(--color-primary-fixed-dim)', animation: 'spin 2.5s linear infinite' }}>memory</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--color-primary-fixed-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Agent Intelligence Stream
                    </span>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(230, 242, 255, 0.4)' }}>
                    Response time: <span style={{ color: '#27c93f' }}>0.4s</span>
                  </div>
                </div>

                {/* Agent Logs */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(230, 242, 255, 0.8)' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{ color: 'var(--color-tertiary-fixed)' }}>&gt;</span>
                    <span>Tracing <code style={{ color: 'var(--color-primary-fixed-dim)' }}>refreshToken</code> caller graph across repo...</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{ color: 'var(--color-tertiary-fixed)' }}>&gt;</span>
                    <span>Found concurrent write potential in <span style={{ color: '#fca5a5' }}>session_store.ts:142</span></span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, background: 'rgba(0, 74, 198, 0.15)', padding: '3px 8px', borderRadius: 4, borderLeft: '2px solid var(--color-primary)' }}>
                    <span style={{ color: 'var(--color-primary-fixed-dim)' }}>&gt;</span>
                    <span style={{ fontWeight: 700, color: '#fff' }}>Proposing RWMutex lock patch in auth handler</span>
                  </div>
                </div>

                {/* Token Progress Bar */}
                <div style={{ background: '#121d27', borderRadius: 6, padding: '6px 10px', border: '1px solid rgba(195, 198, 215, 0.1)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(230, 242, 255, 0.5)', marginBottom: 4 }}>
                    <span>Context Window Assembled</span>
                    <span style={{ fontWeight: 600, color: 'var(--color-primary-fixed-dim)' }}>12,450 / 200,000 Tokens</span>
                  </div>
                  <div className="progress-bar" style={{ height: 4 }}>
                    <div className="progress-fill" style={{ width: '38%' }} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div
          style={{
            display: 'flex',
            gap: 48,
            justifyContent: 'center',
            flexWrap: 'wrap',
            padding: '32px 0',
            borderTop: '1px solid var(--color-outline-variant)',
            borderBottom: '1px solid var(--color-outline-variant)',
            width: '100%',
            opacity: heroInView ? 1 : 0,
            transform: heroInView ? 'translateY(0)' : 'translateY(20px)',
            transition: 'opacity 0.6s ease 0.4s, transform 0.6s ease 0.4s',
          }}
        >
          {[
            { value: 2400, suffix: '+', label: 'Engineers using Inflynx' },
            { value: 98, suffix: '%', label: 'Patch success rate' },
            { value: 70, suffix: '%', label: 'Token cost reduction' },
            { value: 200, suffix: 'k', label: 'Context window tokens' },
          ].map(({ value, suffix, label }) => (
            <div key={label} style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, color: 'var(--color-primary)', letterSpacing: '-0.03em' }}>
                <Counter target={value} suffix={suffix} />
              </span>
              <span style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface-variant)' }}>{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════════════════════════════════
          CONTEXT SECTION
      ═══════════════════════════════════════ */}
      <section
        ref={contextRef}
        style={{
          background: 'var(--color-surface-container)',
          borderTop: '1px solid var(--color-outline-variant)',
          borderBottom: '1px solid var(--color-outline-variant)',
          padding: '80px 24px',
        }}
      >
        <div style={{ maxWidth: 'var(--max-width)', margin: '0 auto', display: 'flex', gap: 64, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Context Window Visualizer */}
          <div
            style={{
              flex: 1,
              minWidth: 300,
              opacity: contextInView ? 1 : 0,
              transform: contextInView ? 'translateX(0)' : 'translateX(-30px)',
              transition: 'all 0.7s ease',
            }}
          >
            <div className="card" style={{ padding: 24, fontFamily: 'var(--font-mono)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--color-outline-variant)', paddingBottom: 12, marginBottom: 16, fontSize: 11, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
                <span>Context Window Management</span>
                <span style={{ background: 'var(--color-surface-container-low)', padding: '2px 8px', borderRadius: 4 }}>200K Limit</span>
              </div>
              {[
                { label: 'Pinned Files', pct: 15, width: '15%', color: 'var(--color-primary)', val: '30k' },
                { label: 'Symbol Graph', pct: 35, width: '35%', color: 'var(--color-secondary)', val: '70k' },
                { label: 'Auto-compressed', pct: 25, width: '45%', color: 'var(--color-tertiary)', val: '45k' },
              ].map(({ label, width, color, val }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <div style={{ width: 96, fontSize: 12, textAlign: 'right', color: 'var(--color-on-surface-variant)' }}>{label}</div>
                  <div style={{ flex: 1, background: 'var(--color-surface-container-low)', borderRadius: 9999, height: 16, overflow: 'hidden', border: '1px solid var(--color-outline-variant)' }}>
                    <div style={{ width, height: '100%', background: color, borderRadius: 9999, transition: 'width 1s ease' }} />
                  </div>
                  <div style={{ width: 48, fontSize: 12, textAlign: 'right' }}>{val}</div>
                </div>
              ))}
              <div style={{ borderTop: '1px dashed var(--color-outline-variant)', paddingTop: 12, marginTop: 4, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 96, fontSize: 12, textAlign: 'right', fontWeight: 700, color: 'var(--color-on-surface)' }}>Total Usage</div>
                <div style={{ flex: 1 }}>
                  <div className="progress-bar"><div className="progress-fill" style={{ width: '72%' }} /></div>
                </div>
                <div style={{ width: 48, fontSize: 12, textAlign: 'right', fontWeight: 700 }}>145k</div>
              </div>
            </div>
          </div>

          {/* Copy */}
          <div
            style={{
              flex: 1,
              minWidth: 300,
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              opacity: contextInView ? 1 : 0,
              transform: contextInView ? 'translateX(0)' : 'translateX(30px)',
              transition: 'all 0.7s ease 0.2s',
            }}
          >
            <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 'clamp(28px, 4vw, 44px)', lineHeight: 1.18, letterSpacing: '-0.02em', color: 'var(--color-on-surface)' }}>
              Intelligent Context<br />Resolution.
            </h2>
            <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
              Don't waste tokens blindly dumping files. Inflynx Code uses AST parsing and symbol resolution to pack exactly what the agent needs—and nothing it doesn't.
            </p>
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { icon: 'push_pin', color: 'var(--color-primary)', label: 'Pinned Context', desc: 'User-selected critical paths locked in memory.' },
                { icon: 'compress', color: 'var(--color-secondary)', label: 'Auto-Compression', desc: 'Distant dependencies minified to interface signatures.' },
                { icon: 'schema', color: 'var(--color-tertiary)', label: 'Semantic Graph', desc: 'Full AST maps provided without raw text bloat.' },
              ].map(({ icon, color, label, desc }) => (
                <li key={icon} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, fontFamily: 'var(--font-mono)', fontSize: 14 }}>
                  <span className="material-symbols-outlined" style={{ color, fontSize: 20, flexShrink: 0, marginTop: 2 }}>{icon}</span>
                  <span><strong>{label}:</strong> {desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════
          MULTI-PROVIDER SECTION
      ═══════════════════════════════════════ */}
      <section
        ref={modelsRef}
        style={{
          background: 'var(--color-surface-container-lowest)',
          borderBottom: '1px solid var(--color-outline-variant)',
          padding: '80px 24px',
        }}
      >
        <div style={{ maxWidth: 'var(--max-width)', margin: '0 auto', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 48 }}>
          <div
            style={{
              maxWidth: 640,
              opacity: modelsInView ? 1 : 0,
              transform: modelsInView ? 'translateY(0)' : 'translateY(20px)',
              transition: 'all 0.6s ease',
            }}
          >
            <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 'clamp(28px, 4vw, 44px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)', marginBottom: 16 }}>
              Model Agnostic Execution.
            </h2>
            <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
              Different tasks require different cognitive architectures. Route sub-tasks between Claude, Gemini, and DeepSeek within a single session seamlessly.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, width: '100%' }}>
            {[
              { letter: 'C', label: 'Claude 3.5 Sonnet', desc: 'Best for complex architectural planning and precise refactoring.', tag: '@claude-plan', color: 'var(--color-secondary)', barColor: 'var(--color-secondary-container)', delay: '0s' },
              { letter: 'G', label: 'Gemini 2.5 Pro', desc: 'Best for massive context analysis and cross-repo symbol tracing.', tag: '@gemini-search', color: 'var(--color-primary)', barColor: 'var(--color-primary)', delay: '0.15s' },
              { letter: 'D', label: 'DeepSeek Coder V2', desc: 'Best for rapid, low-latency implementation of isolated functions.', tag: '@deepseek-impl', color: 'var(--color-tertiary)', barColor: 'var(--color-tertiary)', delay: '0.3s' },
            ].map(({ letter, label, desc, tag, color, barColor, delay }) => (
              <div
                key={label}
                className="card"
                style={{
                  padding: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  textAlign: 'center',
                  gap: 16,
                  position: 'relative',
                  overflow: 'hidden',
                  opacity: modelsInView ? 1 : 0,
                  transform: modelsInView ? 'translateY(0)' : 'translateY(30px)',
                  transition: `all 0.6s ease ${delay}`,
                }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: barColor }} />
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: `${color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 20, color }}>
                  {letter}
                </div>
                <h3 style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 16, color: 'var(--color-on-surface)' }}>{label}</h3>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface-variant)', lineHeight: 1.6 }}>{desc}</p>
                <div style={{ marginTop: 'auto', width: '100%', borderTop: '1px solid var(--color-outline-variant)', paddingTop: 16, display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
                  <span>Routing Tag</span>
                  <span style={{ background: 'var(--color-surface-container-highest)', padding: '2px 8px', borderRadius: 4 }}>{tag}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════
          WORKFLOW TIMELINE
      ═══════════════════════════════════════ */}
      <section
        ref={workflowRef}
        style={{
          maxWidth: 'var(--max-width)',
          margin: '0 auto',
          padding: '80px 24px',
        }}
      >
        <div
          style={{
            textAlign: 'center',
            marginBottom: 56,
            opacity: workflowInView ? 1 : 0,
            transform: workflowInView ? 'translateY(0)' : 'translateY(20px)',
            transition: 'all 0.6s ease',
          }}
        >
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 'clamp(28px, 4vw, 44px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)', marginBottom: 12 }}>
            The Anatomy of a Safe Change
          </h2>
          <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, color: 'var(--color-on-surface-variant)' }}>
            A deterministic workflow for non-deterministic AI.
          </p>
        </div>

        <div style={{ maxWidth: 800, margin: '0 auto', position: 'relative' }}>
          {/* Timeline vertical line */}
          <div style={{ position: 'absolute', left: 24, top: 0, bottom: 0, width: 1, background: 'var(--color-outline-variant)' }} />

          {[
            {
              phase: 'Phase 1: Explore', icon: 'search', color: 'var(--color-primary)',
              desc: 'Agent maps the repository structure and identifies dependencies required for the change.',
              code: '> inflynx explore ./src/auth\nScanning 142 files...\nFound 3 entry points, 12 internal deps.',
              delay: '0s',
            },
            {
              phase: 'Phase 2: Plan', icon: 'architecture', color: 'var(--color-secondary)',
              desc: 'Agent drafts a step-by-step execution plan for human review before any code is modified.',
              code: 'EXECUTION PLAN\n[ ] 1. Update `auth_service.ts`\n[ ] 2. Modify `token_mgr.ts` types\n[ ] 3. Add tests to `auth.spec.ts`',
              delay: '0.15s',
            },
            {
              phase: 'Phase 3: Verify', icon: 'verified', color: 'var(--color-tertiary)',
              desc: 'Code is applied in an isolated sandbox, tests are run, and a diff is presented for final approval.',
              code: 'Sandbox Exec         PASS\nRunning `npm run test:auth`...\n✓ 14 passing (42ms)\n✓ 0 vulnerabilities found',
              delay: '0.3s',
            },
          ].map(({ phase, icon, color, desc, code, delay }, i) => (
            <div
              key={phase}
              style={{
                display: 'flex',
                gap: 24,
                marginBottom: 48,
                paddingLeft: 64,
                position: 'relative',
                opacity: workflowInView ? 1 : 0,
                transform: workflowInView ? 'translateX(0)' : 'translateX(-20px)',
                transition: `all 0.6s ease ${delay}`,
              }}
            >
              {/* Circle */}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: 48,
                  height: 48,
                  borderRadius: '50%',
                  background: 'var(--color-surface-container-lowest)',
                  border: `2px solid ${color}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                  zIndex: 10,
                }}
              >
                <span className="material-symbols-outlined" style={{ color, fontSize: 22 }}>{icon}</span>
              </div>

              {/* Content */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, marginTop: 6 }}>
                <h3 style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 18, color: 'var(--color-on-surface)' }}>{phase}</h3>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface-variant)', lineHeight: 1.6 }}>{desc}</p>
                <div className="code-block" style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                  {code}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════════════════════════════════
          SECURITY SECTION (dark bg)
      ═══════════════════════════════════════ */}
      <section
        ref={securityRef}
        id="security"
        style={{
          background: 'var(--color-inverse-surface)',
          color: 'var(--color-inverse-on-surface)',
          borderTop: '1px solid var(--color-outline-variant)',
          borderBottom: '1px solid var(--color-outline-variant)',
          padding: '80px 24px',
        }}
      >
        <div style={{ maxWidth: 'var(--max-width)', margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 64, alignItems: 'center' }}>
          {/* Left: Copy */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 28,
              opacity: securityInView ? 1 : 0,
              transform: securityInView ? 'translateX(0)' : 'translateX(-30px)',
              transition: 'all 0.7s ease',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-tertiary-fixed)', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>shield</span>
                Enterprise Grade
              </div>
              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 'clamp(28px, 4vw, 44px)', letterSpacing: '-0.02em', lineHeight: 1.18 }}>
                Security &amp; Compliance<br />By Default.
              </h2>
            </div>
            <p style={{ fontFamily: 'var(--font-inter)', fontSize: 17, lineHeight: 1.65, opacity: 0.8 }}>
              Never worry about exposing secrets or running unverified AI-generated code on your host machine.
            </p>
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 20 }}>
              {[
                { icon: 'lock_person', title: 'Automated Secret Redaction', desc: 'API keys, tokens, and PII are scrubbed from context windows before hitting any LLM provider.' },
                { icon: 'view_in_ar', title: 'Sandboxed Execution', desc: 'All agent terminal commands run in ephemeral Docker containers with zero host access.' },
                { icon: 'history', title: 'Immutable Audit Logs', desc: 'Every prompt, response, and executed command is logged cryptographically for SOC2 compliance.' },
              ].map(({ icon, title, desc }) => (
                <li key={icon} style={{ display: 'flex', gap: 16, borderBottom: '1px solid rgba(195,198,215,0.15)', paddingBottom: 20 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 8, background: 'rgba(230,242,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 20 }}>{icon}</span>
                  </div>
                  <div>
                    <h4 style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{title}</h4>
                    <p style={{ fontFamily: 'var(--font-inter)', fontSize: 13, lineHeight: 1.6, opacity: 0.6 }}>{desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Right: Audit Log Terminal */}
          <div
            style={{
              opacity: securityInView ? 1 : 0,
              transform: securityInView ? 'translateX(0)' : 'translateX(30px)',
              transition: 'all 0.7s ease 0.2s',
            }}
          >
            <div style={{ background: '#0a1520', borderRadius: 12, border: '1px solid rgba(195,198,215,0.15)', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.4)', position: 'relative' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: 'linear-gradient(90deg, var(--color-tertiary-fixed), var(--color-primary-fixed-dim))' }} />
              <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(195,198,215,0.1)', display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(195,198,215,0.5)' }}>
                <span>audit_log.jsonl</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-tertiary-fixed)', display: 'inline-block', animation: 'ping 1s ease-in-out infinite' }} />
                  STREAMING
                </span>
              </div>
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {[
                  { time: '14:02:11', tag: '[SECRETS]', tagColor: 'var(--color-tertiary-fixed)', text: 'Redacted `AWS_ACCESS_KEY` from prompt payload.' },
                  { time: '14:02:12', tag: '[ROUTING]', tagColor: 'var(--color-primary-fixed-dim)', text: 'Dispatching to Claude 3.5 Sonnet (us-east-1).' },
                  { time: '14:02:18', tag: '[SANDBOX]', tagColor: 'var(--color-secondary-fixed-dim)', text: 'Container `inflynx-exec-49f2` created. Network: None.' },
                  { time: '14:02:19', tag: '[SANDBOX]', tagColor: 'var(--color-secondary-fixed-dim)', text: "Executed: `npm run lint`. Status: 0." },
                  { time: '14:02:22', tag: '[APPROVE]', tagColor: 'var(--color-primary-fixed-dim)', text: 'User `admin@org.com` signed off on patch `f4a81b`.', highlight: true },
                ].map(({ time, tag, tagColor, text, highlight }, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      gap: 10,
                      color: 'rgba(230,242,255,0.7)',
                      ...(highlight ? { background: 'rgba(0,74,198,0.1)', margin: '0 -20px', padding: '6px 20px', borderLeft: '2px solid var(--color-primary-fixed-dim)' } : {}),
                    }}
                  >
                    <span style={{ color: 'rgba(195,198,215,0.4)', flexShrink: 0 }}>{time}</span>
                    <span style={{ color: tagColor, flexShrink: 0 }}>{tag}</span>
                    <span style={{ color: highlight ? 'var(--color-inverse-on-surface)' : undefined }}>{text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════
          CTA SECTION
      ═══════════════════════════════════════ */}
      <section
        ref={ctaRef}
        style={{
          background: 'var(--color-surface-container)',
          borderBottom: '1px solid var(--color-outline-variant)',
          padding: '80px 24px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            maxWidth: 640,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 32,
            opacity: ctaInView ? 1 : 0,
            transform: ctaInView ? 'translateY(0)' : 'translateY(20px)',
            transition: 'all 0.6s ease',
          }}
        >
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 'clamp(28px, 4vw, 44px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)', lineHeight: 1.2 }}>
            Make your next code change with confidence.
          </h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Link to="/signup" className="btn-primary" style={{ fontSize: 15, padding: '14px 32px' }}>
              Initialize Workspace
            </Link>
            <Link to="/pricing" className="btn-secondary" style={{ fontSize: 15, padding: '14px 32px' }}>
              View Pricing
            </Link>
          </div>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
            No credit card required. Free tier available.
          </p>
        </div>
      </section>
    </div>
  )
}
