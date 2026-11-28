import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseStore } from '../db.ts';
import { DEFAULT_JOB_CONFIG, sanitizeJobConfig } from '../serverConfig.ts';
import type { JobConfig } from '../types/pipeline.ts';
import { atomicWriteJson } from '../utils/persistence.ts';

/**
 * Single owner of the active job configuration, the only mutable state shared by several
 * routers (job config, ingestion, pipeline runs, KPIs, health). Readers always go through
 * `current`, so they see the latest value; writes go through `update`, which sanitizes,
 * timestamps and persists (PostgreSQL when active, plus the local atomic mirror).
 */
export class JobConfigStore {
  private activeJobConfig: JobConfig = { ...DEFAULT_JOB_CONFIG };
  private jobConfigUpdatedAt = new Date().toISOString();
  private readonly configStateFile: string;

  constructor(
    rootDir: string,
    private readonly dbStore: DatabaseStore
  ) {
    this.configStateFile = path.resolve(rootDir, '.state', 'job-config.json');
  }

  get current(): JobConfig {
    return this.activeJobConfig;
  }

  get updatedAt(): string {
    return this.jobConfigUpdatedAt;
  }

  async load(): Promise<void> {
    let parsed: { config?: Partial<JobConfig>; updatedAt?: string } | null = null;
    try {
      if (this.dbStore.isPostgresActive()) {
        parsed = await this.dbStore.getState<{ config?: Partial<JobConfig>; updatedAt?: string }>('job_config');
      }
    } catch {
      // Fallback to local state file
    }
    if (!parsed) {
      try {
        const raw = await fs.readFile(this.configStateFile, 'utf-8');
        parsed = JSON.parse(raw) as { config?: Partial<JobConfig>; updatedAt?: string };
      } catch {
        // Initial startup without persisted state file
      }
    }
    if (parsed?.config) {
      this.activeJobConfig = sanitizeJobConfig(parsed.config, DEFAULT_JOB_CONFIG);
      if (parsed.updatedAt) this.jobConfigUpdatedAt = parsed.updatedAt;
    }
  }

  /** Applies a validated partial update on top of the current configuration and persists it. */
  async update(patch: Partial<JobConfig>): Promise<void> {
    this.activeJobConfig = sanitizeJobConfig(patch, this.activeJobConfig);
    this.jobConfigUpdatedAt = new Date().toISOString();
    await this.persist();
  }

  private async persist(): Promise<void> {
    const payload = { config: this.activeJobConfig, updatedAt: this.jobConfigUpdatedAt };
    try {
      if (this.dbStore.isPostgresActive()) {
        await this.dbStore.saveState('job_config', payload);
      }
    } catch {
      // Fall through to local atomic mirror
    }
    try {
      await atomicWriteJson(this.configStateFile, payload, true);
    } catch {
      // Non-fatal in ephemeral containers
    }
  }
}
