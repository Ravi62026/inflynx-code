import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

function useInView(threshold = 0.1) {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setInView(true) }, { threshold })
    if (ref.current) obs.observe(ref.current)
    return () => obs.disconnect()
  }, [threshold])
  return [ref, inView]
}

const features = [
  {
    icon: 'account_tree',
    title: 'Dependency Graph Engine',
    category: 'Core Engine',
    desc: 'Inflynx parses your entire repository into an AST-based dependency graph. Every symbol, every import, every call chain — visible and queryable by the agent.',
    details: ['Cross-file symbol resolution', 'Circular dependency detection', 'Export/import relationship map', 'Live sync on file change'],
    color: 'var(--color-primary)',
    mockup: 'graph',
  },
  {
    icon: 'compress',
    title: 'Intelligent Context Packing',
    category: 'Context Engine',
    desc: 'The agent never blindly dumps files into context. Inflynx uses proximity scoring, semantic distance, and compression to serve exactly the right context at the right moment.',
    details: ['ZSTD compression for distant deps', 'Pinned file priority system', 'Token budget enforcement', 'Auto-summarization of stale context'],
    color: 'var(--color-secondary)',
    mockup: 'context',
  },
  {
    icon: 'architecture',
    title: 'Plan → Verify → Apply',
    category: 'Safety Layer',
    desc: 'AI-generated code is never blindly committed. Every change goes through a 3-phase pipeline: structured planning, sandbox verification, and human-gated application.',
    details: ['Structured JSON execution plans', 'Ephemeral Docker sandboxes', 'Test-runner integration', 'Cryptographic diff signing'],
    color: 'var(--color-tertiary)',
    mockup: 'pipeline',
  },
  {
    icon: 'route',
    title: 'Multi-Provider Routing',
    category: 'Model Gateway',
    desc: 'Send different subtasks to different models within a single agentic session. Planning to Claude, search to Gemini, implementation to DeepSeek — all with one command.',
    details: ['Per-task model selection', 'Provider fallback chains', 'Cost-aware routing heuristics', 'BYOK for all providers'],
    color: 'var(--color-primary)',
    mockup: 'routing',
  },
  {
    icon: 'terminal',
    title: '14 Built-in Slash Commands',
    category: 'Developer UX',
    desc: 'From /plan to /debug to /graph — a rich CLI command palette gives developers precise control over what the agent does, when, and with what context.',
    details: ['/plan — generate execution plan', '/debug — code review mode', '/graph — visualize dependencies', '/compress — reduce context size'],
    color: 'var(--color-secondary)',
    mockup: 'cli',
  },
  {
    icon: 'shield',
    title: 'Enterprise Security',
    category: 'Security',
    desc: 'Secret redaction, immutable audit logs, and sandboxed execution are first-class citizens — not afterthoughts. Every session is cryptographically signed.',
    details: ['Automated PII / secret scrubbing', 'Network-isolated Docker containers', 'SOC2-compliant audit trails', 'Role-based access control'],
    color: 'var(--color-tertiary)',
    mockup: 'security',
  },
]

const mockups = {
  graph: (
    <div style={{ padding: 16, position: 'relative', height: 200 }}>
      <svg width="100%" height="100%" viewBox="0 0 400 200" style={{ overflow: 'visible' }}>
        {/* Edges */}
        {[
          ['180 40', '80 120'], ['180 40', '280 120'],
          ['280 120', '180 180'], ['80 120', '180 180'],
        ].map(([from, to], i) => (
          <path key={i} d={`M ${from} L ${to}`} stroke="var(--color-outline-variant)" strokeWidth="1.5" fill="none" />
        ))}
        {/* Nodes */}
        {[
          { x: 155, y: 20, label: 'auth.ts', color: 'var(--color-primary)' },
          { x: 55, y: 100, label: 'token.ts', color: 'rgba(195,198,215,0.6)' },
          { x: 255, y: 100, label: 'store.ts', color: 'var(--color-error)' },
          { x: 155, y: 160, label: 'redis.ts', color: 'rgba(195,198,215,0.4)' },
        ].map(({ x, y, label, color }) => (
          <g key={label}>
            <rect x={x} y={y} width={70} height={28} rx={6} fill="white" stroke={color} strokeWidth="1.5" />
            <text x={x + 35} y={y + 18} textAnchor="middle" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fill: 'var(--color-on-surface)' }}>{label}</text>
          </g>
        ))}
      </svg>
    </div>
  ),
  context: (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {[
        { label: 'Pinned Files', w: '20%', color: 'var(--color-primary)' },
        { label: 'Symbol Graph', w: '40%', color: 'var(--color-secondary)' },
        { label: 'Compressed', w: '30%', color: 'var(--color-tertiary)' },
        { label: 'Remaining', w: '10%', color: 'var(--color-outline-variant)' },
      ].map(({ label, w, color }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <div style={{ width: 88, textAlign: 'right', color: 'var(--color-on-surface-variant)' }}>{label}</div>
          <div style={{ flex: 1, height: 14, background: 'var(--color-surface-container-high)', borderRadius: 9999, overflow: 'hidden' }}>
            <div style={{ width: w, height: '100%', background: color, borderRadius: 9999 }} />
          </div>
        </div>
      ))}
    </div>
  ),
  pipeline: (
    <div style={{ padding: 16, display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
      {['Explore', 'Plan', 'Sandbox', 'Apply'].map((step, i, arr) => (
        <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', border: `2px solid ${'var(--color-tertiary)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface-container-lowest)' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 20, color: 'var(--color-tertiary)' }}>
                {['search', 'architecture', 'view_in_ar', 'check_circle'][i]}
              </span>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{step}</span>
          </div>
          {i < arr.length - 1 && <div style={{ width: 24, height: 1, background: 'var(--color-outline-variant)', margin: '0 4px 20px' }} />}
        </div>
      ))}
    </div>
  ),
  routing: (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[
        { tag: '@claude-plan', task: 'Architectural refactor', color: 'var(--color-secondary)' },
        { tag: '@gemini-search', task: 'Cross-repo symbol search', color: 'var(--color-primary)' },
        { tag: '@deepseek-impl', task: 'Isolated fn implementation', color: 'var(--color-tertiary)' },
      ].map(({ tag, task, color }) => (
        <div key={tag} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--color-surface-container)', borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <span style={{ color: 'var(--color-on-surface-variant)' }}>{task}</span>
          <span style={{ background: `${color}15`, color, border: `1px solid ${color}30`, padding: '2px 8px', borderRadius: 4 }}>{tag}</span>
        </div>
      ))}
    </div>
  ),
  cli: (
    <div className="code-block" style={{ margin: 16, fontSize: 12 }}>
      <div style={{ color: 'var(--color-outline-variant)' }}># inflynx v2.4.0</div>
      <div style={{ color: 'var(--color-tertiary-fixed)', marginTop: 8 }}>&gt; <span style={{ color: 'var(--color-primary-fixed-dim)' }}>/plan</span> migrate auth to OAuth2</div>
      <div style={{ color: 'rgba(230,242,255,0.5)' }}>Analysing 38 files...</div>
      <div style={{ color: 'var(--color-tertiary-fixed)' }}>Plan ready — 6 steps · 4 files</div>
      <div style={{ color: 'var(--color-secondary-fixed-dim)', marginTop: 4 }}>[Approve? y/n]</div>
    </div>
  ),
  security: (
    <div className="code-block" style={{ margin: 16, fontSize: 11 }}>
      {[
        { tag: '[SECRETS]', color: 'var(--color-tertiary-fixed)', text: 'Scrubbed AWS_SECRET_KEY' },
        { tag: '[SANDBOX]', color: 'var(--color-secondary-fixed-dim)', text: 'Container network=None' },
        { tag: '[AUDIT]', color: 'var(--color-primary-fixed-dim)', text: 'Signed patch hash a3f891' },
      ].map(({ tag, color, text }) => (
        <div key={tag} style={{ display: 'flex', gap: 8, marginBottom: 6, color: 'rgba(230,242,255,0.7)' }}>
          <span style={{ color }}>{tag}</span>
          <span>{text}</span>
        </div>
      ))}
    </div>
  ),
}

/* FeatureSection extracted to avoid calling hook inside .map() */
function FeatureSection({ feature, index, mockups }) {
  const { icon, title, category, desc, details, color, mockup } = feature
  const [ref, inView] = useInView(0.15)
  const isEven = index % 2 === 0
  return (
    <section
      ref={ref}
      style={{
        background: isEven ? 'var(--color-surface-container-lowest)' : 'var(--color-surface-container)',
        borderTop: '1px solid var(--color-outline-variant)',
        padding: '80px 24px',
      }}
    >
      <div style={{ maxWidth: 'var(--max-width)', margin: '0 auto', display: 'flex', gap: 64, alignItems: 'center', flexWrap: 'wrap', flexDirection: isEven ? 'row' : 'row-reverse' }}>
        <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 20, opacity: inView ? 1 : 0, transform: inView ? 'translateX(0)' : `translateX(${isEven ? '-30px' : '30px'})`, transition: 'all 0.7s ease' }}>
          <div>
            <span className="badge" style={{ background: `${color}15`, color, border: `1px solid ${color}30`, marginBottom: 16, fontSize: 11 }}>{category}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 10, background: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="material-symbols-outlined" style={{ color, fontSize: 24 }}>{icon}</span>
              </div>
              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 'clamp(22px, 3vw, 32px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)' }}>{title}</h2>
            </div>
          </div>
          <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>{desc}</p>
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {details.map(d => (
              <li key={d} style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                <span className="material-symbols-outlined icon-fill" style={{ fontSize: 18, color: 'var(--color-tertiary)', flexShrink: 0 }}>check_circle</span>
                {d}
              </li>
            ))}
          </ul>
        </div>
        <div style={{ flex: 1, minWidth: 280, maxWidth: 440, opacity: inView ? 1 : 0, transform: inView ? 'translateX(0) scale(1)' : `translateX(${isEven ? '30px' : '-30px'}) scale(0.96)`, transition: 'all 0.7s ease 0.15s' }}>
          <div style={{ background: 'var(--color-surface-container-lowest)', border: `1px solid ${color}30`, borderTop: `3px solid ${color}`, borderRadius: 12, overflow: 'hidden', boxShadow: `0 8px 40px ${color}15` }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-outline-variant)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="material-symbols-outlined" style={{ color, fontSize: 18 }}>{icon}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface)' }}>{title}</span>
            </div>
            {mockups[mockup]}
          </div>
        </div>
      </div>
    </section>
  )
}

export default function FeaturesPage() {
  const [heroRef, heroInView] = useInView(0.1)

  return (
    <div style={{ background: 'var(--color-background)', minHeight: '100vh' }}>

      {/* Hero */}
      <section ref={heroRef} style={{ maxWidth: 'var(--max-width)', margin: '0 auto', padding: '72px 24px 48px', textAlign: 'center' }}>
        <div style={{ opacity: heroInView ? 1 : 0, transform: heroInView ? 'translateY(0)' : 'translateY(24px)', transition: 'all 0.6s ease', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
          <span className="badge badge-primary">Features</span>
          <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(36px, 6vw, 64px)', letterSpacing: '-0.04em', color: 'var(--color-on-surface)', lineHeight: 1.1, maxWidth: 800 }}>
            Everything your agent needs.<br />Nothing it doesn't.
          </h1>
          <p style={{ fontFamily: 'var(--font-inter)', fontSize: 18, color: 'var(--color-on-surface-variant)', maxWidth: 540, lineHeight: 1.65 }}>
            A precision-engineered platform for autonomous code intelligence. Built for teams that can't afford hallucinations.
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            <Link to="/signup" className="btn-primary">Start deploying agents</Link>
            <Link to="/pricing" className="btn-secondary">View pricing</Link>
          </div>
        </div>
      </section>

      {/* Feature Sections */}
      {features.map((feature, i) => (
        <FeatureSection key={feature.title} feature={feature} index={i} mockups={mockups} />
      ))}

      {/* CTA */}
      <section style={{ padding: '80px 24px', textAlign: 'center', background: 'var(--color-surface-container)' }}>
        <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 'clamp(28px, 4vw, 44px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)', lineHeight: 1.2 }}>
            Ready to deploy your first agent?
          </h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Link to="/signup" className="btn-primary" style={{ padding: '14px 32px' }}>Get started free</Link>
            <Link to="/pricing" className="btn-secondary" style={{ padding: '14px 32px' }}>See plans</Link>
          </div>
        </div>
      </section>
    </div>
  )
}
