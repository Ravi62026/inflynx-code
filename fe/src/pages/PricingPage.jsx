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

const plans = [
  {
    name: 'Starter',
    price: { monthly: 0, annual: 0 },
    tag: null,
    color: 'var(--color-outline-variant)',
    cta: 'Get started free',
    ctaStyle: 'secondary',
    features: [
      '500 credits / month',
      '1 workspace',
      '2 AI providers (DeepSeek, Gemini)',
      'Basic context window (32k)',
      'Standard tool access',
      'Community support',
    ],
    notIncluded: ['Multi-provider routing', 'Audit logs', 'Team access', 'Custom policies'],
  },
  {
    name: 'Pro',
    price: { monthly: 49, annual: 39 },
    tag: 'Most Popular',
    color: 'var(--color-primary)',
    cta: 'Start free trial',
    ctaStyle: 'primary',
    features: [
      '5,000 credits / month',
      '5 workspaces',
      'All 5 AI providers',
      'Full 200k context window',
      'Multi-provider routing',
      'AST-aware patch engine',
      'Sandboxed execution',
      'Basic audit logs',
      'Email support',
    ],
    notIncluded: ['Team access', 'SOC2 compliance', 'Custom BYOK policies'],
  },
  {
    name: 'Enterprise',
    price: { monthly: null, annual: null },
    tag: 'Custom pricing',
    color: 'var(--color-secondary)',
    cta: 'Contact sales',
    ctaStyle: 'secondary',
    features: [
      'Unlimited credits',
      'Unlimited workspaces',
      'All providers + Ollama/local',
      'Custom context budgets',
      'Full multi-provider routing',
      'Team access & RBAC',
      'SOC2 immutable audit logs',
      'Custom BYOK policies',
      'SLA & dedicated support',
      'On-premise deployment option',
    ],
    notIncluded: [],
  },
]

export default function PricingPage() {
  const [annual, setAnnual] = useState(false)
  const [heroRef, heroInView] = useInView(0.1)
  const [cardsRef, cardsInView] = useInView(0.1)
  const [faqRef, faqInView] = useInView(0.1)
  const [openFaq, setOpenFaq] = useState(null)

  const faqs = [
    { q: 'What are credits?', a: 'Credits are the unit of compute used by agent tasks. Each tool call, model request, and verification step consumes credits. Unused credits roll over within your billing period.' },
    { q: 'Can I bring my own API keys?', a: 'Yes — Inflynx Code is BYOK-first. You can provide your own keys for any supported provider and we will never store or log them. Our system redacts all credentials before they reach our infrastructure.' },
    { q: 'Is there a free trial?', a: 'Pro plan includes a 14-day free trial with no credit card required. After the trial, you can continue on Starter (free forever) or upgrade.' },
    { q: 'How does sandboxed execution work?', a: 'Agent shell commands run in ephemeral Docker containers with network isolation. The container is destroyed after each task. No host access, no persistent state.' },
    { q: 'Do you offer discounts for open source projects?', a: 'Yes! We offer a free Pro tier for verified open source projects. Apply via GitHub and we\'ll get back to you within 2 business days.' },
  ]

  return (
    <div style={{ background: 'var(--color-background)', minHeight: '100vh' }}>

      {/* ═══ HERO ═══ */}
      <section
        ref={heroRef}
        style={{ maxWidth: 'var(--max-width)', margin: '0 auto', padding: '72px 24px 48px', textAlign: 'center' }}
      >
        <div
          style={{
            opacity: heroInView ? 1 : 0,
            transform: heroInView ? 'translateY(0)' : 'translateY(24px)',
            transition: 'all 0.6s ease',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 20,
          }}
        >
          <span className="badge badge-primary" style={{ fontSize: 11 }}>Pricing</span>
          <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(36px, 6vw, 64px)', letterSpacing: '-0.04em', color: 'var(--color-on-surface)', lineHeight: 1.1 }}>
            Simple, transparent pricing.
          </h1>
          <p style={{ fontFamily: 'var(--font-inter)', fontSize: 18, color: 'var(--color-on-surface-variant)', maxWidth: 520, lineHeight: 1.65 }}>
            Start free, scale as you build. No hidden fees. No vendor lock-in. Bring your own API keys.
          </p>

          {/* Toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              background: 'var(--color-surface-container-low)',
              border: '1px solid var(--color-outline-variant)',
              borderRadius: 9999,
              padding: '4px 8px',
              marginTop: 8,
            }}
          >
            <button
              onClick={() => setAnnual(false)}
              style={{
                padding: '6px 16px',
                borderRadius: 9999,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-inter)',
                fontSize: 14,
                fontWeight: 500,
                background: !annual ? 'var(--color-surface-container-lowest)' : 'transparent',
                color: !annual ? 'var(--color-on-surface)' : 'var(--color-on-surface-variant)',
                boxShadow: !annual ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.2s ease',
              }}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              style={{
                padding: '6px 16px',
                borderRadius: 9999,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-inter)',
                fontSize: 14,
                fontWeight: 500,
                background: annual ? 'var(--color-primary)' : 'transparent',
                color: annual ? 'var(--color-on-primary)' : 'var(--color-on-surface-variant)',
                transition: 'all 0.2s ease',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              Annual
              <span style={{ background: annual ? 'rgba(255,255,255,0.25)' : 'var(--color-surface-container)', color: annual ? 'var(--color-on-primary)' : 'var(--color-tertiary)', padding: '1px 6px', borderRadius: 9999, fontSize: 10, fontWeight: 700 }}>
                -20%
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* ═══ PRICING CARDS ═══ */}
      <section ref={cardsRef} style={{ maxWidth: 'var(--max-width)', margin: '0 auto', padding: '0 24px 80px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24, alignItems: 'stretch' }}>
          {plans.map(({ name, price, tag, color, cta, ctaStyle, features, notIncluded }, i) => (
            <div
              key={name}
              style={{
                background: 'var(--color-surface-container-lowest)',
                border: `2px solid ${name === 'Pro' ? color : 'var(--color-outline-variant)'}`,
                borderRadius: 16,
                padding: 28,
                display: 'flex',
                flexDirection: 'column',
                gap: 24,
                position: 'relative',
                overflow: 'hidden',
                opacity: cardsInView ? 1 : 0,
                transform: cardsInView ? 'translateY(0)' : 'translateY(30px)',
                transition: `all 0.6s ease ${i * 0.15}s`,
                boxShadow: name === 'Pro' ? `0 8px 32px ${color}20` : 'none',
              }}
            >
              {/* Top accent bar */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: color }} />

              {tag && (
                <div style={{ position: 'absolute', top: 16, right: 16 }}>
                  <span
                    className="badge"
                    style={{
                      background: name === 'Pro' ? color : 'var(--color-surface-container-high)',
                      color: name === 'Pro' ? 'var(--color-on-primary)' : 'var(--color-on-surface)',
                      border: 'none',
                      fontSize: 11,
                    }}
                  >
                    {tag}
                  </span>
                </div>
              )}

              <div>
                <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 22, color: 'var(--color-on-surface)', marginBottom: 16 }}>{name}</h3>
                {price.monthly !== null ? (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 48, letterSpacing: '-0.04em', color: 'var(--color-on-surface)' }}>
                      ${annual ? price.annual : price.monthly}
                    </span>
                    {price.monthly > 0 && (
                      <span style={{ fontFamily: 'var(--font-inter)', fontSize: 15, color: 'var(--color-on-surface-variant)' }}>/month</span>
                    )}
                    {price.monthly === 0 && (
                      <span style={{ fontFamily: 'var(--font-inter)', fontSize: 15, color: 'var(--color-on-surface-variant)' }}>forever</span>
                    )}
                  </div>
                ) : (
                  <div style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 32, color: 'var(--color-on-surface)' }}>Custom</div>
                )}
              </div>

              {/* CTA */}
              <Link
                to={name === 'Enterprise' ? '/contact' : '/signup'}
                className={ctaStyle === 'primary' ? 'btn-primary' : 'btn-secondary'}
                style={{ justifyContent: 'center', width: '100%', padding: '12px 0' }}
              >
                {cta}
              </Link>

              {/* Features */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {features.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span className="material-symbols-outlined icon-fill" style={{ fontSize: 18, color: 'var(--color-tertiary)', flexShrink: 0, marginTop: 2 }}>check_circle</span>
                    <span style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface)', lineHeight: 1.5 }}>{f}</span>
                  </div>
                ))}
                {notIncluded.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, opacity: 0.4 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-outline)', flexShrink: 0, marginTop: 2 }}>remove</span>
                    <span style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface)', lineHeight: 1.5 }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══ FAQ ═══ */}
      <section
        ref={faqRef}
        style={{
          background: 'var(--color-surface-container)',
          borderTop: '1px solid var(--color-outline-variant)',
          padding: '80px 24px',
        }}
      >
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h2
            style={{
              fontFamily: 'var(--font-geist)',
              fontWeight: 600,
              fontSize: 'clamp(28px, 4vw, 40px)',
              letterSpacing: '-0.02em',
              color: 'var(--color-on-surface)',
              textAlign: 'center',
              marginBottom: 40,
              opacity: faqInView ? 1 : 0,
              transform: faqInView ? 'translateY(0)' : 'translateY(20px)',
              transition: 'all 0.6s ease',
            }}
          >
            Frequently asked questions
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {faqs.map(({ q, a }, i) => (
              <div
                key={i}
                style={{
                  borderBottom: '1px solid var(--color-outline-variant)',
                  opacity: faqInView ? 1 : 0,
                  transform: faqInView ? 'translateY(0)' : 'translateY(12px)',
                  transition: `all 0.5s ease ${0.1 + i * 0.08}s`,
                }}
              >
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '20px 0',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    gap: 16,
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 16, color: 'var(--color-on-surface)' }}>{q}</span>
                  <span
                    className="material-symbols-outlined"
                    style={{
                      fontSize: 22,
                      color: 'var(--color-on-surface-variant)',
                      flexShrink: 0,
                      transition: 'transform 0.2s ease',
                      transform: openFaq === i ? 'rotate(180deg)' : 'none',
                    }}
                  >
                    expand_more
                  </span>
                </button>
                <div
                  style={{
                    maxHeight: openFaq === i ? 200 : 0,
                    overflow: 'hidden',
                    transition: 'max-height 0.3s ease',
                  }}
                >
                  <p style={{ fontFamily: 'var(--font-inter)', fontSize: 15, lineHeight: 1.7, color: 'var(--color-on-surface-variant)', paddingBottom: 20 }}>
                    {a}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ BOTTOM CTA ═══ */}
      <section style={{ padding: '72px 24px', textAlign: 'center' }}>
        <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
          <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 'clamp(24px, 3vw, 36px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)' }}>
            Questions? We're here to help.
          </h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Link to="/signup" className="btn-primary">Start for free</Link>
            <a href="mailto:hello@inflynx.dev" className="btn-secondary">Talk to sales</a>
          </div>
        </div>
      </section>
    </div>
  )
}
