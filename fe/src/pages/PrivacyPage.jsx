import { Link } from 'react-router-dom'

export default function PrivacyPage() {
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
          <span className="badge badge-primary" style={{ marginBottom: 12 }}>Legal & Governance</span>
          <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 4vw, 42px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)' }}>
            Privacy Policy & Data Protection
          </h1>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-on-surface-variant)', marginTop: 8 }}>
            Effective Date: September 1, 2026 · Version 2.4
          </p>
        </div>

        {/* Highlight Callout */}
        <div
          style={{
            padding: '20px 24px',
            borderRadius: 10,
            background: 'rgba(0, 96, 86, 0.08)',
            borderLeft: '4px solid var(--color-tertiary)',
            display: 'flex',
            gap: 14,
            alignItems: 'flex-start',
          }}
        >
          <span className="material-symbols-outlined icon-fill" style={{ fontSize: 24, color: 'var(--color-tertiary)', marginTop: 2 }}>
            verified_user
          </span>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface)' }}>
            <strong>The Inflynx Zero-Training Guarantee:</strong> Under no circumstances is your repository code, AST metadata, terminal command history, or prompt payload used to train, fine-tune, or improve any public or private AI models.
          </div>
        </div>

        {/* Section 1 */}
        <div>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            1. Information We Collect & How It Is Used
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)', marginBottom: 12 }}>
            Inflynx Code operates as a developer platform for autonomous coding agents. When using the CLI, TUI, or Web Console:
          </p>
          <ul style={{ paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
            <li><strong>Account Data:</strong> Name, work email address, and organization name for authentication and billing.</li>
            <li><strong>Repository Metadata:</strong> File tree structures and symbol dependency graphs required to construct precision context windows. ASTs are processed locally on your device or in private ephemeral Docker runners.</li>
            <li><strong>API Credentials (BYOK):</strong> Your provider API keys (Anthropic, OpenAI, Google, DeepSeek) are stored exclusively in your local environment or encrypted local keyrings. They are never transmitted to Inflynx servers.</li>
          </ul>
        </div>

        {/* Section 2 */}
        <div>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            2. Secret Redaction & Transmission
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
            Before any prompt or code excerpt is sent to an authorized model provider, our built-in Shannon entropy and heuristic scanner automatically redacts private credentials, API keys, and sensitive tokens. All transmissions use TLS 1.3 encryption with strict certificate pinning.
          </p>
        </div>

        {/* Section 3 */}
        <div>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            3. Third-Party AI Model Providers
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
            Inflynx Code routes requests to verified frontier AI providers based on your configured policies. All supported commercial providers (Anthropic, OpenAI, Google Cloud, DeepSeek) are engaged under enterprise zero-data-retention agreements where inputs and outputs are not retained or utilized for training.
          </p>
        </div>

        {/* Section 4 */}
        <div>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 12 }}>
            4. Data Retention & Deletion Rights
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
            You retain 100% ownership of your code, plans, and diffs. You may delete your workspace, purge audit trails, or export your data at any time via the console settings or by contacting <Link to="/contact" style={{ color: 'var(--color-primary)' }}>support</Link>.
          </p>
        </div>

        <div style={{ borderTop: '1px solid var(--color-outline-variant)', paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Link to="/" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-primary)', textDecoration: 'none' }}>
            ← Return to Home
          </Link>
          <Link to="/terms" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-primary)', textDecoration: 'none' }}>
            Terms of Service →
          </Link>
        </div>
      </section>
    </div>
  )
}
