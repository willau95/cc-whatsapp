// cc-whatsapp dashboard frontend — beginner-friendly + edit/save/cancel pattern.
// Vanilla JS + Alpine.js. No build step.

function app() {
  return {
    // ─── projects + selection ───
    projects: [],
    selectedId: null,
    selected: null,

    // ─── tabs ───
    tabs: [
      { id: 'overview',   icon: '📊', label: 'Overview',   dirty: () => false },
      { id: 'chats',      icon: '💬', label: 'Chats',      dirty: () => false },
      { id: 'persona',    icon: '🎭', label: 'Persona',    dirty: () => Object.values(this.personaDirty).some(v => v) },
      { id: 'tunables',   icon: '🎚',  label: 'Tunables',   dirty: () => this.tunablesIsDirty },
      { id: 'production', icon: '🔬', label: 'Production', dirty: () => false },
      { id: 'access',     icon: '🔐', label: 'Access',     dirty: () => this.accessIsDirty },
      { id: 'settings',   icon: '⚙️',  label: 'Settings',   dirty: () => false },
    ],
    activeTab: 'overview',
    pendingTab: null,
    confirmTab: false,

    // ─── overview ───
    liveState: {},
    recentTrace: [],
    traceCounter: 0,
    ws: null,

    // ─── chats ───
    conversations: [],
    activeChat: null,
    chatMessages: [],

    // ─── persona ───
    personaNames: ['IDENTITY.md', 'SOUL.md', 'STYLE.md', 'AGENTS.md', 'MEMORY.md'],
    personaHelp: {
      'IDENTITY.md': 'Who the bot IS — name, vibe, languages.',
      'SOUL.md':     'Character traits, beliefs, what it WON\'T do.',
      'STYLE.md':    'How it writes — length, tone, formatting rules.',
      'AGENTS.md':   'The iron rules. Always-fires instructions.',
      'MEMORY.md':   'Global long-term memory (owner profile, cross-contact patterns).',
    },
    personaSaved: {},
    personaDraft: {},
    personaDirty: {},
    activePersonaFile: 'IDENTITY.md',

    // ─── tunables ───
    tunablesSaved: {},
    tunablesDraft: {},
    tunablesIsDirty: false,
    tunablesGroups: [
      { title: 'Reply timing (the most-visible humanlike feel)', keys: ['collect_window_ms', 'pre_reply_min_ms', 'pre_reply_max_ms'] },
      { title: 'Send pacing (per-segment delay during multi-msg replies)', keys: ['inter_segment_min_ms', 'inter_segment_max_ms', 'length_factor_short', 'length_factor_medium', 'length_factor_long'] },
      { title: 'Reply shape (what the bot chooses to do)',           keys: ['quote_reply_probability', 'multi_msg_max_segments', 'enable_typing_indicator'] },
      { title: 'Brain',                                              keys: ['chat_model', 'max_prompt_chars'] },
    ],
    tunablesMeta: {
      collect_window_ms: {
        label: 'Collect window', type: 'number', unit: 'ms', step: 1000, min: 1000, max: 600_000, default: 60_000,
        help: 'How long to wait for MORE messages before processing. Each new inbound resets this timer. Bigger = more humanlike "looking at phone in batches" feel.',
        feelLike: v => `${(v/1000).toFixed(0)}s — ${v < 10_000 ? 'feels instant' : v < 30_000 ? 'quick batching' : v < 90_000 ? 'comfortable real-person pace' : 'very patient bot'}`,
      },
      pre_reply_min_ms: {
        label: 'Pre-reply delay (min)', type: 'number', unit: 'ms', step: 1000, min: 0, max: 900_000, default: 30_000,
        help: 'After collect closes, wait AT LEAST this long before invoking Claude. Mimics "I saw your messages but I\'m not answering immediately."',
        feelLike: v => `${(v/1000).toFixed(0)}s minimum`,
      },
      pre_reply_max_ms: {
        label: 'Pre-reply delay (max)', type: 'number', unit: 'ms', step: 1000, min: 1000, max: 900_000, default: 60_000,
        help: 'Upper bound. Actual delay each batch is RANDOM between min and max — so the bot doesn\'t feel mechanical.',
        feelLike: v => `up to ${(v/1000).toFixed(0)}s`,
      },
      inter_segment_min_ms: {
        label: 'Inter-segment delay (min)', type: 'number', unit: 'ms', step: 100, min: 0, max: 10_000, default: 800,
        help: 'Min wait between chunks during a multi-message reply. Real humans take 1-5 seconds between sends — scale this up if it looks too quick.',
        feelLike: v => v < 500 ? 'instant' : v < 1500 ? 'snappy' : v < 4000 ? 'natural' : 'slow typist',
      },
      inter_segment_max_ms: {
        label: 'Inter-segment delay (max)', type: 'number', unit: 'ms', step: 100, min: 100, max: 30_000, default: 2200,
        help: 'Max wait between chunks. Scaled by message length (longer text = longer pause).',
        feelLike: v => `up to ${(v/1000).toFixed(1)}s`,
      },
      length_factor_short: {
        label: 'Length factor — short msgs (<20 chars)', type: 'number', unit: '×', step: 0.1, min: 0.1, max: 3, default: 0.5,
        help: 'Multiplier for inter-segment delay on SHORT messages. <1 = faster than baseline. Short messages should be quick.',
        feelLike: v => `${v}× the baseline`,
      },
      length_factor_medium: {
        label: 'Length factor — medium msgs (20–100 chars)', type: 'number', unit: '×', step: 0.1, min: 0.1, max: 5, default: 1.0,
        help: '1.0 = use the configured baseline as-is.',
        feelLike: v => `${v}× the baseline`,
      },
      length_factor_long: {
        label: 'Length factor — long msgs (>100 chars)', type: 'number', unit: '×', step: 0.1, min: 0.1, max: 5, default: 1.6,
        help: '>1 = longer wait. Long messages should take more "typing time".',
        feelLike: v => `${v}× the baseline`,
      },
      quote_reply_probability: {
        label: 'Quote-reply probability', type: 'number', unit: '0–1', step: 0.05, min: 0, max: 1, default: 0.4,
        help: 'When batch ≥ 2 messages, chance that Claude quotes ONE specific message in the burst. 0 = never quote-reply, 1 = always (if batch ≥ 2).',
        feelLike: v => `~${Math.round(v*100)}% of multi-msg batches will use quote-reply`,
      },
      multi_msg_max_segments: {
        label: 'Max reply segments', type: 'number', unit: 'count', step: 1, min: 1, max: 8, default: 4,
        help: 'Maximum reply chunks per turn. 1 = always single message. Higher = more natural multi-message responses (like a real person).',
        feelLike: v => v === 1 ? 'always one block' : `up to ${v} natural messages`,
      },
      enable_typing_indicator: {
        label: 'Typing indicator', type: 'boolean', default: true,
        help: 'Show "Eva is typing…" in WhatsApp while the bot is processing + replying. Off = invisible (more stealth, less human).',
      },
      chat_model: {
        label: 'Chat model', type: 'text', default: 'claude-haiku-4-5-20251001',
        help: 'Anthropic model ID. Haiku = fast + cheap (recommended). Sonnet = smarter, pricier. Opus = highest quality, slowest.',
      },
      max_prompt_chars: {
        label: 'Max chars per inbound msg', type: 'number', unit: 'chars', step: 500, min: 500, max: 100_000, default: 8000,
        help: 'Truncate a single inbound message at this length before feeding to Claude. Prevents the prompt from exploding if someone pastes a wall of text.',
        feelLike: v => v < 2000 ? 'tight' : v < 10_000 ? 'comfortable' : 'very long allowed',
      },
    },
    tunablesPresets: [
      { name: '🤖 Default', desc: 'Balanced humanlike pace (60s collect, 30-60s reply delay)',
        values: { collect_window_ms: 60_000, pre_reply_min_ms: 30_000, pre_reply_max_ms: 60_000, multi_msg_max_segments: 4 } },
      { name: '⚡ Quick chat', desc: 'Faster — for active conversations where speed matters',
        values: { collect_window_ms: 15_000, pre_reply_min_ms: 3_000, pre_reply_max_ms: 10_000, multi_msg_max_segments: 3 } },
      { name: '😴 Lazy bot', desc: 'Very humanlike — takes minutes to respond, like a busy person',
        values: { collect_window_ms: 90_000, pre_reply_min_ms: 60_000, pre_reply_max_ms: 300_000, multi_msg_max_segments: 4 } },
      { name: '🥷 Stealth', desc: 'Long delays + typing off — hardest to detect as AI',
        values: { collect_window_ms: 120_000, pre_reply_min_ms: 90_000, pre_reply_max_ms: 600_000, enable_typing_indicator: false } },
    ],

    // ─── access ───
    accessSaved: { allowFrom: [], disabled: false },
    accessDraft: { allowFrom: [], disabled: false },
    accessIsDirty: false,
    newJid: '',

    // ─── production / turns ───
    turns: [],
    turnDetail: null,

    // ─── ui state ───
    toast: null,

    // ─── lifecycle ───
    async init() {
      await this.refresh()
      if (this.projects.length && !this.selectedId) {
        await this.select(this.projects[0].id)
      }
      // Poll for live state every 2s
      setInterval(() => { if (this.selectedId) this.pollLiveState() }, 2000)
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
      if (this.isDirty()) {
        // User has unsaved changes — confirm before switching project
        if (!confirm('You have unsaved changes. Switch project anyway (changes will be lost)?')) {
          this.selectedId = this.selected?.id
          return
        }
      }
      this.selectedId = id
      this.selected = this.projects.find(p => p.id === id)
      if (this.ws) { try { this.ws.close() } catch {}; this.ws = null }
      this.recentTrace = []
      this.activeChat = null
      this.chatMessages = []
      this.turnDetail = null
      await Promise.all([this.loadPersona(), this.loadTunables(), this.loadAccess(), this.loadConversations(), this.loadTurns(), this.pollLiveState()])
      this.connectTrace()
    },

    // ─── tabs ───
    switchTab(id) {
      if (id === this.activeTab) return
      const dirty = this.tabs.find(t => t.id === this.activeTab)?.dirty.call(this)
      if (dirty) {
        this.pendingTab = id
        this.confirmTab = true
        return
      }
      this.activeTab = id
      if (id === 'turns' || id === 'production') this.loadTurns()
    },
    async saveAndSwitch() {
      await this.saveAll()
      this.activeTab = this.pendingTab
      this.pendingTab = null
      this.confirmTab = false
    },
    discardAndSwitch() {
      this.discardAll()
      this.activeTab = this.pendingTab
      this.pendingTab = null
      this.confirmTab = false
    },

    // ─── persona ───
    async loadPersona() {
      const r = await fetch(`/api/projects/${this.selectedId}/persona`)
      this.personaSaved = await r.json()
      this.personaDraft = { ...this.personaSaved }
      this.personaDirty = {}
    },
    switchPersonaFile(name) {
      this.activePersonaFile = name
    },
    markPersonaDirty() {
      this.personaDirty[this.activePersonaFile] = this.personaDraft[this.activePersonaFile] !== this.personaSaved[this.activePersonaFile]
    },
    async savePersona() {
      const dirtyFiles = Object.keys(this.personaDirty).filter(k => this.personaDirty[k])
      for (const name of dirtyFiles) {
        const r = await fetch(`/api/projects/${this.selectedId}/persona/${name}`, {
          method: 'PUT', headers: { 'Content-Type': 'text/plain' },
          body: this.personaDraft[name] ?? '',
        })
        if (!r.ok) { this.flashToast('Save failed: ' + name, 'error'); return }
      }
      this.personaSaved = { ...this.personaDraft }
      this.personaDirty = {}
      this.flashToast(`Saved ${dirtyFiles.length} persona file(s)`)
    },

    // ─── tunables ───
    async loadTunables() {
      const r = await fetch(`/api/projects/${this.selectedId}/tunables`)
      this.tunablesSaved = await r.json()
      this.tunablesDraft = { ...this.tunablesSaved }
      this.tunablesIsDirty = false
    },
    markTunablesDirty() {
      this.tunablesIsDirty = JSON.stringify(this.tunablesDraft) !== JSON.stringify(this.tunablesSaved)
    },
    applyPreset(preset) {
      Object.assign(this.tunablesDraft, preset.values)
      this.markTunablesDirty()
      this.flashToast(`Applied preset: ${preset.name} (review and Save)`)
    },
    async saveTunables() {
      const r = await fetch(`/api/projects/${this.selectedId}/tunables`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.tunablesDraft),
      })
      if (!r.ok) { this.flashToast('Tunables save failed', 'error'); return }
      const data = await r.json()
      this.tunablesSaved = { ...this.tunablesDraft }
      this.tunablesIsDirty = false
      this.flashToast('Tunables saved — applies live on next message')
    },

    // ─── access ───
    async loadAccess() {
      const r = await fetch(`/api/projects/${this.selectedId}/access`)
      const data = await r.json()
      this.accessSaved = { allowFrom: data.allowFrom ?? [], disabled: !!data.disabled }
      this.accessDraft = JSON.parse(JSON.stringify(this.accessSaved))
      this.accessIsDirty = false
    },
    markAccessDirty() {
      this.accessIsDirty = JSON.stringify(this.accessDraft) !== JSON.stringify(this.accessSaved)
    },
    addAllowedJid() {
      const j = (this.newJid || '').trim()
      if (!j) return
      if (!this.accessDraft.allowFrom) this.accessDraft.allowFrom = []
      if (!this.accessDraft.allowFrom.includes(j)) {
        this.accessDraft.allowFrom.push(j)
        this.markAccessDirty()
      }
      this.newJid = ''
    },
    removeAllowedJid(idx) {
      this.accessDraft.allowFrom.splice(idx, 1)
      this.markAccessDirty()
    },
    async saveAccess() {
      const r = await fetch(`/api/projects/${this.selectedId}/access`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.accessDraft),
      })
      if (!r.ok) { this.flashToast('Access save failed', 'error'); return }
      this.accessSaved = JSON.parse(JSON.stringify(this.accessDraft))
      this.accessIsDirty = false
      this.flashToast('Allowlist saved')
    },

    // ─── conversations ───
    async loadConversations() {
      const r = await fetch(`/api/projects/${this.selectedId}/conversations`)
      this.conversations = await r.json()
    },
    async openChat(jid) {
      this.activeChat = jid
      const r = await fetch(`/api/projects/${this.selectedId}/conversations/${encodeURIComponent(jid)}/messages?limit=50`)
      const data = await r.json()
      this.chatMessages = data.messages ?? []
      this.$nextTick(() => {
        if (this.$refs.chatMessages) this.$refs.chatMessages.scrollTop = this.$refs.chatMessages.scrollHeight
      })
    },
    async openContactFile(jid) {
      // For now: jump to overview / future: open contact memory drawer
      this.flashToast('Contact memory file editing coming in next iteration')
    },

    // ─── turns ───
    async loadTurns() {
      const r = await fetch(`/api/projects/${this.selectedId}/turns?limit=30`)
      this.turns = await r.json()
    },
    async openTurn(turnId) {
      const r = await fetch(`/api/projects/${this.selectedId}/turns/${turnId}`)
      this.turnDetail = await r.json()
    },
    get avgTurnDuration() {
      const done = this.turns.filter(t => t.durationMs)
      if (!done.length) return '—'
      const avg = done.reduce((s, t) => s + t.durationMs, 0) / done.length
      return (avg / 1000).toFixed(1) + 's'
    },

    // ─── trace WebSocket ───
    connectTrace() {
      const url = `ws://${location.host}/ws/projects/${this.selectedId}/trace`
      try { this.ws = new WebSocket(url) } catch { return }
      this.ws.onmessage = (e) => {
        this.recentTrace.push({ id: ++this.traceCounter, text: e.data })
        if (this.recentTrace.length > 200) this.recentTrace.splice(0, this.recentTrace.length - 200)
        this.$nextTick(() => {
          if (this.$refs.recentTraceBox) this.$refs.recentTraceBox.scrollTop = this.$refs.recentTraceBox.scrollHeight
        })
      }
      this.ws.onclose = () => setTimeout(() => { if (this.selectedId) this.connectTrace() }, 2000)
    },

    // ─── live state polling ───
    async pollLiveState() {
      if (!this.selectedId) return
      try {
        const r = await fetch(`/api/projects/${this.selectedId}/state`)
        this.liveState = await r.json()
      } catch {}
    },

    // ─── router control ───
    async startRouter() {
      const r = await fetch(`/api/projects/${this.selectedId}/router/start`, { method: 'POST' })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Start failed: ' + (d.err ?? 'unknown'), 'error'); return }
      this.flashToast('Router started')
      setTimeout(() => this.refresh().then(() => this.refresh()), 2000)
    },
    async stopRouter() {
      if (!confirm('Stop the router? The bot will go offline immediately.')) return
      const r = await fetch(`/api/projects/${this.selectedId}/router/stop`, { method: 'POST' })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Stop failed: ' + (d.err ?? 'unknown'), 'error'); return }
      this.flashToast('Router stopped')
      setTimeout(() => this.refresh(), 1500)
    },

    // ─── save/discard all (sticky bar) ───
    isDirty() {
      return Object.values(this.personaDirty).some(v => v) || this.tunablesIsDirty || this.accessIsDirty
    },
    dirtySummary() {
      const parts = []
      const p = Object.keys(this.personaDirty).filter(k => this.personaDirty[k]).length
      if (p) parts.push(`${p} persona file${p > 1 ? 's' : ''}`)
      if (this.tunablesIsDirty) parts.push('tunables')
      if (this.accessIsDirty) parts.push('allowlist')
      return parts.length ? `Unsaved changes: ${parts.join(', ')}` : ''
    },
    async saveAll() {
      const promises = []
      if (Object.values(this.personaDirty).some(v => v)) promises.push(this.savePersona())
      if (this.tunablesIsDirty) promises.push(this.saveTunables())
      if (this.accessIsDirty) promises.push(this.saveAccess())
      await Promise.all(promises)
    },
    discardAll() {
      this.personaDraft = { ...this.personaSaved }
      this.personaDirty = {}
      this.tunablesDraft = { ...this.tunablesSaved }
      this.tunablesIsDirty = false
      this.accessDraft = JSON.parse(JSON.stringify(this.accessSaved))
      this.accessIsDirty = false
      this.flashToast('Discarded all changes')
    },

    // ─── helpers ───
    stateClass(state) {
      return {
        'COLLECTING':     'bg-blue-900/60 text-blue-300',
        'PRE_REPLY':      'bg-amber-900/60 text-amber-300',
        'CLAUDE_RUNNING': 'bg-emerald-900/60 text-emerald-300',
        'IDLE':           'bg-zinc-800 text-zinc-400',
      }[state] || 'bg-zinc-800 text-zinc-400'
    },
    traceLineClass(text) {
      if (text.includes('error') || text.includes('fail')) return 'text-red-400'
      if (text.includes('claude_trigger') || text.includes('claude_spawn')) return 'text-amber-300'
      if (text.includes('claude_exit') || text.includes('claude_done')) return 'text-emerald-300'
      if (text.includes('webhook_received') || text.includes('batch_enqueue')) return 'text-blue-300'
      if (text.includes('drop_')) return 'text-zinc-500'
      return 'text-zinc-300'
    },
    formatTs(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    },
    relativeTime(ts) {
      if (!ts) return ''
      const ms = Date.now() - new Date(ts).getTime()
      const min = Math.floor(ms / 60_000)
      if (min < 1) return 'now'
      if (min < 60) return `${min}m`
      const h = Math.floor(min / 60)
      if (h < 24) return `${h}h`
      const d = Math.floor(h / 24)
      return `${d}d`
    },
    get settingsRows() {
      if (!this.selected) return []
      return [
        { label: 'Project path', value: this.selected.path },
        { label: 'wacli account', value: this.selected.account },
        { label: 'Router PID', value: this.selected.routerPid ? `${this.selected.routerPid} (alive: ${this.selected.routerAlive})` : 'not running' },
        { label: 'Sync PID', value: this.selected.syncPid ? `${this.selected.syncPid} (alive: ${this.selected.syncAlive})` : 'not running' },
        { label: 'Allowlist count', value: this.selected.allowFrom.length },
        { label: 'Contact files', value: this.selected.contactCount },
        { label: 'Bot disabled (kill switch)', value: this.selected.disabled ? 'YES' : 'no' },
      ]
    },
    flashToast(msg, kind = 'ok') {
      this.toast = { msg, kind }
      setTimeout(() => { this.toast = null }, 2500)
    },
  }
}
