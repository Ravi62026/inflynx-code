import { useState } from 'react'
import { Link } from 'react-router-dom'

export default function SecurityPage() {
  const [sampleInput, setSampleInput] = useState(
    'Connect to postgresql://admin:super_secret_pw@db.internal:5432/prod using AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and gh_token=ghp_ABC1234567890XYZ'
  )

  // Simulation of secret redaction
  const getRedacted = (str) => {
    return str
      .replace(/AWS_SECRET_ACCESS_KEY=[A-Za-z0-9/+=]{30,}/g, 'AWS_SECRET_ACCESS_KEY=[REDACTED_AWS_SECRET]')
      .replace(/ghp_[A-Za-z0-9]{15,}/g, '[REDACTED_GITHUB_PAT]')
      .replace(/postgresql:\/\/[^:]+:[^@]+@/g, 'postgresql://[USER]:[REDACTED_PASSWORD]@')
  }

  const securityPillars = [
    {
      icon: 'lock_person',
      title: 'Automated Secret Redaction',
      badge: 'Zero Exposure',
      color: 'var(--color-primary)',
      desc: 'High-speed heuristic and Shannon entropy scanners strip API tokens, SSH keys, private keys, database credentials, and PII from prompts before any LLM provider receives them.',
      checks: ['Entropy-based credential detection', 'AWS, GCP, GitHub, Slack, & Stripe secret patterns', 'Zero local disk caching of raw credentials', 'Redacted audit log mirroring'],
    },
    {
      icon: 'view_in_ar',
      title: 'Network-Isolated Sandboxes',
      badge: 'Zero Network',
      color: 'var(--color-secondary)',
      desc: 'All test runners, code modifications, and package audits run inside disposable Docker containers isolated from the host filesystem with all outbound network sockets blocked.',
      checks: ['Strict --network none isolation', 'Ephemeral tmpfs file systems', 'Non-root container execution', 'CPU and memory quota enforcement'],
    },
    {
      icon: 'policy',
      title: 'PathGuard & CommandPolicy',
      badge: 'Strict Policy',
      color: 'var(--color-error)',
      desc: 'Agent tools are constrained by kernel-level path guards that prohibit directory traversal outside the active workspace, blocking destructive commands like `rm -rf` and forced Git pushes.',
      checks: ['Path traversal containment (prevents ../../../ escaping)', 'Destructive shell command blocking', 'Strict Read-Only tool concurrency', 'Human-in-the-loop signoff required for mutations'],
    },
    {
      icon: 'verified_user',
      title: 'Cryptographic Diff Signing',
      badge: 'Tamper-Evident',
      color: 'var(--color-tertiary)',
      desc: 'Every file modification produces a canonical unified diff that is cryptographically hashed with SHA-256 and signed before application, creating an immutable audit trail.',
      checks: ['SHA-256 canonical diff hashing', 'Immutable append-only JSONL audit logs', 'Author attribution and approval timestamps', 'Deterministic rollback checkpoints'],
    },
  ]

  const complianceStandards = [
    { title: 'SOC2 Type II Ready', desc: 'Immutable audit logs, role-based access control, and zero credential retention.', icon: 'verified' },
    { title: 'BYOK First', desc: 'Bring Your Own Keys directly. Keys never touch Inflynx servers.', icon: 'key' },
    { title: 'GDPR & CCPA Compliant', desc: 'Zero data training policy. Your repository code is never used to train models.', icon: 'gavel' },
    { title: 'Air-Gapped Ready', desc: 'Deploy on-premise with local Ollama or vLLM clusters without internet access.', icon: 'cloud_off' },
  ]

  return (
    <div style={{ background: 'var(--color-background)', minHeight: '100vh', fontFamily: 'var(--font-inter)' }}>
      {/* ═══ HERO SECTION ═══ */}
      <section
        style={{
          maxWidth: 'var(--max-width)',
          margin: '0 auto',
          padding: '64px 24px 48px',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 24,
        }}
        className="animate-fade-in-up"
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 16px',
            borderRadius: 9999,
            background: 'rgba(0, 96, 86, 0.08)',
            border: '1px solid rgba(0, 96, 86, 0.2)',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'var(--color-tertiary)',
          }}
        >
          <span className="material-symbols-outlined icon-fill" style={{ fontSize: 16 }}>shield_lock</span>
          Enterprise Security & Zero Trust Architecture
        </div>

        <h1
          style={{
            fontFamily: 'var(--font-geist)',
            fontWeight: 700,
            fontSize: 'clamp(32px, 5vw, 56px)',
            lineHeight: 1.15,
            letterSpacing: '-0.03em',
            color: 'var(--color-on-surface)',
            maxWidth: 900,
          }}
        >
          Security by Mathematical Guarantee. Not Trust.
        </h1>

        <p
          style={{
            fontFamily: 'var(--font-inter)',
            fontSize: 'clamp(16px, 2vw, 19px)',
            lineHeight: 1.65,
            color: 'var(--color-on-surface-variant)',
            maxWidth: 780,
          }}
        >
          Autonomous agents must never have unfettered access to production machines or private keys.
          Inflynx Code wraps every agent operation in a multi-layered cryptographic and sandbox containment perimeter.
        </p>

        {/* Security Badges */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', marginTop: 12 }}>
          {['Zero Key Storage', 'Zero Model Training', 'Network-Isolated Docker', 'Cryptographic Signatures'].map(b => (
            <span
              key={b}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-on-surface)',
                background: 'var(--color-surface-container)',
                border: '1px solid var(--color-outline-variant)',
                padding: '6px 14px',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span className="material-symbols-outlined icon-fill" style={{ fontSize: 16, color: 'var(--color-tertiary)' }}>check_circle</span>
              {b}
            </span>
          ))}
        </div>
      </section>

      {/* ═══ INTERACTIVE LIVE REDACTION SIMULATOR ═══ */}
      <section
        style={{
          maxWidth: 'var(--max-width)',
          margin: '0 auto',
          padding: '0 24px 72px',
        }}
      >
        <div
          style={{
            background: '#0a1520',
            borderRadius: 16,
            border: '1px solid rgba(195,198,215,0.15)',
            overflow: 'hidden',
            boxShadow: '0 24px 60px rgba(0,0,0,0.3)',
          }}
        >
          <div
            style={{
              padding: '16px 24px',
              background: '#071018',
              borderBottom: '1px solid rgba(195,198,215,0.1)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f56' }} />
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e' }} />
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#27c93f' }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'rgba(230,242,255,0.7)', marginLeft: 8 }}>
                Live Secret Redaction Engine (Pre-LLM Pipeline)
              </span>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-tertiary-fixed)', background: 'rgba(0,96,86,0.2)', padding: '3px 10px', borderRadius: 4 }}>
              Active Filter: STRICT
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 1 }}>
            {/* Left: Raw Prompt Input */}
            <div style={{ padding: 24, borderRight: '1px solid rgba(195,198,215,0.1)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(195,198,215,0.6)', textTransform: 'uppercase' }}>
                  Raw Developer Input / File Context
                </span>
                <button
                  onClick={() => setSampleInput('Connect to postgresql://admin:super_secret_pw@db.internal:5432/prod using AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and gh_token=ghp_ABC1234567890XYZ')}
                  style={{ background: 'none', border: 'none', color: 'var(--color-primary-fixed-dim)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}
                >
                  Reset Sample
                </button>
              </div>
              <textarea
                value={sampleInput}
                onChange={(e) => setSampleInput(e.target.value)}
                style={{
                  width: '100%',
                  height: 140,
                  background: 'rgba(230,242,255,0.04)',
                  border: '1px solid rgba(195,198,215,0.15)',
                  borderRadius: 8,
                  padding: 14,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  color: '#e6f2ff',
                  lineHeight: 1.6,
                  resize: 'none',
                }}
              />
              <span style={{ fontFamily: 'var(--font-inter)', fontSize: 12, color: 'rgba(195,198,215,0.5)' }}>
                Try typing an API key, database URI, or secret token above.
              </span>
            </div>

            {/* Right: Sanitized LLM Prompt */}
            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, background: 'rgba(0,0,0,0.2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-tertiary-fixed)', textTransform: 'uppercase' }}>
                  Sanitized Payload Emitted to LLM
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(195,198,215,0.5)' }}>
                  0 Secrets Leaked
                </span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 140,
                  background: 'rgba(0,96,86,0.06)',
                  border: '1px solid rgba(0,96,86,0.2)',
                  borderRadius: 8,
                  padding: 14,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  color: 'var(--color-tertiary-fixed)',
                  lineHeight: 1.6,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {getRedacted(sampleInput)}
              </div>
              <span style={{ fontFamily: 'var(--font-inter)', fontSize: 12, color: 'rgba(195,198,215,0.5)' }}>
                Tokens replaced locally before socket transmission.
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ═══ FOUR SECURITY PILLARS ═══ */}
      <section
        style={{
          background: 'var(--color-surface-container-low)',
          borderTop: '1px solid var(--color-outline-variant)',
          borderBottom: '1px solid var(--color-outline-variant)',
          padding: '72px 24px',
        }}
      >
        <div style={{ maxWidth: 'var(--max-width)', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <span className="badge badge-primary" style={{ marginBottom: 12 }}>Defense in Depth</span>
            <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(26px, 4vw, 38px)', color: 'var(--color-on-surface)' }}>
              The Four Pillars of Inflynx Security
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
            {securityPillars.map(({ icon, title, badge, color, desc, checks }) => (
              <div
                key={title}
                className="card"
                style={{
                  padding: 28,
                  background: 'var(--color-surface-container-lowest)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ width: 44, height: 44, borderRadius: 10, background: `${color}15`, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 24 }}>{icon}</span>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '3px 8px', borderRadius: 4, background: 'var(--color-surface-container)', color: 'var(--color-on-surface-variant)' }}>
                    {badge}
                  </span>
                </div>
                <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 19, color: 'var(--color-on-surface)' }}>{title}</h3>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 14, lineHeight: 1.65, color: 'var(--color-on-surface-variant)' }}>{desc}</p>
                <div style={{ marginTop: 'auto', borderTop: '1px solid var(--color-outline-variant)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {checks.map(check => (
                    <div key={check} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-on-surface)' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 16, color }}>check_circle</span>
                      <span>{check}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ COMPLIANCE & GOVERNANCE ═══ */}
      <section style={{ maxWidth: 'var(--max-width)', margin: '0 auto', padding: '72px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(24px, 3.5vw, 36px)', color: 'var(--color-on-surface)' }}>
            Compliance & Enterprise Governance
          </h2>
          <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, color: 'var(--color-on-surface-variant)', maxWidth: 640, margin: '8px auto 0' }}>
            Built to satisfy the strictest enterprise security and compliance audits from day one.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 }}>
          {complianceStandards.map(({ title, desc, icon }) => (
            <div
              key={title}
              className="card"
              style={{
                padding: 24,
                background: 'var(--color-surface-container-lowest)',
                textAlign: 'left',
              }}
            >
              <div style={{ width: 40, height: 40, borderRadius: 8, background: 'rgba(0,74,198,0.1)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{icon}</span>
              </div>
              <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 17, color: 'var(--color-on-surface)', marginBottom: 6 }}>{title}</h3>
              <p style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface-variant)', lineHeight: 1.6 }}>{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ═══ CTA SECTION ═══ */}
      <section style={{ maxWidth: 'var(--max-width)', margin: '0 auto', padding: '48px 24px 80px', textAlign: 'center' }}>
        <div
          style={{
            padding: '48px 32px',
            borderRadius: 16,
            background: 'var(--color-surface-container-low)',
            border: '1px solid var(--color-outline-variant)',
          }}
        >
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 28, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            Need a custom security review or SOC2 report?
          </h2>
          <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, color: 'var(--color-on-surface-variant)', maxWidth: 600, margin: '0 auto 24px' }}>
            Our security team can provide our detailed Architecture Security Whitepaper and SOC2 controls mapping.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
            <Link to="/contact" className="btn-primary" style={{ padding: '12px 24px' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>mail</span>
              Contact Security Team
            </Link>
            <Link to="/docs" className="btn-secondary" style={{ padding: '12px 24px' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>menu_book</span>
              Security Documentation
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
