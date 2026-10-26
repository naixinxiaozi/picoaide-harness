import { and, eq } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type Database } from '../db/database.module';
import {
  connectors,
  gatewayProviders,
  models,
  skillGrants,
  skills,
} from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { resolveUserEffectiveGroups } from '../common/effective-groups';
import { granteeMatch } from '../common/skills-shared';

const VALID_THINKING_LEVELS = new Set(['off', 'low', 'high', 'max']);

export interface BootstrapUser {
  userId: number;
  username: string;
  role: string;
}

function parseInputModalities(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // fallthrough
  }
  return ['text'];
}

function injectGlitchTipDefaults(def: string, baseURL: string, org: string): string {
  if (!baseURL && !org) return def;
  try {
    const obj = JSON.parse(def);
    if (Array.isArray(obj.tokenFields)) {
      for (const field of obj.tokenFields) {
        if (!field || typeof field !== 'object') continue;
        if (field.key === 'GLITCHTIP_BASE_URL' && baseURL) field.defaultValue = baseURL;
        if (field.key === 'GLITCHTIP_ORGANIZATION' && org) field.defaultValue = org;
      }
    }
    return JSON.stringify(obj);
  } catch {
    return def;
  }
}

/**
 * 客户端引导配置（/api/client/v2/config/bootstrap，Bearer）。
 * 服务端唯一控制面：统一下发模型清单、建议技能、web 错误上报、连接器、服务端版本。
 */
@Injectable()
export class BootstrapService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly settings: SettingsService,
  ) {}

  async build(user: BootstrapUser): Promise<Record<string, unknown>> {
    const [modelRows, skillRows, settings, connectorRows] = await Promise.all([
      this.listModels(),
      this.listSkills(),
      this.settings.getMany([
        'gateway.default_model',
        'web.error_reporting_dsn',
        'web.error_reporting_enabled',
        'web.error_reporting_level',
        'web.error_reporting_heartbeat',
        'web.glitchtip_base_url',
        'web.glitchtip_organization',
        'web.default_thinking_level',
      ]),
      this.listConnectors(),
    ]);

    const modelsOut = modelRows.map((m) => ({
      id: m.name,
      display_name: m.displayName || m.name,
      default_params: m.defaultParams ?? '',
      input_modalities: parseInputModalities(m.inputModalities ?? '["text"]'),
    }));

    let defaultModel = settings.get('gateway.default_model') ?? '';
    if (!this.modelEnabled(modelsOut, defaultModel)) {
      defaultModel = modelsOut[0]?.id ?? '';
    }

    const skillsOut = await this.authorizeSkills(user, skillRows);

    const level = settings.get('web.default_thinking_level') ?? 'max';
    const web = {
      error_reporting_dsn: settings.get('web.error_reporting_dsn') ?? '',
      error_reporting_enabled: settings.get('web.error_reporting_enabled') === 'true',
      error_reporting_level: settings.get('web.error_reporting_level') ?? 'error',
      error_reporting_heartbeat: settings.get('web.error_reporting_heartbeat') === 'true',
      glitchtip_base_url: settings.get('web.glitchtip_base_url') ?? '',
      glitchtip_organization: settings.get('web.glitchtip_organization') ?? '',
      default_thinking_level: VALID_THINKING_LEVELS.has(level) ? level : 'max',
    };

    const connectorsOut = connectorRows.map((c) => {
      let definition = c.definition ?? '';
      if (c.id === 'glitchtip') {
        definition = injectGlitchTipDefaults(definition, web.glitchtip_base_url, web.glitchtip_organization);
      }
      return {
        id: c.id,
        name: c.name,
        description: c.description ?? '',
        auth_mode: c.authMode,
        definition,
      };
    });

    return {
      default_model: defaultModel,
      models: modelsOut,
      skills: skillsOut,
      web,
      connectors: connectorsOut,
      server_version: process.env.SERVER_VERSION ?? 'dev',
    };
  }

  private async listModels(): Promise<
    { name: string; displayName: string | null; defaultParams: string; inputModalities: string }[]
  > {
    return this.db
      .select({
        name: models.name,
        displayName: models.displayName,
        defaultParams: models.defaultParams,
        inputModalities: models.inputModalities,
      })
      .from(models)
      .innerJoin(gatewayProviders, eq(models.providerId, gatewayProviders.id))
      .where(and(eq(gatewayProviders.enabled, 1), eq(models.catalogMissing, false)))
      .orderBy(models.id);
  }

  private modelEnabled(list: { id: string }[], id: string): boolean {
    if (!id) return false;
    return list.some((m) => m.id === id);
  }

  private async listSkills(): Promise<{ name: string; version: string; description: string }[]> {
    const rows = await this.db
      .select({
        name: skills.name,
        version: skills.version,
        description: skills.description,
      })
      .from(skills)
      .where(eq(skills.enabled, 1))
      .orderBy(skills.id);
    return rows.map((r) => ({ name: r.name, version: r.version, description: r.description ?? '' }));
  }

  private async authorizeSkills(
    user: BootstrapUser,
    all: { name: string; version: string; description: string }[],
  ): Promise<{ name: string; version: string; description: string }[]> {
    if (user.role === 'super_admin') return all;
    const groups = await resolveUserEffectiveGroups(this.db, user.userId);
    const granted = await this.db
      .selectDistinct({ skillName: skillGrants.skillName })
      .from(skillGrants)
      .where(granteeMatch(user.username, groups));
    const allowed = new Set(granted.map((g) => g.skillName));
    return all.filter((s) => allowed.has(s.name));
  }

  private async listConnectors(): Promise<
    { id: string; name: string; description: string | null; authMode: string; definition: string }[]
  > {
    const rows = await this.db
      .select({
        id: connectors.id,
        name: connectors.name,
        description: connectors.description,
        authMode: connectors.authMode,
        definition: connectors.definition,
      })
      .from(connectors)
      .where(eq(connectors.enabled, 1))
      .orderBy(connectors.id);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      authMode: r.authMode,
      definition: r.definition,
    }));
  }
}
