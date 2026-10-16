import { useEffect, useRef, useState } from 'react';
import { Check, FileJson, Globe, KeyRound, LoaderCircle, ShieldCheck, Upload, X } from 'lucide-react';
import type { Profile } from '../shared/types';

const SAMPLE = '{\n  "mcpServers": {\n    "my-mcp": {\n      "type": "streamable_http",\n      "url": "https://example.com/mcp"\n    }\n  }\n}';
type ImportResponse = { profiles: Profile[]; issues: string[] };
interface Props {
  initialText: string;
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  onClose: () => void;
  onImported: (profiles: Profile[]) => void;
}

export default function ImportDialog({ initialText, api, onClose, onImported }: Props) {
  const [text, setText] = useState(initialText);
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { editor.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    setPreview(null); setError('');
    if (!text.trim()) { setScanning(false); return; }
    setScanning(true);
    const timer = setTimeout(() => {
      api<ImportResponse>('/profiles/import', 'POST', { config: text, preview: true })
        .then(result => { if (active) setPreview(result); })
        .catch(e => { if (active) setError(e.message); })
        .finally(() => { if (active) setScanning(false); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [text, api]);

  async function save() {
    setSaving(true); setError('');
    try { const imported = await api<ImportResponse>('/profiles/import', 'POST', { config: text, preview: false }); onImported(imported.profiles); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  return <div className="modal-overlay" onClick={() => { if (!saving) onClose(); }}><section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape' && !saving) onClose(); }}>
    <div className="drawer-heading"><div><span className="eyebrow">IMPORT CONFIGURATION</span><h2 id="import-title"><FileJson size={19}/>导入 MCP 配置</h2></div><button className="icon-button" aria-label="关闭导入窗口" disabled={saving} onClick={onClose}><X size={19}/></button></div>
    <div className="import-body"><p className="import-intro">粘贴配置 JSON，自动识别名称、地址、传输方式和认证信息。支持一次导入多个服务。</p><label className="import-editor-label">配置 JSON<textarea ref={editor} className="import-editor" aria-label="MCP 配置 JSON" value={text} readOnly={saving} placeholder={SAMPLE} spellCheck={false} onChange={e => { setText(e.target.value); setPreview(null); setError(''); }}/></label>
    {scanning && <div className="import-scanning"><LoaderCircle size={14} className="spin"/>正在识别配置…</div>}
    {error && <div className="import-error" role="alert">{error}</div>}
    {preview && <div className="import-preview"><div className="section-label"><span><Check size={13}/>识别到 {preview.profiles.length} 个可导入连接</span></div>{preview.profiles.map(profile => <div className="import-profile" key={profile.id}><div className="profile-symbol"><Globe size={17}/></div><div><strong>{profile.name}</strong><span className="import-url">{profile.url}</span><small>{profile.transport === 'http' ? 'Streamable HTTP' : 'HTTP + SSE'}{profile.auth !== 'none' && <><span> · </span><KeyRound size={10}/>{profile.auth === 'bearer' ? 'Bearer Token' : profile.authHeader}</>}{profile.headers.length > 0 && ` · ${profile.headers.length} 个额外请求头`}</small></div></div>)}</div>}
    {preview?.issues.length ? <div className="import-issues"><strong>以下项目需要注意</strong><ul>{preview.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div> : null}
    <p className="import-note"><ShieldCheck size={13}/>导入后保存到连接列表；密钥仍仅保留在本次运行中。</p></div>
    <div className="import-footer"><button className="secondary" disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={saving || scanning || !preview?.profiles.length} onClick={save}>{saving ? <LoaderCircle size={14} className="spin"/> : <Upload size={14}/>} {saving ? '正在导入…' : `导入${preview?.profiles.length ? ` ${preview.profiles.length} 个` : ''}连接`}</button></div>
  </section></div>;
}
