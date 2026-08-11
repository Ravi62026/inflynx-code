import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'

/* ── Callout Box Component ── */
function Callout({ type = 'note', title, children }) {
  const configs = {
    note: { bg: 'rgba(0,74,198,0.06)', border: 'var(--color-primary)', icon: 'info', titleColor: 'var(--color-primary)' },
    tip: { bg: 'rgba(0,96,86,0.06)', border: 'var(--color-tertiary)', icon: 'lightbulb', titleColor: 'var(--color-tertiary)' },
    warning: { bg: 'rgba(232,160,32,0.08)', border: '#e8a020', icon: 'warning', titleColor: '#b57908' },
    security: { bg: 'rgba(186,26,26,0.06)', border: 'var(--color-error)', icon: 'shield', titleColor: 'var(--color-error)' },
  }
  const cfg = configs[type] || configs.note

  return (
    <div
      style={{
        background: cfg.bg,
        borderLeft: `4px solid ${cfg.border}`,
        borderRadius: '0 8px 8px 0',
        padding: '16px 20px',
        margin: '20px 0',
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
      }}
    >
      <span className="material-symbols-outlined" style={{ color: cfg.titleColor, fontSize: 22, flexShrink: 0, marginTop: 2 }}>
        {cfg.icon}
      </span>
      <div style={{ flex: 1, fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface)' }}>
        {title && <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 14, color: cfg.titleColor, marginBottom: 4 }}>{title}</div>}
        {children}
      </div>
    </div>
  )
}

/* ── Code Block with Copy ── */
function DocCodeBlock({ code, language = 'bash' }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div style={{ position: 'relative', margin: '16px 0' }}>
      <div className="code-block" style={{ margin: 0, paddingRight: 60 }}>
        <div style={{ position: 'absolute', top: 10, right: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(230,242,255,0.4)', textTransform: 'uppercase' }}>{language}</span>
          <button
            onClick={handleCopy}
            style={{
              background: 'rgba(230,242,255,0.1)',
              border: '1px solid rgba(195,198,215,0.2)',
              borderRadius: 4,
              padding: '4px 8px',
              color: 'var(--color-inverse-on-surface)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              transition: 'all 0.2s ease',
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>{copied ? 'check' : 'content_copy'}</span>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.6, overflowX: 'auto' }}>
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState('getting-started')
  const [searchQuery, setSearchQuery] = useState('')

  const sections = [
    {
      group: 'Getting Started',
      items: [
        { id: 'getting-started', title: 'Quick Start & Installation', icon: 'rocket_launch' },
        { id: 'providers-byok', title: 'Providers & BYOK Setup', icon: 'key' },
        { id: 'configuration', title: 'Configuration & Environments', icon: 'tune' },
      ],
    },
    {
      group: 'Architecture & Engine',
      items: [
        { id: 'orchestration-runtime', title: 'Orchestration Runtime Specification', icon: 'memory' },
        { id: 'effort-profiles', title: 'Effort Profiles & Budgets', icon: 'data_usage' },
        { id: 'prompt-modes', title: 'Agent Modes (Ask/Plan/Agent/Debug)', icon: 'psychology' },
        { id: 'event-protocol', title: 'Event Protocol & WebSocket Stream', icon: 'sensors' },
      ],
    },
    {
      group: 'Security & Policy',
      items: [
        { id: 'security-policy', title: 'Canonical Path Guard & Sandboxing', icon: 'shield' },
        { id: 'secret-redaction', title: 'Secret Redaction & Audit Trails', icon: 'lock_person' },
      ],
    },
    {
      group: 'CLI & Slash Commands',
      items: [
        { id: 'slash-commands', title: 'Slash Command API Reference', icon: 'terminal' },
      ],
    },
    {
      group: 'Maturity Specification (RFC)',
      items: [
        { id: 'rfc-maturity-plan', title: 'Production-Grade Maturity Plan (Full RFC)', icon: 'architecture' },
        { id: 'rfc-roadmap-phases', title: 'Phase 0–13 Implementation Roadmap', icon: 'alt_route' },
        { id: 'rfc-evaluation-strategy', title: 'Verification & Security Evaluation', icon: 'verified' },
      ],
    },
  ]

  // Filter sections by search query
  const filteredSections = sections.map(group => ({
    ...group,
    items: group.items.filter(item =>
      item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      group.group.toLowerCase().includes(searchQuery.toLowerCase())
    ),
  })).filter(group => group.items.length > 0)

  return (
    <div style={{ background: 'var(--color-background)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

      {/* Header Strip */}
      <div style={{ background: 'var(--color-surface-container-low)', borderBottom: '1px solid var(--color-outline-variant)', padding: '12px 24px' }}>
        <div style={{ maxWidth: 'var(--max-width)', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-on-surface-variant)' }}>
            <Link to="/" style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}>Inflynx Code</Link>
            <span>/</span>
            <span>Docs</span>
            <span>/</span>
            <span style={{ color: 'var(--color-on-surface)', fontWeight: 600 }}>
              {sections.flatMap(g => g.items).find(i => i.id === activeSection)?.title || 'Documentation'}
            </span>
          </div>

          <span className="badge badge-primary" style={{ fontSize: 11 }}>v2.4.0 Specification</span>
        </div>
      </div>

      {/* Docs Layout Container */}
      <div style={{ maxWidth: 'var(--max-width)', margin: '0 auto', width: '100%', flex: 1, display: 'flex', alignItems: 'stretch' }}>

        {/* ═══ LEFT SIDEBAR ═══ */}
        <aside
          style={{
            width: 280,
            borderRight: '1px solid var(--color-outline-variant)',
            padding: '24px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
            flexShrink: 0,
            background: 'var(--color-surface-container-lowest)',
          }}
        >
          {/* Search Input */}
          <div style={{ position: 'relative' }}>
            <span className="material-symbols-outlined" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 18, color: 'var(--color-on-surface-variant)' }}>
              search
            </span>
            <input
              className="input"
              placeholder="Search docs..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ paddingLeft: 34, paddingRight: 12, fontSize: 13, height: 36 }}
            />
          </div>

          {/* Navigation Groups */}
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 20, flex: 1, overflowY: 'auto' }}>
            {filteredSections.map(group => (
              <div key={group.group} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 8px 4px' }}>
                  {group.group}
                </div>
                {group.items.map(item => {
                  const isActive = activeSection === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveSection(item.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: 'none',
                        background: isActive ? 'rgba(0,74,198,0.08)' : 'transparent',
                        color: isActive ? 'var(--color-primary)' : 'var(--color-on-surface-variant)',
                        fontFamily: 'var(--font-inter)',
                        fontSize: 13,
                        fontWeight: isActive ? 600 : 500,
                        textAlign: 'left',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: isActive ? 'var(--color-primary)' : 'inherit' }}>
                        {item.icon}
                      </span>
                      {item.title}
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>
        </aside>

        {/* ═══ MAIN CONTENT AREA ═══ */}
        <main style={{ flex: 1, padding: '40px 48px', maxWidth: 860, overflowY: 'auto' }}>

          {/* SECTION 1: QUICK START */}
          {activeSection === 'getting-started' && (
            <article style={{ display: 'flex', flexDirection: 'column', gap: 24 }} className="animate-fade-in">
              <div>
                <span className="badge badge-primary" style={{ marginBottom: 12 }}>Getting Started</span>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, letterSpacing: '-0.03em', color: 'var(--color-on-surface)' }}>
                  Quick Start & Installation
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 17, lineHeight: 1.7, color: 'var(--color-on-surface-variant)', marginTop: 8 }}>
                  Inflynx Code is a CLI-first, repository-aware autonomous agent runtime. It indexes your codebase into an AST dependency graph, executes structured execution plans, and runs verification gates after every patch.
                </p>
              </div>

              <Callout type="tip" title="Prerequisites">
                Node.js v18.0.0 or higher is required. Inflynx Code operates with zero telemetry tracking of your private code or API keys.
              </Callout>

              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, marginTop: 12 }}>1. Run via NPX or Install Globally</h2>
              <DocCodeBlock code={`# Instant launch via npx
npx @inflynx/code init

# Or install globally via pnpm / npm
pnpm add -g @inflynx/code
inflynx init`} language="bash" />

              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, marginTop: 12 }}>2. Configure API Keys (BYOK)</h2>
              <p style={{ fontFamily: 'var(--font-inter)', fontSize: 15, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
                Set your API keys as environment variables or inside <code>~/.inflynx/config.json</code>:
              </p>
              <DocCodeBlock code={`export ANTHROPIC_API_KEY="sk-ant-api03-..."
export GEMINI_API_KEY="AIzaSy..."
export DEEPSEEK_API_KEY="sk-..."
export OPENAI_API_KEY="sk-proj-..."`} language="bash" />

              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, marginTop: 12 }}>3. Start an Interactive Session</h2>
              <DocCodeBlock code={`# Launch agent REPL in current repository
inflynx

# Or execute a single prompt mode directly
inflynx --mode plan "Refactor session_store to eliminate race conditions"
inflynx --mode debug "Investigate null pointer in auth token refresh"`} language="bash" />
            </article>
          )}

          {/* SECTION 2: PROVIDERS & BYOK */}
          {activeSection === 'providers-byok' && (
            <article style={{ display: 'flex', flexDirection: 'column', gap: 24 }} className="animate-fade-in">
              <div>
                <span className="badge badge-secondary" style={{ marginBottom: 12 }}>Model Gateway</span>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, letterSpacing: '-0.03em', color: 'var(--color-on-surface)' }}>
                  Providers & BYOK Security
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 17, lineHeight: 1.7, color: 'var(--color-on-surface-variant)', marginTop: 8 }}>
                  Inflynx Code is strictly Bring Your Own Key (BYOK). All model invocations stream directly from your local machine to the chosen LLM provider gateway.
                </p>
              </div>

              <Callout type="security" title="Zero Key Storage Policy">
                Your API keys never pass through Inflynx servers. Credentials are scrubbed and redacted automatically before any prompt payload is emitted.
              </Callout>

              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22 }}>Supported Model Matrix</h2>
              <div className="card" style={{ overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-inter)', fontSize: 14, textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface-container-low)', borderBottom: '1px solid var(--color-outline-variant)' }}>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Provider</th>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Recommended Model</th>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Best Use Case</th>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Routing Tag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { provider: 'Anthropic', model: 'Claude 3.5 Sonnet', use: 'Architectural planning, complex refactoring', tag: '@claude-plan' },
                      { provider: 'Google Gemini', model: 'Gemini 2.5 Pro', use: '200K+ token context search & AST symbol tracing', tag: '@gemini-search' },
                      { provider: 'DeepSeek', model: 'DeepSeek Coder V2', use: 'Rapid function implementation & test generation', tag: '@deepseek-impl' },
                      { provider: 'OpenAI', model: 'GPT-4o', use: 'General coding & instructions', tag: '@openai' },
                      { provider: 'Local / Ollama', model: 'Llama-3.3-70B / Qwen-2.5', use: 'Air-gapped, offline security compliance', tag: '@local' },
                    ].map(({ provider, model, use, tag }, i) => (
                      <tr key={provider} style={{ borderBottom: i < 4 ? '1px solid var(--color-outline-variant)' : 'none' }}>
                        <td style={{ padding: '12px 16px', fontWeight: 600 }}>{provider}</td>
                        <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-primary)' }}>{model}</td>
                        <td style={{ padding: '12px 16px', color: 'var(--color-on-surface-variant)' }}>{use}</td>
                        <td style={{ padding: '12px 16px' }}><span style={{ background: 'var(--color-surface-container)', padding: '2px 8px', borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{tag}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}

          {/* SECTION 3: CONFIGURATION */}
          {activeSection === 'configuration' && (
            <article style={{ display: 'flex', flexDirection: 'column', gap: 24 }} className="animate-fade-in">
              <div>
                <span className="badge badge-primary" style={{ marginBottom: 12 }}>Configuration</span>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, letterSpacing: '-0.03em', color: 'var(--color-on-surface)' }}>
                  Configuration & Workspace Settings
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 17, lineHeight: 1.7, color: 'var(--color-on-surface-variant)', marginTop: 8 }}>
                  Workspace settings are persisted in <code>.inflynx/config.json</code> at the root of your project repository.
                </p>
              </div>

              <DocCodeBlock code={`{
  "version": "2.4.0",
  "defaultProvider": "gemini",
  "effortLevel": "medium",
  "thinkingBudgetTokens": 4096,
  "sandbox": {
    "enabled": true,
    "image": "inflynx/sandbox:latest",
    "networkAccess": "none"
  },
  "policy": {
    "allowParallelReadonlyTools": true,
    "requireApprovalForMutations": true,
    "blockedCommands": ["rm -rf /", "git push --force"]
  }
}`} language="json" />
            </article>
          )}

          {/* SECTION 4: ORCHESTRATION RUNTIME */}
          {activeSection === 'orchestration-runtime' && (
            <article style={{ display: 'flex', flexDirection: 'column', gap: 24 }} className="animate-fade-in">
              <div>
                <span className="badge badge-success" style={{ marginBottom: 12 }}>Core Architecture</span>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, letterSpacing: '-0.03em', color: 'var(--color-on-surface)' }}>
                  Orchestration Runtime Specification
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 17, lineHeight: 1.7, color: 'var(--color-on-surface-variant)', marginTop: 8 }}>
                  Rather than acting as a naive chatbot attached to tool prompts, Inflynx Code operates as a centralized <strong>Orchestration Runtime</strong>:
                </p>
              </div>

              <div className="code-block" style={{ fontSize: 13, textAlign: 'center', padding: '20px', color: 'var(--color-primary-fixed-dim)' }}>
                Orchestration Runtime = Model Gateway + State Machine + Tool DAG Scheduler + Policy Engine + Verification Loop + Event Protocol
              </div>

              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 22, marginTop: 12 }}>State Machine Lifecycle</h2>
              <p style={{ fontFamily: 'var(--font-inter)', fontSize: 15, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
                Every user request transitions deterministically through enforced states:
              </p>

              <div className="code-block" style={{ fontSize: 12, lineHeight: 1.8 }}>
                {`idle → classifying → planning → exploring → hypothesizing → implementing → verifying → repairing → reviewing → waiting_for_approval → completed / failed`}
              </div>

              <Callout type="note" title="Bounded Execution Guarantee">
                State transitions enforce hard limits on model turns, tool calls, retry limits, and wall-clock execution time. If budgets are exceeded, execution halts safely with an actionable report.
              </Callout>
            </article>
          )}

          {/* SECTION 5: EFFORT PROFILES */}
          {activeSection === 'effort-profiles' && (
            <article style={{ display: 'flex', flexDirection: 'column', gap: 24 }} className="animate-fade-in">
              <div>
                <span className="badge badge-primary" style={{ marginBottom: 12 }}>Execution Controls</span>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, letterSpacing: '-0.03em', color: 'var(--color-on-surface)' }}>
                  Effort Profiles & Budget Model
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 17, lineHeight: 1.7, color: 'var(--color-on-surface-variant)', marginTop: 8 }}>
                  The user-facing effort selector controls two distinct layers: model-level reasoning budgets and aggregate task execution budgets.
                </p>
              </div>

              <div className="card" style={{ overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-inter)', fontSize: 14, textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface-container-low)', borderBottom: '1px solid var(--color-outline-variant)' }}>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Setting</th>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-tertiary)' }}>Low</th>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-primary)' }}>Medium (Default)</th>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-secondary)' }}>High</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { setting: 'Thinking budget / request', low: '1,024 tokens', med: '4,096 tokens', high: '8,192 tokens' },
                      { setting: 'Max model turns', low: '3 turns', med: '8 turns', high: '16 turns' },
                      { setting: 'Max tool calls', low: '8 calls', med: '20 calls', high: '50 calls' },
                      { setting: 'Max retries', low: '1 retry', med: '2 retries', high: '3 retries' },
                      { setting: 'Max wall-clock time', low: '60 seconds', med: '5 minutes', high: '15 minutes' },
                      { setting: 'Verification Depth', low: 'Basic', med: 'Standard', high: 'Deep' },
                      { setting: 'Parallel Read-only Tools', low: 'Yes', med: 'Yes', high: 'Yes' },
                    ].map(({ setting, low, med, high }, i) => (
                      <tr key={setting} style={{ borderBottom: i < 6 ? '1px solid var(--color-outline-variant)' : 'none' }}>
                        <td style={{ padding: '12px 16px', fontWeight: 600 }}>{setting}</td>
                        <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 13 }}>{low}</td>
                        <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--color-primary)' }}>{med}</td>
                        <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 13 }}>{high}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}

          {/* SECTION 6: PROMPT MODES */}
          {activeSection === 'prompt-modes' && (
            <article style={{ display: 'flex', flexDirection: 'column', gap: 24 }} className="animate-fade-in">
              <div>
                <span className="badge badge-secondary" style={{ marginBottom: 12 }}>Modes</span>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, letterSpacing: '-0.03em', color: 'var(--color-on-surface)' }}>
                  Execution Prompt Modes
                </h1>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 17, lineHeight: 1.7, color: 'var(--color-on-surface-variant)', marginTop: 8 }}>
                  Inflynx Code configures tool permissions dynamically based on the current mode:
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
                {[
                  { mode: 'ask', color: 'var(--color-primary)', desc: 'Read-only mode. Agent can query AST graph and read files, but cannot mutate code or run mutating shell commands.', tools: 'read_file, grep, glob, ask_user' },
                  { mode: 'plan', color: 'var(--color-secondary)', desc: 'Generates a structured execution plan (.inflynx/PLAN.md) before any modifications take place. Human approval required.', tools: 'read_file, graph, plan_builder' },
                  { mode: 'agent', color: 'var(--color-tertiary)', desc: 'Full autonomous mode. Performs planning, patch transactions, command execution, and verification gates.', tools: 'All tools + docker_bash' },
                  { mode: 'debug', color: 'var(--color-error)', desc: 'Evidence-first bug investigation. Collects stack traces, reproduces issues in sandbox, and writes structured findings report.', tools: 'instrument, test_runner, tracer' },
                ].map(({ mode, color, desc, tools }) => (
                  <div key={mode} className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, borderTop: `3px solid ${color}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 16, color }}>/{mode}</span>
                      <span className="badge" style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}>Mode</span>
                    </div>
                    <p style={{ fontFamily: 'var(--font-inter)', fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>{desc}</p>
                    <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid var(--color-outline-variant)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                      Enabled: {tools}
                    </div>
                  </div>
                ))}
              </div>
            </article>
          )}

          {/* SECTION 7: SLASH COMMANDS */}
          {activeSection === 'slash-commands' && (
            <article style={{ display: 'flex', flexDirection: 'column', gap: 24 }} className="animate-fade-in">
              <div>
                <span className="badge badge-primary" style={{ marginBottom: 12 }}>API Reference</span>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 36, letterSpacing: '-0.03em', color: 'var(--color-on-surface)' }}>
                  Slash Commands Reference (14 Built-in)
                </h1>
              </div>

              <div className="card" style={{ overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-inter)', fontSize: 14, textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface-container-low)', borderBottom: '1px solid var(--color-outline-variant)' }}>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Command</th>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Description</th>
                      <th style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Example Usage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { cmd: '/plan', desc: 'Drafts a structured execution plan before making code changes.', ex: '/plan migrate auth to OAuth2' },
                      { cmd: '/debug', desc: 'Evidence-backed bug investigation and reproduction workflow.', ex: '/debug investigate race condition in token_mgr' },
                      { cmd: '/graph', desc: 'Visualizes AST dependency graph for a specific file or symbol.', ex: '/graph src/auth/auth_service.ts' },
                      { cmd: '/compress', desc: 'Minifies distant context dependencies to interface signatures.', ex: '/compress --target 50k' },
                      { cmd: '/mcp', desc: 'Lists and manages Model Context Protocol (MCP) server connections.', ex: '/mcp list' },
                      { cmd: '/skills', desc: 'Lists custom skills loaded from .agents/skills/', ex: '/skills' },
                      { cmd: '/mode', desc: 'Switches agent operational mode (ask, plan, agent, debug).', ex: '/mode debug' },
                      { cmd: '/undo', desc: 'Rolls back the last transaction patch from the backup stack.', ex: '/undo' },
                      { cmd: '/clear', desc: 'Resets conversation turn history while keeping workspace index.', ex: '/clear' },
                      { cmd: '/help', desc: 'Displays interactive command palette and documentation.', ex: '/help' },
                    ].map(({ cmd, desc, ex }, i) => (
                      <tr key={cmd} style={{ borderBottom: i < 9 ? '1px solid var(--color-outline-variant)' : 'none' }}>
                        <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--color-primary)' }}>{cmd}</td>
                        <td style={{ padding: '12px 16px', color: 'var(--color-on-surface-variant)' }}>{desc}</td>
                        <td style={{ padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{ex}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}

          {/* SECTION 8: FULL MATURITY RFC INCLUSION */}
          {(activeSection === 'rfc-maturity-plan' || activeSection === 'rfc-roadmap-phases' || activeSection === 'rfc-evaluation-strategy') && (
            <article style={{ display: 'flex', flexDirection: 'column', gap: 24 }} className="animate-fade-in">
              <div>
                <span className="badge badge-secondary" style={{ marginBottom: 12 }}>Technical RFC Specification</span>
                <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.03em', color: 'var(--color-on-surface)' }}>
                  Inflynx Code — Production-Grade Agent Maturity Plan
                </h1>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-on-surface-variant)', marginTop: 6, display: 'flex', gap: 16 }}>
                  <span>Status: <strong>Proposed Implementation Roadmap</strong></span>
                  <span>Date: <strong>2026-08-10</strong></span>
                  <span>Scope: <strong>CLI/TUI Maturity to Codex Level</strong></span>
                </div>
              </div>

              <Callout type="note" title="Included Document: docs/PRODUCTION-GRADE-AGENT-MATURITY-PLAN.md">
                This document is embedded directly from <code>docs/PRODUCTION-GRADE-AGENT-MATURITY-PLAN.md</code>. It outlines the architectural baseline, product principles, target architecture, 13-phase implementation roadmap, and security evaluation strategy.
              </Callout>

              {/* RFC Section 1 & 2 */}
              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 24, borderBottom: '1px solid var(--color-outline-variant)', paddingBottom: 8 }}>
                1. Product Principles & Evidence-First Standard
              </h2>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14 }}>
                {[
                  { title: '1. Evidence Before Confidence', text: 'The agent must not present a critical or high-confidence bug finding based only on model intuition. Findings require reproducible commands, stack traces, exact line ranges, or failing regression tests.' },
                  { title: '2. Model Instructions Are Not Security Boundaries', text: 'Prompts guide behavior, but permissions are enforced in code. Every tool execution passes through canonical path guards, symlink protection, Docker sandboxing, and resource limits.' },
                  { title: '3. Thinking Effort and Execution Effort Are Separate', text: 'ThinkingConfig controls provider reasoning for one prompt. EffortProfile controls turns, tools, retries, verification depth, and time budget across the whole task.' },
                  { title: '4. Minimal, Reversible Changes', text: 'Modifications are patch-first, diff-visible, transaction-aware, and rollback-capable.' },
                  { title: '5. Verification is a Gate, Not a Suggestion', text: 'Patch applied → Focused verification → Package verification → Repository verification → Review.' },
                ].map(({ title, text }) => (
                  <li key={title} className="card" style={{ padding: 16 }}>
                    <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 16, color: 'var(--color-primary)', marginBottom: 4 }}>{title}</div>
                    <p style={{ fontFamily: 'var(--font-inter)', fontSize: 14, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>{text}</p>
                  </li>
                ))}
              </ul>

              {/* RFC Implementation Roadmap Phases 0-13 */}
              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 24, borderBottom: '1px solid var(--color-outline-variant)', paddingBottom: 8, marginTop: 24 }}>
                2. Phased Implementation Roadmap (Phases 0–13)
              </h2>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {[
                  { phase: 'Phase 0 — Baseline, Contracts, and CI', goals: 'Establish reproducible baseline before changing orchestration behavior.', items: 'Add CI for Linux/Windows, pin pnpm, mocked streaming test harness, capability matrix.' },
                  { phase: 'Phase 1 — Central Policy and Safe Tool Gateway', goals: 'Make every tool execution pass through security & path policy.', items: 'Canonical realpath validation, symlink escape rejection, shell command policy, process tree cancellation.' },
                  { phase: 'Phase 2 — Shared Agent Orchestrator & State Machine', goals: 'Move loop control out of CLI/TUI into @inflynx/agent-core.', items: 'Implement AgentOrchestrator, state machine transitions, central budget manager.' },
                  { phase: 'Phase 3 — Structured Planning & Context Management', goals: 'Make exploration deliberate, relevant, and bounded.', items: 'Task classifier, structured plan state, context compaction, active file relevance boost.' },
                  { phase: 'Phase 4 — Verification Engine & Bounded Repair Loop', goals: 'Make verification systematic and failure-driven.', items: 'Check registry, failure parser, focused verification, bounded repair loop, failure journal.' },
                  { phase: 'Phase 5 — Evidence-First Debugging & Critical Bug Detection', goals: 'Turn debug mode into disciplined investigation system.', items: 'BugFinding schema, correctness pass, security audit pass, regression pass.' },
                  { phase: 'Phase 6 — Workspace Intelligence & Incremental Semantic Graph', goals: 'Improve investigation for large repositories.', items: 'Incremental watch, symbol graph, test-to-source mapping, dependency distance query.' },
                  { phase: 'Phase 7 — Transactional Editing, Conflicts & AST Support', goals: 'Make multi-file changes safer and structurally reliable.', items: 'Precondition hashes, transaction rollback, AST adapters for TypeScript.' },
                  { phase: 'Phase 8 — Sessions, Failure Memory & Observability', goals: 'Make sessions resumable, auditable, and diagnosable.', items: 'SQLite session store, redacted telemetry, correlation IDs, privacy controls.' },
                  { phase: 'Phase 9 — Provider Reliability & Cost Routing', goals: 'Make model behavior predictable across providers.', items: 'Gemini native thinking adapter, usage parsing, request idempotency, model fallback.' },
                  { phase: 'Phase 10 — Tool DAG, Parallelism & Large Repo Tuning', goals: 'Improve execution speed without sacrificing ordering.', items: 'Tool DAG scheduler, parallel read-only execution, cache invalidation.' },
                  { phase: 'Phase 11 — Plugin & Protocol Expansion', goals: 'Expose stable runtime to server, desktop, and web clients.', items: 'WebSocket server adapter, plugin capability sandbox, versioned protocol schemas.' },
                ].map(({ phase, goals, items }) => (
                  <div key={phase} className="card" style={{ padding: 18 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15, color: 'var(--color-on-surface)', marginBottom: 4 }}>{phase}</div>
                    <div style={{ fontFamily: 'var(--font-inter)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', marginBottom: 6 }}>Goal: {goals}</div>
                    <p style={{ fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-on-surface-variant)', lineHeight: 1.5 }}>Work: {items}</p>
                  </div>
                ))}
              </div>

              {/* Sprint A-E Exit Criteria */}
              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 24, borderBottom: '1px solid var(--color-outline-variant)', paddingBottom: 8, marginTop: 24 }}>
                3. First Implementation Sprint & Definition of Done
              </h2>
              <DocCodeBlock code={`planning → exploring → implementing → verifying → repairing → reviewing → completed`} language="text" />
              <p style={{ fontFamily: 'var(--font-inter)', fontSize: 15, lineHeight: 1.6, color: 'var(--color-on-surface-variant)' }}>
                Definition of Done for Beta v1: Every tool call, approval, failure, and verification result is visible in the event stream, with redacted telemetry and zero unverified bug claims.
              </p>
            </article>
          )}

        </main>

        {/* ═══ RIGHT TABLE OF CONTENTS ═══ */}
        <aside style={{ width: 220, padding: '40px 16px', flexShrink: 0, display: 'none' }} className="hidden xl:block">
          <div style={{ position: 'sticky', top: 88, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              On this page
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-on-surface-variant)' }}>
              <a href="#" style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}>Overview</a>
              <a href="#" style={{ color: 'inherit', textDecoration: 'none' }}>Specification</a>
              <a href="#" style={{ color: 'inherit', textDecoration: 'none' }}>API Reference</a>
              <a href="#" style={{ color: 'inherit', textDecoration: 'none' }}>Security RFC</a>
            </div>
          </div>
        </aside>

      </div>
    </div>
  )
}
