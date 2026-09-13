import { useState } from 'react'
import { Link } from 'react-router-dom'

export default function ContactPage() {
  const [formData, setFormData] = useState({ name: '', email: '', company: '', topic: 'enterprise', message: '' })
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    setLoading(true)
    setTimeout(() => {
      setLoading(false)
      setSubmitted(true)
    }, 1000)
  }

  return (
    <div style={{ background: 'var(--color-background)', minHeight: '100vh', fontFamily: 'var(--font-inter)' }}>
      <section
        style={{
          maxWidth: 'var(--max-width)',
          margin: '0 auto',
          padding: '64px 24px 96px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 48,
          alignItems: 'start',
        }}
        className="animate-fade-in-up"
      >
        {/* Left: Contact Info */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div>
            <span className="badge badge-primary" style={{ marginBottom: 12 }}>Get In Touch</span>
            <h1 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 'clamp(30px, 4vw, 44px)', letterSpacing: '-0.02em', color: 'var(--color-on-surface)' }}>
              Let's talk code intelligence.
            </h1>
            <p style={{ fontFamily: 'var(--font-inter)', fontSize: 16, lineHeight: 1.65, color: 'var(--color-on-surface-variant)', marginTop: 8 }}>
              Whether you need an Enterprise SOC2 review, private air-gapped deployment, custom model adapters, or technical support — our engineering team is here.
            </p>
          </div>

          {/* Contact Cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              {
                icon: 'support_agent',
                title: 'Enterprise & Sales Inquiries',
                desc: 'Custom SLA, volume credits, on-premise Docker sandboxes, and dedicated account engineers.',
                contact: 'sales@inflynx.ai',
                color: 'var(--color-primary)',
              },
              {
                icon: 'shield',
                title: 'Security & Compliance',
                desc: 'Request our SOC2 Type II report, penetration testing artifacts, and security architecture whitepaper.',
                contact: 'security@inflynx.ai',
                color: 'var(--color-tertiary)',
              },
              {
                icon: 'forum',
                title: 'Developer Community',
                desc: 'Join 2,400+ engineers on Discord and GitHub discussions discussing AST parsing and multi-provider agent workflows.',
                contact: 'discord.gg/inflynx',
                color: 'var(--color-secondary)',
              },
            ].map(({ icon, title, desc, contact, color }) => (
              <div
                key={title}
                className="card"
                style={{
                  padding: 20,
                  background: 'var(--color-surface-container-lowest)',
                  display: 'flex',
                  gap: 16,
                  alignItems: 'flex-start',
                }}
              >
                <div style={{ width: 40, height: 40, borderRadius: 8, background: `${color}15`, color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{icon}</span>
                </div>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-geist)', fontWeight: 600, fontSize: 15, color: 'var(--color-on-surface)' }}>{title}</h3>
                  <p style={{ fontFamily: 'var(--font-inter)', fontSize: 13, color: 'var(--color-on-surface-variant)', margin: '4px 0 6px', lineHeight: 1.5 }}>{desc}</p>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color }}>{contact}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Interactive Form */}
        <div
          className="card"
          style={{
            padding: 36,
            background: 'var(--color-surface-container-lowest)',
            boxShadow: '0 8px 32px rgba(20, 33, 43, 0.08)',
          }}
        >
          {submitted ? (
            <div style={{ textAlign: 'center', padding: '48px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }} className="animate-scale-in">
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(0, 96, 86, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="material-symbols-outlined icon-fill" style={{ fontSize: 36, color: 'var(--color-tertiary)' }}>
                  check_circle
                </span>
              </div>
              <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 24, color: 'var(--color-on-surface)' }}>
                Message Received!
              </h2>
              <p style={{ fontFamily: 'var(--font-inter)', fontSize: 15, color: 'var(--color-on-surface-variant)', maxWidth: 360, lineHeight: 1.6 }}>
                Thank you, <strong>{formData.name || 'there'}</strong>. An Inflynx systems engineer will review your request and reply to <strong>{formData.email}</strong> within 2 hours.
              </p>
              <button
                onClick={() => { setSubmitted(false); setFormData({ name: '', email: '', company: '', topic: 'enterprise', message: '' }) }}
                className="btn-secondary"
                style={{ marginTop: 12 }}
              >
                Send another message
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div>
                <h2 style={{ fontFamily: 'var(--font-geist)', fontWeight: 700, fontSize: 22, color: 'var(--color-on-surface)' }}>
                  Send us a message
                </h2>
                <p style={{ fontFamily: 'var(--font-inter)', fontSize: 14, color: 'var(--color-on-surface-variant)', marginTop: 4 }}>
                  Fill out the form below and our team will get back to you promptly.
                </p>
              </div>

              <div>
                <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>
                  Your Name *
                </label>
                <input
                  required
                  className="input"
                  placeholder="Arjun Patel"
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                />
              </div>

              <div>
                <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>
                  Work Email *
                </label>
                <input
                  required
                  type="email"
                  className="input"
                  placeholder="arjun@company.com"
                  value={formData.email}
                  onChange={e => setFormData({ ...formData, email: e.target.value })}
                />
              </div>

              <div>
                <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>
                  Company / Organization
                </label>
                <input
                  className="input"
                  placeholder="Acme Corp"
                  value={formData.company}
                  onChange={e => setFormData({ ...formData, company: e.target.value })}
                />
              </div>

              <div>
                <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>
                  Topic *
                </label>
                <select
                  className="input"
                  value={formData.topic}
                  onChange={e => setFormData({ ...formData, topic: e.target.value })}
                  style={{ background: 'var(--color-surface-container-low)' }}
                >
                  <option value="enterprise">Enterprise Plan & Custom Pricing</option>
                  <option value="security">Security Review & SOC2 Audit Access</option>
                  <option value="onprem">On-Premise / Air-Gapped Deployment</option>
                  <option value="support">Technical Support & Issue Report</option>
                  <option value="partnership">Partnership or Model Gateway Integration</option>
                </select>
              </div>

              <div>
                <label style={{ fontFamily: 'var(--font-inter)', fontWeight: 600, fontSize: 13, color: 'var(--color-on-surface)', display: 'block', marginBottom: 6 }}>
                  Message *
                </label>
                <textarea
                  required
                  rows={4}
                  className="input"
                  placeholder="Tell us about your team's codebase, repository size, and requirements..."
                  value={formData.message}
                  onChange={e => setFormData({ ...formData, message: e.target.value })}
                  style={{ resize: 'vertical' }}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-primary"
                style={{ justifyContent: 'center', padding: '14px', fontSize: 15 }}
              >
                {loading ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="material-symbols-outlined" style={{ animation: 'spin 1s linear infinite' }}>progress_activity</span>
                    Sending message...
                  </span>
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    Send Message
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>send</span>
                  </span>
                )}
              </button>

              <p style={{ fontFamily: 'var(--font-inter)', fontSize: 12, color: 'var(--color-on-surface-variant)', textAlign: 'center' }}>
                Protected by Inflynx Zero-Spam Policy · <Link to="/privacy" style={{ color: 'var(--color-primary)' }}>Privacy Policy</Link>
              </p>
            </form>
          )}
        </div>
      </section>
    </div>
  )
}
