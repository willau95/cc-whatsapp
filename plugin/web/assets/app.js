// cc-whatsapp dashboard frontend
// Vanilla JS + Alpine.js. No build step.

function dashboard() {
  return {
    // ─── state ───
    projects: [],
    selectedId: null,
    selected: null,

    tabs: ['tunables', 'persona', 'contacts', 'access', 'trace'],
    activeTab: 'tunables',

    tunables: {},
    tunablesMeta: {
      collect_window_ms: {
        type: 'number', unit: 'ms', step: 1000, min: 1000, max: 300_000, default: 60_000,
        help: 'Collect window: keep batching inbound msgs while no new msg arrives within this duration. Bigger = longer wait, more humanlike but slower.',
      },
      pre_reply_min_ms: {
        type: 'number', unit: 'ms', step: 1000, min: 0, max: 900_000, default: 30_000,
        help: 'Pre-reply delay LOW bound: minimum time after collect window before claude is invoked.',
      },
      pre_reply_max_ms: {
        type: 'number', unit: 'ms', step: 1000, min: 1000, max: 900_000, default: 60_000,
        help: 'Pre-reply delay HIGH bound: maximum. Actual delay random between min/max each batch.',
      },
      quote_reply_probability: {
        type: 'number', unit: '0–1', step: 0.05, min: 0, max: 1, default: 0.4,
        help: 'Probability to quote-reply ONE specific message in a multi-msg batch. 0 = never, 1 = always (when batch >= 2).',
      },
      multi_msg_max_segments: {
        type: 'number', unit: 'count', step: 1, min: 1, max: 8, default: 4,
        help: 'Max reply chunks per turn (1 = always single message; higher = more natural multi-msg).',
      },
      inter_segment_min_ms: {
        type: 'number', unit: 'ms', step: 100, min: 0, max: 10_000, default: 800,
        help: 'Min delay between segments during multi-msg reply (length-scaled in router).',
      },
      inter_segment_max_ms: {
        type: 'number', unit: 'ms', step: 100, min: 100, max: 20_000, default: 2200,
        help: 'Max delay between segments. Real humans take 1-5s between sends.',
      },
      chat_model: {
        type: 'text', unit: 'model id', step: null, min: null, max: null, default: 'claude-haiku-4-5-20251001',
        help: 'Anthropic model id for the chat bot. Haiku = fast+cheap; Sonnet/Opus = smarter+pricier.',
      },
    },
    tunablesSaved: false,

    personaNames: ['IDENTITY.md', 'SOUL.md', 'STYLE.md', 'AGENTS.md', 'MEMORY.md'],
    persona: { 'IDENTITY.md': '', 'SOUL.md': '', 'STYLE.md': '', 'AGENTS.md': '', 'MEMORY.md': '' },
    activePersonaFile: 'IDENTITY.md',
    personaSaved: false,

    access: { allowFrom: [], disabled: false },
    newJid: '',
    accessSaved: false,

    contacts: [],
    activeContact: null,
    contactContent: '',
    contactSaved: false,

    traceLines: [],   // {id, text}
    traceCounter: 0,
    ws: null,
    wsConnected: false,

    // ─── lifecycle ───
    async init() {
      await this.refresh()
      if (this.projects.length && !this.selectedId) this.select(this.projects[0].id)
    },

    async refresh() {
      const r = await fetch('/api/projects')
      this.projects = await r.json()
      if (this.selectedId) {
        const fresh = this.projects.find(p => p.id === this.selectedId)
        if (fresh) this.selected = fresh
      }
    },

    async select(id) {
      this.selectedId = id
      this.selected = this.projects.find(p => p.id === id)
      // Close existing WS
      if (this.ws) { try { this.ws.close() } catch {}; this.ws = null }
      this.traceLines = []
      await Promise.all([
        this.loadTunables(),
        this.loadPersona(),
        this.loadAccess(),
        this.loadContacts(),
      ])
      this.connectTrace()
    },

    // ─── tunables ───
    async loadTunables() {
      const r = await fetch(`/api/projects/${this.selectedId}/tunables`)
      this.tunables = await r.json()
    },
    async saveTunables() {
      const r = await fetch(`/api/projects/${this.selectedId}/tunables`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.tunables),
      })
      if (r.ok) this.flashSaved('tunablesSaved')
    },

    // ─── persona ───
    async loadPersona() {
      const r = await fetch(`/api/projects/${this.selectedId}/persona`)
      this.persona = await r.json()
    },
    async savePersona() {
      const name = this.activePersonaFile
      const r = await fetch(`/api/projects/${this.selectedId}/persona/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: this.persona[name] ?? '',
      })
      if (r.ok) this.flashSaved('personaSaved')
    },

    // ─── access ───
    async loadAccess() {
      const r = await fetch(`/api/projects/${this.selectedId}/access`)
      this.access = await r.json()
      this.access.allowFrom = this.access.allowFrom ?? []
    },
    async saveAccess() {
      const r = await fetch(`/api/projects/${this.selectedId}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.access),
      })
      if (r.ok) this.flashSaved('accessSaved')
    },
    addJid() {
      const j = (this.newJid || '').trim()
      if (!j) return
      if (!this.access.allowFrom.includes(j)) {
        this.access.allowFrom.push(j)
        this.saveAccess()
      }
      this.newJid = ''
    },
    removeJid(idx) {
      this.access.allowFrom.splice(idx, 1)
      this.saveAccess()
    },

    // ─── contacts ───
    async loadContacts() {
      const r = await fetch(`/api/projects/${this.selectedId}/contacts`)
      this.contacts = await r.json()
    },
    async loadContact(jid) {
      this.activeContact = jid
      const r = await fetch(`/api/projects/${this.selectedId}/contacts/${encodeURIComponent(jid)}`)
      const d = await r.json()
      this.contactContent = d.content
    },
    async saveContact() {
      if (!this.activeContact) return
      const r = await fetch(`/api/projects/${this.selectedId}/contacts/${encodeURIComponent(this.activeContact)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: this.contactContent,
      })
      if (r.ok) this.flashSaved('contactSaved')
    },

    // ─── trace WS ───
    connectTrace() {
      const url = `ws://${location.host}/ws/projects/${this.selectedId}/trace`
      try { this.ws = new WebSocket(url) } catch (e) { return }
      this.ws.onopen = () => { this.wsConnected = true }
      this.ws.onclose = () => {
        this.wsConnected = false
        // Reconnect after 2s if still on same project
        setTimeout(() => {
          if (this.selectedId) this.connectTrace()
        }, 2000)
      }
      this.ws.onerror = () => { this.wsConnected = false }
      this.ws.onmessage = (e) => {
        this.traceLines.push({ id: ++this.traceCounter, text: e.data })
        if (this.traceLines.length > 500) this.traceLines.splice(0, this.traceLines.length - 500)
        // Auto-scroll
        this.$nextTick(() => {
          if (this.$refs.traceBox) this.$refs.traceBox.scrollTop = this.$refs.traceBox.scrollHeight
        })
      }
    },

    traceLineClass(text) {
      if (text.includes('error') || text.includes('fail')) return 'text-red-400'
      if (text.includes('claude_trigger') || text.includes('claude_spawn')) return 'text-amber-300'
      if (text.includes('claude_exit')) return 'text-emerald-300'
      if (text.includes('webhook_received') || text.includes('batch_enqueue')) return 'text-blue-300'
      if (text.includes('drop_')) return 'text-zinc-500'
      return 'text-zinc-300'
    },

    // ─── router control ───
    async startRouter() {
      const r = await fetch(`/api/projects/${this.selectedId}/router/start`, { method: 'POST' })
      const d = await r.json()
      if (!d.ok) alert('start failed: ' + (d.err ?? 'unknown'))
      // Refresh status after a moment
      setTimeout(() => this.refresh().then(() => this.refresh()), 2000)
    },
    async stopRouter() {
      const r = await fetch(`/api/projects/${this.selectedId}/router/stop`, { method: 'POST' })
      const d = await r.json()
      if (!d.ok) alert('stop failed: ' + (d.err ?? 'unknown'))
      setTimeout(() => this.refresh(), 1500)
    },

    flashSaved(key) {
      this[key] = true
      setTimeout(() => { this[key] = false }, 1500)
    },
  }
}
