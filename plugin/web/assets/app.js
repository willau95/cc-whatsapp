// cc-whatsapp dashboard frontend.
// Vanilla JS + Alpine.js. No build step.

function app() {
  return {
    // ─── projects + selection ───
    projects: [],
    selectedId: null,
    selected: null,

    // ─── tabs ───
    // dirty status looked up via isTabDirty(id) method — DON'T put closures
    // here, `this` in arrow funcs captures lexical scope (NOT the Alpine
    // component instance), so referencing this.personaDirty inside an arrow
    // function defined here would throw at render time.
    tabs: [
      { id: 'accounts',   icon: 'phone',      label: 'Accounts',    needsProject: false },
      { id: 'projects',   icon: 'folder',     label: 'Projects',    needsProject: false },
      { id: 'overview',   icon: 'chart',      label: 'Overview',    needsProject: true },
      { id: 'chats',      icon: 'chat',       label: 'Chats',       needsProject: true },
      { id: 'persona',    icon: 'mask',       label: 'Persona',     needsProject: true },
      { id: 'tunables',   icon: 'sliders',    label: 'Tunables',    needsProject: true },
      { id: 'production', icon: 'microscope', label: 'Production',  needsProject: true },
      { id: 'access',     icon: 'lock',       label: 'Access',      needsProject: true },
      { id: 'mcp-tools',  icon: 'wrench',     label: 'MCP & Tools', needsProject: true },
      { id: 'playbooks',  icon: 'book',       label: 'Playbooks',   needsProject: true },
      { id: 'settings',   icon: 'settings',   label: 'Settings',    needsProject: true },
    ],
    activeTab: 'accounts',
    accounts: [],
    accountDetail: null,    // currently expanded account
    accountBindingDraft: { groupJid: '', targetProjectId: '' },
    accountDefaultDraft: '',

    // ─── memory v2 ───
    memoryV2: {
      open: false, jid: '', activeSub: 'card',
      subs: ['card', 'facts', 'preferences', 'voice', 'timeline', 'notes'],
      saved: {},   // { card: '...', facts: '...', ... }
      draft: {},
      dirty: {},
      legacy: false,
    },

    // ─── playbooks ───
    playbooks: [],
    activePlaybook: '',
    playbookSaved: '',
    playbookDraft: '',
    playbookDirty: false,
    pendingTab: null,
    confirmTab: false,
    showApplyTemplate: false,

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
        help: 'Min wait between chunks during a multi-message reply. Real humans take 1-5 seconds between sends.',
        feelLike: v => v < 500 ? 'instant' : v < 1500 ? 'snappy' : v < 4000 ? 'natural' : 'slow typist',
      },
      inter_segment_max_ms: {
        label: 'Inter-segment delay (max)', type: 'number', unit: 'ms', step: 100, min: 100, max: 30_000, default: 2200,
        help: 'Max wait between chunks. Scaled by message length (longer text = longer pause).',
        feelLike: v => `up to ${(v/1000).toFixed(1)}s`,
      },
      length_factor_short: {
        label: 'Length factor — short (<20 chars)', type: 'number', unit: '×', step: 0.1, min: 0.1, max: 3, default: 0.5,
        help: 'Multiplier for inter-segment delay on SHORT messages. <1 = faster than baseline.',
        feelLike: v => `${v}× baseline`,
      },
      length_factor_medium: {
        label: 'Length factor — medium (20–100 chars)', type: 'number', unit: '×', step: 0.1, min: 0.1, max: 5, default: 1.0,
        help: '1.0 = use baseline as-is.',
        feelLike: v => `${v}× baseline`,
      },
      length_factor_long: {
        label: 'Length factor — long (>100 chars)', type: 'number', unit: '×', step: 0.1, min: 0.1, max: 5, default: 1.6,
        help: '>1 = longer wait. Long messages should take more "typing time".',
        feelLike: v => `${v}× baseline`,
      },
      quote_reply_probability: {
        label: 'Quote-reply probability', type: 'number', unit: '0–1', step: 0.05, min: 0, max: 1, default: 0.4,
        help: 'When batch ≥ 2 messages, chance Claude quotes ONE specific message in the burst.',
        feelLike: v => `~${Math.round(v*100)}% of multi-msg batches will use quote-reply`,
      },
      multi_msg_max_segments: {
        label: 'Max reply segments', type: 'number', unit: 'count', step: 1, min: 1, max: 8, default: 4,
        help: 'Maximum reply chunks per turn. 1 = always single message. Higher = more natural multi-message responses.',
        feelLike: v => v === 1 ? 'always one block' : `up to ${v} natural messages`,
      },
      enable_typing_indicator: {
        label: 'Typing indicator', type: 'boolean', default: true,
        help: 'Show "is typing…" in WhatsApp while the bot is processing + replying. Off = invisible (more stealth, less human).',
      },
      chat_model: {
        label: 'Chat model', type: 'text', default: 'claude-haiku-4-5-20251001',
        help: 'Anthropic model ID. Haiku = fast + cheap (recommended). Sonnet = smarter, pricier. Opus = highest quality, slowest.',
      },
      max_prompt_chars: {
        label: 'Max chars per inbound msg', type: 'number', unit: 'chars', step: 500, min: 500, max: 100_000, default: 8000,
        help: 'Truncate a single inbound message at this length before feeding to Claude.',
        feelLike: v => v < 2000 ? 'tight' : v < 10_000 ? 'comfortable' : 'very long allowed',
      },
    },
    tunablesPresets: [
      { name: '🤖 Default', desc: 'Balanced humanlike pace (60s collect, 30-60s reply delay)',
        values: { collect_window_ms: 60_000, pre_reply_min_ms: 30_000, pre_reply_max_ms: 60_000, multi_msg_max_segments: 4 } },
      { name: '⚡ Quick chat', desc: 'Faster — for active conversations where speed matters',
        values: { collect_window_ms: 15_000, pre_reply_min_ms: 3_000, pre_reply_max_ms: 10_000, multi_msg_max_segments: 3 } },
      { name: '😴 Lazy bot', desc: 'Very humanlike — minutes to respond, like a busy person',
        values: { collect_window_ms: 90_000, pre_reply_min_ms: 60_000, pre_reply_max_ms: 300_000, multi_msg_max_segments: 4 } },
      { name: '🥷 Stealth', desc: 'Long delays + typing off — hardest to detect as AI',
        values: { collect_window_ms: 120_000, pre_reply_min_ms: 90_000, pre_reply_max_ms: 600_000, enable_typing_indicator: false } },
    ],

    // ─── access ───
    accessSaved: { allowFrom: [], disabled: false, mode: 'open' },
    accessDraft: { allowFrom: [], disabled: false, mode: 'open' },
    accessIsDirty: false,
    newJid: '',

    // ─── mcp & tools ───
    extraMcpsSaved: { mcpServers: {} },
    extraMcpsDraft: { mcpServers: {} },
    extraMcpsIsDirty: false,
    newMcp: { name: '', command: '', args: '' },
    availableTools: [
      'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
      'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit',
    ],

    // ─── templates ───
    availableTemplates: [],

    // ─── production / turns ───
    turns: [],
    turnDetail: null,

    // ─── contact memory editor (drawer) ───
    contactEditor: { open: false, jid: '', saved: '', draft: '' },

    // ─── owner JID config ───
    ownerJidSaved: '',
    ownerJidDraft: '',
    ownerJidInfo: '',

    // ─── link-existing-project modal ───
    linkExisting: {
      open: false, step: 1, busy: false, error: null,
      projectDir: '', account: '', ownerJid: '',
      newProjectId: null,
      warnings: [],
      pairStatus: 'idle', pairError: '', qrDataUrl: '',
      eventSource: null,
    },

    // ─── wizard ───
    wizard: {
      open: false, step: 1, busy: false, error: null,
      name: '', parentDir: '', account: '', template: 'eva',
      newProjectId: null,
      pairStatus: 'idle',
      pairError: '',
      pairAlreadyDone: false,
      qrDataUrl: '',         // server-rendered PNG dataURL
      qrTextDebug: '',       // shown in <details> for debugging
      qrRotateCount: 0,      // how many fresh QR codes have arrived
      eventSource: null,
    },

    // ─── pair modal (re-pair) ───
    pairModal: { open: false, status: 'idle', error: '', qrDataUrl: '', eventSource: null },

    // ─── ui state ───
    toast: null,

    // ─── lifecycle ───
    async init() {
      const [hostInfo, templates] = await Promise.all([
        fetch('/api/host-info').then(r => r.json()).catch(() => ({})),
        fetch('/api/templates').then(r => r.json()).catch(() => []),
      ])
      this.wizard.parentDir = hostInfo.defaultParent || ''
      this.availableTemplates = templates

      await this.refresh()
      await this.loadAccounts()
      if (this.projects.length > 0) {
        await this.select(this.projects[0].id)
        // Start on Accounts (new top-level orientation)
        this.activeTab = 'accounts'
      } else {
        this.activeTab = 'accounts'
      }
      setInterval(() => { if (this.selectedId) this.pollLiveState() }, 2000)
      setInterval(() => this.loadAccounts(), 5000)
    },

    async loadAccounts() {
      try {
        const r = await fetch('/api/accounts')
        this.accounts = await r.json()
      } catch {}
    },

    async refresh() {
      try {
        const r = await fetch('/api/projects')
        this.projects = await r.json()
        if (this.selectedId) {
          const fresh = this.projects.find(p => p.id === this.selectedId)
          if (fresh) this.selected = fresh
        }
      } catch (err) {
        this.flashToast('Failed to refresh: ' + err, 'error')
      }
    },

    // ─── project mode (bot ↔ terminal-extension) ───
    async setMode(newMode) {
      if (!confirm(`Switch project to "${newMode}" mode?\n\nbot: full chatbot (persona, memory v2, playbooks, humanlike delays)\nterminal-extension: lean, owner-only, direct replies\n\nThis changes default behavior but does NOT delete existing files.`)) return
      const r = await fetch(`/api/projects/${this.selectedId}/mode`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Mode switch failed: ' + (d.err ?? 'unknown'), 'error'); return }
      this.flashToast(`Project mode → ${newMode}`)
      await this.refresh()
    },

    // ─── owner JID ───
    async loadOwnerJid() {
      if (!this.selectedId) { this.ownerJidSaved = ''; this.ownerJidDraft = ''; return }
      try {
        const r = await fetch(`/api/projects/${this.selectedId}/owner-jid`)
        const d = await r.json()
        this.ownerJidSaved = d.ownerJid ?? ''
        this.ownerJidDraft = this.ownerJidSaved
      } catch {
        this.ownerJidSaved = ''
        this.ownerJidDraft = ''
      }
    },
    async saveOwnerJid() {
      const v = (this.ownerJidDraft || '').trim()
      const r = await fetch(`/api/projects/${this.selectedId}/owner-jid`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerJid: v || null }),
      })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Save failed: ' + (d.err ?? 'unknown'), 'error'); return }
      this.ownerJidSaved = d.ownerJid ?? ''
      this.ownerJidDraft = this.ownerJidSaved
      this.ownerJidInfo = d.sessionUuid
        ? `✓ saved · session UUID: ${d.sessionUuid.slice(0,8)}…  (linked to existing terminal session at ~/.claude/projects/<cwd-hash>/${d.sessionUuid}.jsonl)`
        : (v ? `✓ saved · no existing terminal session found for this cwd — WA messages will spawn a fresh UUID. Run "claude" in the project once if you want to share with terminal.` : '✓ cleared')
      this.flashToast('Owner JID saved')
    },

    // ─── link existing project ───
    openLinkExisting() {
      this.linkExisting = {
        open: true, step: 1, busy: false, error: null,
        projectDir: '', account: '', ownerJid: '',
        newProjectId: null, warnings: [],
        pairStatus: 'idle', pairError: '', qrDataUrl: '',
        eventSource: null,
      }
    },
    closeLinkExisting() {
      if (this.linkExisting.eventSource) { try { this.linkExisting.eventSource.close() } catch {} }
      if (this.linkExisting.newProjectId && (this.linkExisting.step === 3 || this.linkExisting.pairStatus === 'paired')) {
        this.refresh().then(() => {
          this.select(this.linkExisting.newProjectId)
          this.activeTab = 'overview'
          this.linkExisting.open = false
        })
      } else {
        this.linkExisting.open = false
      }
    },
    async linkExistingStep1Next() {
      this.linkExisting.error = null
      this.linkExisting.busy = true
      this.linkExisting.warnings = []
      try {
        const r = await fetch('/api/projects/link-existing', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectDir: this.linkExisting.projectDir,
            account: this.linkExisting.account,
            ownerJid: (this.linkExisting.ownerJid || '').trim() || undefined,
          }),
        })
        const d = await r.json()
        if (!d.ok) { this.linkExisting.error = d.err ?? 'link failed'; return }
        this.linkExisting.newProjectId = d.id
        this.linkExisting.warnings = d.warnings ?? []
        await this.refresh()
        this.linkExisting.step = 2
        await this.linkExistingStartPair()
      } finally {
        this.linkExisting.busy = false
      }
    },
    async linkExistingStartPair() {
      this.linkExisting.pairStatus = 'starting'
      const startRes = await fetch(`/api/projects/${this.linkExisting.newProjectId}/pair/start`, { method: 'POST' })
      const startData = await startRes.json()
      if (!startData.ok) {
        this.linkExisting.pairStatus = 'error'
        this.linkExisting.pairError = startData.err ?? 'unknown'
        return
      }
      const es = new EventSource(`/api/projects/${this.linkExisting.newProjectId}/pair/stream`)
      this.linkExisting.eventSource = es
      es.addEventListener('qr_image', (e) => {
        this.linkExisting.qrDataUrl = e.data
        this.linkExisting.pairStatus = 'qr'
      })
      es.addEventListener('status', (e) => {
        const d = e.data
        if (d === 'paired') {
          this.linkExisting.pairStatus = 'paired'
          try { es.close() } catch {}
          this.linkExisting.eventSource = null
          this.refresh()
          setTimeout(() => this.refresh(), 3000)
        } else if (d.startsWith('error:')) {
          this.linkExisting.pairStatus = 'error'
          this.linkExisting.pairError = d.slice(6)
        }
      })
      es.addEventListener('log', (e) => { console.debug('[link-pair log]', e.data) })
      es.onerror = () => {
        if (this.linkExisting.pairStatus === 'paired' || this.linkExisting.pairStatus === 'error') {
          try { es.close() } catch {}
        }
      }
    },

    async select(id) {
      if (this.isDirty()) {
        if (!confirm('You have unsaved changes. Switch project anyway?')) {
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
      await Promise.all([
        this.loadPersona(),
        this.loadTunables(),
        this.loadAccess(),
        this.loadConversations(),
        this.loadTurns(),
        this.loadExtraMcps(),
        this.loadOwnerJid(),
        this.loadPlaybooks(),
        this.pollLiveState(),
      ])
      this.connectTrace()
    },

    // ─── isTabDirty (method form — avoids arrow-function-this bug) ───
    isTabDirty(id) {
      if (id === 'persona')  return Object.values(this.personaDirty || {}).some(v => v)
      if (id === 'tunables') return this.tunablesIsDirty
      if (id === 'access')   return this.accessIsDirty
      if (id === 'mcp-tools')return this.extraMcpsIsDirty || this.tunablesIsDirty
      return false
    },

    switchTab(id) {
      if (id === this.activeTab) return
      const t = this.tabs.find(t => t.id === id)
      if (t?.needsProject && !this.selected) {
        this.flashToast('Pick a project first', 'error')
        return
      }
      if (this.isTabDirty(this.activeTab)) {
        this.pendingTab = id
        this.confirmTab = true
        return
      }
      this.activeTab = id
      if (id === 'production') this.loadTurns()
    },
    async saveAndSwitch() {
      await this.saveAll()
      if (this.pendingTab) this.activeTab = this.pendingTab
      this.pendingTab = null
      this.confirmTab = false
    },
    discardAndSwitch() {
      this.discardAll()
      if (this.pendingTab) this.activeTab = this.pendingTab
      this.pendingTab = null
      this.confirmTab = false
    },

    // ─── persona ───
    async loadPersona() {
      if (!this.selectedId) return
      const r = await fetch(`/api/projects/${this.selectedId}/persona`)
      this.personaSaved = await r.json()
      this.personaDraft = { ...this.personaSaved }
      this.personaDirty = {}
    },
    switchPersonaFile(name) {
      this.activePersonaFile = name
    },
    markPersonaDirty() {
      const cur = this.personaDraft[this.activePersonaFile] ?? ''
      const saved = this.personaSaved[this.activePersonaFile] ?? ''
      this.personaDirty[this.activePersonaFile] = cur !== saved
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
    async confirmApplyTemplate(templateId) {
      if (!confirm('This overwrites all 5 persona files. Continue?')) return
      const r = await fetch(`/api/projects/${this.selectedId}/persona/apply-template`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: templateId }),
      })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Apply failed: ' + (d.err ?? 'unknown'), 'error'); return }
      this.showApplyTemplate = false
      await this.loadPersona()
      this.flashToast('Persona template applied')
    },

    // ─── tunables ───
    async loadTunables() {
      if (!this.selectedId) return
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
      this.tunablesSaved = { ...this.tunablesDraft }
      this.tunablesIsDirty = false
      this.flashToast('Tunables saved — applies on next message')
    },

    toggleAllowedTool(tool) {
      const arr = this.tunablesDraft.allowed_tools || []
      if (arr.includes(tool)) {
        this.tunablesDraft.allowed_tools = arr.filter(t => t !== tool)
      } else {
        this.tunablesDraft.allowed_tools = [...arr, tool]
      }
      this.markTunablesDirty()
    },

    // ─── access ───
    async loadAccess() {
      if (!this.selectedId) return
      const r = await fetch(`/api/projects/${this.selectedId}/access`)
      const data = await r.json()
      this.accessSaved = {
        allowFrom: data.allowFrom ?? [],
        disabled: !!data.disabled,
        mode: (data.mode === 'closed' ? 'closed' : 'open'),
      }
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
      if (!this.selectedId) return
      try {
        const r = await fetch(`/api/projects/${this.selectedId}/conversations`)
        this.conversations = await r.json()
      } catch {}
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

    // ─── contact memory editor (legacy, kept for backward compat) ───
    async openContactFile(jid) {
      // New default: open memory v2 multi-tab drawer
      await this.openMemoryV2(jid)
    },

    // ─── memory v2 (multi-tab per-contact directory editor) ───
    async openMemoryV2(jid) {
      const r = await fetch(`/api/projects/${this.selectedId}/contacts-v2/${encodeURIComponent(jid)}`)
      const data = await r.json()
      const subs = ['card', 'facts', 'preferences', 'voice', 'timeline', 'notes']
      const saved = {}
      for (const s of subs) saved[s] = data[s] ?? ''
      this.memoryV2 = {
        open: true, jid,
        activeSub: 'card',
        subs,
        saved,
        draft: { ...saved },
        dirty: {},
        legacy: data._legacy === '1',
      }
    },
    closeMemoryV2() {
      if (Object.values(this.memoryV2.dirty).some(v => v)) {
        if (!confirm('Unsaved changes will be lost. Close anyway?')) return
      }
      this.memoryV2.open = false
    },
    switchMemorySub(name) {
      this.memoryV2.activeSub = name
    },
    markMemoryDirty() {
      const cur = this.memoryV2.draft[this.memoryV2.activeSub] ?? ''
      const saved = this.memoryV2.saved[this.memoryV2.activeSub] ?? ''
      this.memoryV2.dirty[this.memoryV2.activeSub] = cur !== saved
    },
    async saveMemoryV2() {
      const dirtySubs = Object.keys(this.memoryV2.dirty).filter(s => this.memoryV2.dirty[s])
      let savedCount = 0
      for (const sub of dirtySubs) {
        const r = await fetch(`/api/projects/${this.selectedId}/contacts-v2/${encodeURIComponent(this.memoryV2.jid)}/${sub}`, {
          method: 'PUT', headers: { 'Content-Type': 'text/plain' },
          body: this.memoryV2.draft[sub] ?? '',
        })
        if (r.ok) {
          this.memoryV2.saved[sub] = this.memoryV2.draft[sub]
          this.memoryV2.dirty[sub] = false
          savedCount++
        }
      }
      this.flashToast(`Saved ${savedCount} memory file(s)`)
    },

    // ─── playbooks ───
    async loadPlaybooks() {
      if (!this.selectedId) return
      const r = await fetch(`/api/projects/${this.selectedId}/playbooks`)
      this.playbooks = await r.json()
      if (this.playbooks.length > 0 && !this.activePlaybook) {
        this.activePlaybook = this.playbooks[0].name
      }
      this.loadActivePlaybookContent()
    },
    loadActivePlaybookContent() {
      const pb = this.playbooks.find(p => p.name === this.activePlaybook)
      this.playbookSaved = pb?.content ?? ''
      this.playbookDraft = this.playbookSaved
      this.playbookDirty = false
    },
    switchPlaybook(name) {
      if (this.playbookDirty && !confirm('Unsaved playbook changes — switch anyway?')) return
      this.activePlaybook = name
      this.loadActivePlaybookContent()
    },
    markPlaybookDirty() {
      this.playbookDirty = this.playbookDraft !== this.playbookSaved
    },
    async savePlaybook() {
      const r = await fetch(`/api/projects/${this.selectedId}/playbooks/${encodeURIComponent(this.activePlaybook)}`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' },
        body: this.playbookDraft,
      })
      if (!r.ok) { this.flashToast('Save failed', 'error'); return }
      this.playbookSaved = this.playbookDraft
      this.playbookDirty = false
      this.flashToast(`Saved playbook: ${this.activePlaybook}`)
    },
    async installDefaultPlaybooks() {
      const r = await fetch(`/api/projects/${this.selectedId}/playbooks/install-defaults`, { method: 'POST' })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Install failed', 'error'); return }
      this.flashToast(`Installed ${d.playbooks.length} playbooks`)
      await this.loadPlaybooks()
    },

    // ─── dispatcher bindings ───
    async loadDispatcher() {
      if (!this.selectedId) return
      const r = await fetch(`/api/projects/${this.selectedId}/dispatcher`)
      const data = await r.json()
      return data
    },
    async addBinding(jid, targetProjectId) {
      const r = await fetch(`/api/projects/${this.selectedId}/dispatcher/bindings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid, targetProjectId }),
      })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Bind failed: ' + (d.err ?? 'unknown'), 'error'); return false }
      this.flashToast('Binding added')
      await this.loadAccounts()
      return true
    },
    async removeBinding(jid) {
      if (!confirm(`Remove binding for ${jid}?`)) return
      const r = await fetch(`/api/projects/${this.selectedId}/dispatcher/bindings/${encodeURIComponent(jid)}`, { method: 'DELETE' })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Unbind failed', 'error'); return }
      this.flashToast('Binding removed')
      await this.loadAccounts()
    },
    async setDefaultProject(targetProjectId) {
      const r = await fetch(`/api/projects/${this.selectedId}/dispatcher/default`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetProjectId }),
      })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Set default failed', 'error'); return }
      this.flashToast('Default project saved')
      await this.loadAccounts()
    },
    async loadRecentJids(projectId) {
      try {
        const r = await fetch(`/api/projects/${projectId}/recent-jids`)
        return await r.json()
      } catch { return [] }
    },
    closeContactEditor() {
      if (this.contactEditor.draft !== this.contactEditor.saved) {
        if (!confirm('Unsaved changes will be lost. Close anyway?')) return
      }
      this.contactEditor = { open: false, jid: '', saved: '', draft: '' }
    },
    async saveContactEditor() {
      const r = await fetch(`/api/projects/${this.selectedId}/contacts/${encodeURIComponent(this.contactEditor.jid)}`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' },
        body: this.contactEditor.draft,
      })
      if (!r.ok) { this.flashToast('Save failed', 'error'); return }
      this.contactEditor.saved = this.contactEditor.draft
      this.flashToast('Contact memory saved')
    },

    // ─── turns ───
    async loadTurns() {
      if (!this.selectedId) return
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

    // ─── extra MCPs ───
    async loadExtraMcps() {
      if (!this.selectedId) return
      try {
        const r = await fetch(`/api/projects/${this.selectedId}/mcps`)
        this.extraMcpsSaved = await r.json()
        this.extraMcpsDraft = JSON.parse(JSON.stringify(this.extraMcpsSaved))
        this.extraMcpsIsDirty = false
      } catch {
        this.extraMcpsSaved = { mcpServers: {} }
        this.extraMcpsDraft = { mcpServers: {} }
        this.extraMcpsIsDirty = false
      }
    },
    addMcpServer() {
      const { name, command, args } = this.newMcp
      if (!name || !command) {
        this.flashToast('Need at least name + command', 'error')
        return
      }
      if (name === 'whatsapp') {
        this.flashToast('Cannot override built-in "whatsapp" server', 'error')
        return
      }
      this.extraMcpsDraft.mcpServers = {
        ...(this.extraMcpsDraft.mcpServers || {}),
        [name]: { command, args: (args || '').split(' ').filter(Boolean) },
      }
      this.extraMcpsIsDirty = JSON.stringify(this.extraMcpsDraft) !== JSON.stringify(this.extraMcpsSaved)
      this.newMcp = { name: '', command: '', args: '' }
    },
    removeMcpServer(name) {
      const next = { ...(this.extraMcpsDraft.mcpServers || {}) }
      delete next[name]
      this.extraMcpsDraft = { mcpServers: next }
      this.extraMcpsIsDirty = JSON.stringify(this.extraMcpsDraft) !== JSON.stringify(this.extraMcpsSaved)
    },
    async saveExtraMcps() {
      const r = await fetch(`/api/projects/${this.selectedId}/mcps`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.extraMcpsDraft),
      })
      if (!r.ok) { this.flashToast('MCP save failed', 'error'); return }
      this.extraMcpsSaved = JSON.parse(JSON.stringify(this.extraMcpsDraft))
      this.extraMcpsIsDirty = false
      this.flashToast('Extra MCPs saved — applies on next turn')
    },

    // ─── trace WS ───
    connectTrace() {
      if (!this.selectedId) return
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
      setTimeout(() => this.refresh(), 2000)
    },
    async stopRouter() {
      if (!confirm('Stop the router? The bot will go offline immediately.')) return
      const r = await fetch(`/api/projects/${this.selectedId}/router/stop`, { method: 'POST' })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Stop failed: ' + (d.err ?? 'unknown'), 'error'); return }
      this.flashToast('Router stopped')
      setTimeout(() => this.refresh(), 1500)
    },

    // ─── save/discard all ───
    isDirty() {
      return Object.values(this.personaDirty || {}).some(v => v)
        || this.tunablesIsDirty || this.accessIsDirty || this.extraMcpsIsDirty
    },
    dirtySummary() {
      const parts = []
      const p = Object.keys(this.personaDirty || {}).filter(k => this.personaDirty[k]).length
      if (p) parts.push(`${p} persona file${p > 1 ? 's' : ''}`)
      if (this.tunablesIsDirty) parts.push('tunables')
      if (this.accessIsDirty) parts.push('allowlist')
      if (this.extraMcpsIsDirty) parts.push('MCP servers')
      return parts.length ? `Unsaved changes: ${parts.join(', ')}` : ''
    },
    async saveAll() {
      const promises = []
      if (Object.values(this.personaDirty || {}).some(v => v)) promises.push(this.savePersona())
      if (this.tunablesIsDirty) promises.push(this.saveTunables())
      if (this.accessIsDirty) promises.push(this.saveAccess())
      if (this.extraMcpsIsDirty) promises.push(this.saveExtraMcps())
      await Promise.all(promises)
    },
    discardAll() {
      this.personaDraft = { ...this.personaSaved }
      this.personaDirty = {}
      this.tunablesDraft = { ...this.tunablesSaved }
      this.tunablesIsDirty = false
      this.accessDraft = JSON.parse(JSON.stringify(this.accessSaved))
      this.accessIsDirty = false
      this.extraMcpsDraft = JSON.parse(JSON.stringify(this.extraMcpsSaved))
      this.extraMcpsIsDirty = false
      this.flashToast('Discarded all changes')
    },

    // ─── wizard ───
    openWizard() {
      this.wizard = {
        ...this.wizard,
        open: true, step: 1, busy: false, error: null,
        name: '', account: '', template: 'eva',
        newProjectId: null,
        pairStatus: 'idle', pairError: '', pairAlreadyDone: false,
        eventSource: null,
      }
    },
    closeWizard() {
      if (this.wizard.eventSource) { try { this.wizard.eventSource.close() } catch {} }
      if (this.wizard.newProjectId && (this.wizard.step === 4 || this.wizard.pairStatus === 'paired')) {
        this.refresh().then(() => {
          this.select(this.wizard.newProjectId)
          this.activeTab = 'overview'
          this.wizard.open = false
        })
      } else {
        this.wizard.open = false
      }
    },
    async wizardStep1Next() {
      this.wizard.error = null
      this.wizard.busy = true
      try {
        const r = await fetch('/api/projects', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parentDir: this.wizard.parentDir,
            name: this.wizard.name,
            account: this.wizard.account || this.wizard.name,
            template: this.wizard.template,
          }),
        })
        const data = await r.json()
        if (!data.ok) {
          this.wizard.error = data.err ?? 'create failed'
          return
        }
        this.wizard.newProjectId = data.id
        await this.refresh()
        this.wizard.step = 2
      } finally {
        this.wizard.busy = false
      }
    },
    async wizardStep2Next() {
      this.wizard.busy = true
      try {
        if (this.wizard.template) {
          await fetch(`/api/projects/${this.wizard.newProjectId}/persona/apply-template`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template: this.wizard.template }),
          })
        }
        await this.refresh()
        const proj = this.projects.find(p => p.id === this.wizard.newProjectId)
        if (proj?.paired) {
          this.wizard.pairAlreadyDone = true
          this.wizard.step = 4
          return
        }
        await this.wizardStartPair()
        this.wizard.step = 3
      } finally {
        this.wizard.busy = false
      }
    },
    async wizardStartPair() {
      this.wizard.pairStatus = 'starting'
      this.wizard.pairError = ''
      this.wizard.qrDataUrl = ''
      this.wizard.qrTextDebug = ''
      const startRes = await fetch(`/api/projects/${this.wizard.newProjectId}/pair/start`, { method: 'POST' })
      const startData = await startRes.json()
      if (!startData.ok) {
        this.wizard.pairStatus = 'error'
        this.wizard.pairError = startData.err ?? 'unknown'
        return
      }
      const es = new EventSource(`/api/projects/${this.wizard.newProjectId}/pair/stream`)
      this.wizard.eventSource = es
      // The 'qr' event carries the raw QR string (debug only).
      // The 'qr_image' event carries the server-rendered PNG dataURL — that's what we display.
      es.addEventListener('qr', (e) => {
        this.wizard.pairStatus = 'qr'
        this.wizard.qrTextDebug = `len=${e.data.length} preview=${e.data.slice(0, 48)}…`
      })
      es.addEventListener('qr_image', (e) => {
        this.wizard.qrDataUrl = e.data
        this.wizard.pairStatus = 'qr'
      })
      es.addEventListener('qr_rotate', (e) => {
        this.wizard.qrRotateCount = Number(e.data) || 0
      })
      es.addEventListener('status', (e) => {
        const d = e.data
        if (d === 'paired') {
          this.wizard.pairStatus = 'paired'
          // Close SSE NOW so it doesn't auto-reconnect into a 410 loop.
          try { es.close() } catch {}
          this.wizard.eventSource = null
          this.refresh()
          // Backend auto-starts router ~1.5s after this; refresh again to pick up routerAlive.
          setTimeout(() => this.refresh(), 3000)
          this.flashToast('✓ WhatsApp linked! Router starting…')
        } else if (d.startsWith('error:')) {
          this.wizard.pairStatus = 'error'
          this.wizard.pairError = d.slice(6)
        } else if (d === 'timeout') {
          this.wizard.pairStatus = 'timeout'
        }
      })
      es.addEventListener('log', (e) => { console.debug('[pair log]', e.data) })
      es.onerror = (err) => {
        // EventSource auto-reconnects by default. We only want it to retry while
        // pairing is active. Once paired/error/timeout, the status handler closes it.
        if (this.wizard.pairStatus === 'paired' || this.wizard.pairStatus === 'error' || this.wizard.pairStatus === 'timeout') {
          try { es.close() } catch {}
        } else {
          console.debug('SSE transient error (will auto-reconnect):', err)
        }
      }
    },
    async wizardRetryPair() {
      if (this.wizard.eventSource) { try { this.wizard.eventSource.close() } catch {} }
      await fetch(`/api/projects/${this.wizard.newProjectId}/pair/stop`, { method: 'POST' }).catch(() => {})
      await this.wizardStartPair()
    },

    // ─── re-pair modal ───
    async openPair() {
      this.pairModal = { open: true, status: 'starting', error: '', qrDataUrl: '', eventSource: null }
      const startRes = await fetch(`/api/projects/${this.selectedId}/pair/start`, { method: 'POST' })
      const startData = await startRes.json()
      if (!startData.ok) {
        this.pairModal.status = 'error'
        this.pairModal.error = startData.err ?? 'unknown'
        return
      }
      const es = new EventSource(`/api/projects/${this.selectedId}/pair/stream`)
      this.pairModal.eventSource = es
      es.addEventListener('qr', (e) => {
        this.pairModal.status = 'qr'
      })
      es.addEventListener('qr_image', (e) => {
        this.pairModal.qrDataUrl = e.data
        this.pairModal.status = 'qr'
      })
      es.addEventListener('status', (e) => {
        const d = e.data
        if (d === 'paired') {
          this.pairModal.status = 'paired'
          try { es.close() } catch {}
          this.pairModal.eventSource = null
          this.refresh()
          setTimeout(() => this.refresh(), 3000)
          this.flashToast('✓ WhatsApp linked! Router starting…')
        } else if (d.startsWith('error:')) {
          this.pairModal.status = 'error'
          this.pairModal.error = d.slice(6)
        }
      })
      es.addEventListener('log', (e) => { console.debug('[pair log]', e.data) })
      es.onerror = (err) => {
        if (this.pairModal.status === 'paired' || this.pairModal.status === 'error') {
          try { es.close() } catch {}
        } else {
          console.debug('SSE transient error (will auto-reconnect):', err)
        }
      }
    },
    closePair() {
      if (this.pairModal.eventSource) { try { this.pairModal.eventSource.close() } catch {} }
      if (this.pairModal.status !== 'paired') {
        fetch(`/api/projects/${this.selectedId}/pair/stop`, { method: 'POST' }).catch(() => {})
      }
      this.pairModal = { open: false, status: 'idle', error: '', qrDataUrl: '', eventSource: null }
    },

    // QR rendering is server-side (dashboard.ts uses qrcode npm pkg via Bun).
    // PNG dataURL arrives via SSE 'qr_image' event — we just set img.src.

    // ─── open claude terminal (project-level or per-conversation) ───
    async openTerminal(jid) {
      const body = jid ? { jid } : {}
      const r = await fetch(`/api/projects/${this.selectedId}/open-terminal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!d.ok) {
        this.flashToast('Open terminal failed: ' + (d.err ?? 'unknown'), 'error')
        return
      }
      this.flashToast(jid ? '🖥 Opening conversation in Terminal…' : '🖥 Opening Claude in Terminal…')
    },

    // ─── project delete ───
    async deleteProject() {
      if (!confirm(`Delete config for "${this.selected.name}"? Wipes .claude/cc-whatsapp/. The project folder itself stays.`)) return
      if (!confirm('Really? This cannot be undone.')) return
      const r = await fetch(`/api/projects/${this.selectedId}`, { method: 'DELETE' })
      const d = await r.json()
      if (!d.ok) { this.flashToast('Delete failed: ' + (d.err ?? 'unknown'), 'error'); return }
      this.flashToast('Project config deleted')
      this.selectedId = null
      this.selected = null
      this.activeTab = 'projects'
      await this.refresh()
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
        { label: 'Paired', value: this.selected.paired ? 'YES' : 'no' },
        { label: 'Router PID', value: this.selected.routerPid ? `${this.selected.routerPid} (alive: ${this.selected.routerAlive})` : 'not running' },
        { label: 'Sync PID', value: this.selected.syncPid ? `${this.selected.syncPid} (alive: ${this.selected.syncAlive})` : 'not running' },
        { label: 'Allowlist count', value: this.selected.allowFrom.length },
        { label: 'Contact files', value: this.selected.contactCount },
        { label: 'Bot disabled (kill switch)', value: this.selected.disabled ? 'YES' : 'no' },
      ]
    },
    flashToast(msg, kind = 'ok') {
      this.toast = { msg, kind }
      setTimeout(() => { this.toast = null }, 2800)
    },
  }
}
