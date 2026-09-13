import { Link } from 'react-router-dom'

export default function StatusPage() {
  const services = [
    { name: 'Model Gateway — Anthropic (Claude Opus 5 / Sonnet 5)', status: 'Operational', uptime: '100.0%', latency: '340ms' },
    { name: 'Model Gateway — OpenAI (GPT-6 Astra / GPT-5.6 Sol)', status: 'Operational', uptime: '99.99%', latency: '315ms' },
    { name: 'Model Gateway — Google (Gemini 3.8 Flash)', status: 'Operational', uptime: '100.0%', latency: '190ms' },
    { name: 'Model Gateway — DeepSeek (DeepSeek V4 Flash)', status: 'Operational', uptime: '99.97%', latency: '205ms' },
    { name: 'AST Dependency Graph & Context Packing Engine', status: 'Operational', uptime: '100.0%', latency: '142ms' },
    { name: 'Ephemeral Docker Sandboxing Cluster', status: 'Operational', uptime: '100.0%', latency: '420ms' },
    { name: 'Cryptographic Diff Signing & Audit Ledger', status: 'Operational', uptime: '100.0%', latency: '18ms' },
    { name: 'Developer CLI / TUI Streaming Protocol', status: 'Operational', uptime: '100.0%', latency: '24ms' },
  ]

  return (
    <div style={{ background: 'var(--color-background)', minHeight: '100vh', fontFamily: 'var(--font-inter)' }}>
      <section
        style={{
          maxWidth: 'var(--max-width)',
          margin: '0 auto',
          padding: '64px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
        }}
        className="animate-fade-in-up"
      >
        {/* Status Header */}
        <div
          style={{
            padding: '24px 32px',
            borderRadius: 12,
            background: 'rgba(0, 96, 86, 0.08)',
            border: '1px solid rgba(0, 96, 86, 0.25)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ position: 'relative', display: 'inline-flex', width: 16, height: 16 }}>
              <span style={{ position: 'absolute', width: '100%', height: '100%', borderRadius: '50%', background: 'var(--color-tertiary)', animation: 'ping 1.5s ease-in-out infinite', opacity: 0.6 }} />
              <span style={{ position: 'relative', width: 16, height: 16, borderRadius: '50%', background: 'var(--color-tertiary)', display: 'inline-flex' }} />
            </span>
            <div>
              <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 24, color: 'var(--color-on-surface)' }}>
                All Systems Operational
              </h1>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-on-surface-variant)' }}>
                All frontier model gateways and sandbox runners are operating normally.
              </span>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
            Updated just now · Refreshed every 60s
          </div>
        </div>

        {/* System Telemetry Metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          {[
            { label: 'Overall 90-Day Uptime', value: '99.99%' },
            { label: 'Avg Model Gateway Latency', value: '262ms' },
            { label: 'Sandboxes Spawned (24h)', value: '14,820' },
            { label: 'Verification Pass Rate', value: '98.9%' },
          ].map(({ label, value }) => (
            <div key={label} className="card" style={{ padding: '20px 24px' }}>
              <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 28, color: 'var(--color-primary)', letterSpacing: '-0.02em' }}>
                {value}
              </div>
              <div style={{ fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-on-surface-variant)', marginTop: 4 }}>
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* Services Table */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-container-low)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 18, color: 'var(--color-on-surface)' }}>
              Core Infrastructure Services
            </h2>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
              8 / 8 Healthy
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {services.map(({ name, status, uptime, latency }, i) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '16px 24px',
                  borderBottom: i < services.length - 1 ? '1px solid var(--color-outline-variant)' : 'none',
                  flexWrap: 'wrap',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="material-symbols-outlined icon-fill" style={{ fontSize: 18, color: 'var(--color-tertiary)' }}>
                    check_circle
                  </span>
                  <span style={{ fontFamily: 'var(--font-inter)', fontSize: 14, fontWeight: 500, color: 'var(--color-on-surface)' }}>
                    {name}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
                    {latency}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
                    {uptime}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--color-tertiary)',
                      background: 'rgba(0, 96, 86, 0.1)',
                      padding: '2px 8px',
                      borderRadius: 4,
                    }}
                  >
                    {status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 90-Day Visual Activity Bars */}
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 16, color: 'var(--color-on-surface)' }}>
              Historical Availability (Past 90 Days)
            </h3>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-tertiary)', fontWeight: 600 }}>
              100% Operational
            </span>
          </div>
          <div style={{ display: 'flex', gap: 3, height: 32, alignItems: 'center' }}>
            {Array.from({ length: 90 }).map((_, i) => (
              <div
                key={i}
                title={`Day ${90 - i}: 100% Operational`}
                style={{
                  flex: 1,
                  height: '100%',
                  background: 'var(--color-tertiary)',
                  borderRadius: 2,
                  opacity: 0.85,
                  cursor: 'pointer',
                  transition: 'transform 0.15s ease, opacity 0.15s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'scaleY(1.2)'; e.currentTarget.style.opacity = '1' }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'scaleY(1)'; e.currentTarget.style.opacity = '0.85' }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
            <span>90 days ago</span>
            <span>Today</span>
          </div>
        </div>

        {/* Incident History */}
        <div className="card" style={{ padding: 24 }}>
          <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 16, color: 'var(--color-on-surface)', marginBottom: 16 }}>
            Recent Incident Logs
          </h3>
          <div style={{ padding: '16px 20px', borderRadius: 8, background: 'var(--color-surface-container-low)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface-variant)' }}>
              No incidents reported across any region in the past 90 days.
            </span>
            <span className="material-symbols-outlined icon-fill" style={{ fontSize: 20, color: 'var(--color-tertiary)' }}>
              verified
            </span>
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Link to="/" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-primary)', textDecoration: 'none' }}>
            ← Back to Inflynx Code home
          </Link>
        </div>
      </section>
    </div>
  )
}
