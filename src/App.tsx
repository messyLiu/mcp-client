import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, ArrowRight, Braces, Check, ChevronDown, ChevronRight, CircleHelp, Copy, Download, FileText, FlaskConical, FolderOpen, Globe, KeyRound, LoaderCircle, MessageSquare, Pause, Play, Plug, Plus, Radio, RefreshCw, Save, Search, Settings2, ShieldCheck, Square, Terminal, Trash2, Unplug, X, Zap } from 'lucide-react';
import type { CallResult, Catalog, Connection, Profile, ProfileInput, ToolInfo, TraceEvent } from '../shared/types';
import ImportDialog from './ImportDialog';

const EMPTY: Catalog = { tools: [], resources: [], prompts: [] };
const format = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const initialProfile = (): Profile => ({ id: crypto.randomUUID(), name: '新建连接', url: '', transport: 'http', auth: 'none', authHeader: 'X-API-Key', headers: [], timeoutMs: 30000, protocol: 'auto', hasSecret: false });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
function example(schema: Record<string, unknown>): unknown {
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>).map(([k, v]) => [k, example(v)]));
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0;
  if (schema.type === 'array') return [];
  return '';
}

export default function App() {
  const token = useRef('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [draft, setDraft] = useState<Profile>(initialProfile);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [headersText, setHeadersText] = useState('{}');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(EMPTY);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [streamOnline, setStreamOnline] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [tab, setTab] = useState<'tools' | 'resources' | 'prompts'>('tools');
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [args, setArgs] = useState('{}');
  const [showSchema, setShowSchema] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [callError, setCallError] = useState('');
  const [callId, setCallId] = useState('');
  const [layer, setLayer] = useState('rpc');
  const [logSearch, setLogSearch] = useState('');
  const [paused, setPaused] = useState<TraceEvent[] | null>(null);
  const [detail, setDetail] = useState<TraceEvent | null>(null);
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [importText, setImportText] = useState<string | null>(null);
  const connected = connection?.status === 'connected';
  const activeItem = catalog[tab].find(item => ('uri' in item ? item.uri : item.name) === selected);
  const tool = tab === 'tools' ? activeItem as ToolInfo | undefined : undefined;

  const api = useCallback(async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token.current }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }, []);
  const selectProfile = (profile: Profile) => { setDraft(structuredClone(profile)); setApiKey(''); setClearKey(false); setHeadersText(JSON.stringify(Object.fromEntries(profile.headers.map(h => [h.name, h.value])), null, 2)); };
  const notify = (text: string, error = false) => setNotice({ text, error });

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    api<{ token: string; profiles: Profile[]; connection: Connection; catalog: Catalog }>('/bootstrap').then(data => {
      if (cancelled) return;
      token.current = data.token; setProfiles(data.profiles); setConnection(data.connection); setCatalog(data.catalog);
      if (data.profiles[0]) selectProfile(data.profiles.find(p => p.id === data.connection?.profileId) ?? data.profiles[0]);
      source = new EventSource('/api/events');
      source.onopen = () => setStreamOnline(true);
      source.onerror = () => setStreamOnline(false);
      source.addEventListener('snapshot', e => { const snapshot = JSON.parse(e.data); setEvents(snapshot.events); setConnection(snapshot.connection); });
      source.addEventListener('trace', e => setEvents(previous => [...previous, JSON.parse(e.data)].slice(-1000)));
      source.addEventListener('catalog', e => setCatalog(JSON.parse(e.data)));
      source.addEventListener('connection', e => { const next = JSON.parse(e.data); setConnection(next); if (next?.status !== 'connected') setCatalog(EMPTY); });
      source.addEventListener('clear', () => { setEvents([]); setPaused(null); setDetail(null); });
    }).catch(error => { if (!cancelled) notify(`无法连接本地服务：${errorMessage(error)}`, true); });
    return () => { cancelled = true; source?.close(); };
  }, [api]);
  useEffect(() => { if (!notice || notice.error) return; const timer = setTimeout(() => setNotice(null), 3500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const items = catalog[tab];
    if (!items.some(item => ('uri' in item ? item.uri : item.name) === selected)) setSelected(items[0] ? ('uri' in items[0] ? items[0].uri : items[0].name) : '');
  }, [catalog, tab, selected]);
  useEffect(() => {
    if (tab === 'tools') setArgs(JSON.stringify(example(tool?.inputSchema ?? { type: 'object' }), null, 2));
    else if (tab === 'prompts') {
      const prompt = catalog.prompts.find(p => p.name === selected);
      setArgs(JSON.stringify(Object.fromEntries(prompt?.arguments?.map(a => [a.name, '']) ?? []), null, 2));
    } else setArgs('{}');
    setResult(null); setCallError(''); setShowSchema(false);
  }, [selected, tab]);

  async function saveProfile() {
    const headers = JSON.parse(headersText);
    if (!headers || Array.isArray(headers) || typeof headers !== 'object' || Object.values(headers).some(v => typeof v !== 'string')) throw new Error('请求头应为 JSON 对象，且值均为字符串');
    const input: ProfileInput = { ...draft, headers: Object.entries(headers).map(([name, value]) => ({ name, value: value as string })), ...(apiKey || clearKey || !draft.hasSecret ? { apiKey } : {}) };
    const saved = await api<Profile>('/profiles', 'POST', input);
    setProfiles(previous => previous.some(p => p.id === saved.id) ? previous.map(p => p.id === saved.id ? saved : p) : [...previous, saved]);
    setDraft(saved); setApiKey(''); setClearKey(false);
    return saved;
  }
  async function save() { setBusy('save'); try { await saveProfile(); notify('连接配置已保存；凭证仅保留在本次运行中'); } catch (e) { notify(errorMessage(e), true); } finally { setBusy(''); } }
  async function connect() {
    setBusy('connect'); setNotice(null); setResult(null); setCallError('');
    try { const profile = await saveProfile(); const data = await api<{ connection: Connection; catalog: Catalog }>('/connect', 'POST', { profileId: profile.id }); setConnection(data.connection); setCatalog(data.catalog); notify('已连接，服务能力已加载'); }
    catch (e) { notify(errorMessage(e), true); } finally { setBusy(''); }
  }
  async function disconnect() { setBusy('disconnect'); try { await api('/disconnect', 'POST'); setCatalog(EMPTY); } catch (e) { notify(errorMessage(e), true); } finally { setBusy(''); } }
  async function removeProfile() {
    setBusy('delete');
    try { await api(`/profiles/${draft.id}`, 'DELETE'); const remaining = profiles.filter(p => p.id !== draft.id); setProfiles(remaining); selectProfile(remaining[0] ?? initialProfile()); }
    catch (e) { notify(errorMessage(e), true); } finally { setBusy(''); }
  }
  async function refresh() { setBusy('refresh'); try { setCatalog(await api<Catalog>('/catalog/refresh', 'POST')); notify('能力列表已刷新'); } catch (e) { notify(errorMessage(e), true); } finally { setBusy(''); } }
  async function run() {
    if (!connected || !selected || callId) return;
    setResult(null); setCallError('');
    try {
      const parsed = JSON.parse(args);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('参数必须是 JSON 对象');
      const id = crypto.randomUUID(); setCallId(id);
      setResult(await api<CallResult>('/calls', 'POST', { callId: id, method: tab === 'tools' ? 'tools/call' : tab === 'resources' ? 'resources/read' : 'prompts/get', name: selected, arguments: parsed }));
    } catch (e) { setCallError(errorMessage(e)); } finally { setCallId(''); }
  }
  async function copy(value: unknown) { try { await navigator.clipboard.writeText(format(value) ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { notify('复制失败，请手动选择文本', true); } }
  const visibleEvents = (paused ?? events).filter(e => (layer === 'all' || e.layer === layer) && `${e.method ?? ''} ${e.kind} ${e.rpcId ?? ''} ${format(e.data)}`.toLowerCase().includes(logSearch.toLowerCase()));
  const failed = Boolean(callError || (result?.result && typeof result.result === 'object' && 'isError' in result.result && result.result.isError));
  const filteredItems = catalog[tab].filter(item => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(search.toLowerCase()));

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-icon"><Terminal size={20}/></span><strong>MCP<span>workbench</span></strong><span className="version">v0.1</span></div><div className="topbar-right"><span className="local-badge"><span className="dot green"/> 本地工作台</span><span className="top-divider"/><button className="icon-button" aria-label="使用帮助" onClick={() => setHelp(true)}><CircleHelp size={18}/></button></div></header>
    <aside className="sidebar">
      <div className="section-label">连接管理 <button className="icon-button" title="新建连接" aria-label="新建连接" disabled={!!busy} onClick={() => selectProfile(initialProfile())}><Plus size={16}/></button></div>
      <div className="profiles">{profiles.map(profile => <button className={`profile-card ${draft.id === profile.id ? 'selected' : ''}`} key={profile.id} disabled={!!busy} onClick={() => selectProfile(profile)}><span className="profile-symbol">{profile.id === 'demo' ? <FlaskConical size={18}/> : <Globe size={18}/>}</span><span className="profile-text"><strong>{profile.name}</strong><small>{profile.transport === 'http' ? 'Streamable HTTP' : 'Legacy SSE'}</small></span>{connection?.profileId === profile.id && connected ? <span className="dot green"/> : <ChevronRight size={14}/>}</button>)}</div>
      <div className="config-divider"/>
      <button className="secondary import-trigger" disabled={!!busy} onClick={() => setImportText('')}><FileText size={14}/>导入配置<span>JSON</span></button>
      <div className="section-label">连接配置 <Settings2 size={15}/></div>
      <div className="config-fields"><label>连接名称<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：开发环境"/></label>
        <label>MCP 地址<input className="mono" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} onPaste={e => { const text = e.clipboardData.getData('text'); if (text.trim().startsWith('{')) { e.preventDefault(); setImportText(text); } }} placeholder="https://example.com/mcp" spellCheck={false}/><span className="hint">也可直接粘贴 mcpServers 配置 JSON</span></label>
        <label>传输方式<select value={draft.transport} onChange={e => setDraft({ ...draft, transport: e.target.value as Profile['transport'] })}><option value="http">Streamable HTTP</option><option value="sse">HTTP + SSE（旧版）</option></select></label>
        <label>认证方式<select value={draft.auth} onChange={e => setDraft({ ...draft, auth: e.target.value as Profile['auth'] })}><option value="none">无认证</option><option value="bearer">Bearer Token</option><option value="header">API Key · 自定义请求头</option></select></label>
        {draft.auth === 'header' && <label>API Key 请求头名称<input value={draft.authHeader} onChange={e => setDraft({ ...draft, authHeader: e.target.value })} placeholder="X-API-Key"/></label>}
        {draft.auth !== 'none' && <label><span className="label-row">API Key <KeyRound size={12}/></span><input type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={draft.hasSecret && !clearKey ? '本次运行已保存，留空沿用' : '输入你的 API Key'}/>{draft.hasSecret && !clearKey && <button className="text-button" onClick={() => { setClearKey(true); setApiKey(''); }}>清除已保存的密钥</button>}</label>}
        <details className="advanced"><summary><ChevronDown size={14}/>高级配置</summary><div className="advanced-fields"><label>请求超时（秒）<input type="number" min={1} max={300} value={draft.timeoutMs / 1000} onChange={e => setDraft({ ...draft, timeoutMs: Number(e.target.value) * 1000 })}/></label><label>协议协商<select value={draft.protocol} onChange={e => setDraft({ ...draft, protocol: e.target.value as Profile['protocol'] })}><option value="auto">自动识别（推荐）</option><option value="legacy">旧版 initialize</option><option value="modern">2026-07-28</option></select></label><label>自定义请求头 · JSON<textarea className="headers-editor mono" value={headersText} onChange={e => setHeadersText(e.target.value)} spellCheck={false}/></label><p className="hint">请求头的值仅保留在本次运行中。</p></div></details>
      </div>
      <div className="sidebar-actions"><button className="primary full" onClick={connect} disabled={!!busy || !!callId || !draft.url}>{busy === 'connect' ? <LoaderCircle className="spin" size={16}/> : <Plug size={16}/>} {busy === 'connect' ? '正在连接…' : connected && connection.profileId === draft.id ? '保存并重新连接' : '连接服务'}<ArrowRight size={16}/></button><div className="button-row"><button className="secondary" disabled={!!busy} onClick={save}><Save size={14}/>保存配置</button><button className="icon-button bordered" disabled={!!busy || !profiles.some(p => p.id === draft.id)} title="删除此连接配置" aria-label="删除此连接配置" onClick={removeProfile}><Trash2 size={15}/></button></div><p className="privacy"><ShieldCheck size={13}/>凭证仅存内存，报文自动脱敏</p></div>
    </aside>
    <main className="workspace">
      <div className="workspace-heading"><div><div className="eyebrow">DEVELOPER TOOLS <span>/</span> MCP CLIENT</div><h1>调试工作台 <span className={`status-pill ${connected ? 'online' : ''}`}><span className={`dot ${connected ? 'green' : ''}`}/>{connected ? '已连接' : connection?.status === 'connecting' ? '连接中' : '未连接'}</span></h1><p>连接服务，探索工具，让每一次调用都有迹可循。</p></div>{connected && <button className="secondary" disabled={!!busy} onClick={disconnect}><Unplug size={14}/>断开连接</button>}</div>
      {notice && <div className={`notice ${notice.error ? 'error' : 'success'}`} role="status"><span>{notice.error ? <Activity size={15}/> : <Check size={15}/>} {notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15}/></button></div>}
      <div className="connection-strip"><div className="server-icon"><Globe size={19}/></div><div className="server-label"><strong>{connected ? connection.serverName ?? connection.name : '等待连接 MCP 服务'}</strong><span>{connected ? connection.name : '选择左侧连接，或使用本地演示快速开始'}</span></div><div className="strip-stat"><small>协议版本</small><span className="mono">{connected ? connection.protocol ?? '已协商' : '—'}</span></div><div className="strip-stat"><small>可用工具</small><span>{connected ? catalog.tools.length.toString().padStart(2, '0') : '—'}</span></div><span className="strip-badge">{connected ? `v${connection.serverVersion ?? '—'}` : 'LOCAL FIRST'}</span></div>
      <section className="explorer panel"><div className="panel-tabs"><div className="tabs">{([['tools', '工具', Zap], ['resources', '资源', FolderOpen], ['prompts', '提示词', MessageSquare]] as const).map(([key, name, Icon]) => <button key={key} disabled={!!callId} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setSearch(''); }}><Icon size={15}/>{name}<span>{catalog[key].length}</span></button>)}</div><button className="icon-button" title="刷新能力列表" aria-label="刷新能力列表" disabled={!connected || !!busy || !!callId} onClick={refresh}><RefreshCw size={15} className={busy === 'refresh' ? 'spin' : ''}/></button></div>
        <div className="explorer-body"><div className="tool-list"><div className="search-box"><Search size={14}/><input aria-label="搜索能力" placeholder="搜索名称…" value={search} onChange={e => setSearch(e.target.value)}/></div><div className="tool-items">{filteredItems.map(item => { const id = 'uri' in item ? item.uri : item.name; return <button key={id} disabled={!!callId} className={`tool-item ${selected === id ? 'selected' : ''}`} onClick={() => setSelected(id)}><span><Braces size={14}/><strong>{item.name}</strong></span><small>{item.description ?? ('uri' in item ? item.uri : '暂无描述')}</small></button>; })}{!filteredItems.length && <div className="list-empty">{connected ? search ? '没有匹配的结果' : '服务未提供此能力' : '连接后显示能力列表'}</div>}</div><div className="list-footer"><span className="dot"/>{catalog[tab].length} 项能力</div></div>
        <div className="playground">{!activeItem ? <div className="empty-state"><div className="empty-illustration"><span/><Plug size={32}/><span/></div><span className="eyebrow">READY WHEN YOU ARE</span><h2>从一次连接开始</h2><p>填写 MCP 地址和认证信息，连接后即可<br/>探索服务能力、发送请求并检查响应。</p><button className="secondary" disabled={!!busy} onClick={() => { const demo = profiles.find(p => p.id === 'demo'); if (demo) selectProfile(demo); else selectProfile({ ...initialProfile(), id: 'demo', name: '本地演示服务', url: 'http://127.0.0.1:3210/demo/mcp' }); notify('已选择演示服务，点击左侧「连接服务」即可体验'); }}><FlaskConical size={15}/>试试本地演示<ArrowRight size={14}/></button></div> : <><div className="tool-heading"><div><h2>{activeItem.name}</h2><p>{activeItem.description}</p></div><span className="method-tag">{tab === 'tools' ? 'tools/call' : tab === 'resources' ? 'resources/read' : 'prompts/get'}</span></div><div className="editor-grid"><div className="editor-pane"><div className="editor-toolbar"><div className="mini-tabs"><button className={!showSchema ? 'active' : ''} onClick={() => setShowSchema(false)}>{tab === 'resources' ? '资源 URI' : '参数'}</button>{tool && <button className={showSchema ? 'active' : ''} onClick={() => setShowSchema(true)}>Schema</button>}</div><span className="language-label">{tab === 'resources' ? 'URI' : 'JSON'}</span></div>{tab === 'resources' ? <pre className="code-editor uri-editor">{selected}</pre> : <textarea aria-label={showSchema ? '工具 Schema' : '调用参数 JSON'} className="code-editor" readOnly={showSchema || !!callId} value={showSchema ? JSON.stringify(tool?.inputSchema, null, 2) : args} spellCheck={false} onChange={e => setArgs(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }}/>}<div className="editor-bottom"><button className="text-button" disabled={showSchema || !!callId || tab === 'resources'} onClick={() => { try { setArgs(JSON.stringify(JSON.parse(args), null, 2)); } catch { notify('JSON 格式有误，请检查参数', true); } }}><Braces size={13}/>格式化</button><span>⌘ / Ctrl + Enter</span></div></div><div className="result-pane"><div className="editor-toolbar"><span>执行结果</span><div className="result-meta">{result && <span className={failed ? 'text-red' : 'text-green'}>{failed ? '工具报错' : '成功'} · {Math.round(result.durationMs)} ms</span>}{result && <button className="icon-button" aria-label="复制结果" onClick={() => copy(result.result)}><Copy size={13}/></button>}</div></div>{callId ? <div className="result-empty"><LoaderCircle size={25} className="spin"/><span>等待服务响应…</span></div> : callError ? <pre className="result-code text-red">{callError}</pre> : result ? <pre className="result-code">{format(result.result)}</pre> : <div className="result-empty"><Braces size={27}/><span>响应内容会显示在这里</span><small>发送一次请求，看看会发生什么</small></div>}</div></div><div className="run-bar"><span><ShieldCheck size={13}/>报文实时记录 · 凭证自动脱敏</span>{callId ? <button className="secondary" onClick={() => api(`/calls/${callId}/cancel`, 'POST').catch(e => notify(errorMessage(e), true))}><Square size={13}/>取消调用</button> : <button className="primary" disabled={!connected} onClick={run}><Play size={14}/>{tab === 'resources' ? '读取资源' : tab === 'prompts' ? '获取提示词' : '运行工具'}</button>}</div></> }</div></div>
      </section>
      <section className="traffic panel"><div className="traffic-header"><div className="traffic-title"><Activity size={16}/><strong>报文时间线</strong><span className="count">{events.length}</span><span className={`live-label ${paused ? 'paused' : ''}`}><span className={`dot ${streamOnline && !paused ? 'green' : ''}`}/>{paused ? '已暂停显示' : streamOnline ? '实时' : '正在重连'}</span></div><div className="traffic-actions"><button className="icon-button" title={paused ? '恢复显示' : '暂停显示（仍在采集）'} aria-label={paused ? '恢复显示' : '暂停显示'} onClick={() => setPaused(paused ? null : [...events])}>{paused ? <Play size={14}/> : <Pause size={14}/>}</button><a className="icon-button" title="导出脱敏报文" aria-label="导出脱敏报文" href="/api/events/export" download><Download size={15}/></a><button className="icon-button" title="清空报文" aria-label="清空报文" onClick={() => api('/events', 'DELETE').catch(e => notify(errorMessage(e), true))}><Trash2 size={14}/></button></div></div><div className="traffic-filters"><div className="filter-chips">{[['rpc', 'JSON-RPC'], ['http', 'HTTP / SSE'], ['all', '全部']].map(([value, label]) => <button key={value} className={layer === value ? 'active' : ''} onClick={() => setLayer(value)}>{label}</button>)}</div><div className="search-box log-search"><Search size={13}/><input aria-label="搜索报文" placeholder="搜索方法、ID 或内容…" value={logSearch} onChange={e => setLogSearch(e.target.value)}/></div></div><div className="trace-table"><table><thead><tr><th>时间</th><th>方向</th><th>方法 / 事件</th><th>ID</th><th>状态</th><th>耗时</th><th/></tr></thead><tbody>{visibleEvents.slice().reverse().map(event => <tr key={event.id} onClick={() => setDetail(event)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setDetail(event); }}><td className="mono muted">{new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false })}<small>.{new Date(event.time).getMilliseconds().toString().padStart(3, '0')}</small></td><td><span className={`direction ${event.direction}`}>{event.direction === 'out' ? <ArrowUpRight size={13}/> : event.direction === 'in' ? <ArrowDownLeft size={13}/> : <Activity size={12}/>} {event.direction === 'out' ? '发送' : event.direction === 'in' ? '接收' : '系统'}</span></td><td className="mono method-cell">{event.method ?? event.kind}<small>{event.layer === 'http' ? event.kind : ''}</small></td><td className="mono muted">{event.rpcId ?? '—'}</td><td><span className={`event-status ${event.kind.includes('error') || (event.status ?? 0) >= 400 ? 'bad' : ''}`}>{event.status ?? ({ request: '请求', response: '响应', notification: '通知', error: '错误' }[event.kind] ?? event.kind)}</span></td><td className="mono muted">{event.durationMs !== undefined ? `${Math.round(event.durationMs)} ms` : '—'}</td><td><ChevronRight size={13}/></td></tr>)}</tbody></table>{!visibleEvents.length && <div className="trace-empty"><Radio size={21}/><span>{events.length ? '没有匹配的报文' : '等待第一条报文'}</span><small>连接、调用和通知都会记录在这里</small></div>}</div><div className="trace-footer"><span>保留最近 1,000 条 · 点击报文查看详情</span><span><ShieldCheck size={11}/>敏感字段已遮盖</span></div></section>
      <footer className="workspace-footer"><span>MCP WORKBENCH</span><span>在本机运行，为调试而生。</span></footer>
    </main>
    {importText !== null && <ImportDialog initialText={importText} api={api} onClose={() => setImportText(null)} onImported={imported => { setProfiles(previous => [...previous, ...imported]); selectProfile(imported[0]); setImportText(null); notify(`已导入 ${imported.length} 个连接，点击「连接服务」即可使用`); }}/>}
    {detail && <div className="drawer-overlay" onClick={() => setDetail(null)}><aside className="detail-drawer" onClick={e => e.stopPropagation()}><div className="drawer-heading"><div><span className="eyebrow">MESSAGE INSPECTOR</span><h2>报文详情</h2></div><button className="icon-button" aria-label="关闭报文详情" onClick={() => setDetail(null)}><X size={20}/></button></div><dl className="detail-meta"><div><dt>方法 / 事件</dt><dd>{detail.method ?? detail.kind}</dd></div><div><dt>时间</dt><dd>{new Date(detail.time).toLocaleString('zh-CN')}</dd></div><div><dt>层级 / 方向</dt><dd>{detail.layer.toUpperCase()} · {detail.direction}</dd></div><div><dt>JSON-RPC ID</dt><dd>{detail.rpcId ?? '—'}</dd></div><div><dt>连接 ID</dt><dd>{detail.connectionId}</dd></div>{detail.exchangeId && <div><dt>HTTP 交换 ID</dt><dd>{detail.exchangeId}</dd></div>}</dl><div className="editor-toolbar"><span>报文内容{detail.truncated ? ' · 已截断' : ''}</span><button className="text-button" onClick={() => copy(detail.data)}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? '已复制' : '复制'}</button></div><pre className="detail-code">{format(detail.data)}</pre><div className="drawer-note"><ShieldCheck size={14}/>认证信息和已知密钥已脱敏。导出保留相同内容。</div></aside></div>}
    {help && <div className="modal-overlay" onClick={() => setHelp(false)}><div className="help-modal" onClick={e => e.stopPropagation()}><div className="drawer-heading"><h2>快速开始</h2><button className="icon-button" aria-label="关闭帮助" onClick={() => setHelp(false)}><X size={18}/></button></div><ol><li>在左侧填写 MCP 地址和认证信息，点击「连接服务」。</li><li>选择工具，在参数编辑器填写 JSON，点击「运行工具」。</li><li>在报文时间线查看 JSON-RPC，切换 HTTP / SSE 查看传输细节。</li><li>点击报文展开详情，或使用下载图标导出当前记录。</li></ol><p>没有 MCP 服务？选择「本地演示服务」，体验 echo、calculate 和 wait 工具。</p><p className="hint">密钥与请求头值仅保留在本次服务运行中。重启后需要重新输入。完整手册见项目 README.md。</p><button className="primary full" onClick={() => setHelp(false)}>开始调试<ArrowRight size={15}/></button></div></div>}
  </div>;
}
