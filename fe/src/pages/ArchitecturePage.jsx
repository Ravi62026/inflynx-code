import { useState } from 'react'
import { Link } from 'react-router-dom'

export default function ArchitecturePage() {
  const [activeLayer, setActiveLayer] = useState('gateway')

  const layers = [
    {
      id: 'ui',
      title: '1. Developer Interfaces',
      badge: 'Client Tier',
      icon: 'terminal',
      color: 'var(--color-primary)',
      desc: 'Native developer surfaces connecting directly into the repository workspace without proxy servers.',
      specs: ['CLI REPL (@inflynx/code)', 'Terminal UI (Ink-based TUI)', 'Web Console & Telemetry Portal', 'VS Code & JetBrains Extension API'],
    },
    {
      id: 'policy',
      title: '2. Policy & Safety Engine',
      badge: 'Zero Trust Guard',
      icon: 'shield',
      color: 'var(--color-error)',
      desc: 'Intercepts, audits, and redacts every token and shell command prior to LLM submission or execution.',
      specs: ['Automated Secret & PII Sanitizer', 'PathGuard Directory Traversal Blocker', 'CommandPolicy Whitelist / Blacklist', 'SSRF Guard on network tools'],
    },
    {
      id: 'gateway',
      title: '3. Multi-Provider Model Gateway',
      badge: 'Frontier AI Tier',
      icon: 'route',
      color: 'var(--color-secondary)',
      desc: 'Dynamic cognitive routing engine dispatching discrete subtasks to frontier AI providers based on reasoning requirements.',
      specs: [
        'Claude Opus 5 / Sonnet 5 — Architectural planning & AST refactoring',
        'OpenAI GPT-6 Astra / GPT-5.6 Sol — Complex multi-step reasoning & execution',
        'Google Gemini 3.8 Flash — 1M+ context cross-repo search & native thinking',
        'DeepSeek V4 Flash (0731 GA) — Ultra-fast MoE code synthesis & test generation',
      ],
    },
    {
      id: 'graph',
      title: '4. AST Dependency Graph & Context Engine',
      badge: 'Code Intelligence',
      icon: 'account_tree',
      color: 'var(--color-tertiary)',
      desc: 'Full-repository AST indexing parsing imports, export symbols, and call graphs to construct precision token budgets.',
      specs: ['Incremental Tree-Sitter AST Parsing', 'Topological Call-Graph Resolution', 'ZSTD Stream Compression for distant dependencies', 'Proximity Scoring Token Packer'],
    },
    {
      id: 'sandbox',
      title: '5. Tool Runtime & Ephemeral Sandboxes',
      badge: 'Deterministic Execution',
      icon: 'view_in_ar',
      color: 'var(--color-primary)',
      desc: 'Isolated Docker execution containers with non-root privileges, memory limits, and disabled host networking.',
      specs: ['Zero-Network Docker Sandboxes (--network none)', 'Deterministic Test-Runner Execution', 'AST-Aware Patch Engine with rollback guarantees', 'Cryptographic SHA-256 Patch Signing'],
    },
  ]

  const activeData = layers.find(l => l.id === activeLayer) || layers[2]

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
            background: 'rgba(0, 74, 198, 0.08)',
            border: '1px solid rgba(0, 74, 198, 0.2)',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'var(--color-primary)',
          }}
        >
          <span className="material-symbols-outlined icon-fill" style={{ fontSize: 16 }}>architecture</span>
          System Architecture & Runtime Engine
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
          Deterministic Repository Intelligence Architecture
        </h1>

        <p
          style={{
            fontFamily: 'var(--font-inter)',
            fontSize: 'clamp(16px, 2vw, 19px)',
            lineHeight: 1.65,
            color: 'var(--color-on-surface-variant)',
            maxWidth: 760,
          }}
        >
          Inflynx Code separates cognitive planning from execution. By decoupling frontier model routing from
          isolated ephemeral sandboxes, code generation remains provable, deterministic, and safe.
        </p>

        {/* Quick Architecture Metrics */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 16,
            width: '100%',
            maxWidth: 880,
            marginTop: 16,
          }}
        >
          {[
            { label: 'AST Parse Latency', value: '< 150ms', sub: 'Per 100k LoC' },
            { label: 'Context Budget', value: '1M+ Tokens', sub: 'Multi-model streaming' },
            { label: 'Sandbox Isolation', value: 'Level 4', sub: 'Zero-network Docker' },
            { label: 'Patch Determinism', value: '100%', sub: 'Cryptographically signed' },
          ].map(({ label, value, sub }) => (
            <div
              key={label}
              className="card"
              style={{
                padding: '20px 16px',
                textAlign: 'center',
                background: 'var(--color-surface-container-lowest)',
              }}
            >
              <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 26, color: 'var(--color-primary)', letterSpacing: '-0.02em' }}>
                {value}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)', marginTop: 4 }}>
                {label}
              </div>
              <div style={{ fontFamily: 'var(--font-inter)', fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>
                {sub}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══ INTERACTIVE ARCHITECTURE EXPLORER ═══ */}
      <section
        style={{
          maxWidth: 'var(--max-width)',
          margin: '0 auto',
          padding: '48px 24px 72px',
        }}
      >
        <div
          style={{
            background: 'var(--color-surface-container-lowest)',
            border: '1px solid var(--color-outline-variant)',
            borderRadius: 16,
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(20, 33, 43, 0.06)',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '20px 24px',
              borderBottom: '1px solid var(--color-outline-variant)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 12,
              background: 'var(--color-surface-container-low)',
            }}
          >
            <div>
              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 20, color: 'var(--color-on-surface)' }}>
                Interactive Architectural Flow
              </h2>
              <p style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface-variant)' }}>
                Select an architectural tier to inspect specifications, guardrails, and data contracts.
              </p>
            </div>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 9999,
                background: 'rgba(0, 74, 198, 0.1)',
                color: 'var(--color-primary)',
                fontWeight: 600,
              }}
            >
              Protocol v2.4.0
            </span>
          </div>

          {/* Explorer Layout */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {/* Left: Layer Selector */}
            <div style={{ borderRight: '1px solid var(--color-outline-variant)', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {layers.map((layer) => {
                const isSelected = layer.id === activeLayer
                return (
                  <button
                    key={layer.id}
                    onClick={() => setActiveLayer(layer.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 16,
                      padding: '16px',
                      borderRadius: 12,
                      border: `1px solid ${isSelected ? layer.color : 'transparent'}`,
                      background: isSelected ? `${layer.color}0a` : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.2s ease',
                      width: '100%',
                    }}
                  >
                    <div
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 10,
                        background: `${layer.color}15`,
                        color: layer.color,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 24 }}>{layer.icon}</span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 15, color: 'var(--color-on-surface)' }}>
                          {layer.title}
                        </span>
                      </div>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: 'var(--color-surface-container)',
                          color: 'var(--color-on-surface-variant)',
                        }}
                      >
                        {layer.badge}
                      </span>
                    </div>
                    <span className="material-symbols-outlined" style={{ color: isSelected ? layer.color : 'var(--color-outline)', fontSize: 20 }}>
                      chevron_right
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Right: Active Layer Inspector */}
            <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  className="material-symbols-outlined"
                  style={{
                    fontSize: 32,
                    color: activeData.color,
                    padding: 8,
                    borderRadius: 10,
                    background: `${activeData.color}15`,
                  }}
                >
                  {activeData.icon}
                </span>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 22, color: 'var(--color-on-surface)' }}>
                    {activeData.title}
                  </h3>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: activeData.color, fontWeight: 600 }}>
                    {activeData.badge}
                  </span>
                </div>
              </div>

              <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.7, color: 'var(--color-on-surface-variant)' }}>
                {activeData.desc}
              </p>

              <div>
                <h4 style={{ fontFamily: 'var(--font-mono)', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-on-surface-variant)', marginBottom: 12 }}>
                  Component Capabilities & Protocols
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {activeData.specs.map((spec) => (
                    <div
                      key={spec}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 12,
                        padding: '12px 16px',
                        borderRadius: 8,
                        background: 'var(--color-surface-container-low)',
                        border: '1px solid var(--color-outline-variant)',
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: activeData.color, marginTop: 2 }}>
                        check_circle
                      </span>
                      <span style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface)', lineHeight: 1.5 }}>
                        {spec}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Architectural JSON Sample */}
              <div className="code-block" style={{ margin: 0, fontSize: 12, lineHeight: 1.6 }}>
                <div style={{ color: 'rgba(195,198,215,0.4)', marginBottom: 6 }}>
                  # Execution Plan Protocol Schema (Draft v2.4)
                </div>
                <pre style={{ margin: 0, color: 'var(--color-primary-fixed-dim)', fontFamily: 'var(--font-mono)' }}>
{`{
  "taskId": "task-8f921d",
  "routingTarget": "anthropic/claude-opus-5",
  "verificationTier": "docker-isolated",
  "astSymbolsLocked": ["AuthService", "TokenManager"],
  "allowedCommands": ["npm test", "npm run lint"],
  "contextBudgetTokens": 1048576,
  "cryptographicSignature": "sha256:d82f9b..."
}`}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══ THREE-PHASE PIPELINE DEEP DIVE ═══ */}
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
            <span className="badge badge-secondary" style={{ marginBottom: 12 }}>Safety By Design</span>
            <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(26px, 4vw, 38px)', color: 'var(--color-on-surface)' }}>
              The Plan → Verify → Apply Pipeline
            </h2>
            <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, color: 'var(--color-on-surface-variant)', maxWidth: 640, margin: '8px auto 0' }}>
              Unlike naive code assistants that stream uncontrolled edits directly into files, Inflynx Code enforces a strict 3-phase state machine.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
            {[
              {
                step: 'Phase 01',
                title: 'Plan & AST Analysis',
                icon: 'architecture',
                color: 'var(--color-primary)',
                desc: 'The orchestrator parses the AST, maps call graphs, packages context with ZSTD compression, and produces a structured JSON plan with human-readable rationale.',
              },
              {
                step: 'Phase 02',
                title: 'Sandbox Verification',
                icon: 'view_in_ar',
                color: 'var(--color-secondary)',
                desc: 'The patch is dispatched to an ephemeral Docker container. Compilers and test runners execute with zero network connectivity to mathematically verify correctness.',
              },
              {
                step: 'Phase 03',
                title: 'Human Gating & Apply',
                icon: 'verified',
                color: 'var(--color-tertiary)',
                desc: 'Only after verification passes is an interactive diff presented to the developer. Once signed off, changes are committed with cryptographic audit trails.',
              },
            ].map(({ step, title, icon, color, desc }) => (
              <div
                key={step}
                className="card"
                style={{
                  padding: 28,
                  background: 'var(--color-surface-container-lowest)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                  position: 'relative',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color }}>{step}</span>
                  <div style={{ width: 40, height: 40, borderRadius: 8, background: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{icon}</span>
                  </div>
                </div>
                <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 18, color: 'var(--color-on-surface)' }}>{title}</h3>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 14, lineHeight: 1.65, color: 'var(--color-on-surface-variant)' }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ CTA SECTION ═══ */}
      <section style={{ maxWidth: 'var(--max-width)', margin: '0 auto', padding: '80px 24px', textAlign: 'center' }}>
        <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(28px, 4vw, 42px)', color: 'var(--color-on-surface)', marginBottom: 16 }}>
          Ready to deploy autonomous repository agents?
        </h2>
        <p style={{ fontFamily: 'var(--font-inter)', fontSize: 17, color: 'var(--color-on-surface-variant)', maxWidth: 600, margin: '0 auto 32px' }}>
          Connect your GitHub, GitLab, or local repository in less than 60 seconds.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Link to="/signup" className="btn-primary" style={{ padding: '14px 28px', fontSize: 15 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>rocket_launch</span>
            Get started free
          </Link>
          <Link to="/docs" className="btn-secondary" style={{ padding: '14px 28px', fontSize: 15 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>menu_book</span>
            Explore Documentation
          </Link>
        </div>
      </section>
    </div>
  )
}
