import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Profile, ProfileInput } from '../shared/types.js';

export const demoProfile: Profile = {
  id: 'demo', name: '本地演示服务', url: 'http://127.0.0.1:3210/demo/mcp', transport: 'http', auth: 'none', authHeader: 'X-API-Key', headers: [], timeoutMs: 30000, protocol: 'auto', hasSecret: false,
};

export class ProfileStore {
  profiles: Profile[] = [];
  private secrets = new Map<string, string>();
  private pendingWrite: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async load() {
    try { this.profiles = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!this.profiles.length) this.profiles = [structuredClone(demoProfile)];
  }
  get(id: string) { return this.profiles.find(p => p.id === id); }
  secret(id: string) { return this.secrets.get(id); }
  async save(input: ProfileInput) {
    if (input.apiKey !== undefined) {
      if (input.apiKey) this.secrets.set(input.id, input.apiKey); else this.secrets.delete(input.id);
    }
    const { apiKey: _, ...config } = input;
    const profile: Profile = { ...config, hasSecret: this.secrets.has(input.id) };
    const index = this.profiles.findIndex(p => p.id === profile.id);
    if (index >= 0) this.profiles[index] = profile; else this.profiles.push(profile);
    await this.persist();
    return profile;
  }
  async remove(id: string) {
    this.profiles = this.profiles.filter(p => p.id !== id);
    this.secrets.delete(id);
    await this.persist();
  }
  private persist() {
    // Header values can contain arbitrary credentials: none are written to disk.
    const payload = JSON.stringify(this.profiles.map(p => ({ ...p, hasSecret: false, headers: p.headers.map(h => ({ ...h, value: '' })) })), null, 2);
    this.pendingWrite = this.pendingWrite.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file + '.tmp', payload, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
    });
    return this.pendingWrite;
  }
}
