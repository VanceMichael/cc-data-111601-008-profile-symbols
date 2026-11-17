import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { profileToJSON } from './profile.mjs';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    await mkdir(join(this.directory, 'interpretations'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async find(id) {
    const records = await this.list();
    return records.find(record => record.id === id) ?? null;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
  interpretationPath(id) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('invalid_id');
    return join(this.directory, 'interpretations', `${id}.json`);
  }
  // 解释文档独立于原件保存；重补只追加 pass，绝不重写原始字节。
  async saveInterpretation(id, interpretation) {
    const operation = this.pending.then(async () => {
      const path = this.interpretationPath(id);
      const temporary = join(this.directory, 'interpretations', `interpretation-${randomUUID()}.tmp`);
      await writeFile(temporary, profileToJSON(interpretation));
      await rename(temporary, path);
      return interpretation;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async interpretation(id) {
    return JSON.parse(await readFile(this.interpretationPath(id), 'utf8'));
  }
}
