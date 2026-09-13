import { Link } from 'react-router-dom'

export default function TermsPage() {
  return (
    <div style={{ background: 'var(--color-background)', minHeight: '100vh', fontFamily: 'var(--font-inter)' }}>
      <section
        style={{
          maxWidth: 800,
          margin: '0 auto',
          padding: '64px 24px 96px',
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
        }}
        className="animate-fade-in-up"
      >
        <div>
          <span className="badge badge-secondary" style={{ marginBottom: 12 }}>Terms & Conditions</span>
          <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 4vw, 42px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)' }}>
            Terms of Service
          </h1>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-on-surface-variant)', marginTop: 8 }}>
            Last Updated: September 1, 2026 · Version 2.4
          </p>
        </div>

        <div>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            1. Acceptance of Terms
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
            By downloading, installing, or accessing Inflynx Code (including the CLI, TUI, Web Console, and associated APIs), you agree to be bound by these Terms of Service. If you are entering into these terms on behalf of an enterprise or organization, you represent that you have authority to bind that entity.
          </p>
        </div>

        <div>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            2. Bring Your Own Key (BYOK) & Compute Usage
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
            Inflynx Code facilitates deterministic agentic workflows using your configured API keys or integrated platform credits. You are responsible for ensuring your API keys maintain compliance with individual provider service agreements (such as Anthropic, OpenAI, Google Cloud, or DeepSeek terms).
          </p>
        </div>

        <div>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            3. Acceptable Use Policy
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)', marginBottom: 12 }}>
            You agree not to use Inflynx Code to:
          </p>
          <ul style={{ paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
            <li>Generate, test, or distribute malicious code, ransomware, or exploits.</li>
            <li>Attempt to escape or bypass container sandbox boundaries or path guardrails.</li>
            <li>Conduct unauthorized penetration tests or denial-of-service activities against any third-party infrastructure.</li>
          </ul>
        </div>

        <div>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            4. Code Responsibility & Human Review
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
            Inflynx Code employs isolated Docker test sandboxes and AST-aware validation to maximize patch safety. However, AI-generated code must be inspected and approved by human engineers prior to deployment in production environments. Developers retain ultimate responsibility for code applied to their repositories.
          </p>
        </div>

        <div>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            5. Limitation of Liability
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
            To the maximum extent permitted by applicable law, Inflynx Code shall not be liable for any indirect, incidental, special, or consequential damages resulting from the execution of agent-proposed diffs or third-party AI provider outages.
          </p>
        </div>

        <div style={{ borderTop: '1px solid var(--color-outline-variant)', paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Link to="/" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-primary)', textDecoration: 'none' }}>
            ← Return to Home
          </Link>
          <Link to="/privacy" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-primary)', textDecoration: 'none' }}>
            Privacy Policy →
          </Link>
        </div>
      </section>
    </div>
  )
}
